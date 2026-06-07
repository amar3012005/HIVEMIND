# Hermes Profile Distributions — Technical Reference

Source: https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions

Packaging, sharing, and installing complete Hermes agents. A "distribution" is a git repo containing a profile plus a `distribution.yaml` manifest. Distribution = transport over git; install clones the repo into `~/.hermes/profiles/<name>/`.

---

## `distribution.yaml` manifest

Required manifest at repo root. **Only `name` is mandatory**; all other fields have defaults.

```yaml
name: research-bot                 # REQUIRED. Profile name (becomes install dir name unless --name)
version: 1.0.0                     # semver
description: "Autonomous research assistant with arXiv and web tools"
hermes_requires: ">=0.12.0"        # min Hermes version constraint
author: "Your Name"
license: "MIT"
env_requires:                      # declares env vars -> drives generated .env.EXAMPLE
  - name: OPENAI_API_KEY
    description: "OpenAI API key (for model access)"
    required: true
  - name: SERPAPI_KEY
    description: "SerpAPI key for web search"
    required: false
    default: ""
distribution_owned:                # paths owned/managed by the distribution (overwritten on update unless preserved)
  - SOUL.md
  - skills/research/
  - cron/digest.json
```

`env_requires[]` fields: `name`, `description`, `required` (bool), `default` (string).

---

## What bundles (repo layout)

```
research-bot/
├── distribution.yaml   # REQUIRED manifest
├── SOUL.md             # strongly recommended — agent personality
├── config.yaml         # model, provider, tool defaults
├── mcp.json            # MCP server connections
├── skills/             # bundled skills
├── cron/               # scheduled tasks
└── README.md           # optional human docs
```

### Hard-excluded paths (NEVER shipped, regardless of author intent)
`auth.json`, `.env`, `memories/`, `sessions/`, `state.db*`, `logs/`, `workspace/`, `plans/`, `home/`, `*_cache/`, `local/`

These are secrets/state/runtime — excluded so distributions stay portable and safe.

---

## CLI — authoring & publishing

```bash
# Create + test locally
hermes profile create research-bot
research-bot setup
# edit ~/.hermes/profiles/research-bot/SOUL.md
research-bot chat

# Publish (it is just a git repo + tag)
cd ~/.hermes/profiles/research-bot
git init && git add . && git commit -m "v1.0.0"
git remote add origin git@github.com:you/research-bot.git
git tag v1.0.0
git push -u origin main --tags

# Release a new version
# edit distribution.yaml -> version: 1.1.0
git add distribution.yaml SOUL.md skills/
git commit -m "v1.1.0: tighter research SOUL, add arxiv skill"
git tag v1.1.0
git push --tags
```

---

## CLI — installing & managing

```bash
# Install (accepts shorthand, https, ssh, or local path)
hermes profile install github.com/you/research-bot --alias
hermes profile install https://github.com/you/research-bot.git
hermes profile install git@github.com:you/research-bot.git
hermes profile install ~/my-profile-in-progress/
hermes profile install github.com/you/research-bot --name custom-name --alias
hermes profile install github.com/you/research-bot -y        # non-interactive

# After install: wire env vars
cp ~/.hermes/profiles/research-bot/.env.EXAMPLE \
   ~/.hermes/profiles/research-bot/.env
# edit .env with real keys

# Inspect
hermes profile info research-bot
hermes profile list

# Update (pull new version)
hermes profile update research-bot
hermes profile update research-bot --force-config --yes

# Remove
hermes profile delete research-bot
```

### Install/update flags
| Flag | Effect |
|------|--------|
| `--alias` | Register a shell alias for the profile (e.g. `research-bot chat`) |
| `--name <custom-name>` | Override install dir / profile name from manifest |
| `-y` / `--yes` | Non-interactive; accept prompts |
| `--force-config` | Overwrite `config.yaml` on update (otherwise preserved) |

---

## Gotchas / constraints

- **`.env.EXAMPLE` is auto-generated post-install** from `env_requires`, with required keys present but values commented out. Copy it to `.env` and fill in.
- **`.git/` is stripped after clone** to prevent accidental secret commits into the installed profile.
- **`config.yaml` is `distribution_owned` but preserved by default on update** — local edits survive unless you pass `--force-config`.
- **Reserved profile names are rejected**: `hermes`, `test`, `tmp`, `root`, `sudo`.
- **Git ref pinning (`#v1.2.0`) is planned but NOT in the initial release** — `install` currently tracks the repo's **default branch**, not the tag. Tags are for human versioning/changelog only right now.
- Profiles install under `~/.hermes/profiles/<name>/`.
