# HIVE Harness chat acceptance

Promotion to `singulance-main` is forbidden until every item below is observed,
not inferred.

## Environment

- [ ] `./scripts/harness-chat-env status` shows matching repo SHAs and the
      `hivemind-chat` profile.
- [ ] `./scripts/harness-chat-env doctor` exits 0.
- [ ] No package-level bind mounts on the running runner container.
- [ ] Exactly one Core, Control Plane, PostgreSQL, and Redis generation is running.
- [ ] `docker compose` project is `hivemind-chat-local`; recovery overlays are absent.
- [ ] Uncommitted trees are not mixed across HIVEMIND, Da-vinci, and Harness.

## Admission

- [ ] Authenticated Overview bootstrap issues a ticket.
- [ ] `/api/hivemind/session/establish` returns success, not 401/403.
- [ ] Same-origin `/api/remote.mux` WebSocket connects.
- [ ] Reload restores the same session from PostgreSQL.

## Native composition

- [ ] Native tables, code, reasoning, tool cards, trajectory, and replay match
      `https://deepseek.singulancelabs.com/` capability, with HIVE chrome only.
- [ ] Five-session projection shows newest non-empty root sessions.
- [ ] New Session creates a persisted session.
- [ ] Composer sits at the bottom; Chat/Trajectory do not overlap it.

## Connectors

- [ ] connection-required → OAuth → connected replay.
- [ ] Connected read emits a typed receipt.
- [ ] Editable draft → approval → provider completion.
- [ ] Cancel and expired approval do not send.
- [ ] Provider failure retries without duplicate sends.
- [ ] Reload while waiting for connection or approval resumes the same draft.
- [ ] Cross-tenant connection, draft, and receipt isolation.
- [ ] Runner restart during connection/approval wait resumes from PostgreSQL.

## Security

- [ ] Filesystem/developer operations denied in HIVE mode.
- [ ] Native mode can reuse hidden components without restoring deleted code.
- [ ] No secrets in git, journals, or agent output.
