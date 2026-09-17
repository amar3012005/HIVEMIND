# HUB_CONTRACT

Source-verified reference for `agentscope.app.hub`.
Verify with `../../agentscope-runtime/verify_api_surface.py`.

## Exports

```python
from agentscope.app.hub import (
    HubBase, HubError,
    # MCP
    MCPHubBase, MCPCard, MCPHubPage, GitHubMCPHub,
    # Skill
    SkillHubBase, SkillCard, SkillHubPage, SkillArchive, ClawSkillHub,
)
```

## Registration

```python
app = create_app(
    ...,
    mcp_hubs=[GitHubMCPHub()],
    skill_hubs=[ClawSkillHub()],
)
```

One argument brings the routes, the store page, and the install flow.
**Duplicate `hub_id` fails at startup** rather than silently shadowing — trust it,
do not add your own uniqueness guard.

Hubs are optional: without any registered, users can still paste an MCP config or
upload a skill folder.

## Built-in hubs

### GitHubMCPHub

| Parameter | Default | Description |
| --- | --- | --- |
| `hub_id` | `"github"` | identifier in routes and URLs |
| `display_name` | `"GitHub MCP Registry"` | shown in the hub switcher |
| `description` | GitHub registry blurb | one-line description |
| `icon_url` | GitHub avatar | icon shown beside the name |
| `base_url` | `"https://api.mcp.github.com"` | registry endpoint |
| `api_token` | `None` | GitHub token — **affects rate limits only** |
| `timeout` | `30.0` | per-request timeout (s) |

Works anonymously.

### ClawSkillHub

| Parameter | Default | Description |
| --- | --- | --- |
| `hub_id` | `"clawhub"` | identifier in routes and URLs |
| `display_name` | `"ClawHub"` | shown in the switcher |
| `base_url` | `"https://clawhub.ai"` | registry endpoint |
| `api_token` | `None` | affects rate limits only |
| `timeout` | `30.0` | per-request timeout (s) |
| `max_retries` | `3` | retries before giving up on a rate-limited request |

## Custom MCP hub

```python
from agentscope.app.hub import MCPCard, MCPHubBase, MCPHubPage


class InternalMCPHub(MCPHubBase):
    def __init__(self) -> None:
        super().__init__(
            hub_id="internal",
            display_name="Internal Registry",
            description="MCP servers approved by the platform team.",
        )

    async def __aenter__(self) -> "InternalMCPHub":
        self._client = httpx.AsyncClient(timeout=30.0)   # pooled, per-service
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self._client.aclose()

    async def list_mcps(
        self,
        user_id: str,
        q: str | None = None,          # keyword, or None to browse all
        cursor: str | None = None,     # opaque resume token, or None to start
        limit: int = 20,
    ) -> MCPHubPage:
        """One page of listings — WITHOUT heavy bodies."""
        cursor, cards = await fetch_page(q, cursor, limit)
        return MCPHubPage(cards=cards, next_cursor=cursor)   # None → no more

    async def get_mcp(self, user_id: str, card_id: str) -> MCPCard:
        """One listing, or KeyError → 404."""
        return self._to_card(await fetch_one(card_id))
```

### Declaring required inputs

Write user-supplied parts as `${placeholder}` in **any** string (URL, header, env
var, arg), then describe them with a JSON Schema for form rendering.
(`HttpMCPConfig` is imported from `agentscope.mcp`, not from `agentscope.app.hub`.)

```python
from agentscope.mcp import HttpMCPConfig

MCPCard(
    hub_id=self.hub_id,
    id="weather",
    name="weather",
    display_name="Weather",
    description="Current conditions and forecasts.",
    config_template=HttpMCPConfig(
        url="https://weather.example.com/mcp",
        headers={"Authorization": "Bearer ${api_key}"},
    ),
    inputs_schema={
        "type": "object",
        "required": ["api_key"],
        "properties": {
            "api_key": {
                "type": "string",
                "title": "API key",
                "description": "Found under Settings → API.",
                "writeOnly": True,        # MANDATORY for credentials
                "format": "password",     # MANDATORY for credentials
            },
        },
    },
)
```

> **`"writeOnly": true` + `"format": "password"` are mandatory on every credential
> field.** They tell the frontend to mask the value and leave the field blank on
> later edits. Omitting them risks rendering a secret in plaintext.

