# Mobile store readiness — 8 October 2026

Evidence baseline: parent `a227a782f56de382e3f47121f4800df571ddc129`, frontend `18f19e69b58da58d479d8f3e78339bcbde5da182`. This is an audit of source and current public policy, **not store approval or a completed device certification**. Later implementation should attach actual artifact/device results to each gate. The baseline mobile shell loads the hosted app; all reachable web routes, third-party SDKs, native permissions and generated content remain within review scope.

Implementation update, 8 October 2026: native PKCE login, dedicated CP sessions, durable AI consent/report receipts, passkey-protected operator triage, no broad API key in native bootstrap and signed Runner consent revalidation now exist in source. See [SAFETY_OPERATIONS.md](SAFETY_OPERATIONS.md) for actual cookie/JWT and isolated Redis proof. The newer packaged local-shell bridge, signing, device behavior and deployed integration require their own evidence; the baseline findings below describe what prompted those changes and are not a claim that the source additions passed store review.

## Current release evidence

The table below retains its original baseline findings. For current status, see [PROGRESS.md](PROGRESS.md): Cloudflare frontend `12f169fe` and Control Plane `5b7f0780` are deployed. Android debug APK contains the real packaged frontend and its exact SHA; Android compilation and policy tests passed. iOS project and OS transport exist in source but have not been compiled on macOS. The checked runner image `8b119aea` awaits an idle cutover; native AI admission remains disabled until paired Runner verification.

Browser fixtures and signed-out public page checks are useful implementation evidence. They do not establish authenticated physical-device functionality, source-store account erasure, provider/privacy review or store eligibility. The SDK requirement references below must be rechecked against the submission date; neither an API level nor a clean build guarantees approval.

## Release gates

