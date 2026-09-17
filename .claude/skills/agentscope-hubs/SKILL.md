---
name: agentscope-hubs
description: "Distribute MCP servers and skills to HIVEMIND Digital Employees with AgentScope 2.0.8 hubs — register GitHub/ClawHub or build custom internal hubs, map HIVEMIND connectors to MCP servers, declare credential inputs safely (writeOnly/password), gate visibility per tenant with user_id, and wire the install-vs-equip flow. Invoke BEFORE building any connector distribution, MCP catalog, or skill marketplace surface."
---

# Hubs — distributing connectors and skills

A **hub** is a catalog of MCP servers or skills that users browse and install from
inside the app. Registering one means nobody hand-writes MCP config, and the
catalog grows without a redeploy.

**Announce:** "Using agentscope-hubs."

Load `.claude/skills/agentscope-runtime/CONTRACT.md` and
`references/HUB_CONTRACT.md` first.

## Install ≠ equip (the core mental model)

This split is what makes credentials a one-time cost.

```
1. INSTALL   user browses hub → installs MCP/skill → enters credentials once
                    │
                    ▼
             user's pool (outlives any chat; every hub feeds the same pool)
                    │
2. EQUIP           user picks from pool → unpacks into THAT agent's workspace
                    │
                    ▼
             tools reach the agent immediately
```

An API key entered once at install is reused when equipping the server in ten
different workspaces. The pool is owned by the **user**, not a chat.

Hubs are **optional**. Without any registered, users can still paste an MCP
configuration or upload a skill folder.

## Built-in hubs

```python
from agentscope.app import create_app
from agentscope.app.hub import GitHubMCPHub, ClawSkillHub

app = create_app(
    ...,
    mcp_hubs=[GitHubMCPHub()],      # GitHub MCP Registry (https://github.com/mcp)
    skill_hubs=[ClawSkillHub()],    # ClawHub (https://clawhub.ai)
)
```

Both work anonymously; an `api_token` raises the rate limit. One argument brings
the routes, the store page, and the install flow with it.

**Registering two hubs under the same `hub_id` fails at startup** rather than
silently shadowing one — good, trust it instead of adding your own uniqueness check.

## HIVEMIND connectors → MCP servers

The connector strategy maps cleanly onto hubs:

