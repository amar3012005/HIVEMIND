# Brain security boundary fixes — first release batch

Base: origin/singulance-main 16b9a2650. No change to employee, payment, memory-card or frontend candidates.

- Non-self DSR requires active target membership and selects only organization-scoped target memories plus that organization's audit rows. Personal Brain remains owner-only.
- MCP signing/endpoint credentials and connector crypto reject absent, short and known development defaults. Explicit configured compatibility aliases remain for existing ciphertext; dedicated-key rotation requires a separate migration and is not claimed here.
- Missing MCP scopes deny manifests and execution; read-only credentials cannot write operating memory or triggers.
- Evidence reads no longer infer organization access from missing context; explicit projects require caller access.
- Qdrant deletion checks HTTP and operation completion, rejects pending/error responses, and runs before destructive identity/membership stages. This avoids false vector completion and preserves retry coordinates if remote cleanup fails. It does not establish a durable multi-store erasure workflow or close concurrent-ingestion races.

Eight sandboxed focused regressions pass. OS sandbox denies network, fork, writes and home-data reads; Node permission layer permits only this checkout reads. Empty environment, 20-second CPU, 128 descriptor, 1-MiB file-size and 128-MiB V8 heap limits. No real identities/deletion/provider calls were used.

Release preflight must prove configured secret presence and secure length WITHOUT values. Absent secrets deliberately disable affected signing/encryption operations. Existing scopes must be explicit; legacy scope-less connections require reauthorization.

Remaining authorized work: unified complete export/download contract, durable deletion inventory/reconciliation (objects/graph/native records), broader personal Brain isolation fixtures, coordinated release and signed-in denied-access canaries. No production-complete claim yet.

## Follow-on batch

- Account erasure retains all shared database triggers; no table-global disabling.
- Self DSR is personal-only; non-self administrator DSR remains organization-only.
- Real /v1/account/export personal-record download uses repeatable-read snapshot and paginates to completion or explicitly fails at the 20-MiB response bound. It lists included categories/exclusions and never claims full portability. Organization/project/team documents are excluded even when the requester uploaded them; section reads intersect the personal document IDs. Native events intersect personal sessions. Credentials are omitted.
- Trusted browser Origin required on new self-export and DSR-erasure cookie mutations.
- Disconnected legacy export-storage and erasure-scheduler stubs fail explicitly rather than produce fabricated success receipts.
- Profile UI paired branch offers actual download and explains excluded original binaries.

Twelve sandbox regressions and changed-JS syntax parsing pass. Production/deployed model/schema acceptance, original-object and derived-store reconciliation, complete portability inventory and paired frontend release remain to verify.
