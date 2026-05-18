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

## OAuth callback URL (MANDATORY for every provider)

```
https://api.hivemind.davinciai.eu:8042/oauth/callback
```

Must be added EXACTLY (including port, trailing path, no slash) to each provider's redirect URI allowlist BEFORE Nango integration will work. Missing this = "redirect_uri did not match" error.

## Adding a new provider

1. Provider dev console (e.g. https://api.slack.com/apps, https://www.notion.so/my-integrations, https://github.com/settings/developers, etc.)
2. Add redirect URI: `https://api.hivemind.davinciai.eu:8042/oauth/callback`
3. Copy Client ID + Secret
4. Nango admin UI (`https://api.hivemind.davinciai.eu:8042` → Integrations → New)
5. Select template, paste Client ID + Secret
4. Scopes per above
5. Ensure `nango_provider` in all three catalogs matches the key here
6. Test: `curl POST /v1/proxy/connectors/connect-session` with that connector_id
7. Update this table
