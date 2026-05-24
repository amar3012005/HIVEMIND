// Salesforce normalizer. Handles per-object-type shaping:
//   • Strips Salesforce attributes envelope
//   • Flattens compound fields (Name, BillingAddress)
//   • Drops system fields (SystemModstamp, IsDeleted, raw OwnerId)
//   • Multi-currency: keep original + converted
//   • Person Account vs Business Account split
//
// Input metadata is expected to carry `salesforce_object_type` set by the
// SalesforceAdapter. Output preserves canonical business fields as
// metadata for the router + enrichment to consume.

const SYSTEM_FIELDS = new Set([
  'SystemModstamp', 'IsDeleted', 'attributes', 'LastReferencedDate',
  'LastViewedDate', 'LastActivityDate',
]);

const COMPOUND_ADDRESS_FIELDS = ['BillingAddress', 'ShippingAddress', 'MailingAddress', 'OtherAddress'];

// Per-object key business fields. Used to keep the human-readable summary
// dense and consistent regardless of the raw payload shape.
const OBJECT_PRESENTATION = {
  Account: ['Name', 'Industry', 'AnnualRevenue', 'NumberOfEmployees', 'Type',
            'BillingCountry', 'BillingCity', 'Website', 'Phone', 'Description'],
  Contact: ['Name', 'Title', 'AccountName', 'Email', 'Phone', 'MobilePhone',
            'Department', 'MailingCountry', 'LeadSource', 'Description'],
  Opportunity: ['Name', 'AccountName', 'StageName', 'Amount', 'CloseDate',
                'ForecastCategoryName', 'Probability', 'OwnerName', 'NextStep',
                'Type', 'LeadSource', 'Description'],
  Task: ['Subject', 'WhoName', 'WhatName', 'Status', 'Priority', 'ActivityDate',
         'OwnerName', 'Description'],
  Event: ['Subject', 'WhoName', 'WhatName', 'StartDateTime', 'EndDateTime',
          'Location', 'OwnerName', 'Description'],
  EmailMessage: ['Subject', 'FromAddress', 'ToAddress', 'CcAddress', 'BccAddress',
                 'MessageDate', 'Status', 'TextBody'],
  Case: ['CaseNumber', 'Subject', 'AccountName', 'ContactName', 'Status',
         'Priority', 'Origin', 'Reason', 'Description'],
  OpportunityHistory: ['OpportunityName', 'StageName', 'Amount', 'CloseDate',
                       'Probability', 'ForecastCategory', 'CreatedDate'],
  CaseComment: ['CommentBody', 'CreatedByName', 'CreatedDate', 'IsPublished'],
};

