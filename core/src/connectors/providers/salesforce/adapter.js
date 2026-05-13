import { BaseProviderAdapter } from '../../framework/provider-adapter.js';

const API_VERSION = 'v60.0';
const PAGE_SIZE = 50;

/**
 * Salesforce adapter — pulls Accounts, Contacts, Opportunities, Cases.
 *
 * Uses SOQL via /services/data/<v>/query against the org's instance_url
 * (captured at OAuth time and read from context.provider_metadata).
 *
 * Cursor shape:
 *   "<sobject>:<offset>" — only one sobject in flight at a time. When
 *   a stream exhausts we advance to the next sobject in OBJECT_ORDER.
 *   Done when all four are exhausted.
 *
 * Incremental sync filters on LastModifiedDate.
 */

const OBJECT_ORDER = ['Account', 'Contact', 'Opportunity', 'Case'];

const FIELDS = {
  Account: 'Id,Name,Type,Industry,Website,Description,AnnualRevenue,NumberOfEmployees,LastModifiedDate',
  Contact: 'Id,Name,Email,Phone,Title,AccountId,Account.Name,Description,LastModifiedDate',
  Opportunity: 'Id,Name,StageName,Amount,CloseDate,Probability,AccountId,Account.Name,Description,LastModifiedDate',
  Case: 'Id,CaseNumber,Subject,Status,Priority,Origin,AccountId,Account.Name,Description,LastModifiedDate',
};

export class SalesforceAdapter extends BaseProviderAdapter {
  constructor() {
    super({ providerId: 'salesforce', requiredScopes: ['api', 'refresh_token'], defaultTags: ['salesforce'] });
  }

  async fetchInitial({ accessToken, cursor, context }) {
    return this._fetch({ accessToken, cursor, context, sinceIso: null });
  }

  async fetchIncremental({ accessToken, cursor, context }) {
    const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    return this._fetch({ accessToken, cursor, context, sinceIso });
  }

  async _fetch({ accessToken, cursor, context, sinceIso }) {
    const instanceUrl = context?.provider_metadata?.instance_url;
    if (!instanceUrl) {
      return { records: [], nextCursor: null, hasMore: false };
    }

    let { sobject, offset } = _parseCursor(cursor);
    let records = [];
    let nextCursor = null;
    let hasMore = false;

    while (sobject) {
      const { rows, total, done } = await this._queryObject({
        accessToken, instanceUrl, sobject, offset, sinceIso,
      });
      for (const row of rows) records.push({ _kind: sobject, data: row });

      const newOffset = offset + rows.length;
      if (rows.length === 0 || (done && newOffset >= total)) {
        // Move to next sobject
        const idx = OBJECT_ORDER.indexOf(sobject);
        const nextObj = OBJECT_ORDER[idx + 1] || null;
        sobject = nextObj;
        offset = 0;
        if (!sobject) break;
      } else {
        nextCursor = _serializeCursor(sobject, newOffset);
        hasMore = true;
        break;
      }

      // Cap per-call batch size
      if (records.length >= PAGE_SIZE) {
        nextCursor = _serializeCursor(sobject, offset);
        hasMore = true;
        break;
      }
    }

    if (!sobject && !hasMore) {
      nextCursor = null;
      hasMore = false;
    }
    return { records, nextCursor, hasMore };
  }

