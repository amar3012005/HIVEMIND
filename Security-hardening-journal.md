# Security Hardening Journal

## Phase 1 - Edge and Network Exposure (2026-07-10)

### Context
- Production is a single Hetzner host behind Caddy, with public B2C and B2B traffic.
- Prior work hardened runtime dependencies, removed disabled TLS verification, and added rollback images/snapshots.

### Findings
- `hm-core` (2026), `hm-control` (2027), and Nango (3003) were Docker-published on all interfaces despite Caddy being their intended public gateway.
- UFW is inactive. Docker-published ports can bypass host firewall rules, so binding internal services to loopback is the first reliable control.
- The BYOD broker port 8790 is publicly bound. It is intentionally not changed in this phase until its remote-agent ingress contract is verified.

### Change
- Bound Core, Control Plane, and Nango host ports to `127.0.0.1` in production Compose.
- Caddy continues to proxy the existing public domains to these loopback ports.

### Validation Required After Deploy
- `core.singulancelabs.com`, `api.singulancelabs.com`, and `nango.singulancelabs.com` remain reachable through Caddy.
- Ports 2026, 2027, and 3003 are no longer listening on `0.0.0.0` or `[::]`.

### Follow-up
- Nango listens on container port 8080. Corrected the host mapping from 3003:3003 to 127.0.0.1:3003:8080 after the hardened recreation exposed the mismatch.
- Nango migrations required `public.uuid_generate_v4()` while `uuid-ossp` is installed in the shared `hivemind` schema. Added a compatibility wrapper that delegates to `hivemind.uuid_generate_v4()`; the extension itself was not moved.

### Next Phase
- Map BYOD broker authentication/TLS and expose it only through a named Caddy route.
- Enable a restrictive host firewall after confirming SSH access and the complete public ingress inventory.

## Phase 2 - BYOD Broker Boundary (2026-07-10)

### Change
- Restricted broker enrollment keys to organizations with `hosting_mode = self_host`.
- Rejected public cleartext agent and instance URLs; HTTPS is required unless the address is loopback, private LAN, or Tailscale.
- Bound the broker host port to loopback. Public enrollment must be routed through Caddy over HTTPS.

### Deployment Validation
- Caddy now routes `https://api.singulancelabs.com/v1/byod/*` to the loopback broker.
- The enrollment endpoint returns `401` without an API key; direct host port 8790 is no longer public.
- Caddy required a container restart after the host Caddyfile was atomically replaced, because the bind mount retained the prior inode.

## Phase 3 - Broker Least Privilege (2026-07-10)

### Change
- Broker database configuration is separated from the application database credential via `BROKER_DATABASE_URL`.
- Role scope: connect to the shared database, use `hivemind` schema, and read only the API-key hash/revocation/org fields needed for self-host enrollment.

### Validation
- Broker runs as `hivemind_broker`; unauthenticated HTTPS enrollment returns `401`.
- A query for the `memories` table from inside the broker container is denied.

## Phase 4 - Standalone Edge Service Exposure (2026-07-10)

### Finding
- Four legacy standalone containers are still published directly on all interfaces: frontend `8088`, TARA AAAS `8090`, TARA Deepgram `8091`, and waitlist relay `8095`.
- Caddy is host-networked and is the intended public ingress for each service.

### Attempt and Rollback
- Rebinding the four Docker ports to `127.0.0.1` was attempted with preserved rollback containers.
- The frontend became unavailable through Caddy (`502`). The replacement frontend mapping also targeted container port `8088`, while its embedded Caddy listens on `80`; host-networked Caddy traffic to Docker's loopback-published proxy reset rather than reaching the service.
- All four containers were restored from their preserved rollback copies. Public verification after rollback: main frontend `200`, core health `200`, and unauthenticated BYOD enrollment `401`.

### Required Design Before Retrying
- Do not repeat the direct loopback port remap on this host topology.
- Migrate the Caddy ingress and these services to a shared Docker network, then proxy by service name, or move each standalone service to host networking with an explicit loopback listener.
- Keep the existing direct port exposure until that migration is tested atomically with a rollback plan. Do not rely on UFW alone because Docker-published ports bypass ordinary host firewall policy.

## Phase 5 - Docker Published-Port Firewall (2026-07-10)

### Change
- Added `infra/docker-edge-firewall.sh` and the `hivemind-docker-edge-firewall.service` systemd unit.
- Docker's legacy userland proxy owns these published host sockets, so `DOCKER-USER` forwarding rules do not govern their inbound traffic. The initial forwarding rules were removed.
- The unit now installs idempotent `INPUT` rules for both IPv4 and IPv6: allow loopback traffic, then drop all other TCP traffic to legacy direct-published ports `8088`, `8090`, `8091`, and `8095`.
- The unit is enabled on production and ordered after Docker, so Docker restarts cannot silently remove the protection.

### Validation
- Verified the loopback allow and remote-drop rules for all four ports across IPv4 and IPv6 on production.
- Caddy-hosted frontend and core health routes remain `200` after the rules are active.