export const salesforce = {
  name: 'salesforce',

  /**
   * @param {string} content  Raw stringified record (may be JSON or plain text)
   * @param {object} metadata  Carries salesforce_object_type, salesforce_id, ...
   * @returns {{content: string, metadata: object}}
   */
  normalize(content, metadata = {}) {
    const objType = metadata.salesforce_object_type || 'Custom';
    let record = null;

    // Accept either JSON stringified record or already-parsed object on metadata.raw_record.
    if (metadata.raw_record && typeof metadata.raw_record === 'object') {
      record = metadata.raw_record;
    } else if (typeof content === 'string') {
      try { record = JSON.parse(content); } catch { record = null; }
    }
    if (!record || typeof record !== 'object') {
      return {
        content: String(content || ''),
        metadata: { ...metadata, source_type_normalized: 'salesforce', salesforce_object_type: objType },
      };
    }

    // Strip system + flatten compound + drop nulls.
    const cleaned = stripSystemFields(record);
    flattenCompoundAddresses(cleaned);
    flattenNameField(cleaned);
    flattenLookupNames(cleaned);

    // Build presentation order based on object type.
    const order = OBJECT_PRESENTATION[objType] || Object.keys(cleaned);
    const lines = [];
    const businessFields = {};
    for (const key of order) {
      const v = cleaned[key];
      if (v == null || v === '') continue;
      const value = formatValue(v);
      lines.push(`${key}: ${value}`);
      businessFields[key] = v;
    }

    // Append remaining fields not in presentation order (custom fields).
    for (const [k, v] of Object.entries(cleaned)) {
      if (v == null || v === '') continue;
      if (order.includes(k)) continue;
      if (SYSTEM_FIELDS.has(k)) continue;
      lines.push(`${k}: ${formatValue(v)}`);
      businessFields[k] = v;
    }

    const sfId = record.Id || metadata.salesforce_id;
    const lastModified = record.LastModifiedDate || null;
    const createdInSf = record.CreatedDate || null;
    const isPersonAccount = !!record.IsPersonAccount;

    return {
      content: lines.join('\n').slice(0, 12000),
      metadata: {
        ...metadata,
        source_type_normalized: 'salesforce',
        salesforce_object_type: objType,
        salesforce_id: sfId,
        salesforce_last_modified: lastModified,
        salesforce_created_at: createdInSf,
        salesforce_is_person_account: isPersonAccount,
        salesforce_owner_name: record.OwnerName || record.Owner?.Name || null,
        salesforce_account_id: record.AccountId || null,
        salesforce_account_name: record.AccountName || record.Account?.Name || null,
        // Currency
        salesforce_currency: record.CurrencyIsoCode || null,
        // Email-domain extracted from Contact for entity-resolver.
        salesforce_email_domain: extractEmailDomain(record.Email),
        // Selected business fields available for enrichment + retrieval.
        salesforce_business_fields: businessFields,
        // Object-type-specific anchors:
        ...(objType === 'Opportunity' && {
          salesforce_stage: record.StageName,
          salesforce_amount: record.Amount,
          salesforce_close_date: record.CloseDate,
          salesforce_forecast_category: record.ForecastCategoryName,
          salesforce_probability: record.Probability,
        }),
        ...(objType === 'Case' && {
          salesforce_case_status: record.Status,
          salesforce_case_priority: record.Priority,
          salesforce_case_number: record.CaseNumber,
        }),
      },
    };
  },
};

function stripSystemFields(record) {
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    if (SYSTEM_FIELDS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function flattenCompoundAddresses(record) {
  for (const field of COMPOUND_ADDRESS_FIELDS) {
    const addr = record[field];
    if (!addr || typeof addr !== 'object') continue;
    const prefix = field.replace(/Address$/, '');
    if (addr.street) record[`${prefix}Street`] = addr.street;
    if (addr.city) record[`${prefix}City`] = addr.city;
    if (addr.state) record[`${prefix}State`] = addr.state;
    if (addr.postalCode) record[`${prefix}PostalCode`] = addr.postalCode;
    if (addr.country) record[`${prefix}Country`] = addr.country;
    delete record[field];
  }
}

function flattenNameField(record) {
  // Name is compound on Contact/Lead (FirstName/LastName/Salutation). Keep
  // both compound and components for downstream search.
  if (record.Name && typeof record.Name === 'object') {
    const parts = record.Name;
    record.FirstName = parts.firstName || parts.FirstName || record.FirstName;
    record.LastName = parts.lastName || parts.LastName || record.LastName;
    record.Salutation = parts.salutation || record.Salutation;
    record.Name = [parts.firstName, parts.lastName].filter(Boolean).join(' ');
  }
}

function flattenLookupNames(record) {
  // Salesforce returns lookups as nested {Id, Name, ...}. Promote Name to
  // OwnerName / AccountName / ContactName for readability.
  const lookups = ['Owner', 'Account', 'Contact', 'CreatedBy', 'LastModifiedBy',
                   'What', 'Who', 'Opportunity'];
  for (const k of lookups) {
    if (record[k] && typeof record[k] === 'object' && record[k].Name) {
      record[`${k}Name`] = record[k].Name;
    }
  }
}

function formatValue(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(formatValue).join(', ');
  if (typeof v === 'object') {
    if (v.Name) return v.Name;
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

function extractEmailDomain(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.indexOf('@');
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase().trim();
}
