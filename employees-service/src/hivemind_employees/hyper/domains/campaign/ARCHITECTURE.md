# Campaign Intelligence Architecture

## Product Boundary

One user campaign maps to one durable Campaign record, one Campaign Intelligence Room, and one canonical Campaign Contract. The user may start it from HQ, another Room, chat, or Your Campaigns, but those surfaces delegate to the same toolkit and Room. Branding, Marketing, Research, and other domains are progressively loaded specialist methods, not visible room handoffs and not competing report owners.

This preserves one campaign ID, one evidence board, one approval history, one schedule, and one place for the finished operating plan.

## Pipeline

1. Normalize the goal, objective, channels, horizon, pace, and approval policy.
2. Snapshot tenant-scoped company, audience, connector, and channel-capability evidence.
3. Load the Campaign Operating System plus only the relevant research, media, creative, platform, launch, or measurement skills.
4. Gather evidence and debate materially different strategies in the Campaign Room.
5. Compile and validate one Campaign Contract v4.
6. Generate only the selected visual assets after plan acceptance.
7. Return the plan to Your Campaigns for review.
8. Allow launch only when every requested channel is execution-ready and the existing approval, capability, audit, idempotency, verification, and rollback controls pass.

## Planning Versus Execution

`planning_ready` means the Campaign Room can produce a source-grounded strategy, creative system, media plan, schedule, measurement plan, and explicit prerequisites for a channel.

`execution_ready` means SINGULANCE also has the connected account, permissions, enabled worker, and supported publishing adapter required to perform external writes.

Planning-only channels must be listed in `launch_plan.blocked_by`. They never become executable because an LLM generated content for them. Current live campaign adapters remain X organic, Gmail, and TARA. Every additional provider must add its own account inspection, payload validation, idempotent adapter, reconciliation, metrics, and approval tests before its execution flag can become true.

## Imported Methodology

The Campaign Intelligence methods adapt useful contract, evidence, creative, launch-safety, and measurement patterns from the MIT-licensed reference in `/root/hivemind/resources/claude-ads`. SINGULANCE keeps its own product language, tenant boundary, Campaign Contract, UI, storage, approval system, and provider adapters. The reference project is never exposed as a user-facing product or runtime dependency.
