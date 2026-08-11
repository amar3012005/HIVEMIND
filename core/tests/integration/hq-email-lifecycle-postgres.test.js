import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

import {
  EMAIL_LIFECYCLE_STATUS,
  compileEmailLifecycle,
} from '../../src/hq-runtime/langgraph/email-lifecycle.js';
import { createPostgresCheckpointer } from '../../src/hq-runtime/langgraph/postgres-checkpointer.js';

const { Pool } = pg;
const databaseUrl = process.env.HQ_LANGGRAPH_TEST_DATABASE_URL || '';

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]+$/.test(value)) throw new Error('unsafe_test_schema');
  return `"${value}"`;
}

class PostgresTestDomainStore {
  constructor(client, schema) {
    this.client = client;
    this.schema = quoteIdentifier(schema);
  }

  async setup() {
    await this.client.query(`
      CREATE TABLE ${this.schema}.prospects (
        id text PRIMARY KEY,
        organization_id text NOT NULL,
        work_order_id text NOT NULL,
        name text NOT NULL,
        contact_name text NOT NULL,
        email text NOT NULL,
        outreach_angle text NOT NULL,
        evidence_refs jsonb NOT NULL
      );
      CREATE TABLE ${this.schema}.drafts (
        id text PRIMARY KEY,
        organization_id text NOT NULL,
        execution_id text NOT NULL,
        prospect_id text NOT NULL,
        recipient text NOT NULL,
        subject text NOT NULL,
        body text NOT NULL,
        evidence_refs jsonb NOT NULL,
        version integer NOT NULL,
        UNIQUE (organization_id, execution_id, prospect_id)
      );
      CREATE TABLE ${this.schema}.receipts (
        id text PRIMARY KEY,
        organization_id text NOT NULL,
        execution_id text NOT NULL,
        prospect_id text NOT NULL,
        touch integer NOT NULL,
        idempotency_key text NOT NULL UNIQUE,
        provider_message_id text NOT NULL,
        provider_thread_id text NOT NULL,
        status text NOT NULL,
        UNIQUE (organization_id, execution_id, prospect_id, touch)
      );
      CREATE TABLE ${this.schema}.calls (
        operation text NOT NULL,
        entity_id text NOT NULL,
        count integer NOT NULL,
        PRIMARY KEY (operation, entity_id)
      );
    `);
  }

  async seedProspects() {
    for (const [index, id] of ['p1', 'p2', 'p3'].entries()) {
      await this.client.query(
        `INSERT INTO ${this.schema}.prospects
          (id, organization_id, work_order_id, name, contact_name, email, outreach_angle, evidence_refs)
         VALUES ($1, 'org-a', 'work-order-1', $2, $3, $4, $5, $6::jsonb)`,
        [
          id,
          `Prospect ${index + 1}`,
          `Contact ${index + 1}`,
          `contact${index + 1}@example.test`,
          `verified angle ${index + 1}`,
          JSON.stringify([`source:${id}`]),
        ],
      );
    }
  }

  async increment(operation, entityId) {
    const result = await this.client.query(
      `INSERT INTO ${this.schema}.calls (operation, entity_id, count)
       VALUES ($1, $2, 1)
       ON CONFLICT (operation, entity_id)
       DO UPDATE SET count = ${this.schema}.calls.count + 1
       RETURNING count`,
      [operation, entityId],
    );
    return result.rows[0].count;
  }

  async callCount(operation, entityId) {
    const result = await this.client.query(
      `SELECT count FROM ${this.schema}.calls WHERE operation = $1 AND entity_id = $2`,
      [operation, entityId],
    );
    return result.rows[0]?.count || 0;
  }

