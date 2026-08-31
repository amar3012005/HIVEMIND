# Unified Email-First Identity v1

## Contract

`email_identity_v1` is multivariate: `off`, `shadow`, `primary`, and
`email_only`. Evaluation failure is `off`. Preview defaults to `email_only`;
production must be deployed `off` and promoted through the governed release.

The public API is additive and stable:

- `GET /auth/email/config`
- `POST /auth/email/start`
- `POST /auth/email/verify`
- `POST /auth/email/resend`

Email verification links carry credentials in the URL fragment. GET never
authenticates; the browser confirms by POST. OTP/link values are hashed,
addresses and outbox payloads are encrypted, and Queue messages contain only an
outbox UUID, environment, and processing version.

## Authority and identity linking

ZITADEL remains identity authority. PostgreSQL owns challenges, identity links,
delivery outbox, and audit events. `UserIdentity` links multiple providers to a
canonical `User`; provider switching never overwrites the compatibility
`User.zitadelUserId`. A verified existing email links to the existing user. A
verified unknown email provisions a human in the environment-specific ZITADEL
organization and then enters personal onboarding. Enterprise membership still
requires a matching invitation.

## Local Cloudflare resources

- Worker/Queue: `singulance-auth-email-local`
- DLQ: `singulance-auth-email-dlq-local`
- Flagship app: `6568ec71-67c6-4b2c-b2f3-98aebe9e81c8`
- Flag: `email_identity_v1=email_only`

The Worker evaluates Flagship and relays opaque outbox identifiers. Turnstile
must be validated server-side. Worker and control-plane secrets are configured
out of band and are never committed.

## Rollback

Set `email_identity_v1=off`. Google/OIDC/SSO paths remain intact. Additive
identity and audit data is retained. Never roll schema back and never deploy
`singulance-local` to production.
