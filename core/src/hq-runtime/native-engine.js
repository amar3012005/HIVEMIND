import { appendHqEvent, scheduleHqWake, transitionHqRuntime } from './repository.js';
import { buildHqContext } from './context.js';
import { HqSkillRegistry, HqToolkitRegistry } from './skill-registry.js';
import { ingestPendingInstructions, reconcileTodoCapabilities } from './instruction-loop.js';

const DAY = 86400000;

async function event(prisma, runtime, cycle, input) {
  return appendHqEvent({ prisma, runtimeId: runtime.id, orgId: runtime.orgId, cycleId: cycle.id, ...input });
}

export function resolveWorkResultTodo({ order, result }) {
  if (!order || !result) return null;
  const resultOutput = result.output && typeof result.output === 'object' ? result.output : {};
  return {
    resultOutput,
    todoId: resultOutput.todo_id || order.inputSnapshot?.todo_id || null,
  };
}

export class NativeHqEngine {
  constructor({ prisma, logger = console }) {
    this.prisma = prisma;
    this.logger = logger;
    this.skills = new HqSkillRegistry();
    this.toolkits = new HqToolkitRegistry();
  }

  async runCycle({ runtime, cycle, trigger }) {
    const prisma = this.prisma;
    let state = runtime.state;
    const move = async (to, data = {}) => {
      runtime = await transitionHqRuntime({ prisma, runtimeId: runtime.id, orgId: runtime.orgId, from: state, to, data });
      state = to;
    };
    if (state === 'WAITING' && trigger.type === 'work_result') {
      await move('REVIEWING', { blockedReason: null });
    } else if (state === 'WAITING' || state === 'BLOCKED') {
      await move('OBSERVING', { blockedReason: null });
    }
    const firstAwakening = trigger.type === 'onboarding_complete' || trigger.type === 'user_first_activation';
    await event(prisma, runtime, cycle, { eventType: 'wake', title: firstAwakening ? 'I am here' : 'I am awake', summary: firstAwakening
      ? 'I was dormant because there was no company to operate. Onboarding has given me a company, a memory, and a responsibility. I am reading what you built, where it operates, who it serves, and what authority I have before I choose my first move.'
      : `I am awake. ${String(trigger.type || 'An event').replaceAll('_', ' ')} moved, so I am reading the company before I touch anything.` });
    let context = await buildHqContext({ prisma, runtime, trigger });
    await event(prisma, runtime, cycle, {
      eventType: 'context_loaded', title: 'I have the company in view',
      summary: `I found ${context.pending_work.length} active work order(s). I have checked the retained company state and the latest growth evidence; memory is useful only when it still describes the company in front of me.`,
      evidenceRefs: [context.evidence.baseline?.id, context.evidence.latest_growth_plan?.id].filter(Boolean),
    });

    const appliedInstructions = await ingestPendingInstructions({ prisma, runtime, company: context.company });
    if (!appliedInstructions.length) await event(prisma, runtime, cycle, {
      eventType: 'instruction_checked', title: 'I checked for new operating instructions',
      summary: 'No unapplied instruction changed the operating queue. I will use the current priorities rather than replaying old work.',
    });
    for (const applied of appliedInstructions) {
      await event(prisma, runtime, cycle, {
        eventType: 'instruction_received', title: 'I have accepted a new operating instruction',
        summary: applied.instruction.body, details: { instruction_id: applied.instruction.id, interpretation: applied.interpreted },
      });
      await event(prisma, runtime, cycle, {
        eventType: 'todo_created', title: `Added to my operating queue: ${applied.todo.title}`,
        summary: applied.todo.objective, details: { todo_id: applied.todo.id, required_capabilities: applied.interpreted.required_capabilities },
        skillRef: applied.interpreted.skill,
      });
    }
    const capabilityState = await reconcileTodoCapabilities({ prisma, runtime });
    for (const resolved of capabilityState.resolved) await event(prisma, runtime, cycle, {
      eventType: 'capability_resolved', title: 'A required capability is available',
      summary: `${resolved.platform_managed?.length ? `${resolved.platform_managed.join(', ')} is provided by Singulance.` : `I verified ${resolved.capabilities.join(', ')} against this organization.`} The blocked todo is ready again, so I am continuing from it instead of rebuilding the plan.`,
      details: resolved,
    });
    for (const request of capabilityState.requests) {
      const alreadyShown = await prisma.hqRuntimeEvent.findFirst({ where: { runtimeId: runtime.id, eventType: 'capability_required', details: { path: ['capability_request_id'], equals: request.id } } }).catch(() => null);
      if (!alreadyShown) await event(prisma, runtime, cycle, {
        eventType: 'capability_required', title: `I need ${request.provider} to continue`, summary: request.reason,
        details: { capability_request_id: request.id, todo_id: request.todoId, provider: request.provider, connect_path: request.connectPath },
      });
    }
    const readyTodo = capabilityState.todos.find((todo) => todo.status === 'READY');
    await event(prisma, runtime, cycle, {
      eventType: 'queue_checked', title: 'I re-ranked the operating queue',
      summary: readyTodo
        ? `The next executable priority is ${readyTodo.title}. Waiting items remain retained but will not stall safe work behind them.`
        : 'There is no executable todo ahead of the active stage. I will wait only for the evidence or capability that can change the next decision.',
      details: { next_todo_id: readyTodo?.id || null, platform_managed_capabilities: capabilityState.platform_managed || [] },
    });

    const baselineMissing = !context.evidence.baseline;
    const baselineStale = !baselineMissing && (!context.evidence.company_identity.matches || !context.evidence.company_identity.current_onboarding);
    if (baselineMissing || baselineStale) {
      const baselineSkill = this.skills.load('baseline-establishment');
      const [baselineToolkit] = this.toolkits.select(['growth_baseline']);
      await event(prisma, runtime, cycle, {
        eventType: 'skill_loaded', title: 'I need an exact starting position',
        summary: baselineSkill.description, skillRef: baselineSkill.id,
        details: { model_policy: baselineSkill.model_policy || { mode: 'deterministic_tools', model: null } },
      });
      await event(prisma, runtime, cycle, {
        eventType: 'tool_started', title: 'I am establishing the company baseline',
        summary: baselineStale ? 'The company changed, so I am replacing stale evidence with a full source transfer.' : 'No baseline exists, so I am collecting the first full source transfer.',
        toolRef: 'growth_baseline_collect', details: { toolkit: baselineToolkit.id, depth: 'full_transfer', model: null },
      });
      try {
        const baseline = await this.toolkits.invoke('growth_baseline', 'collect', {
          mode: 'full_all', scheduleRuntimeWake: false,
        }, { prisma, orgId: runtime.orgId, userId: runtime.ownerUserId });
        await event(prisma, runtime, cycle, {
          eventType: 'tool_result', title: 'I have established the current position',
          summary: `The baseline is real now: ${Number(baseline.website?.mapped_pages || 0)} website page(s), ${Number(baseline.social_presence?.accounts?.length || 0)} connected account(s), and every provider limitation retained instead of politely ignored.`,
          toolRef: 'growth_baseline_collect', evidenceRefs: [baseline.resource_id],
          details: { toolkit: baselineToolkit.id, resource_id: baseline.resource_id, model: null, usage: { prompt_tokens: 0, completion_tokens: 0 } },
        });
        context = await buildHqContext({ prisma, runtime, trigger });
      } catch (error) {
        await move('BLOCKED', { blockedReason: error.message });
        await event(prisma, runtime, cycle, { eventType: 'blocked', title: 'I cannot establish a trustworthy baseline', summary: `The evidence door is closed: ${error.message}. I will not invent a company position to keep the interface moving.`, skillRef: baselineSkill.id, toolRef: 'growth_baseline_collect' });
        return { transition: 'ESCALATE', reason: 'baseline_collection_failed' };
      }
    }

    if (!context.evidence.baseline || !context.evidence.company_identity.matches || !context.evidence.company_identity.current_onboarding) {
      await move('BLOCKED', { blockedReason: 'Fresh baseline did not reconcile with the current company identity.' });
      await event(prisma, runtime, cycle, { eventType: 'blocked', title: 'I stopped before acting on mixed company evidence', summary: 'The evidence still describes more than one company. Motion would look productive and be wrong. I will not delegate from an uncertain identity.' });
      return { transition: 'ESCALATE', reason: 'baseline_company_mismatch' };
    }

    if (trigger.type === 'work_result') {
      const workOrderId = String(trigger.payload?.work_order_id || '');
      const order = workOrderId ? await prisma.hyperWorkOrder.findFirst({
        where: { id: workOrderId, orgId: runtime.orgId, hqCycleId: { not: null } },
      }) : null;
      const result = order ? await prisma.hyperWorkResult.findFirst({
        where: { workOrderId: order.id }, orderBy: { attempt: 'desc' },
      }) : null;
      const reviewSkill = this.skills.load('stage-review');
      await event(prisma, runtime, cycle, {
        eventType: 'skill_loaded', title: 'Specialist result review selected',
        summary: reviewSkill.description, skillRef: reviewSkill.id, workOrderId: order?.id || null,
      });
      const workResult = resolveWorkResultTodo({ order, result });
      if (!workResult) {
        await move('BLOCKED', { blockedReason: 'A Work Result event arrived without a durable result packet.' });
        await event(prisma, runtime, cycle, {
          eventType: 'blocked', title: 'Specialist result could not be reconciled',
          summary: 'HQ retained the event and stopped rather than inventing or replaying specialist work.',
          workOrderId: order?.id || null,
        });
        return { transition: 'ESCALATE', reason: 'work_result_missing' };
      }
      const { todoId, resultOutput } = workResult;
      if (todoId) await prisma.hqTodo.updateMany({ where: { id: todoId, runtimeId: runtime.id }, data: { status: 'COMPLETED', result: resultOutput, completedAt: new Date(), blockedReason: null } });
      const accepted = result.status === 'completed'
        && String(result.summary || '').trim().length > 0
        && resultOutput.code !== 'company_identity_mismatch';
      await event(prisma, runtime, cycle, {
        eventType: 'verification',
        title: accepted ? 'Specialist result accepted' : 'Specialist result requires intervention',
        summary: accepted
          ? 'The bounded result is durable, attributable, evidence-linked, and ready to inform the active Growth Stage.'
          : `The specialist returned ${result.status}; HQ will not treat the Work Order as complete.`,
        details: { status: result.status, attempt: result.attempt, usage: result.usage },
        workOrderId: order.id, evidenceRefs: Array.isArray(result.evidence) ? result.evidence : [],
      });
      if (!accepted) {
        await move('BLOCKED', { blockedReason: `Specialist Work Order ${order.id} returned ${result.status}.` });
        return { transition: 'ESCALATE', reason: `work_result_${result.status}` };
      }
      await event(prisma, runtime, cycle, {
        eventType: 'decision', title: 'Active Growth Stage continues with new evidence',
        summary: 'HQ accepted the specialist contribution and will compare stage outcomes at the next measurement checkpoint.',
        workOrderId: order.id,
      });
    } else if (readyTodo) {
      await move('DIAGNOSING');
      await move('DELEGATING');
      const skillId = String(readyTodo.context?.skill || 'company-state-diagnosis');
      const selectedSkill = this.skills.load(skillId);
      await event(prisma, runtime, cycle, { eventType: 'skill_loaded', title: `I am taking the next item: ${readyTodo.title}`, summary: selectedSkill.description, skillRef: skillId, details: { todo_id: readyTodo.id } });
      const roomTag = readyTodo.kind === 'outreach_growth' ? 'research' : 'general';
      const room = await prisma.hyperRoom.findFirst({ where: { orgId: runtime.orgId, archivedAt: null, roomTag }, orderBy: { updatedAt: 'desc' } });
      if (!room) {
        await prisma.hqTodo.update({ where: { id: readyTodo.id }, data: { status: 'BLOCKED', blockedReason: `No ${roomTag} Company Room is available.` } });
        await event(prisma, runtime, cycle, { eventType: 'blocked', title: 'The right specialist room is unavailable', summary: `I retained the todo, but no ${roomTag} Company Room exists to own it.` });
      } else {
        const ownerId = room.permanentLeadId || room.participantIds?.[0] || null;
        const owner = ownerId ? await prisma.digitalEmployee.findUnique({ where: { id: ownerId } }) : null;
        const order = await prisma.hyperWorkOrder.create({ data: {
          orgId: runtime.orgId, roomId: room.id, hqCycleId: cycle.id, orderKey: `todo-${readyTodo.id}`,
          kind: readyTodo.kind, title: readyTodo.title, objective: readyTodo.objective,
          ownerEmployeeId: owner?.id || null, ownerSlug: owner?.slug || null, ownerLane: owner?.roleArchetype || null,
          selectedSkills: [skillId], requiredEvidence: ['company_memory', 'connected_capabilities'],
          acceptanceCriteria: ['Return a bounded result with evidence, next action, and measurable outcome.'],
          inputSnapshot: { todo_id: readyTodo.id, location: readyTodo.context?.location, instruction_id: readyTodo.instructionId },
          evidenceRefs: [context.evidence.baseline?.id].filter(Boolean),
        } });
        await prisma.hqTodo.update({ where: { id: readyTodo.id }, data: { status: 'RUNNING', startedAt: new Date() } });
        await event(prisma, runtime, cycle, { eventType: 'work_order_created', title: `I delegated: ${readyTodo.title}`, summary: `The ${roomTag} specialist owns this bounded action. I will review its evidence before changing company direction.`, workOrderId: order.id, details: { todo_id: readyTodo.id } });
      }
    } else if (!context.evidence.latest_growth_plan) {
      await move('DIAGNOSING');
      const selectedSkill = this.skills.load('growth-constraint-diagnosis');
      const [growthToolkit] = this.toolkits.select(['growth_plan']);
      const selectedModel = selectedSkill.model_policy?.model || 'gpt-oss-120b';
      await event(prisma, runtime, cycle, { eventType: 'skill_loaded', title: 'I am choosing the highest-leverage constraint', summary: `${selectedSkill.description} I will choose the wound supported by evidence, not the one with the best story.`, skillRef: selectedSkill.id, details: { model_policy: selectedSkill.model_policy, selected_model: selectedModel } });
      await event(prisma, runtime, cycle, { eventType: 'tool_started', title: 'I am building the first Growth Operating Plan', summary: 'I will assess the complete baseline, choose one bounded stage, and give one specialist a measurable Work Order.', toolRef: 'growth_plan_run', details: { toolkit: growthToolkit.id, model: selectedModel, mode: 'initial_full' } });
      const result = await this.toolkits.invoke('growth_plan', 'run', {
        mode: 'initial_full', objective: runtime.objective, hqCycleId: cycle.id,
        model: selectedModel,
      }, { prisma, orgId: runtime.orgId, userId: runtime.ownerUserId });
      await event(prisma, runtime, cycle, {
        eventType: 'tool_result', title: 'I have a governed operating plan',
        summary: 'The plan survived evidence, stage-boundary, measurement, and specialist-ownership checks. It is narrow enough to operate and precise enough to judge.',
        toolRef: 'growth_plan_run', evidenceRefs: [result.artifact_id],
        details: { toolkit: growthToolkit.id, model: result.model, usage: result.usage || {} },
      });
      await move('DELEGATING', { activeGoalId: result.committed.goal_id, activeStageId: result.committed.stage_id });
      await event(prisma, runtime, cycle, {
        eventType: 'decision', title: 'I selected the first bounded Growth Stage',
        summary: result.plan?.stage?.objective || result.plan?.executive_thesis || 'The initial Growth Stage is ready.',
        details: { constraint: result.plan?.constraint, stage: result.plan?.stage }, evidenceRefs: [result.artifact_id],
      });
      await event(prisma, runtime, cycle, {
        eventType: 'work_order_created', title: `I delegated this to ${result.plan?.delegation?.room_tag || 'a specialist Room'}`,
        summary: result.plan?.delegation?.objective || 'A bounded specialist Work Order was created.',
        workOrderId: result.committed.work_order_id, evidenceRefs: [result.artifact_id],
      });
    } else {
      await move('DIAGNOSING');
      const action = context.growth.next_action;
      await event(prisma, runtime, cycle, {
        eventType: 'decision', title: `Next operating action: ${action.action}`,
        summary: action.reason, details: { priority: action.priority },
        evidenceRefs: [context.evidence.baseline.id, context.evidence.latest_growth_plan.id],
      });
      if (trigger.type === 'user_wake' && action.action === 'monitor' && !appliedInstructions.length) {
        await event(prisma, runtime, cycle, { eventType: 'observation', title: 'No material change detected', summary: 'The company state, operating instruction, work ownership, and measurement evidence are unchanged. Repeating the same work would create activity, not progress.' });
      }
    }

    if (trigger.type === 'work_result' && capabilityState.todos.some((todo) => todo.status === 'READY')) {
      await scheduleHqWake({
        prisma, runtimeId: runtime.id, orgId: runtime.orgId,
        idempotencyKey: `queue-advance:${cycle.id}`, triggerType: 'queue_advance', dueAt: new Date(),
        payload: { completed_cycle_id: cycle.id },
      });
    }

    const dueAt = context.growth.active_stage?.checkpoint_at
      ? new Date(context.growth.active_stage.checkpoint_at)
      : new Date(Date.now() + DAY);
    await scheduleHqWake({
      prisma, runtimeId: runtime.id, orgId: runtime.orgId,
      idempotencyKey: `checkpoint:${runtime.activeStageId || cycle.id}:${dueAt.toISOString()}`,
      triggerType: 'checkpoint', dueAt, payload: { stage_id: runtime.activeStageId },
    });
    const measurement = context.growth.active_stage?.measurement || {};
    const metrics = [...new Set([...(measurement.primary_metrics || []), ...(measurement.metrics || []), ...Object.keys(measurement.thresholds || {})])].slice(0, 6);
    const waitingDays = Math.max(1, Math.ceil((dueAt.getTime() - Date.now()) / DAY));
    const openCapability = capabilityState.requests[0];
    const sleepReason = openCapability
      ? `I am pausing because ${openCapability.provider} is not connected. That capability is required by the next todo; pretending otherwise would produce an unusable result. Connect it and I will wake immediately, verify the tenant binding, and continue the same todo.`
      : `I am sleeping because assigned work is owned and no material evidence has changed. The next useful decision needs about ${waitingDays} day(s) of observation${metrics.length ? ` across ${metrics.join(', ')}` : ''}. I will wake at ${dueAt.toISOString()} to compare results with the active stage thresholds. I will wake earlier for a campaign result, connector change or failure, specialist result, new instruction, or material performance change.`;
    await event(prisma, runtime, cycle, { eventType: 'schedule_created', title: 'I scheduled the next checkpoint', summary: `The next evidence review is ${dueAt.toISOString()}. Its timing comes from the active Growth Stage, not an arbitrary sleep interval.`, details: { wake_reasons: ['checkpoint', 'work_result', 'instruction_updated', 'connector_changed', 'material_evidence'], metrics } });
    await move('WAITING', { nextWakeAt: dueAt, currentCycleId: null });
    await event(prisma, runtime, cycle, { eventType: 'sleep', title: openCapability ? 'I am waiting for access' : 'I am sleeping', summary: sleepReason, details: { due_at: dueAt.toISOString(), capability_request_id: openCapability?.id || null } });
    return { transition: 'WAIT', nextWakeAt: dueAt };
  }
}
