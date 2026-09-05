# Governed answer evidence release

Production Core revision: `10590eee174b8cd6a15c7e0bd2c20e8d46093967`.
Manifest: `/root/releases/manifests/10590eee/20260905T174615Z/RELEASE_MANIFEST.json`.
Rollback image: `hivemind/core-api:sha-fa287db5`.
Release scope: Core only. The customer frontend is Cloudflare-hosted; no frontend change or deployment was necessary.

## Root causes and changes

- Serial JSON truncation discarded later records, then a second prompt projection truncated that string again. The new projection retains nested objects and arrays and distributes context across records.
- Answer validation collapsed newlines. Markdown now survives unchanged.
- Read success was mistaken for answer completeness. The synthesis decision can return missing outcomes and resume the graph for a detail read, with two bounded recovery attempts and an explicit partial terminal status.
- Model intent could classify an in-chat summary as an external draft. Intent definitions and repair validation distinguish read composition from external mutations.
- Model output is validated before use. Table instructions preserve factual values without abbreviating names, subjects, or addresses.

## Acceptance evidence

23 focused tests pass, including large five-record results, Markdown preservation, a list-to-detail recovery, multilingual reads, connection resume, and approval/provider-event regressions.

Isolated live evaluation used the real model and connected Gmail adapter before production deployment. English and German five-row reads passed. The multi-part table-plus-summary evaluation checked all five subjects, sender addresses, and UTC times against the connector receipts.

After deployment, the service-authenticated real `/api/chat` endpoint passed:

| Mode | Canonical run | Checked | Duration |
| --- | --- | --- | --- |
| JSON | `aeacae33-34bb-45bf-ab62-2d84788d0bac` | Five persisted records, five table rows, subjects, sender addresses, UTC times, zero drafts | 9.4 s |
| SSE | `1d9f23fe-075c-463a-9378-e8383098e318` | Same field checks plus ordered, run-scoped state-transition events and terminal response | 5.9 s |

`core/scripts/governed-receipt-acceptance.mjs` reproduces these checks inside the authorized Core environment using `GOVERNED_ACCEPTANCE_EMAIL`; set `GOVERNED_ACCEPTANCE_STREAM=true` for SSE. It outputs structural assertions and run IDs, never email contents or credentials. It performs reads only and never approves an action.

These checks prove the reported Gmail answer regression and the tested recovery paths. They do not certify every provider capability, an actual browser render, or every possible model response. No external write was approved during live acceptance.