### Rollback
- Disable and remove the unit, then remove the matching loopback-allow and remote-drop `INPUT` rules with `iptables -D` and `ip6tables -D`. Do not remove the rules until an alternative edge ingress path has been verified.

## Phase 6 - SSH and Host Access (2026-07-10)

### Findings
- SSH accepted passwords and enabled X11 forwarding. Authentication logs showed active password spraying against `root` and invalid users.
- The sole current management identity is an ED25519 key for `root`; `PermitRootLogin prohibit-password` already prevented root password login, but the global password surface was still enabled.
- Unattended security upgrades are enabled. A kernel update has left the host in a reboot-required state.

### Change
- Added `infra/sshd_config.d/99-hivemind-hardening.conf`: disables password and keyboard-interactive SSH, disables X11 forwarding, retains root public-key access, reduces authentication/session limits, enables keepalives, and raises SSH audit verbosity.
- Added `infra/fail2ban/jail.d/hivemind-sshd.local`, then installed and enabled Fail2ban with an aggressive systemd-backed SSH jail: four attempts in ten minutes results in a one-hour ban.

### Validation
- `sshd -t` passed before reload; effective SSH policy confirms password authentication and X11 forwarding are disabled.
- A fresh key-only root SSH connection succeeded after the policy reload and again after Fail2ban activation.
- Fail2ban is running and has already banned repeated hostile sources observed in the SSH journal.

### Operational Follow-up
- Schedule a maintenance-window reboot to apply the pending kernel update. Do not reboot this single production host without confirming backups, public health checks, and a rollback/operator-access plan.

## Phase 7 - Secret File Permissions (2026-07-10)

### Findings
- The live production dotenv file was root-only, but several historical `/root/hivemind/.env.bak*` files were mode `0644` and could contain still-valid credentials.
- Docker container inspection shows that several application containers receive a broad shared environment with credentials unrelated to their individual responsibilities. This is a separate least-privilege refactor and was not changed blindly in production.

### Change
- Added `infra/hivemind-secret-permissions.sh` and a systemd path unit. It restricts the known production dotenv and backup locations to `0600` whenever `/root/hivemind` changes.
- Installed and enabled the path guard on production, and corrected every existing root deployment dotenv/backup file plus the next-stack deployment environment.

### Validation
- Verified all tracked deployment dotenv files are mode `0600`.
- Created a deliberately mode-`0644` dotenv-style test file; the path guard changed it to `0600` automatically.

### Next Phase
- Refactor Compose service environments to explicit per-service allowlists, starting with the broker and edge services, then core/control/employees after dependency mapping and staging validation. This will reduce the blast radius of a container compromise.

## Phase 8 - B2C Quota Abuse Protection (2026-07-10)

### Findings
- Free, Pro, and Scale had monthly allocations but no complete daily budget contract. Pro and Scale also allowed unlimited unbilled overage after their allocation.
- Search and graph queries consumed separate counters against the same limit, effectively doubling query allowance.
- The memory cap used monthly ingestion instead of the live memory count. Deep Research success was recorded as Web Intel, and several web/knowledge paths recorded usage before success or recorded it twice.
- Room, connector, and seat capacity checks could ignore effective referral entitlements, fail open on database errors, or race under concurrent requests.
- Billing displayed hardcoded plan data and an annual discount not supplied by the backend.

### Change
- Added explicit daily token, query, upload, KB-page, and research limits for Free, Pro, and Scale. Paid B2C overage is hard-disabled until metered charging exists end-to-end.
- Unified search and graph-query budgets, enforced live memory totals, corrected success-only metering, and made daily-ledger/capacity verification fail closed with retryable `503` responses.
- Added transaction-locked seat, connector, and active HyperAgents-room capacity controls using the effective entitlement plan.
- Billing and Usage now render backend plan truth, daily/monthly counters, KB pages, and 80%/100% reminders. Removed the browser-side direct plan flip and invented annual discount.

### Validation Before Deploy
- Targeted billing suite: 17 tests pass; modified runtime files pass `node --check` and `git diff --check`.
- Frontend optimized production build succeeds.
- Full core suite is not a release gate in its current state: 462 tests pass; failures are dominated by missing test `DATABASE_URL`, Vitest files executed by Node, unavailable local `.amr` native binaries, and pre-existing placeholder/contract failures.
- Production currently has three Free orgs, four Enterprise orgs, 48 daily-usage rows, and one active entitlement. No migration is required.

### Rollback
- Retain the previous Core, Control, and Frontend image tags before recreation. Roll back all three together because the new UI consumes the new usage-summary contract while remaining backward-compatible with the legacy payload.

