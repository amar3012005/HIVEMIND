# Phase 09 - Conversational Runtime

## Outcome

HQ is no longer presented as a vertical stage tracker. The primary surface is a
continuous assistant transcript modeled on the shared Claude-style chat grammar
used by `Overview.jsx`.

## Presentation contract

- Wake, context, observations, decisions, delegations, blockers, and sleep are
  rendered as unboxed conversational prose.
- Consecutive skill, tool, verification, and schedule events are grouped into a
  connected execution trace inside the conversation.
- The newest narrative streams into view with a terminal cursor while SSE
  continues to append durable events.
- Live SSE events enter through a 260 ms display queue and timestamps include
  hundredths of a second. Runtime execution is never delayed for presentation;
  the queue only makes rapid durable transitions legible to a human observer.
- Decisions and delegated outcomes use the serif answer treatment; operational
  narration remains compact sans-serif prose.
- The right rail contains state, current work, and checkpoints only. It does not
  duplicate the conversation.

## Persona

The runtime persona is SINGULANCE HQ: calm, exact, accountable, and mildly
sardonic about waste or unsupported assumptions. It speaks as the persistent
operating mind of the company without claiming sentience or imitating a
fictional villain. Governance language becomes formal around consequential
actions.

The visible stream is not hidden chain-of-thought. It contains only observable
state, high-level judgment, selected action, real tool or skill invocation,
verification, ownership, and scheduled continuation.

## Runtime integrity

Persona language is emitted by the runtime event source, not added only by the
frontend. Tool references, skill references, evidence references, timestamps,
and model usage remain durable machine fields. Input and output token counters
continue to display provider-reported usage independently.

## Production verification

- Control plane: `hivemind/control-plane:prod-20260730-hq-conversation-v4`
- Product frontend: `hivemind/fe:prod-20260730-hq-conversation-v4-r3`
- Stable rollback: control `prod-20260730-hq-conscious-v3-r3`, frontend `prod-20260730-hq-conscious-v3`
- Playwright vision: desktop and mobile production routes verified with authenticated API fixtures.
- Responsive result: the HQ status rail remains available on desktop and collapses below the large breakpoint so the transcript owns the mobile viewport.
- Timing result: event timestamps render hundredths of a second and realtime arrivals are disclosed progressively at 260 ms intervals without delaying runtime execution.
