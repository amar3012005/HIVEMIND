// feature-loop phase-2 verification: reply detection via GmailAdapter.extractStructured.
// Seeds an outbound_actions row, feeds an inbound thread (no SENT label) and a
// sent-only thread, asserts: replied set once, idempotent, own-copy ignored.
import { PrismaClient } from '@prisma/client';
import { GmailAdapter } from '../src/connectors/providers/gmail/adapter.js';

const ORG = '00000000-0000-0000-0000-000000000001';
const prisma = new PrismaClient();
const adapter = new GmailAdapter();
const ctx = { prisma, user_id: '00000000-0000-0000-0000-0000000000aa', org_id: ORG };

const q = (sql, ...a) => prisma.$queryRawUnsafe(sql, ...a);
const x = (sql, ...a) => prisma.$executeRawUnsafe(sql, ...a);

let fail = 0;
const assert = (cond, name) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`); if (!cond) fail++; };

// clean + seed two outbound sends
await x(`DELETE FROM "hivemind"."outbound_actions" WHERE org_id = $1::uuid`, ORG);
await x(`INSERT INTO "hivemind"."outbound_actions" (org_id, channel, recipient, thread_id) VALUES ($1::uuid,'email','a@x.com','THREAD-A'), ($1::uuid,'email','b@x.com','THREAD-B')`, ORG);

// 1. sent-only thread (our own copy) → no outcome
await adapter.extractStructured({ id: 'THREAD-A', messages: [{ labelIds: ['SENT'], payload: { headers: [] } }] }, ctx);
let r = await q(`SELECT outcome FROM "hivemind"."outbound_actions" WHERE org_id=$1::uuid AND thread_id='THREAD-A'`, ORG);
assert(r[0].outcome === null, 'own SENT copy does not trigger replied');

// 2. inbound message on THREAD-A → replied
await adapter.extractStructured({ id: 'THREAD-A', messages: [{ labelIds: ['SENT'], payload: { headers: [] } }, { labelIds: ['INBOX'], payload: { headers: [] } }] }, ctx);
r = await q(`SELECT outcome, outcome_at FROM "hivemind"."outbound_actions" WHERE org_id=$1::uuid AND thread_id='THREAD-A'`, ORG);
assert(r[0].outcome === 'replied' && r[0].outcome_at, 'inbound message marks replied');
const firstAt = r[0].outcome_at;

// 3. second inbound → idempotent (first reply wins)
await new Promise((s) => setTimeout(s, 1100));
await adapter.extractStructured({ id: 'THREAD-A', messages: [{ labelIds: ['INBOX'], payload: { headers: [] } }] }, ctx);
r = await q(`SELECT outcome_at FROM "hivemind"."outbound_actions" WHERE org_id=$1::uuid AND thread_id='THREAD-A'`, ORG);
assert(new Date(r[0].outcome_at).getTime() === new Date(firstAt).getTime(), 'idempotent — outcome_at unchanged on second reply');

// 4. other-org same thread id → untouched (org scoping)
await x(`INSERT INTO "hivemind"."outbound_actions" (org_id, channel, recipient, thread_id) VALUES ('00000000-0000-0000-0000-000000000099'::uuid,'email','c@x.com','THREAD-B')`);
await adapter.extractStructured({ id: 'THREAD-B', messages: [{ labelIds: ['INBOX'], payload: { headers: [] } }] }, ctx);
r = await q(`SELECT org_id::text AS org, outcome FROM "hivemind"."outbound_actions" WHERE thread_id='THREAD-B' ORDER BY org`);
assert(r.find((w) => w.org === ORG).outcome === 'replied', 'own org THREAD-B marked replied');
assert(r.find((w) => w.org !== ORG).outcome === null, 'other org THREAD-B untouched (org-scoped)');

// cleanup
await x(`DELETE FROM "hivemind"."outbound_actions" WHERE thread_id IN ('THREAD-A','THREAD-B')`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
