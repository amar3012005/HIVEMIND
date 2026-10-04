# Company-local advisory method revisions

This is an advisory extension of the operating playbook catalogue, not an executable
RuntimePlaybookDefinition, private memory, or a task-completion gate.

## Contract

- Runner: existing signed principal proxy `/internal/v1/harness-chat/core/advisory-methods`.
  GET returns at most 50 latest **approved** methods for the authorized organization.
  POST prepares `method_id` (company- namespace), `prior_version`, `body`, `rationale`,
  and nonempty `evidence_refs`. Tenant and proposer are derived from authentication.
- Body: title, description, content, domains, intents, parentGlobalIds, limitations.
- Proposal hash binds organization, proposer, exact normalized body, prior version,
  rationale, and evidence. Identical preparations return the same proposal.
- Browser: `/api/advisory-methods/:id` renders the exact body and evidence under
  existing dashboard session plus current organization-administrator checks.
  Approve/Decline submits a same-origin POST with decision and exact content_hash.
  Runner/service/API principals cannot use the browser session approval path.
- Publication uses a transaction, locks proposal and organization/method, verifies
  expected prior approved version, then records the administrator and decision time.
  Body/provenance cannot be overwritten, enforced by the database trigger.
- `hivemind_playbooks propose_revision` returns the owner approval URL. Pending
  publication never delays acceptance of already satisfactory employee work.
- Search/load query approved versions afresh. Static global definitions remain stable;
  unavailable company catalogues are reported, and cannot substitute stale versions.
  Global methods remain usable during a company-provider outage.

## Release scope

Apply additive migration `20261004140000_advisory_playbook_revisions`, rebuild Core/
Control Plane route modules, then rebuild native memory, playbooks, runtime packages.
No tenant method is migrated, approved or changed automatically.

## Disposable PostgreSQL verification

Use a separate PostgreSQL instance, database **advisory_test**, never platform DB.
With Node and the existing `pg` dependency available:

```
ADVISORY_TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55439/advisory_test \
  node --test core/src/runtime-playbooks/advisory-methods.postgres.test.mjs
```

The script refuses other database names and creates its schema/tables only in that
new disposable database. It proves durable preparation, exact-hash authorization,
runner rejection, tenant isolation, immutable old body, concurrent optimistic
publication, latest-version read, and declined-version exclusion. Destroy the test
instance afterward. The in-memory unit tests do not replace this database check.

## Native repeat-task canary after release

1. Complete a harmless internal task using a static method; save its artifact and
   private learning, and let Runtime accept it independently.
2. Prepare `company-disposable-verification` version 1 with an exact harmless body,
   task/evidence references, limitation “test-only”, and rationale. Do not use real
   business doctrine or claim that preparation approved it.
3. Open returned approval_url in the actual logged-in owner browser. Inspect exact
   text and explicitly approve. Verify recorded administrator/hash/version.
4. In an existing employee room, search/load that company method and perform a
   small equivalent task. Confirm its loaded receipt names company-1 and actual
   new output follows the method; do not infer this from a memory save.
5. Prepare a different version 2, approve its exact body, repeat load in a fresh
   turn, and confirm company-2. Read version 1 by proposal ID to prove preservation.
6. Reject a test proposal and verify it is not selected. Recheck global content
   unchanged and that task completion never waited for method publication.

The owner browser/cookie route and the live repeat-task canary remain release-time
verification, not proven by source compilation or synthetic approval fixtures.
