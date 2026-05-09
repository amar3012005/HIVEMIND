/**
 * Salesforce connector — covers Accounts, Contacts, Opportunities, Cases, and
 * arbitrary Custom Objects via REST API + OAuth 2.0 (User-Agent / Web Server flow).
 *
 * Required env vars (set on control-plane container):
 *   SALESFORCE_CLIENT_ID            — Connected App consumer key
 *   SALESFORCE_CLIENT_SECRET        — Connected App consumer secret
 *   SALESFORCE_REDIRECT_URI         — defaults to https://api.hivemind.davinciai.eu:8040/auth/salesforce/callback
 *   SALESFORCE_LOGIN_HOST           — login.salesforce.com (prod) or test.salesforce.com (sandbox)
 *
 * Connected App registration (Salesforce Setup):
 *   1. Setup → App Manager → New Connected App
 *   2. Name: "HIVEMIND Connector"
 *   3. Enable OAuth Settings
 *   4. Callback URL: https://api.hivemind.davinciai.eu:8040/auth/salesforce/callback
 *   5. Selected OAuth Scopes:
 *        - Manage user data via APIs (api)
 *        - Perform requests at any time (refresh_token, offline_access)
 *        - Access Connect REST API resources (chatter_api)
 *   6. Save. Note "Consumer Key" + "Consumer Secret".
 *   7. Wait ~10 min for OAuth policies to propagate before first auth.
 *
 * Wiring TODO (backend):
 *   - Add /auth/salesforce + /auth/salesforce/callback routes.
 *     Authorize URL: https://{login_host}/services/oauth2/authorize?response_type=code&...
 *     Token URL:     https://{login_host}/services/oauth2/token
 *   - Token response includes `instance_url` — persist alongside access_token + refresh_token.
 *   - Pollers (use instance_url as base):
 *       Accounts:      GET /services/data/v60.0/query?q=SELECT+Id,Name,...+FROM+Account
 *       Opportunities: GET /services/data/v60.0/query?q=SELECT+...+FROM+Opportunity+WHERE+LastModifiedDate+>+...
 *       Cases:         GET /services/data/v60.0/query?q=SELECT+...+FROM+Case
 *       Contacts:      GET /services/data/v60.0/query?q=SELECT+...+FROM+Contact
 *   - For each record → normalize* method → POST /api/memories.
 *   - Use Salesforce Pub/Sub API or Change Data Capture for real-time updates
 *     instead of polling for production.
 */

export class SalesforceConnector {
  normalizeAccount(rec, { user_id, org_id, project, instance_url }) {
    return {
      user_id,
      org_id,
      project,
      content: [
        `Account: ${rec.Name}`,
        rec.Description,
        rec.Industry ? `Industry: ${rec.Industry}` : null,
        rec.Type ? `Type: ${rec.Type}` : null,
        rec.AnnualRevenue ? `ARR: $${rec.AnnualRevenue}` : null,
      ].filter(Boolean).join('\n\n'),
      tags: [
        'salesforce',
        'account',
        ...(rec.Type ? [`type:${rec.Type}`] : []),
        ...(rec.Industry ? [`industry:${rec.Industry}`] : []),
      ],
      document_date: rec.LastModifiedDate || rec.CreatedDate || null,
      event_dates: [rec.CreatedDate, rec.LastModifiedDate].filter(Boolean),
      source_metadata: {
        source_type: 'salesforce-account',
        source_platform: 'salesforce',
        source_id: rec.Id,
        source_url: instance_url ? `${instance_url}/${rec.Id}` : null,
      },
      metadata: {
        name: rec.Name,
        owner_id: rec.OwnerId || null,
        industry: rec.Industry || null,
        type: rec.Type || null,
        annual_revenue: rec.AnnualRevenue || null,
        employees: rec.NumberOfEmployees || null,
        billing_country: rec.BillingCountry || null,
        billing_city: rec.BillingCity || null,
      },
    };
  }

