/**
 * Atlassian connector — covers Jira (issues + projects) and Confluence (pages
 * + spaces) via a single OAuth 2.0 (3LO) app.
 *
 * Required env vars (set on control-plane container):
 *   ATLASSIAN_CLIENT_ID           — Atlassian app client ID
 *   ATLASSIAN_CLIENT_SECRET       — Atlassian app secret
 *   ATLASSIAN_REDIRECT_URI        — defaults to https://api.hivemind.davinciai.eu:8040/auth/atlassian/callback
 *
 * App registration steps (developer.atlassian.com):
 *   1. developer.atlassian.com → Console → Create → OAuth 2.0 integration
 *   2. Permissions:
 *        Jira API:        read:jira-work, read:jira-user, manage:jira-project
 *        Confluence API:  read:confluence-content.summary, read:confluence-content.all,
 *                         read:confluence-space.summary, read:confluence-user
 *        Plus: offline_access (for refresh tokens)
 *   3. Authorization → Add callback URL: https://api.hivemind.davinciai.eu:8040/auth/atlassian/callback
 *   4. Distribute → set to Public (multi-tenant) or keep Private
 *
 * Wiring TODO (backend):
 *   - Add /auth/atlassian (start) + /auth/atlassian/callback (token exchange)
 *     to control-plane-server.js. Pattern matches /auth/google.
 *     Authorize URL: https://auth.atlassian.com/authorize?audience=api.atlassian.com&...
 *     Token URL:     https://auth.atlassian.com/oauth/token
 *   - On token exchange, call GET https://api.atlassian.com/oauth/token/accessible-resources
 *     to discover the user's cloud_id (one per Jira/Confluence site).
 *   - Persist tokens + cloud_id in oauth-tokens.
 *   - Pollers:
 *       Jira:        GET https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/search?jql=...
 *       Confluence:  GET https://api.atlassian.com/ex/confluence/{cloud_id}/wiki/api/v2/pages
 */

export class AtlassianConnector {
  /** Jira issue → memory. */
  normalizeJiraIssue(issue, { user_id, org_id, project, cloud_url }) {
    const fields = issue.fields || {};
    return {
      user_id,
      org_id,
      project,
      content: [
        `${issue.key}: ${fields.summary || ''}`,
        fields.description?.content
          ? this._renderAdf(fields.description)
          : fields.description || '',
      ].filter(Boolean).join('\n\n'),
      tags: [
        'jira',
        `project:${fields.project?.key}`,
        `type:${fields.issuetype?.name}`,
        `status:${fields.status?.name}`,
        ...(fields.labels || []),
        ...(fields.components || []).map(c => `component:${c.name}`),
      ].filter(Boolean),
      document_date: fields.updated || fields.created || null,
      event_dates: [fields.created, fields.updated, fields.duedate].filter(Boolean),
      source_metadata: {
        source_type: 'jira-issue',
        source_platform: 'jira',
        source_id: issue.id,
        source_url: cloud_url ? `${cloud_url}/browse/${issue.key}` : null,
      },
      metadata: {
        key: issue.key,
        project: fields.project?.key,
        type: fields.issuetype?.name,
        status: fields.status?.name,
        priority: fields.priority?.name,
        assignee: fields.assignee?.emailAddress || fields.assignee?.displayName || null,
        reporter: fields.reporter?.emailAddress || fields.reporter?.displayName || null,
        story_points: fields.customfield_10016 || null, // common Jira story-points field
        sprint: (fields.customfield_10020 || []).map(s => s.name).filter(Boolean),
        epic: fields.customfield_10014 || null,
      },
    };
  }

  /** Confluence page → memory. */
  normalizeConfluencePage(page, { user_id, org_id, project, cloud_url }) {
    return {
      user_id,
      org_id,
      project,
      content: [
        page.title,
        page.body?.atlas_doc_format?.value
          ? this._renderAdf(JSON.parse(page.body.atlas_doc_format.value))
          : page.body?.storage?.value || '',
      ].filter(Boolean).join('\n\n'),
      tags: [
        'confluence',
        `space:${page.spaceId || page.space?.key}`,
        ...(page.labels?.results || []).map(l => `label:${l.name}`),
      ].filter(Boolean),
      document_date: page.version?.createdAt || page.createdAt || null,
      event_dates: [page.createdAt, page.version?.createdAt].filter(Boolean),
      source_metadata: {
        source_type: 'confluence-page',
        source_platform: 'confluence',
        source_id: page.id,
        source_url: cloud_url ? `${cloud_url}${page._links?.webui || `/wiki/spaces/${page.spaceId}/pages/${page.id}`}` : null,
      },
      metadata: {
        title: page.title,
        space_id: page.spaceId,
        version: page.version?.number || 1,
        author_id: page.authorId || page.version?.authorId || null,
        status: page.status || 'current',
        parent_id: page.parentId || null,
      },
    };
  }

  /** Crude ADF (Atlassian Document Format) → plaintext renderer. */
  _renderAdf(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(n => this._renderAdf(n)).join('');
    if (node.type === 'text') return node.text || '';
    if (node.type === 'hardBreak') return '\n';
    if (node.content) return this._renderAdf(node.content);
    return '';
  }
}
