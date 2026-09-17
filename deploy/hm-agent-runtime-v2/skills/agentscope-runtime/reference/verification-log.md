# Verification log — review status of every claim

**Purpose.** You asked for skills that match a "best in class" bar, and for a note
on **what needs review**. This file is that note. Every substantive claim in this
skill set is listed with its verification status and the exact check used, so you
can see what is proven and what is asserted.

**Method.** Claims were checked against the **source** at
`~/agentscope/src/agentscope/` (source is authoritative; the public docs contain
at least one wrong name), by AST-parsing the package rather than importing it —
required because this machine's global Python has a broken numpy.

**Verification command:**

```bash
python .claude/skills/agentscope-runtime/verify_api_surface.py
# last run: PASS — 110 checks, 0 failures (version 2.0.8)
```

**Legend**

- ✅ **Independently verified** — asserted by `verify_api_surface.py` (110 automated checks) or confirmed by direct source read. Re-runnable.
- 👁 **Verified by reading** — confirmed by reading source during authoring, but *not* asserted by the script, so it can drift silently.
- ⚠️ **Needs review** — a judgement call, an inference, or an operational claim that is not provable from source. **These are the items to check.**

---

## 1. API surface (✅ automated)

| Claim | Status |
| --- | --- |
| Pinned version is 2.0.8 | ✅ detected from `_version.py` |
| `create_app` lives in `agentscope.app`, **not** top-level `agentscope` | ✅ asserted (and now guarded by a forbidden-export check) |
| All 10 documented modules export their documented symbols | ✅ 88 export checks |
| All 21 documented `create_app` parameters exist | ✅ asserted |
| `sub_agent_templates` does **not** exist as a `create_app` param | ✅ asserted as forbidden |
| `create_app` accepts `**kwargs` (silent-swallow risk is real) | ✅ asserted |
| All 21 `agentscope.app.deps` functions exist | ✅ asserted |
| `IsolationPolicy` = `per_session`/`per_agent`/`per_user` | ✅ asserted |
| `ResourceKind` = `credential`/`agent`/`knowledge_base`; `ResourcePermission` = `read`/`edit` | ✅ asserted |
| Documented REST route fragments exist in `app/_router` | ✅ asserted |
| Python ≥ 3.11 required | ✅ asserted against interpreter |

## 2. Doc-vs-source drift (✅ automated)

| Claim | Status |
| --- | --- |
| Public docs say `sub_agent_templates`; source is `custom_subagent_templates` | ✅ asserted — the wrong name is checked as *absent*, the right one as *present* |
| The wrong name fails **silently** (no error, no warning) | ✅ verified by reading `create_app`; `**kwargs` presence asserted |

**How this was found:** the verifier failed on its first run — it flagged that
`create_app` is *not* exported by the top-level package, which was an error in my
own draft `CONTRACT.md`. The script was extended to permanently guard it. That
failure is the single best argument for keeping the script in the loop.

### Bugs the script found in itself (both fixed)

Three defects were caught by adversarially testing the verifier, not by reading it.
Recorded because each one would have produced a **false PASS** — the most damaging
outcome for a gate:

| # | Defect | Impact | Fix |
| --- | --- | --- | --- |
| 1 | Progress lines printed to **stdout**, corrupting `--json` output | `--json` was unparseable — automated use would break, and the crash could be mistaken for a test failure rather than a formatting bug | progress routed to `stderr` under `--json` via an `_info()` helper |
| 2 | `--source /nonexistent` **silently fell back** to a default path and reported PASS | **Worst case:** a gate validating a typo'd path would report green against a *different* checkout. Exactly the "green summary over a red reality" failure this script exists to prevent. | an explicitly supplied path is never substituted; if it is not a valid source root, the run **fails with exit 1** |
| 3 | `main()` called `_info()` defined *after* it (order-dependent) | Latent; would break if the module were imported rather than run as `__main__` | helper hoisted above `main()` |

Verified: valid source → PASS/exit 0; bogus `--source` → FAILED/exit 1;
`--json` → stdout is pure JSON.

## 3. Verified by reading (👁 — not asserted, can drift)

| Claim | Where |
| --- | --- |
| `InboxMiddleware` is the sole owner of hint injection | `app/middleware/_inbox_middleware.py` |
| Team coordination rode the bus (inbox + wakeup), workers run concurrently, not nested | agent-team flow described from the service internals |
| Install ≠ equip; the pool belongs to the user | hub design |
| Cloud sandbox managers reattach by metadata on cache miss | workspace-manager design |
| `AsyncSQLAlchemyStorage` is lazily exported via `__getattr__` | `app/storage/__init__.py` |
| Upload bounds: ≤100 files, 50 MB/file, 500 MB total | skill-hub implementation |
| `TeamDelete` deletes `AgentCreate` workers permanently, spares invited agents | agent-team semantics |