  normalizeOpportunity(rec, { user_id, org_id, project, instance_url }) {
    return {
      user_id,
      org_id,
      project,
      content: [
        `Opportunity: ${rec.Name}`,
        rec.Description,
        `Stage: ${rec.StageName}`,
        rec.Amount ? `Amount: $${rec.Amount}` : null,
        rec.CloseDate ? `Close: ${rec.CloseDate}` : null,
        rec.NextStep ? `Next: ${rec.NextStep}` : null,
      ].filter(Boolean).join('\n\n'),
      tags: [
        'salesforce',
        'opportunity',
        `stage:${rec.StageName}`,
        ...(rec.Type ? [`type:${rec.Type}`] : []),
        ...(rec.IsClosed ? ['closed'] : ['open']),
        ...(rec.IsWon ? ['won'] : []),
      ],
      document_date: rec.LastModifiedDate || rec.CreatedDate || null,
      event_dates: [rec.CreatedDate, rec.CloseDate, rec.LastModifiedDate].filter(Boolean),
      source_metadata: {
        source_type: 'salesforce-opportunity',
        source_platform: 'salesforce',
        source_id: rec.Id,
        source_url: instance_url ? `${instance_url}/${rec.Id}` : null,
      },
      metadata: {
        name: rec.Name,
        account_id: rec.AccountId || null,
        owner_id: rec.OwnerId || null,
        stage: rec.StageName,
        amount: rec.Amount || null,
        close_date: rec.CloseDate || null,
        probability: rec.Probability || null,
        forecast_category: rec.ForecastCategoryName || null,
        is_closed: rec.IsClosed || false,
        is_won: rec.IsWon || false,
      },
    };
  }

  normalizeCase(rec, { user_id, org_id, project, instance_url }) {
    return {
      user_id,
      org_id,
      project,
      content: [
        `Case ${rec.CaseNumber}: ${rec.Subject}`,
        rec.Description,
        `Status: ${rec.Status}`,
        rec.Priority ? `Priority: ${rec.Priority}` : null,
      ].filter(Boolean).join('\n\n'),
      tags: [
        'salesforce',
        'case',
        `status:${rec.Status}`,
        ...(rec.Priority ? [`priority:${rec.Priority}`] : []),
        ...(rec.Type ? [`type:${rec.Type}`] : []),
        ...(rec.IsClosed ? ['closed'] : ['open']),
      ],
      document_date: rec.LastModifiedDate || rec.CreatedDate || null,
      event_dates: [rec.CreatedDate, rec.ClosedDate, rec.LastModifiedDate].filter(Boolean),
      source_metadata: {
        source_type: 'salesforce-case',
        source_platform: 'salesforce',
        source_id: rec.Id,
        source_url: instance_url ? `${instance_url}/${rec.Id}` : null,
      },
      metadata: {
        case_number: rec.CaseNumber,
        subject: rec.Subject,
        account_id: rec.AccountId || null,
        contact_id: rec.ContactId || null,
        owner_id: rec.OwnerId || null,
        status: rec.Status,
        priority: rec.Priority || null,
        type: rec.Type || null,
        origin: rec.Origin || null,
        is_closed: rec.IsClosed || false,
      },
    };
  }

  normalizeContact(rec, { user_id, org_id, project, instance_url }) {
    return {
      user_id,
      org_id,
      project,
      content: [
        `${rec.FirstName || ''} ${rec.LastName || ''}`.trim(),
        rec.Title ? `Title: ${rec.Title}` : null,
        rec.Email ? `Email: ${rec.Email}` : null,
        rec.Phone ? `Phone: ${rec.Phone}` : null,
        rec.Description,
      ].filter(Boolean).join('\n\n'),
      tags: ['salesforce', 'contact'],
      document_date: rec.LastModifiedDate || rec.CreatedDate || null,
      event_dates: [rec.CreatedDate, rec.LastModifiedDate].filter(Boolean),
      source_metadata: {
        source_type: 'salesforce-contact',
        source_platform: 'salesforce',
        source_id: rec.Id,
        source_url: instance_url ? `${instance_url}/${rec.Id}` : null,
      },
      metadata: {
        first_name: rec.FirstName || null,
        last_name: rec.LastName || null,
        full_name: `${rec.FirstName || ''} ${rec.LastName || ''}`.trim(),
        email: rec.Email || null,
        phone: rec.Phone || null,
        title: rec.Title || null,
        account_id: rec.AccountId || null,
        owner_id: rec.OwnerId || null,
      },
    };
  }
}
