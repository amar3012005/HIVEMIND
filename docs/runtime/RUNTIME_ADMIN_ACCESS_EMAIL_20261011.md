# Runtime access and approval emails

## Native producer integration
POST the existing `/internal/v1/harness-chat/core/administrator-message` endpoint with the scoped native Runtime service token, immediately after persisting/flushing the native request.

For Runtime's own connection request, persist the existing `hivemind/connected-receipt` event in the Runtime room:

```js
{version:1, tool:'connection_authorization', workflowSessionId,
 receipt:{status:'connection_required',request_call_id:callId,
 app_label,toolkit,reason,redirect_url,session_id:workflowSessionId}}
```

The same room must contain the originating `tool/call` with `name:'hivemind_connected_task'` and exact `callId`. The Core query scopes room, organization and native storage principal. The latest receipt must remain `connection_required`; a later ready receipt prevents stale notifications. `receipt.session_id` is the Composio workflow ID, not the Runtime room. App label is nonempty, at most120characters; reason is nonempty, at most2000characters and contains no control characters. Normalize multiline query/use_case into ordinary sentence text before saving.

Notification body:

```js
{message_key:`${callId}-user-request`,kind:'approval',request_call_id:callId,
 subject:`Connect ${app_label}`,message:reason}
```

Core derives connection email description from saved evidence. It never emails the receipt's external `redirect_url`. Recipient remains the active authenticated administrator in the organization, with existing email preference honored. Existing native approval/asked, questions and delegated-blocker requests remain supported.

## Link and resume contract
Emails open `/hivemind/app/employee/harness?session=<Runtime room>&request=<callId>`. Approval buttons append `review=approve` or `review=decline` as non-authorizing review hints. Native/outer UI must locate the pending request from the authenticated session and show its existing controls. No bearer token, approval grant, connection mutation, or resume operation is performed by these GET links. User must authenticate and submit the existing approval/connection action. Native lifecycle must verify actual access before resuming the same checkpoint/employee. This Core patch does not implement the native producer, request focus or resume lifecycle; those are coordinated root changes.

## Email threading and delivery
The existing email ledger provides a best-effort persistent thread root per organization, current administrator email hash and current sender hash. Only accepted admin messages are eligible. All new messages use a stable organization Runtime updates subject; detailed request subject remains in the body. No database migration is needed. Rendered transport now accepts the same `thread:{inReplyTo,references}` interface as named system emails, validates bounded RFC Message-IDs and forwards In-Reply-To/References through existing senders.

Opaque Cloudflare receipt IDs cannot honestly become RFC message headers. If the provider returns no usable Message-ID, mail still sends but thread grouping is not guaranteed; no fabricated identifier is used. Concurrent initial emails may also establish separate threads before an accepted root exists. Previous messages without recipient/sender hash cannot establish a safe root. Cloudflare controls Message-ID and rejects overrides; its documented headers allow In-Reply-To/References: https://developers.cloudflare.com/email-service/reference/headers/ .

One attempt, no provider fallback and existing uncertain-outcome no-resend behavior remain. `accepted` requires Cloudflare ok plus a message receipt. `queued` is not recipient-server delivery; require the existing system_email_deliveries ledger to reach `delivered`. Receipt is not user approval or proof of read.

## Checks and coordinated release
51 focused unit checks pass across runtime-administrator-messages, email-service-provider, runtime-support-report and email-core-delivery-boundaries. Changed JavaScript syntax and diff whitespace checks pass. No production email or deployment was executed by this task.

Integrate pushed Core commit with the corresponding native producer/UI checkpoint changes. Root owns immutable managed Core/Control build and deployment, preserving current images/settings/security/memory limits and pending work. No migration. Verify real saved request -> one email with app/reason -> mobile authenticated review -> verified connection/decision -> same employee resumed. Verify replay sends no duplicate, foreign tenant/nonadmin cannot act, opening link does nothing, declined request stays stopped, unknown transport stays unknown and delivered ledger receipt is correlated. Keep prior immutable Core/Control and runner images for rollback.
