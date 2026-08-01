#!/usr/bin/env node
import crypto from 'node:crypto';
import { getPrismaClient } from '../src/db/prisma.js';
import {
  ensureHqRuntime,
  FIRST_LIFE_OBJECTIVE,
  getHqRuntime,
  resetHqForCompanyReplacement,
  scheduleHqWake,
  transitionHqRuntime,
} from '../src/hq-runtime/repository.js';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`hq_canary_argument_invalid:${key}`);
    if (key === '--reset' || key === '--dry-run') values[key.slice(2)] = true;
    else values[key.slice(2)] = argv[++index];
  }
  return values;
}

function required(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`hq_canary_${name}_required`);
  return normalized;
}

const args = parseArgs(process.argv.slice(2));
const userId = required(args['user-id'], 'user_id');
const orgId = required(args['org-id'], 'org_id');
const instructionBody = required(args.instruction, 'instruction');
if (args.reset && String(args['confirm-org'] || '') !== orgId) {
  throw new Error('hq_canary_reset_confirmation_mismatch');
}

const prisma = getPrismaClient();
if (!prisma) throw new Error('hq_canary_database_unavailable');

try {
  const membership = await prisma.userOrganization.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { isActive: true, role: true },
  });
  if (!membership?.isActive) throw new Error('hq_canary_active_membership_required');

  if (args['dry-run']) {
    console.log(JSON.stringify({ ok: true, dry_run: true, user_id: userId, org_id: orgId, reset: Boolean(args.reset) }, null, 2));
    process.exitCode = 0;
  } else {
    const before = await getHqRuntime({ prisma, orgId });
    const reset = args.reset && before ? await resetHqForCompanyReplacement({ prisma, orgId }) : null;
    let runtime = await ensureHqRuntime({
      prisma, orgId, userId, objective: FIRST_LIFE_OBJECTIVE,
      authorityPolicy: {
        internal_autonomy: true,
        external_writes: args['external-writes'] === 'auto' ? 'auto' : 'approval_required',
      },
    });
    if (runtime.state === 'INACTIVE') {
      runtime = await transitionHqRuntime({
        prisma, runtimeId: runtime.id, orgId, runtimeEpoch: runtime.epoch,
        from: 'INACTIVE', to: 'OBSERVING', data: { activatedAt: new Date() },
      });
    }
    const instruction = await prisma.hqInstruction.create({
      data: {
        runtimeId: runtime.id, orgId, userId, body: instructionBody,
        interpreted: { source: 'operator_canary', execution_mode: 'single_outcome' },
      },
    });
    const dueAt = new Date();
    const schedule = await scheduleHqWake({
      prisma, runtimeId: runtime.id, orgId, runtimeEpoch: runtime.epoch,
      idempotencyKey: `operator-canary:${instruction.id}:${crypto.randomUUID()}`,
      triggerType: 'user_first_activation', dueAt,
      payload: { instruction_id: instruction.id, source: 'operator_canary', fresh_start: Boolean(args.reset) },
    });
    console.log(JSON.stringify({
      ok: true,
      user_id: userId,
      org_id: orgId,
      membership_role: membership.role,
      reset_verification: reset?.resetVerification || null,
      runtime_id: runtime.id,
      runtime_epoch: runtime.epoch,
      instruction_id: instruction.id,
      schedule_id: schedule.id,
      execution_mode: 'single_outcome',
      external_writes: runtime.authorityPolicy?.external_writes || 'approval_required',
    }, null, 2));
  }
} finally {
  await prisma.$disconnect?.();
}
