# Nango OAuth Providers

Per-provider OAuth setup for self-hosted Nango at `api.hivemind.davinciai.eu:8042`.

## Provider key reference

| Catalog ID | Nango provider key | Env registered | Status |
|---|---|---|---|
| slack-live | `slack` | dev | configured |
| notion-live | `notion` | — | pending |
| github-live | `github` | — | pending |
| linear-live | `linear` | — | pending |
| jira-live | `jira` | — | pending |
| confluence-ingestion | `confluence` | — | pending |
| gmail-ingestion | `google-mail` | — | pending |
| google-drive-ingestion | `google-drive` | — | pending |
| notion-ingestion | `notion` | — | pending |

## Scopes per provider

### Slack
- `channels:history`, `channels:read`, `chat:write`, `users:read`, `groups:history`, `im:history`, `mpim:history`

### Notion
- `read_content`, `read_user_information`

### GitHub
- `repo`, `read:user`, `read:org`

### Linear
- `read`, `write`, `issues:create`

### Jira / Confluence (Atlassian)
- `read:jira-work`, `read:confluence-content.all`, `offline_access`

### Google (Gmail/Drive/Calendar)
- Gmail: `gmail.readonly`, `gmail.modify`
- Drive: `drive.readonly`
- Calendar: `calendar.readonly`, `calendar.events`
- All: `userinfo.email`, `userinfo.profile`, `openid`, `offline_access`

## Adding a new provider

1. Admin UI (`https://api.hivemind.davinciai.eu:8042` → log in → Integrations → New)
2. Select template, paste Client ID + Secret from provider's dev console
3. Set redirect URI in provider console: `https://api.hivemind.davinciai.eu:8042/oauth/callback`
4. Scopes per above
5. Ensure `nango_provider` in all three catalogs matches the key here
6. Test: `curl POST /v1/proxy/connectors/connect-session` with that connector_id
7. Update this table
