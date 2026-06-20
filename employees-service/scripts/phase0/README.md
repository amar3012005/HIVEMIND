# Phase-0 — model eval (the sprint gate)

Decides the HyperAgents action-path model with two numbers per model:
**battery pass rate** (did the room produce the right grounded artifact / honest
dead-end?) and **tool-call failure count** (the patchwork tax). Output:
`comparison.md`. This eval becomes the CI regression gate for the whole sprint.

## Files
- `battery.json` — 8 room tasks (answer, doc, sheet, email-draft, sheet→email
  chain, honest dead-end, multi-tool gather, decision). Email tasks target the
  safe test recipient and use `write_policy=ask` (drafts, never an outward send).
- `run_battery.py` — runs the battery for ONE model against the sync
  `/internal/hyper/room-turn` endpoint; scores each verdict; writes
  `battery-<model>.json`. Per-turn model via `AGENTIC_MODEL` env (no restart).
- `sweep.sh` — runs the battery across N models, tallies tool-call failures from
  the sidecar log, aggregates → `comparison.md`.

## Prereqs
1. Deploy the `agentic_model` request-field change (api_hyper_rooms.py) so the
   per-turn override works without restarting the sidecar.
2. A real hyper-room with the Google connector enabled (for doc/sheet/email
   tasks) + its participant ids + tenant. Get them on the box:
   ```bash
   # room + participants + tenant (adjust to the seeded test room):
   docker exec hm-control node -e "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.hyperRoom.findMany({take:5}).then(r=>{console.log(JSON.stringify(r.map(x=>({id:x.id,org:x.orgId,name:x.name})),null,2));process.exit()})"
   ```

## Run (on the box)
```bash
cd /opt/HIVEMIND/employees-service/scripts/phase0
ROOM_ID=<room> PARTICIPANT_IDS=<id1,id2,id3> USER_ID=<u> ORG_ID=<o> \
  bash sweep.sh "openai/gpt-oss-120b" "llama-3.3-70b-versatile" "anthropic/claude-haiku-4-5"
cat /tmp/phase0/comparison.md
```

## Decision
- Reliable model clears the battery with ~0 tool-call fails → **Phase 4 GREEN**:
  agents own their actions; delete the JSON-content/tool-less-reactor/placeholder
  patchwork on that model.
- Only gpt-oss affordable + nonzero fails → keep the centralized producer as the
  action path; no Phase 4 on that model.
