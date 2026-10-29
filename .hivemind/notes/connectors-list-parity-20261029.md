# Connectors listing applies the one connection rule

Status: implemented on `claude/connectors-list-parity`; not deployed.

## Problem

The account Connectors page reads two Control Plane lists. `GET /v1/connectors/composio/toolkits` (read by `ComposioToolkitBrowser.jsx`) marked a toolkit `connected` when any ACTIVE account existed on any authorized subject. It had no `reconnect` state and no origin, so it disagreed with the Runtime apps listing and with `chooseToolkitSubjects`, which Core and Runtime use to execute. `GET /v1/connectors` (the tiles, and the mobile apps sheet) took the first ACTIVE account in listing order as `account_ref` and showed `needs_reauth` only for curated catalog toolkits.

## Rule (unchanged, shared with Runtime `subjects.ts`)

Accounts live under the personal subject `hivemind:<userId>` and the legacy organization subject `<orgId>`. Per toolkit the ACTIVE account is used: personal first; when both subjects hold an ACTIVE account the most recently updated wins and a tie goes to personal. EXPIRED and FAILED accounts are ignored, and a toolkit with only those is `reconnect`. New connections are created on `hivemind:<userId>` (`composioConnectSubject`, unchanged).

## Change

- `toolkitConnectionRows(orgId, accounts)` derives one row per toolkit (`status` connected or reconnect, `origin` personal or workspace, `accountId`) from `chooseToolkitSubjects`. The organization subject is reported as `workspace`, the Runtime vocabulary.
- `withToolkitConnections(toolkits, rows)` adds `connection_status` (connected, reconnect or available), `connection_origin` and `connected_account_id` to each catalog item. `connected` remains and is true only for a connected row.
- The listing response also carries `connections`, one row per toolkit with an account, independent of the catalog page.
- `overlayToolkitRows` (`connected-app-overlay.js`) merges the same rows into `GET /v1/connectors`: connected rows carry the chosen `account_ref` and `origin`; expired-only toolkits become `needs_reauth` for every provider, not just curated ones.
- Native Slack still overlays a connected row.

## Evidence

`core/tests/unit/composio-connectors-parity.test.js` reads `core/tests/fixtures/connectors-parity.json`, the tenant inventory (personal gmail, linkedin, googlecalendar ACTIVE and github EXPIRED; 21 organization accounts, one gmail ACTIVE, the rest EXPIRED) plus rule cases. The Runtime repository carries a byte-identical copy and asserts the same `expectedRows` and `expectedListing`. The test fails on `origin/singulance-main` (`toolkitConnectionRows is not a function`) and passes with this change.

## Release

Core only, through `deploy_core_services`. The Da-vinci frontend reads the new fields in a separate release and keeps working against the old response because `connected` is preserved.