## Custom skill hub

```python
from agentscope.app.hub import (
    SkillArchive, SkillCard, SkillHubBase, SkillHubPage,
)

class InternalSkillHub(SkillHubBase):
    def __init__(self) -> None:
        super().__init__(
            hub_id="internal",
            display_name="Internal Skills",
            description="Skills published by the platform team.",
        )

    async def list_skills(
        self, user_id: str, q=None, cursor=None, limit: int = 20,
    ) -> SkillHubPage:
        """Listings WITHOUT the SKILL.md body."""
        ...

    async def get_skill(self, user_id: str, card_id: str) -> SkillCard:
        """One listing, WITH its SKILL.md body (`markdown=`)."""
        ...

    async def download(
        self, user_id: str, card_id: str, version: str | None = None,
    ) -> SkillArchive:
        # format is one of "zip", "tar", "tar.gz"
        return SkillArchive(format="tar.gz", stream=response.aiter_bytes())
```

**Archive layout:** the skill's folder with `SKILL.md` at its root, either as a
single top-level directory or as the files directly. Both work. The folder is
renamed to the installed skill's name.

## Behaviour rules

| Point | Guidance |
| --- | --- |
| **Cheap listing** | Omit bodies from `list_*`. Fetching a body per card multiplies one request by the page size and exhausts most registries on the first screen. Load it in `get_skill`. |
| **Cursor pagination** | Return any opaque resume string; `None` when exhausted → frontend stops loading. |
| **Missing cards** | Raise `KeyError` from `get_*` for an unknown id → the service answers **404**. |
| **Shared client** | A hub lives for the service's lifetime. Implement `__aenter__`/`__aexit__` to pool one HTTP client; the service enters every hub on startup and closes it on shutdown. |
| **Per-user visibility** | All methods receive `user_id` **first** — filter on it for allowlists, entitlement gating, or drafts visible only to authors. |

## Security rules

1. **`user_id` is passed to every method for a reason.** Apply the same filter in
   `list_*`, `get_*`, **and** `download`. Hiding a card from a listing alone is
   **not** access control — `get_*` and `download` are reachable with any id the
   caller guesses.
2. **Raise `KeyError`** for unknown *and* unauthorized ids, so guessing yields 404
   without leaking existence.
3. **Credentials are never echoed.** The service masks them in list/get responses
   and resolves the raw secret only inside trusted runtime paths. Never add an
   endpoint that returns a resolved credential.
4. **Gate on entitlements from hm-core** (billing/policy), not on UI state.

## Install vs equip

| Step | What happens |
| --- | --- |
| **Install** | the user picks a server/skill, fills the generated form; it joins **their pool**. Credentials are captured here, once. |
| **Equip** | in a chat, the user picks from the pool to unpack it into **that agent's workspace**. Tools reach the agent immediately. |

Every hub feeds the same pool, so provenance stops mattering after install. The
pool belongs to the **user**, not a chat; an installed skill fetches its files
**at equip time**, so if the hub is unreachable that skill reports as failed while
others in the same request still succeed.

## Upload bounds (skill folders)

| Bound | Value |
| --- | --- |
| Files per folder | ≤ 100 |
| Per file | ≤ 50 MB |
| Total | ≤ 500 MB |

A folder whose name is taken installs under a **numbered suffix** rather than
overwriting.

## HIVEMIND mapping

| HIVEMIND | AgentScope |
| --- | --- |
| connector registry | MCP hub cards |
| per-org connector credential | card `inputs_schema` → user pool at install |
| connector enabled for an employee | MCP equipped in that employee's workspace |
| approved/allowlisted connectors | custom hub + `user_id` entitlement filter |
| employee skill set (these `agentscope-*` skills) | skill hub archive with `SKILL.md` at root |

## Verification checklist

- [ ] `hub_id` unique across all registered hubs.
- [ ] `user_id` filter in `list_*`, `get_*`, **and** `download`.
- [ ] `KeyError` (not an empty result) for unknown/unauthorized ids.
- [ ] Credential fields carry `writeOnly: true` + `format: "password"`.
- [ ] `list_*` does not fetch per-card bodies.
- [ ] One pooled HTTP client per hub via `__aenter__`/`__aexit__`.
- [ ] Runtime check: install a connector → equip it in a workspace → its tools
      actually reach the agent.