  async _queryObject({ accessToken, instanceUrl, sobject, offset, sinceIso }) {
    const fields = FIELDS[sobject];
    const where = sinceIso ? `WHERE LastModifiedDate >= ${sinceIso} ` : '';
    const order = 'ORDER BY LastModifiedDate DESC';
    const limit = `LIMIT ${PAGE_SIZE}`;
    const offsetClause = offset > 0 ? `OFFSET ${offset}` : '';
    const soql = `SELECT ${fields} FROM ${sobject} ${where}${order} ${limit} ${offsetClause}`.trim();
    const url = `${instanceUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    if (!res.ok) {
      if (res.status === 401) { const e = new Error('Salesforce 401'); e.status = 401; throw e; }
      const text = await res.text().catch(() => '');
      throw new Error(`Salesforce ${sobject} ${res.status} ${text}`);
    }
    const data = await res.json();
    return { rows: data.records || [], total: data.totalSize || 0, done: data.done !== false };
  }

  normalize(record, context) {
    const fn = {
      Account: this._normalizeAccount,
      Contact: this._normalizeContact,
      Opportunity: this._normalizeOpportunity,
      Case: this._normalizeCase,
    }[record._kind];
    if (!fn) return [];
    return [fn.call(this, record.data, context)];
  }

  _baseSourceUrl(context, sobject, id) {
    const instanceUrl = context?.provider_metadata?.instance_url;
    return instanceUrl ? `${instanceUrl}/lightning/r/${sobject}/${id}/view` : null;
  }

  _normalizeAccount(rec, context) {
    return {
      user_id: context.user_id, org_id: context.org_id, project: null,
      content: [
        `Account: ${rec.Name}`,
        rec.Description,
        rec.Industry ? `Industry: ${rec.Industry}` : null,
        rec.Type ? `Type: ${rec.Type}` : null,
        rec.AnnualRevenue ? `ARR: $${rec.AnnualRevenue}` : null,
      ].filter(Boolean).join('\n\n'),
      title: `Account: ${rec.Name}`.slice(0, 200),
      tags: ['salesforce', 'account', rec.Industry ? `industry:${rec.Industry.toLowerCase()}` : null].filter(Boolean),
      memory_type: 'fact',
      document_date: rec.LastModifiedDate || null,
      source_metadata: {
        source_type: 'salesforce_account',
        source_platform: 'salesforce',
        source_id: rec.Id,
        source_url: this._baseSourceUrl(context, 'Account', rec.Id),
      },
      metadata: { account_name: rec.Name, employees: rec.NumberOfEmployees || null },
    };
  }

  _normalizeContact(rec, context) {
    return {
      user_id: context.user_id, org_id: context.org_id, project: null,
      content: [
        `Contact: ${rec.Name}`,
        rec.Title ? `Title: ${rec.Title}` : null,
        rec.Account?.Name ? `Account: ${rec.Account.Name}` : null,
        rec.Email ? `Email: ${rec.Email}` : null,
        rec.Phone ? `Phone: ${rec.Phone}` : null,
        rec.Description,
      ].filter(Boolean).join('\n\n'),
      title: `Contact: ${rec.Name}`.slice(0, 200),
      tags: ['salesforce', 'contact', rec.Account?.Name ? `account:${rec.Account.Name.toLowerCase().replace(/\s+/g,'-')}` : null].filter(Boolean),
      memory_type: 'fact',
      document_date: rec.LastModifiedDate || null,
      source_metadata: {
        source_type: 'salesforce_contact',
        source_platform: 'salesforce',
        source_id: rec.Id,
        source_url: this._baseSourceUrl(context, 'Contact', rec.Id),
      },
      metadata: { email: rec.Email || null, account_id: rec.AccountId || null },
    };
  }

  _normalizeOpportunity(rec, context) {
    return {
      user_id: context.user_id, org_id: context.org_id, project: null,
      content: [
        `Opportunity: ${rec.Name}`,
        rec.Account?.Name ? `Account: ${rec.Account.Name}` : null,
        rec.StageName ? `Stage: ${rec.StageName}` : null,
        rec.Amount ? `Amount: $${rec.Amount}` : null,
        rec.CloseDate ? `Close: ${rec.CloseDate}` : null,
        rec.Probability != null ? `Probability: ${rec.Probability}%` : null,
        rec.Description,
      ].filter(Boolean).join('\n\n'),
      title: `Opp: ${rec.Name}`.slice(0, 200),
      tags: [
        'salesforce', 'opportunity',
        rec.StageName ? `stage:${rec.StageName.toLowerCase().replace(/\s+/g,'-')}` : null,
      ].filter(Boolean),
      memory_type: 'fact',
      document_date: rec.LastModifiedDate || null,
      source_metadata: {
        source_type: 'salesforce_opportunity',
        source_platform: 'salesforce',
        source_id: rec.Id,
        source_url: this._baseSourceUrl(context, 'Opportunity', rec.Id),
      },
      metadata: {
        stage: rec.StageName, amount: rec.Amount || null,
        close_date: rec.CloseDate || null, account_name: rec.Account?.Name || null,
      },
    };
  }

  _normalizeCase(rec, context) {
    return {
      user_id: context.user_id, org_id: context.org_id, project: null,
      content: [
        `Case ${rec.CaseNumber}: ${rec.Subject || ''}`,
        rec.Status ? `Status: ${rec.Status}` : null,
        rec.Priority ? `Priority: ${rec.Priority}` : null,
        rec.Origin ? `Origin: ${rec.Origin}` : null,
        rec.Account?.Name ? `Account: ${rec.Account.Name}` : null,
        rec.Description,
      ].filter(Boolean).join('\n\n'),
      title: `Case ${rec.CaseNumber}: ${rec.Subject || ''}`.slice(0, 200),
      tags: [
        'salesforce', 'case',
        rec.Status ? `status:${rec.Status.toLowerCase().replace(/\s+/g,'-')}` : null,
        rec.Priority ? `priority:${rec.Priority.toLowerCase()}` : null,
      ].filter(Boolean),
      memory_type: 'task',
      document_date: rec.LastModifiedDate || null,
      source_metadata: {
        source_type: 'salesforce_case',
        source_platform: 'salesforce',
        source_id: rec.Id,
        source_url: this._baseSourceUrl(context, 'Case', rec.Id),
      },
      metadata: { case_number: rec.CaseNumber, status: rec.Status, priority: rec.Priority },
    };
  }

  dedupeKey(record) {
    return `salesforce:${record._kind.toLowerCase()}:${record.data.Id}`;
  }
}

// ── helpers ──────────────────────────────────────────────────────
function _parseCursor(cursor) {
  if (!cursor) return { sobject: OBJECT_ORDER[0], offset: 0 };
  const [sobject, off] = String(cursor).split(':');
  if (!sobject || !OBJECT_ORDER.includes(sobject)) return { sobject: OBJECT_ORDER[0], offset: 0 };
  return { sobject, offset: parseInt(off, 10) || 0 };
}

function _serializeCursor(sobject, offset) {
  return `${sobject}:${offset}`;
}