| HIVEMIND concept | AgentScope concept |
| --- | --- |
| connector registry (Gmail, Drive, Salesforce, …) | **MCP hub** cards |
| per-org connector credentials | hub card `inputs_schema` (installed into the user's pool) |
| connector enabled for an employee | MCP **equipped** in that employee's workspace |
| internal/approved-only connectors | a **custom hub** with a per-tenant allowlist |

**Model internal connectors as a custom hub, not as hardcoded MCP configs.**
That gives you: a browsable catalog, credential forms generated from schema,
credential masking for free, and per-tenant visibility — all without touching the
service.

## Custom hub — internal connector registry

```python
from agentscope.app.hub import MCPCard, MCPHubBase, MCPHubPage
from agentscope.mcp import HttpMCPConfig      # transport config lives here, not in .hub

class InternalConnectorHub(MCPHubBase):
    """HIVEMIND connectors approved for use inside the org."""

    def __init__(self) -> None:
        super().__init__(
            hub_id="hivemind-connectors",
            display_name="HIVEMIND Connectors",
            description="Connectors approved for your organization.",
        )

    async def __aenter__(self):
        self._client = httpx.AsyncClient(timeout=30.0)   # pool, reused per request
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    async def list_mcps(self, user_id, q=None, cursor=None, limit=20) -> MCPHubPage:
        # Cheap: exclude any SKILL.md-equivalent body. Bodies are fetched per card
        # and exhaust registries on the first screen.
        allowed = await our_entitlements(user_id)        # per-tenant gate
        page = await fetch_catalog(q, cursor, limit)
        return MCPHubPage(
            cards=[self._to_card(c) for c in page.items if c.id in allowed],
            next_cursor=page.next_cursor,                # None → nothing more
        )

    async def get_mcp(self, user_id, card_id) -> MCPCard:
        if card_id not in await our_entitlements(user_id):
            raise KeyError(card_id)                      # → 404, no existence leak
        return self._to_card(await fetch_one(card_id))
```

### Declaring credential inputs

Write the user-supplied parts as `${placeholder}` in **any** string (URL, header,
env var, arg), and describe them with a JSON Schema so the frontend renders the form:

```python
MCPCard(
    hub_id=self.hub_id,
    id="salesforce",
    name="salesforce",
    display_name="Salesforce",
    description="Query and update CRM records.",
    config_template=HttpMCPConfig(
        url="https://mcp.example.com/salesforce",
        headers={"Authorization": "Bearer ${api_key}"},
    ),
    inputs_schema={
        "type": "object",
        "required": ["api_key"],
        "properties": {
            "api_key": {
                "type": "string",
                "title": "API key",
                "description": "From your connector settings.",
                "writeOnly": True,        # MANDATORY for credentials
                "format": "password",     # MANDATORY for credentials
            },
        },
    },
)
```

> **Every credential field must be `"writeOnly": true, "format": "password"`.**
> That is what tells the frontend to mask the value and leave the field blank on
> later edits. Omitting it can render a secret in plaintext in the UI.

## Skill hubs

Same shape, three methods. A skill is a folder with a `SKILL.md` at its root.

```python
from agentscope.app.hub import SkillArchive, SkillCard, SkillHubBase, SkillHubPage

class InternalSkillHub(SkillHubBase):
    async def list_skills(self, user_id, q=None, cursor=None, limit=20) -> SkillHubPage: ...
    async def get_skill(self, user_id, card_id) -> SkillCard:     # include the SKILL.md body here
        ...
    async def download(self, user_id, card_id, version=None) -> SkillArchive:
        ...
```

`SkillArchive(format=…)` accepts `"zip"`, `"tar"`, or `"tar.gz"`. The archive
should hold the skill folder with `SKILL.md` at its root, either as a top-level
directory or as the files directly; the folder is renamed to the installed skill's
name.

**This is where the agentscope-* skills themselves become distributable.** A
skill folder with `SKILL.md` + `references/` + scripts installs through the same
flow — so the employee skill set can ship as a hub rather than as repo files.

## Security rules (these are access control, not cosmetics)

- **`user_id` is passed to every method for a reason.** Apply the filter in
  `list_*` **and** `get_*` **and** `download`. Hiding a card from a listing alone
  is *not* access control — `get_*` is reachable with any id the caller guesses.
- **Raise `KeyError`** for an unknown/unauthorized id so the service answers 404
  instead of leaking existence.
- **Credentials are never echoed.** The service masks them in list/get responses
  and resolves the raw secret only inside trusted runtime paths. Never add an
  endpoint that returns a resolved credential.
- **Gate on entitlements, not on the UI.** A per-tenant allowlist driven by
  hm-core billing/policy is the correct place to enforce connector availability.

## Implementation notes

| Point | Guidance |
| --- | --- |
| Cheap listing | leave the `SKILL.md` body out of `list_*`; load it in `get_*` |
| Cursor pagination | return an opaque resume string, `None` when exhausted |
| Shared client | hubs live for the service's lifetime — implement `__aenter__`/`__aexit__` to pool one HTTP client |
| Upload limits | a skill folder is bounded (≤100 files, 50 MB/file, 500 MB total); a name collision installs under a numbered suffix |
| Hub unreachable at equip time | an installed skill fetches files at equip time, so an unreachable hub reports that skill as failed while others in the request still succeed |

## Checklist

- [ ] Internal connectors modelled as a **custom hub**, not hardcoded MCP configs.
- [ ] Every credential field has `writeOnly: true` + `format: "password"`.
- [ ] `user_id` filter applied in `list_*`, `get_*`, **and** `download`.
- [ ] `get_*` raises `KeyError` for unknown/unauthorized ids.
- [ ] Listing stays cheap (no per-card bodies).
- [ ] `hub_id` values unique across registered hubs.
- [ ] One pooled HTTP client per hub via `__aenter__`/`__aexit__`.
- [ ] Verified by a real run: install a connector, equip it in a workspace, confirm its tools reach the agent.

## See also

- `references/HUB_CONTRACT.md` — full card/hub/page/archive reference.
- `../agentscope-workspace-sandbox/SKILL.md` — where an equipped server runs.
- `CONTRACT.md` §8 — hub exports and signatures.