  async listAcceptedProspects({ organizationId, workOrderId }) {
    const result = await this.client.query(
      `SELECT id, organization_id, name, contact_name, email, outreach_angle, evidence_refs
       FROM ${this.schema}.prospects
       WHERE organization_id = $1 AND work_order_id = $2
       ORDER BY id`,
      [organizationId, workOrderId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      contactName: row.contact_name,
      email: row.email,
      outreachAngle: row.outreach_angle,
      evidenceRefs: row.evidence_refs,
    }));
  }

  async getAcceptedProspect({ organizationId, workOrderId, prospectId }) {
    return (await this.listAcceptedProspects({ organizationId, workOrderId }))
      .find((prospect) => prospect.id === prospectId) || null;
  }

  async upsertDraft(value) {
    const id = `draft:${value.organizationId}:${value.executionId}:${value.prospectId}`;
    const result = await this.client.query(
      `INSERT INTO ${this.schema}.drafts
        (id, organization_id, execution_id, prospect_id, recipient, subject, body, evidence_refs, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       ON CONFLICT (organization_id, execution_id, prospect_id)
       DO UPDATE SET recipient = EXCLUDED.recipient, subject = EXCLUDED.subject,
         body = EXCLUDED.body, evidence_refs = EXCLUDED.evidence_refs, version = EXCLUDED.version
       RETURNING *`,
      [id, value.organizationId, value.executionId, value.prospectId, value.recipient,
        value.subject, value.body, JSON.stringify(value.evidenceRefs), value.version],
    );
    return this.toDraft(result.rows[0]);
  }

  toDraft(row) {
    return {
      id: row.id,
      organizationId: row.organization_id,
      executionId: row.execution_id,
      prospectId: row.prospect_id,
      recipient: row.recipient,
      subject: row.subject,
      body: row.body,
      evidenceRefs: row.evidence_refs,
      version: row.version,
    };
  }

  async listDrafts({ organizationId, executionId }) {
    const result = await this.client.query(
      `SELECT * FROM ${this.schema}.drafts
       WHERE organization_id = $1 AND execution_id = $2 ORDER BY prospect_id`,
      [organizationId, executionId],
    );
    return result.rows.map((row) => this.toDraft(row));
  }

  async getDraft({ organizationId, executionId, prospectId }) {
    return (await this.listDrafts({ organizationId, executionId }))
      .find((draft) => draft.prospectId === prospectId) || null;
  }

  async upsertReceipt(value) {
    const id = `receipt:${value.idempotencyKey}`;
    const result = await this.client.query(
      `INSERT INTO ${this.schema}.receipts
        (id, organization_id, execution_id, prospect_id, touch, idempotency_key,
         provider_message_id, provider_thread_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (idempotency_key) DO UPDATE SET status = EXCLUDED.status
       RETURNING *`,
      [id, value.organizationId, value.executionId, value.prospectId, value.touch,
        value.idempotencyKey, value.providerMessageId, value.providerThreadId, value.status],
    );
    return { id: result.rows[0].id, ...value };
  }

  async listReceipts({ organizationId, executionId }) {
    const result = await this.client.query(
      `SELECT id, prospect_id FROM ${this.schema}.receipts
       WHERE organization_id = $1 AND execution_id = $2 ORDER BY prospect_id`,
      [organizationId, executionId],
    );
    return result.rows.map((row) => ({ id: row.id, prospectId: row.prospect_id, touch: 1 }));
  }

  async getFollowUpDraft() { throw new Error('follow_up_not_expected_in_prepare_test'); }
  async upsertFollowUpDraft() { throw new Error('follow_up_not_expected_in_prepare_test'); }
  async getFollowUpReceipt() { throw new Error('follow_up_not_expected_in_prepare_test'); }
  async upsertFollowUpReceipt() { throw new Error('follow_up_not_expected_in_prepare_test'); }
}

function roomExecutor(store) {
  return {
    async draftEmail({ prospect }) {
      const count = await store.increment('draft', prospect.id);
      if (prospect.id === 'p2' && count === 1) throw new Error('injected_persistent_failure:p2');
      return {
        recipient: prospect.email,
        subject: `Specific idea for ${prospect.name}`,
        body: `Hi ${prospect.contactName}, ${prospect.outreachAngle}`,
        evidenceRefs: prospect.evidenceRefs,
      };
    },
    async governDrafts({ prospectIds, drafts }) {
      const present = new Set(drafts.map((draft) => draft.prospectId));
      const repairIds = prospectIds.filter((id) => !present.has(id));
      return { accepted: repairIds.length === 0, repairIds, issues: [] };
    },
    async draftFollowUp() { throw new Error('follow_up_not_expected_in_prepare_test'); },
    async governFollowUp() { throw new Error('follow_up_not_expected_in_prepare_test'); },
  };
}

