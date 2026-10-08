# Submission data inventory — draft, not console answers

This inventory identifies candidate data categories from baseline code and the public PrivacySecurity component. Actual collection, optionality, linkage, retention and sharing must be verified against deployment and processor contracts before console submission. “Shared” has different meanings in Apple and Play declarations; service-provider exceptions must be checked rather than assumed.

| Data / feature | Evidence / purpose | Recipient categories requiring verification | Submission decision still needed |
|---|---|---|---|
| Account identifiers, name, email, organization membership | Session/bootstrap; authentication, tenant access | Identity provider; application/database infrastructure | Linked to user; exact retention and deletion |
| Prompts, responses, stored memories and uploaded documents | Chat and memory features | Application storage; configured language/embedding/model provider through routing gateway | User content and other content categories; compulsory vs optional features; processor treatment |
| Audio and transcripts | Voice conversations / dictation | Configured voice recognition, synthesis and model providers | Audio category; transient vs persisted audio; transcript retention; explicit sharing consent |
| Uploaded images/video/files and generated artifacts | Attachments and visual generation | Storage; configured image/model provider | Photos/video/files categories; permission scope; generated-content reporting |
| Connected-app records and authorization tokens | User-authorized connectors | Identity/connector providers and selected connected service | Emails/contacts/calendar and other categories only as actually connected; scope, revocation, deletion |
| Product interaction and diagnostics | Operational security/usage; optional PostHog described in policy | Cloudflare, app infrastructure; PostHog only when enabled and consented | Identifiers, app interactions, diagnostics; establish native/web consent parity |
| Billing records | Stripe account/subscription references; no full card storage stated | Stripe and platform billing infrastructure | Purchase history; no native purchase feature until billing choice implemented |
| Safety reports | New reporting implementation required | Developer moderation system | Content/reference submitted, retention, user linkage and access |

## Required reconciliation

1. Obtain actual model/voice/embedding/image routes and connector processors for shipped mobile features. Do not equate an available provider option with actual data collection.
2. Inventory native dependencies, bundled SDKs, hosted JS analytics and network calls. A remote WebView still processes web data.
3. Capture first-launch disclosure, AI-sharing consent, microphone rationale and withdrawal/deletion controls from the released app.
4. Verify default-off optional analytics and denied consent with network evidence.
5. Record data residency, processor retention/training terms, source-store erasure, legally required retention and backup expiry. Public copy must match operations.
6. Determine whether any cross-company advertising tracking occurs. Do not claim ATT is mandatory solely because analytics exists; do not claim no tracking without evidence.
7. Complete Apple privacy categories/purposes/linkage/tracking and Google collection/sharing/purposes/security/deletion from the reconciled inventory; owner signs answers.

No contacts, location, health, advertising ID, or broad photo-library permission is justified by the baseline mobile shell. User-entered or connected data may nevertheless contain such information: classify actual processing rather than automatically requesting native permissions.