### Production Deployment
- Merged the hardening branch with the production-only Calendar/TARA history; deployed backend source `731b95cd` and frontend source `18541b4`.
- Live images: `hivemind/core-api:next-731b95cd-quotas`, `hivemind/control-plane:next-731b95cd-quotas`, and `hivemind/fe:next-18541b4-quotas`.
- Rollback images use timestamp `20260710-020312`; the prior frontend container is also retained stopped as `hm-fe-rollback-20260710-020312`.
- Live authenticated usage response returns Free daily limits for tokens, combined queries, uploads, KB pages, Deep Research, and Web Intel plus the reminders array. Unauthenticated usage returns `401`.
- Main frontend, Core health, and Control health return `200`; no recent fatal/uncaught runtime logs were found.
- Previous controls remain active after recreation: Fail2ban, Docker edge firewall, dotenv permission guard, key-only SSH, KB queue mode `all`, and unauthenticated BYOD enrollment `401`.

## Phase 9 - Organization Entitlements and Privileged Agents (2026-07-10)

### Change
- Added provider-neutral, expiring checkout intents. Dummy checkout is restricted to an explicit organization allowlist and confirmation is idempotent under a PostgreSQL advisory transaction lock.
- Referral limits are server-owned campaign data. Unknown or malformed limit overrides are discarded, redemption caps are claimed atomically, and onboarding/runway entitlements are activated only after checkout confirmation.
- Removed the org-creation shortcut that activated and provisioned referral plans before payment. Signup now returns a pending offer preview while the organization remains on its authorized base plan.
- Added daily and monthly TARA talk-time and HyperAgents-run limits, durable daily/monthly/cumulative counters, and frontend usage meters.
- Restricted TARA and HyperAgents to active organization owners/admins, team leads, and project owners. Project owners only see their owned project rooms.

### Validation
- Targeted billing, entitlement, plan-enforcement, and privileged-agent tests: 23 passed.
- Modified backend JavaScript passes syntax checks and `git diff --check`.
- Prisma schema validates with a non-connecting PostgreSQL validation URL.
- Frontend production build succeeds with referral checkout, explicit dummy confirmation, and new agent-usage meters.

### Deployment Gate
- Apply migrations `20260710153000_agent_usage_quotas` and `20260710154000_provider_neutral_checkout` before recreating Core or Control.
- Set `BILLING_DUMMY_ALLOWED_ORGS` only for test organizations. Never use a wildcard or expose dummy confirmation broadly.
- Post-payment provisioning now cuts over only empty managed-enterprise organizations after source PostgreSQL and embedded `.amr` counts are verified. Existing-data organizations remain on central hybrid and log `migration-required`; build and test an explicit data migration before enabling automatic cutover for them.
- Managed provisioning reuses completed registrations and fails closed on partial container state instead of rotating credentials against reused containers. Operators must recover or remove partial org resources before retrying.

## Phase 10 - Isolated Checkout Canary and TARA Boundary (2026-07-10)

### Change
- Exposed dummy-checkout configuration only through fail-closed vNext Compose variables; production mode still requires an explicit organization UUID allowlist.
- Added the missing privileged-agent authorization check to the TARA Cartesia token-mint route, reusing the same owner/admin/team-lead/project-owner policy as HyperAgents.
- Restored the two omitted B2B/B2C canary frontend routes in live Caddy configuration after config validation and a timestamped backup.

### Canary Evidence
- Applied the referral, agent-usage, provider-neutral checkout, and previously omitted memory-storage migrations only to the isolated vNext database.
- Deployed immutable Core, Control, and B2B/B2C frontend canary images. All loopback and public canary health/bootstrap/frontend paths return `200`; production health remained `200`.
- Disposable authenticated E2E proved unauthenticated billing is `401`, ordinary-member checkout is `403`, invalid referral is `400`, owner checkout and confirmation are `200`, repeat confirmation is idempotent, and the organization enters the referral onboarding entitlement only after confirmation.

### Promotion Gate
- Rebuild and redeploy the Control canary with the TARA boundary fix, prove member denial and owner passage at the live route, then remove the disposable fixture and disable dummy checkout again.
- Run the idempotent `infra/apply-vnext-migrations.sh` before every canary application start. Its explicit ledger closes the schema-snapshot gap without pretending the imported schema has Prisma migration history.

### Integration Verification
- Shared OIDC, Google, and Cartesia credentials are now server-only vNext variables; B2B and B2C retain separate callback URLs and isolated session secrets.
- Cartesia live E2E passed on both tiers: owners received a short-lived token and agent ID, while ordinary members received `403`. The disposable users, organization, and Redis sessions were removed afterwards.
- ZITADEL and Google both reject the new callback URLs because they are not yet registered in their provider consoles. Keep production callbacks and add both B2B/B2C callbacks before promotion; never replace the existing production entries.
- Removed callback query strings and raw session IDs from authentication/account-deletion logs to prevent authorization codes and bearer sessions entering centralized logs.
- Login organization resolution now accepts only active memberships, preserves an active organization already bound to the session, and otherwise selects the newest active membership. Existing users therefore return to their assigned personal or enterprise workspace instead of re-entering account-type creation.