const provider = {
  async sendEmail() {
    throw new Error('provider_must_not_run_in_prepare_test');
  },
};

test('Postgres checkpoint resumes only the failed branch after graph reconstruction', {
  skip: !databaseUrl,
}, async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const domainSchema = `hq_lg_domain_${suffix}`;
  const checkpointSchema = `hq_lg_checkpoint_${suffix}`;
  const client = new Pool({ connectionString: databaseUrl, max: 8 });
  await client.query(`CREATE SCHEMA ${quoteIdentifier(domainSchema)}`);
  await client.query(`CREATE SCHEMA ${quoteIdentifier(checkpointSchema)}`);
  const store = new PostgresTestDomainStore(client, domainSchema);

  let firstCheckpointRuntime;
  let secondCheckpointRuntime;
  try {
    await store.setup();
    await store.seedProspects();
    firstCheckpointRuntime = await createPostgresCheckpointer({
      connectionString: databaseUrl,
      schema: checkpointSchema,
    });
    const firstSaver = firstCheckpointRuntime.checkpointer;
    const firstGraph = compileEmailLifecycle(
      { domainStore: store, roomExecutor: roomExecutor(store), provider },
      { checkpointer: firstSaver },
    );
    const config = { configurable: { thread_id: `postgres-recovery-${suffix}` } };
    const input = {
      executionId: `execution-${suffix}`,
      organizationId: 'org-a',
      workOrderId: 'work-order-1',
      mode: 'PREPARE',
      externalWrites: 'approval_required',
      status: EMAIL_LIFECYCLE_STATUS.LOADING,
      prospectIds: [],
      draftRefs: {},
      receiptRefs: {},
      followUpDraftRefs: {},
      followUpReceiptRefs: {},
      terminalOutcomes: {},
      processedEventIds: [],
      pendingFollowUp: null,
      events: [],
    };

    await assert.rejects(firstGraph.invoke(input, config), /injected_persistent_failure:p2/);
    const failedSnapshot = await firstGraph.getState(config);
    assert.equal(failedSnapshot.tasks.length, 3);
    assert.ok(failedSnapshot.tasks.some((task) => (
      task.error?.message === 'injected_persistent_failure:p2'
    )));
    const failedTuple = await firstSaver.getTuple(config);
    assert.ok(failedTuple);
    assert.ok((failedTuple.pendingWrites || []).length >= 2,
      'successful parallel branches must be retained as official pending writes');
    const failedHistory = [];
    for await (const checkpoint of firstSaver.list(config, { limit: 100 })) {
      failedHistory.push(checkpoint);
    }
    assert.ok(failedHistory.length >= 3);
    await firstCheckpointRuntime.close();
    firstCheckpointRuntime = null;

    secondCheckpointRuntime = await createPostgresCheckpointer({
      connectionString: databaseUrl,
      schema: checkpointSchema,
    });
    const secondSaver = secondCheckpointRuntime.checkpointer;
    const reconstructedGraph = compileEmailLifecycle(
      { domainStore: store, roomExecutor: roomExecutor(store), provider },
      { checkpointer: secondSaver },
    );
    const result = await reconstructedGraph.invoke(null, config);

    assert.equal(result.status, EMAIL_LIFECYCLE_STATUS.READY_FOR_APPROVAL);
    assert.equal(await store.callCount('draft', 'p1'), 1);
    assert.equal(await store.callCount('draft', 'p2'), 2);
    assert.equal(await store.callCount('draft', 'p3'), 1);
    assert.equal((await store.listDrafts({
      organizationId: 'org-a', executionId: input.executionId,
    })).length, 3);

    await secondSaver.deleteThread(config.configurable.thread_id);
    const retained = [];
    for await (const checkpoint of secondSaver.list(config)) retained.push(checkpoint);
    assert.equal(retained.length, 0);
    assert.equal((await store.listDrafts({
      organizationId: 'org-a', executionId: input.executionId,
    })).length, 3, 'checkpoint retention must not delete business artifacts');
  } finally {
    if (firstCheckpointRuntime) await firstCheckpointRuntime.close();
    if (secondCheckpointRuntime) await secondCheckpointRuntime.close();
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(checkpointSchema)} CASCADE`);
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(domainSchema)} CASCADE`);
    await client.end();
  }
});
