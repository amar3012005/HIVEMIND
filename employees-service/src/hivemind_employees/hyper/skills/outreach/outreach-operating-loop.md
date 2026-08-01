---
when: An HQ Outreach assignment can span discovery, qualification, lead persistence, messaging, governed contact, reply handling, or follow-up and must remain resumable.
---
Treat Outreach as an operating lifecycle, not an email template task and not a fixed checklist.

First infer the business checkpoint that is relevant to the active assignment. Possible checkpoints include audience grounding, prospect discovery, qualification, shared lead persistence, account research, outreach preparation, approval, governed delivery, reply observation, response handling, follow-up, and outcome review. Load and execute only the methods and tools needed for the current checkpoint. The objective, accepted upstream artifacts, authority mode, and connected capabilities decide what applies; do not force every checkpoint into every assignment.

Use the Room Director's normal skill and tool selection. Continue through multiple internal checkpoints in one Room run when the next step is safe, supported by evidence, and does not require an external event or new authority. Persist concrete artifacts as they are produced so a later run can resume without rediscovery.

At the end of the run, return a checkpoint handoff with:

- `stage`: the checkpoint actually reached.
- `completed`: checkpoints proven by durable artifacts or provider receipts.
- `next`: the next useful checkpoint, if any.
- `disposition`: `complete`, `continue_room`, `wait_event`, `wait_capability`, or `request_hq`.
- `reason`: why this is the correct transition.
- `requires`: only the specific event, capability, authority, or upstream artifact needed next.

Use `continue_room` only when new durable evidence was produced and the same Room can make further progress immediately. Use a waiting disposition only for a real dependency. Use `request_hq` only for authorization, company-policy decisions, spending, deletion, or an objective-changing conflict. Do not stop merely because one internal method finished, and do not report a plan as execution.