| Gate | Baseline evidence | Required completion evidence / owner |
|---|---|---|
| Android SDK | `mobile-app/android/variables.gradle`: target and compile API36; minimum24 | Native owner: signed AAB manifest confirms API36; installed Android16 behavior. Current Play requirement is API36 for new submissions since Aug31 2026 [G1]. |
| iOS build | Baseline has no `mobile-app/ios`, no `@capacitor/ios` dependency | Native owner: generated iOS project and archive built with iOS26 SDK or later [A2], signed by enrolled developer on supported Mac/CI. |
| Native identity / release | Package `com.singulancelabs.mobile`, versionCode1, no release signing configuration | Owner controls developer registrations, App Store app record, Play app record, upload key custody and version allocation. Never put signing secrets in Git. |
| Minimum functionality | Remote `https://next.singulancelabs.com/hivemind/m/chat`, local fallback only | Native + FE: demonstrate useful working chat, memory, team, artifact, connection and voice capabilities; offline/retry, keyboard, back and permissions. Review evaluates actual experience, not Capacitor usage alone [A1 §4.2]. |
| OAuth / login | FE shared API documents ZITADEL OIDC; Android custom `singulance:` callback | Native + identity owner: external system-browser provider flow with bound callback state, return-to app, session persistence and logout. Confirm actual primary-account identity methods and Apple equivalent-login obligation or documented exception [A1 §4.8]; generic email login alone is not proof of equivalence. |
| Account deletion | MobileProfile calls `apiClient.deleteAccount('DELETE')`; Core `/v1/account` authenticates session, checks source-erasure reconciliation | Identity owner: dummy-account removal across durable stores, tokens and backups/retention handling, and explain retained data. FE: accessible public deletion-request URL for Play, plus in-app initiation. Never validate by deleting a real user [A3, G2]. |
| Billing | MobileBilling offers Stripe subscription management and plan changes | FE + product owner: select lawful distribution model. Proposed initial shell is consumption-only: no purchase, upgrade, price CTA or external payment steering reachable in native app. If selling digital access inside app, implement store billing unless a documented market/program exception applies [A1 §3.1; G3]. Do not presume “enterprise” exempts all customers. |
| Third-party AI permission | PrivacySecurity describes model/connector providers but no explicit mobile AI-sharing consent located | FE + Core: disclose actual recipients/purposes before sharing personal data, record explicit permission, prevent requests before consent and honor withdrawal. Resolve configured provider list; browser notice alone does not prove server enforcement [A1 §5.1.2]. |
| AI reporting and safeguards | AI text/image/voice is central; no dedicated offensive-content report flow located in baseline mobile sources | FE + Core: report inside app, authenticated durable receipt, developer review/moderation owner and prevention controls. General thumbs-down alone is not proof of an actionable safety report [G4]. |
| Privacy disclosures | Public PrivacySecurity includes Cloudflare, EU infrastructure, Stripe, optional PostHog, identity/model providers | Owner: reconcile DATA_INVENTORY.md to production processing and third-party contracts, then submit Apple privacy answers and Play Data safety. No “no collection” declaration based only on absent native trackers [A4, G5]. |
| SDK manifests | Capacitor8 Android dependencies; baseline has no iOS SDK inventory | Native owner: inspect archive privacy report, included SDK signatures/manifests and actual required-reason APIs. Capacitor is on Apple's named SDK list [A5]; app manifest must reflect actual access, not invented declarations. |
| Permissions | Android baseline requests INTERNET only, yet voice is a product feature | Native owner: microphone permission rationale, deny/revoke handling and no background capture. Add camera/photos/notifications only for implemented flows, avoid broad storage permissions. |
| Generated apps / artifacts | CRM and HTML artifact rendering may execute web content | Core + native: restrict bridge exposure to trusted hosted app, isolate untrusted artifact origins and examine Apple §4.7 applicability to distributable mini-app functionality. A document preview is not automatically a mini-app marketplace. |
| Device experience | No new physical-device evidence in this audit | FE/native: small phone, large phone, tablet, portrait/landscape, dynamic text, screen reader, reduced motion, keyboard, safe areas, touch targets, uploads/downloads, long-history paging, voice + Stop, network interruption and reconnect. |
| Reviewer access | Authenticated workspace needed; no review account supplied | Owner: isolated persistent review workspace with non-sensitive seeded data and instructions; no personal mailbox or production tenant access. Review backend must stay reachable. |
| Console declarations | No account-console evidence | Owner: truthful age/content ratings, rights, support URL/email, countries, export compliance, Data safety, app access and content declarations. EU distribution may require trader details and verification. |
| Release testing | No TestFlight/Play internal-track evidence | Owner/native: distribute actual signed builds, collect crash/permission/device results. Play 12 opted-in testers for14 continuous days applies to personal developer accounts created after13 Nov2023, not every organization account [G6]. |

## Work that cannot be completed solely in this Linux checkout

Developer enrollment/account agreements, legal identity and trader verification; Apple signing/team access and Mac/Xcode archive; Play upload-key choice and custody; real device/tester participation; real reviewer credentials; verified privacy/retention/vendor declarations; store listing screenshots from shipped binaries; upload, review and approval by Apple/Google. These are explicit external gates, not reasons to stop implementing source fixes.

## Sources checked 8 October 2026

- [A1 — Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [A2 — Apple SDK minimum requirements](https://developer.apple.com/news/?id=ueeok6yw)
- [A3 — Apple in-app account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
- [A4 — Apple privacy details](https://developer.apple.com/app-store/app-privacy-details/)
- [A5 — Apple third-party SDK requirements](https://developer.apple.com/support/third-party-SDK-requirements/)
- [G1 — Google Play target API](https://support.google.com/googleplay/android-developer/answer/11926878)
- [G2 — Google Play account deletion](https://support.google.com/googleplay/android-developer/answer/13327111)
- [G3 — Google Play payments](https://support.google.com/googleplay/android-developer/answer/10281818)
- [G4 — Google Play AI-generated content](https://support.google.com/googleplay/android-developer/answer/13985936)
- [G5 — Google Play Data safety](https://support.google.com/googleplay/android-developer/answer/10787469)
- [G6 — Google Play personal-account testing](https://support.google.com/googleplay/android-developer/answer/14151465)

Recheck these at submission: regional payment programs, SDK dates and console questions change. Conditional requirements must be determined from the actual distribution/account/features, not treated as globally mandatory.