> These are accurate as of 2.0.8 but are **behavioural**, so a point release could
> change them without changing any symbol name. Re-read the source if you pin a
> newer version.

## 4. ⚠️ Needs review — operational & inferred

**These are the items you should review. They are not provable from source.**

| # | Claim | Why it needs review |
| --- | --- | --- |
| 1 | **E2B is the right scale-out backend** for SINGULANCE production | A product/vendor decision, not a technical fact. Daytona / OpenSandbox / K8s are equally valid and may fit cost, data-residency, or existing infra better. The skill presents E2B as the example, not the mandate. |
| 2 | **`PER_AGENT` is the right isolation grain** | Depends on the employee model. If employees are per-org rather than per-user, `PER_USER` or a custom manager may be correct. The skill states the default and the consequence, not a recommendation. |
| 3 | **`ttl=3600` is appropriate** | A tuning decision. Wrong values either leak sandboxes (cost) or destroy unpersisted work (data loss). Not derivable from source. |
| 4 | **`AppleContainerWorkspaceManager` suits your macOS development** | The class exists (verified), but is **not probed** — the verifier only warns that the marker is present. Whether Apple Container is installed/working on your box is untested. |
| 5 | **The `user_id` scheme** (`principal.user_id` from hm-core) | The skill mandates *a* canonical id but does not know your existing identity model. Mapping hm-core identity to AgentScope's flat `user_id` is an integration decision that affects every persisted record. |
| 6 | **WorkRun ↔ session mapping is 1:1** | Stated as the shape in the architecture doc. If a WorkRun should be able to fan out to many sessions (or multiple WorkRuns share a session), the mapping needs redesign. |
| 7 | **Team ↔ WorkRun mapping** (leader = primary session, `AgentCreate` worker = sub-task) | Inferred from the team model, not specified by AgentScope. Reasonable but unproven against your delegation semantics. |
| 8 | **`PermissionMode.EXPLORE` as the read-only default for researcher roles** | Verified as an enum value; that it produces the *intended* read-only behaviour for a worker was **not** runtime-tested. |
| 9 | **Artifact pointers in HIVE-MIND vs bytes in the workspace** | A storage-design proposal. The split is sound but the retention/eviction policy (what happens to artifacts when a workspace hits `ttl`) is unresolved. |
| 10 | **Custom hub for internal connectors** | A design proposal. It is well-supported by the hub API, but choosing it over, say, pre-provisioned MCP configs per employee is a product decision. |
| 11 | **`enable_channel_worker` / `enable_scheduler` single-replica rules** | Verified as parameters and documented as single-owner, but your actual production topology (replica count) is unknown — the rule only bites once there is more than one replica. |
| 12 | **`AsyncSQLAlchemyStorage` vs `RedisStorage`** | The Postgres path is unexercised here. The skill notes it needs the `sql` extra plus `asyncpg`, but no migration has been run against your Postgres. |
| 13 | **The two bundled frontend/backend examples are the right starting point** | They are the documented path and the repo has them, but whether `examples/web_ui` is meant to become the SINGULANCE UI or is only a reference is your call. |

## 5. Not verified at all (explicit gaps)

| Gap | Note |
| --- | --- |
| **No runtime install completed** | `uv pip install -e ".[full]"` was **cancelled by you** mid-run. The venv exists (Python 3.12.12) but AgentScope is not installed into it. Every runtime claim in this skill set is therefore source-derived, never import-derived — which is why the verifier is static. |
| **No live service boot** | `python main.py` has not been run. Port `:8000`, the SSE stream, `/chat` 409 behaviour, and team tool round-trips are **documented and source-derived, not observed**. |
| **No frontend run** | `pnpm install` was not attempted; `:5173` unobserved. |
| **Sandbox backends unexercised** | No Docker, Apple Container, E2B, or K8s workspace was provisioned. Manager behaviour (provisioning latency, sweeper, reattach) is from source reading only. |
| **Real provider credentials** | No model credential was configured, so no agent has actually reasoned. The `ModelCard`/provider section rests on docs + source shape. |

**Consequence:** treat this skill set as a **verified API contract plus a build
plan**, not as a tested implementation. The API names are proven; the runtime
behaviour is not. Phase 0 of the build order exists precisely to close that gap —
boot the service and let the verifier and a real chat run convert 👁 and ⚠️ into ✅.

## 6. How to re-verify after a version bump

```bash
python .claude/skills/agentscope-runtime/verify_api_surface.py --source <new-src>
python .claude/skills/agentscope-runtime/verify_api_surface.py --json   # machine-readable
```

If the script fails after a bump, **the skill set is stale, not the source** —
update `CONTRACT.md` and the affected skill, then re-run. The forbidden-name
checks (drift table) and the top-level export guard are the two that most often
catch a real regression.
