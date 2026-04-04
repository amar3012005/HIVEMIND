import React, { createContext, useContext, useRef, useState, useMemo, useCallback } from 'react';
import { submitWorkflow, resumeWorkflow } from './blaiq-client';

const BlaiqWorkspaceContext = createContext(null);

/* ─── Helpers ───────────────────────────────────────────────────────────────── */

function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function agentLabel(name) {
  const k = String(name || '').toLowerCase();
  if (k.includes('strateg')) return 'Strategic Planner';
  if (k.includes('research')) return 'Research Agent';
  if (k.includes('vangogh')) return 'Visual Designer';
  if (k.includes('govern')) return 'Governance';
  if (k.includes('hitl') || k.includes('clarif')) return 'HITL Agent';
  return name || 'System';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sentenceCase(value) {
  const text = String(value || '').replace(/[_-]+/g, ' ').trim();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatStrategyMessage(plan) {
  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    return 'I have your request. I am mapping the workflow and selecting the right agents now.';
  }

  const mode = sentenceCase(plan.workflow_mode || 'workflow');
  const lead = plan.summary || `I am running a ${String(plan.workflow_mode || 'hybrid')} workflow for this request.`;
  const noteBlock = Array.isArray(plan.notes) && plan.notes.length > 0
    ? `\n\nKey note: ${plan.notes[0]}`
    : '';
  const steps = plan.tasks
    .map((task, index) => {
      const branch = task.branch_key ? ` (${sentenceCase(task.branch_key)})` : '';
      const depends = Array.isArray(task.depends_on) && task.depends_on.length > 0
        ? ` after ${task.depends_on.join(', ')}`
        : '';
      return `${index + 1}. ${sentenceCase(task.agent_type)}: ${task.purpose}${branch}${depends}.`;
    })
    .join('\n');

  const fanIn = plan.fan_in_required
    ? `\nI will merge the parallel branches through ${sentenceCase(plan.fan_in_agent || 'the strategist')} before generating the final artifact.`
    : '';

  return `${lead}\n\nExecution mode: ${mode}. Tasks: ${plan.tasks.length}.${noteBlock}\n${steps}${fanIn}`;
}

function normalizeChecklist(checklist) {
  if (!checklist) return null;
  const items = Array.isArray(checklist.items) ? checklist.items : [];
  return {
    ...checklist,
    items,
    missing_required_ids: Array.isArray(checklist.missing_required_ids) ? checklist.missing_required_ids : [],
  };
}

function formatAgentLiveMessage(event, mapped) {
  const data = event.data || {};
  const agent = mapped.agent || agentLabel(event.agent_name);

  switch (event.type) {
    case 'workflow_submitted':
      return {
        agent: 'BLAIQ-CORE',
        content: 'I have your request. I am preparing the execution strategy now.',
      };
    case 'workflow_resumed':
      return {
        agent: 'BLAIQ-CORE',
        content: 'I am resuming the workflow from the last blocked or failed step.',
      };
    case 'planning_complete':
      return {
        agent: 'BLAIQ-CORE',
        content: formatStrategyMessage(data.plan),
      };
    case 'artifact_family_selected':
      return {
        agent: 'BLAIQ-CORE',
        content: `I classified this request as a ${sentenceCase(data.artifact_family || 'custom')} artifact.`,
      };
    case 'requirements_check_completed':
      return {
        agent: 'BLAIQ-CORE',
        content: 'I have the requirements checklist and I am verifying the remaining gaps.',
      };
    case 'parallel_branch_started':
      if (event.phase === 'research') {
        const branch = sentenceCase(data.branch_kind || data.branch || 'research');
        return {
          agent,
          content: `I’m starting the ${branch.toLowerCase()} research pass now and gathering source-backed evidence.`,
        };
      }
      if (event.phase === 'artifact') {
        const section = data.section_id ? sentenceCase(data.section_id) : 'artifact section';
        return {
          agent,
          content: `I’m rendering the ${section.toLowerCase()} now.`,
        };
      }
      return null;
    case 'parallel_branch_completed':
      if (event.phase === 'research') {
        const evidencePack = data.evidence_pack || {};
        const sourceCount = Array.isArray(evidencePack.sources) ? evidencePack.sources.length : 0;
        const confidence = typeof evidencePack.confidence === 'number' ? ` Confidence: ${evidencePack.confidence.toFixed(2)}.` : '';
        return {
          agent,
          content: `${mapped.detail || 'Evidence gathered.'} I found ${sourceCount} sources.${confidence}`,
        };
      }
      if (event.phase === 'artifact') {
        const section = data.section_id ? sentenceCase(data.section_id) : 'section';
        return {
          agent,
          content: `${section} is rendered and ready for the final composition.`,
        };
      }
      return null;
    case 'fanin_started':
      return {
        agent: 'BLAIQ-CORE',
        content: `I’m merging ${Array.isArray(data.branches) ? data.branches.length : 0} research branches into one working evidence pack.`,
      };
    case 'fanin_completed': {
      const evidencePack = data.evidence_pack || {};
      const citations = Array.isArray(evidencePack.citations) ? evidencePack.citations.length : 0;
      return {
        agent: 'BLAIQ-CORE',
        content: `The evidence is consolidated. I now have a merged brief with ${citations} citation${citations === 1 ? '' : 's'} for downstream generation.`,
      };
    }
    case 'contradictions_detected':
      return {
        agent: 'Research Agent',
        content: `I found ${data.count || 0} contradiction${data.count === 1 ? '' : 's'} between memory and live web evidence that should be reviewed before final delivery.`,
      };
    case 'save_back_available':
      return {
        agent: 'Research Agent',
        content: 'This evidence set is clean enough to be saved back into HIVE-MIND if you want to persist it after delivery.',
      };
    case 'content_director_started':
      return {
        agent: 'Content Director',
        content: 'I’m translating the evidence and requirements into a section-by-section content plan.',
      };
    case 'content_director_completed':
      return {
        agent: 'Content Director',
        content: 'The content brief is ready. I have the section distribution and renderer handoff prepared.',
      };
    case 'artifact_started':
      return {
        agent,
        content: 'I’m turning the approved structure and evidence into the final artifact now.',
      };
    case 'artifact_ready': {
      const manifest = data.artifact_manifest || {};
      const sections = Array.isArray(manifest.sections) ? manifest.sections.length : 0;
      return {
        agent,
        content: `The artifact structure is ready. I’m composing ${sections} section${sections === 1 ? '' : 's'} for the preview.`,
      };
    }
    case 'artifact_section_ready':
      return {
        agent,
        content: `${sentenceCase(data.title || data.section_id || 'Section')} is now available in the live preview.`,
      };
    case 'governance_started':
      return {
        agent,
        content: 'I’m validating the artifact for completeness, evidence coverage, and final readiness.',
      };
    case 'workflow_blocked':
      return {
        agent: 'HITL Agent',
        content: `${data.prompt_headline || 'I need a few clarification answers before I can continue.'}${data.prompt_intro ? `\n\n${data.prompt_intro}` : ''}`,
      };
    case 'resume_accepted':
      return {
        agent: 'BLAIQ-CORE',
        content: 'I received your answers and I am resuming from the blocked checkpoint.',
      };
    case 'governance_complete': {
      const report = data.governance_report || {};
      return {
        agent,
        content: report.approved
          ? `Validation passed. The artifact is approved with a readiness score of ${report.readiness_score}.`
          : `Validation flagged revisions. Current readiness score: ${report.readiness_score}.`,
      };
    }
    case 'workflow_complete':
      if (data.final_answer) {
        return null;
      }
      return {
        agent: 'BLAIQ-CORE',
        content: 'The workflow is complete. The final artifact and supporting evidence are ready.',
      };
    case 'workflow_error':
      return {
        agent: 'BLAIQ-CORE',
        content: data.error_message || 'The workflow hit an error.',
      };
    case 'agent_log':
      // Real-time backend message — use it directly, no canned text
      if (data.visibility === 'debug') return null; // debug-only, skip in user chat
      return {
        agent: agent,
        content: data.message || mapped.detail || '',
        kind: data.message_kind || 'status',
      };
    default:
      if (mapped.detail && event.phase) {
        return { agent, content: mapped.detail };
      }
      return null;
  }
}

function normalizeHitlQuestion(item, index) {
  if (!item) {
    return {
      requirement_id: `q${index + 1}`,
      question: 'Please provide the next detail.',
      why_it_matters: '',
      answer_hint: '',
      answer_options: [],
    };
  }
  if (typeof item === 'string') {
    return {
      requirement_id: `q${index + 1}`,
      question: item,
      why_it_matters: '',
      answer_hint: '',
      answer_options: [],
    };
  }
  return {
    requirement_id: item.requirement_id || `q${index + 1}`,
    question: item.question || 'Please provide the next detail.',
    why_it_matters: item.why_it_matters || '',
    answer_hint: item.answer_hint || '',
    answer_options: Array.isArray(item.answer_options) ? item.answer_options : [],
  };
}

export function normalizePreviewHtml(rawHtml, options = {}) {
  const title = options.title || 'Artifact preview';
  const extraCss = String(options.css || '').trim();
  let html = String(rawHtml || '').trim();

  if (!html) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>html,body{margin:0;min-height:100%;}body{display:grid;place-items:center;background:#faf9f4;color:#0f172a;font-family:Inter,system-ui,sans-serif;padding:32px}.card{max-width:720px;width:100%;border:1px solid rgba(15,23,42,.08);border-radius:24px;background:#fff;box-shadow:0 20px 60px rgba(15,23,42,.08);padding:28px}h1{margin:0 0 10px;font-size:22px;line-height:1.2}p{margin:0;color:#475569;line-height:1.7}</style></head><body><div class="card"><h1>No artifact yet</h1><p>The preview will appear as soon as the workflow returns rendered content.</p></div></body></html>`;
  }

  const hasDocumentShell = /<!doctype html>|<html[\s>]/i.test(html) && /<body[\s>]/i.test(html);
  if (hasDocumentShell) {
    if (extraCss) {
      if (/<\/head>/i.test(html)) {
        return html.replace(/<\/head>/i, `<style>${extraCss}</style></head>`);
      }
      return html.replace(/<body([^>]*)>/i, `<head><style>${extraCss}</style></head><body$1>`);
    }
    return html;
  }

  const containsMarkup = /<([a-z][\w-]*)(?:\s|>)/i.test(html);
  const body = containsMarkup
    ? html
    : `<div class="text-block">${escapeHtml(html)}</div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    :root{color-scheme:light}
    html,body{margin:0;min-height:100%}
    body{background:#faf9f4;color:#111827;font-family:Inter,system-ui,sans-serif;padding:32px}
    .frame{max-width:1100px;margin:0 auto;background:#fff;border:1px solid rgba(17,24,39,.08);border-radius:28px;box-shadow:0 24px 80px rgba(17,24,39,.08);overflow:hidden}
    .header{padding:20px 24px;border-bottom:1px solid rgba(17,24,39,.06);background:linear-gradient(180deg,#fff,rgba(250,249,244,.9))}
    .eyebrow{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#6b7280}
    .title{margin-top:6px;font-size:28px;line-height:1.15;font-weight:700}
    .body{padding:28px 24px 32px}
    .text-block{white-space:pre-wrap;line-height:1.8;font-size:15px;color:#1f2937}
    img,video,svg{max-width:100%}
    section{box-sizing:border-box}
    ${extraCss}
  </style></head><body><div class="frame"><div class="header"><div class="eyebrow">Artifact preview</div><div class="title">${escapeHtml(title)}</div></div><div class="body">${body}</div></div></body></html>`;
}

function buildArtifactPreview(task) {
  if (!task) {
    return { rawHtml: '', html: '', title: 'Artifact preview' };
  }

  const title = task.artifact?.title || task.query || 'Artifact preview';
  const css = task.artifact?.css || '';
  const artifactHtml = String(task.artifact?.html || '').trim();

  if (artifactHtml) {
    return {
      rawHtml: artifactHtml,
      html: normalizePreviewHtml(artifactHtml, { title, css }),
      title,
    };
  }

  const sections = Array.isArray(task.artifactSections) ? task.artifactSections : [];
  const fragments = sections
    .map((section) => section.html_fragment || '')
    .filter(Boolean)
    .join('\n');

  if (!fragments) {
    return { rawHtml: '', html: '', title };
  }

  const rawHtml = `<!doctype html><html><head><meta charset="UTF-8"/><style>body{font-family:system-ui,sans-serif;margin:0;padding:40px;background:#f3efe7;color:#101010}section{margin-bottom:24px;padding:24px;border-radius:16px;background:#fff}${css}</style></head><body>${fragments}</body></html>`;
  return {
    rawHtml,
    html: normalizePreviewHtml(rawHtml, { title }),
    title,
  };
}

/* ─── Step definitions ──────────────────────────────────────────────────────── */
// These mirror the AgentScope workflow phases exactly.

function makeSteps(mode) {
  const steps = [
    { id: 'planning', label: 'Plan workflow strategy', status: 'pending', agent: 'Strategic Planner', detail: '' },
    { id: 'research', label: 'Research and gather evidence', status: 'pending', agent: 'Research Agent', detail: '' },
  ];
  if (mode === 'parallel' || mode === 'hybrid') {
    steps.push({ id: 'fanin', label: 'Merge research branches', status: 'pending', agent: 'Strategic Planner', detail: '' });
  }
  steps.push({ id: 'content_director', label: 'Plan content distribution', status: 'pending', agent: 'Content Director', detail: '' });
  steps.push(
    { id: 'artifact', label: 'Generate visual artifact', status: 'pending', agent: 'Visual Designer', detail: '' },
    { id: 'governance', label: 'Validate and approve', status: 'pending', agent: 'Governance', detail: '' },
    { id: 'complete', label: 'Deliver final result', status: 'pending', agent: 'System', detail: '' },
  );
  return steps;
}

/* ─── Map a StreamEvent.type to a step transition ───────────────────────────── */

function mapEvent(event) {
  const t = event.type;
  const d = event.data || {};
  const agent = agentLabel(event.agent_name);

  switch (t) {
    case 'workflow_submitted':
    case 'workflow_resumed':
      return { stepId: null, detail: 'Workflow started', agent };

    case 'planning_started':
      return { stepId: 'planning', status: 'active', detail: d.message || 'Choosing workflow topology and agents', agent };
    case 'planning_complete':
      return { stepId: 'planning', status: 'done', detail: d.plan?.summary || 'Plan ready', agent };
    case 'artifact_family_selected':
      return { stepId: 'planning', status: 'active', detail: `Artifact family: ${d.artifact_family || 'custom'}`, agent };
    case 'requirements_check_started':
      return { stepId: 'planning', status: 'active', detail: 'Checking required artifact requirements', agent };
    case 'requirements_check_completed':
      return { stepId: 'planning', status: 'done', detail: `Requirements coverage: ${Math.round((d.requirements_checklist?.coverage_score || 0) * 100)}%`, agent };

    case 'agent_started':
    case 'parallel_branch_started':
      if (event.phase === 'research') {
        const branch = d.branch || d.branch_id || '';
        return { stepId: 'research', status: 'active', detail: branch ? `Researching (${branch})` : 'Gathering evidence', agent };
      }
      if (event.phase === 'artifact') {
        return { stepId: 'artifact', status: 'active', detail: d.section_id ? `Rendering section: ${d.section_id}` : 'Generating artifact', agent };
      }
      if (event.phase === 'content_director') {
        return { stepId: 'content_director', status: 'active', detail: 'Planning content distribution', agent };
      }
      return { stepId: null, detail: d.message || t, agent };

    case 'agent_completed':
    case 'parallel_branch_completed':
      if (event.phase === 'research') {
        return { stepId: 'research', status: 'done', detail: 'Evidence gathered', agent };
      }
      if (event.phase === 'artifact') {
        return { stepId: null, detail: 'Section complete', agent };
      }
      if (event.phase === 'content_director') {
        return { stepId: 'content_director', status: 'done', detail: 'Content plan ready', agent };
      }
      return { stepId: null, detail: t, agent };

    case 'fanin_started':
      return { stepId: 'fanin', status: 'active', detail: `Merging ${(d.branches || []).length} research branches`, agent };
    case 'fanin_completed':
      return { stepId: 'fanin', status: 'done', detail: 'Evidence merged', agent };

    case 'content_director_started':
      return { stepId: 'content_director', status: 'active', detail: 'Planning content distribution', agent };
    case 'content_director_completed':
      return { stepId: 'content_director', status: 'done', detail: 'Content plan ready', agent };

    case 'artifact_started':
      return { stepId: 'artifact', status: 'active', detail: 'Composing visual artifact', agent };
    case 'artifact_ready':
      return { stepId: 'artifact', status: 'active', detail: 'Artifact manifest ready, rendering sections', agent };
    case 'artifact_section_ready':
      return { stepId: 'artifact', status: 'active', detail: `Section "${d.title || d.section_id}" rendered`, agent, sectionData: d };

    case 'governance_started':
      return { stepId: 'governance', status: 'active', detail: 'Running validation checks', agent };
    case 'governance_complete':
      const approved = d.governance_report?.approved;
      return {
        stepId: 'governance',
        status: 'done',
        detail: approved ? `Approved (score: ${d.governance_report?.readiness_score})` : 'Revision required',
        agent,
        governanceReport: d.governance_report,
      };

    case 'workflow_complete':
      return { stepId: 'complete', status: 'done', detail: d.final_answer ? 'Answer ready' : 'Workflow finished', agent, finalData: d };
    case 'workflow_error':
      return { stepId: null, status: 'error', detail: d.error_message || 'Workflow failed', agent };
    case 'workflow_blocked':
      return { stepId: 'planning', status: 'active', detail: d.blocked_question || 'Waiting for required details', agent };
    case 'resume_accepted':
      return { stepId: 'planning', status: 'active', detail: 'Resume accepted', agent };

    case 'agent_log': {
      // Real-time log from the backend agent. Map phase → step, update detail with real message.
      const phase = event.phase;
      let sid = null;
      if (phase === 'planning') sid = 'planning';
      else if (phase === 'research') sid = 'research';
      else if (phase === 'content_director') sid = 'content_director';
      else if (phase === 'artifact') sid = 'artifact';
      else if (phase === 'governance') sid = 'governance';
      return { stepId: sid, status: 'active', detail: d.message || '', agent };
    }

    default:
      return { stepId: null, detail: d.message || t.replace(/_/g, ' '), agent };
  }
}

/* ─── Provider ──────────────────────────────────────────────────────────────── */

export function BlaiqWorkspaceProvider({ children }) {
  const [isDayMode, setIsDayMode] = useState(() => {
    try { return window.localStorage.getItem('blaiq.theme') !== 'night'; } catch { return true; }
  });
  function toggleDayMode() {
    setIsDayMode((prev) => {
      const next = !prev;
      try { window.localStorage.setItem('blaiq.theme', next ? 'day' : 'night'); } catch {}
      return next;
    });
  }

  // ─── Task state ──────────────────────────────────────────────
  const [tasks, setTasks] = useState([]);
  const [activeTaskId, setActiveTaskId] = useState(null);
  const [query, setQuery] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const sessionIdRef = useRef('');

  function ensureSession() {
    if (!sessionIdRef.current) sessionIdRef.current = generateId();
    return sessionIdRef.current;
  }

  const activeTask = useMemo(
    () => tasks.find((t) => t.id === activeTaskId) || null,
    [tasks, activeTaskId]
  );
  const preview = useMemo(() => buildArtifactPreview(activeTask), [activeTask]);
  const messages = useMemo(() => activeTask?.messages || [], [activeTask]);
  const activeAgents = useMemo(() => {
    if (!activeTask) return [];
    const names = new Set();
    (activeTask.steps || []).forEach((step) => {
      if (step.status === 'active' || step.status === 'done') names.add(step.agent);
    });
    if (activeTask.currentAgent) names.add(activeTask.currentAgent);
    return Array.from(names);
  }, [activeTask]);
  const timeline = useMemo(() => {
    if (!activeTask) return [];
    return (activeTask.steps || [])
      .filter((step) => step.status !== 'pending')
      .map((step) => ({
        label: step.label,
        state: step.status,
        at: activeTask.createdAt,
      }));
  }, [activeTask]);
  const routingDecision = useMemo(() => {
    if (!activeTask) return null;
    const planningEvent = (activeTask.events || []).find((event) => event.type === 'planning_complete');
    return planningEvent
      ? {
          reasoning: planningEvent.data?.plan?.summary || 'Workflow plan resolved.',
          plan: planningEvent.data?.plan || null,
        }
      : null;
  }, [activeTask]);
  const evidenceSummary = useMemo(() => {
    if (!activeTask) return null;
    const pack = activeTask.evidencePack || null;
    if (!pack) return null;
    return {
      summary: pack.summary,
      message: pack.summary,
      citations: pack.citations || [],
      memoryFindings: pack.memory_findings || [],
      webFindings: pack.web_findings || [],
      docFindings: pack.doc_findings || [],
      contradictions: pack.contradictions || [],
      freshness: pack.freshness || null,
      provenance: pack.provenance || null,
      recommendedFollowups: pack.recommended_followups || [],
      sources: pack.sources || [],
    };
  }, [activeTask]);
  const hivemindSummary = useMemo(() => {
    if (!activeTask?.evidencePack) return null;
    const pack = activeTask.evidencePack;
    const provenance = pack.provenance || {};
    return {
      policy: 'Memory-first retrieval with HIVE-MIND as ground truth and live web only for freshness or external verification.',
      memoryFindings: pack.memory_findings || [],
      webFindings: pack.web_findings || [],
      uploadFindings: pack.doc_findings || [],
      contradictions: pack.contradictions || [],
      freshness: pack.freshness || null,
      provenance,
      saveBackEligible: Boolean(provenance.save_back_eligible),
      memorySources: (pack.sources || []).filter((source) => source.source_type === 'memory'),
      uploadSources: (pack.sources || []).filter((source) => source.source_type === 'upload'),
      webSources: (pack.sources || []).filter((source) => source.source_type === 'web'),
      recommendedFollowups: pack.recommended_followups || [],
    };
  }, [activeTask]);
  const schema = useMemo(() => {
    if (!activeTask?.artifact) return null;
    return {
      artifact_id: activeTask.artifact.id,
      title: activeTask.artifact.title,
      theme: activeTask.artifact.theme || null,
      sections: activeTask.artifact.sections || [],
    };
  }, [activeTask]);
  const governance = useMemo(() => {
    if (!activeTask?.governanceReport) return null;
    return {
      approved: Boolean(activeTask.governanceReport.approved),
      readiness_score: activeTask.governanceReport.readiness_score,
      issues: activeTask.governanceReport.issues || [],
      notes: activeTask.governanceReport.notes || [],
    };
  }, [activeTask]);
  const renderState = useMemo(() => {
    if (!activeTask) return { loading: false, label: '', section: 0, total: 0, artifactKind: '' };
    const artifactStep = (activeTask.steps || []).find((step) => step.id === 'artifact');
    return {
      loading: activeTask.status === 'running' && artifactStep?.status === 'active',
      label: artifactStep?.detail || '',
      section: (activeTask.artifactSections || []).length,
      total: activeTask.artifact?.sections?.length || (activeTask.artifactSections || []).length || 0,
      artifactKind: activeTask.artifact ? 'visual_html' : '',
    };
  }, [activeTask]);
  const hitl = useMemo(() => activeTask?.hitl || { open: false, headline: '', intro: '', reason: '' }, [activeTask]);

  // ─── Task mutations ──────────────────────────────────────────

  function createTask(userQuery, workflowMode) {
    const id = generateId();
      const task = {
      id,
      query: userQuery,
      threadId: null,
      workflowMode: workflowMode || 'hybrid',
      status: 'running',
      steps: makeSteps(workflowMode || 'hybrid'),
      events: [],
      messages: [{ id: generateId(), role: 'user', content: userQuery, at: new Date().toISOString() }],
      artifact: null,
      artifactSections: [],
      governanceReport: null,
      evidencePack: null,
      error: null,
      createdAt: new Date().toISOString(),
      currentAgent: null,
      // HITL
      hitl: { open: false, headline: '', intro: '', reason: '' },
      artifactFamily: null,
      requirementsChecklist: null,
      contentDirector: null,
      agentRoster: [],
    };
    setTasks((prev) => [task, ...prev]);
    setActiveTaskId(id);
    return task;
  }

  function patchTask(taskId, patch) {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...patch } : t)));
  }

  // ─── Event handler ───────────────────────────────────────────

  function handleEvent(taskId, event) {
    // Skip non-StreamEvent payloads (raw AgentScope tool_use/tool_result messages)
    if (!event.type || event.type === 'tool_use' || event.type === 'tool_result') return;

    const mapped = mapEvent(event);

    setTasks((prev) => prev.map((t) => {
      if (t.id !== taskId) return t;
      const updated = { ...t, events: [...(t.events || []), event] };

      // Thread ID
      if (event.thread_id) updated.threadId = event.thread_id;

      // Current agent
      if (event.agent_name && event.agent_name !== 'system') {
        updated.currentAgent = agentLabel(event.agent_name);
      }

      // Update step states
      if (mapped.stepId) {
        const stepOrder = updated.steps.map((s) => s.id);
        const targetIdx = stepOrder.indexOf(mapped.stepId);

        updated.steps = updated.steps.map((s, i) => {
          if (i < targetIdx && s.status !== 'done') return { ...s, status: 'done' };
          if (s.id === mapped.stepId) {
            return {
              ...s,
              status: mapped.status || 'active',
              detail: mapped.detail || s.detail,
              agent: mapped.agent || s.agent,
            };
          }
          return s;
        });
      }

      if (event.type === 'planning_complete') {
        updated.artifactFamily = event.data?.plan?.artifact_family || updated.artifactFamily;
        updated.requirementsChecklist = normalizeChecklist(event.data?.plan?.requirements_checklist) || updated.requirementsChecklist;
      }
      if (event.type === 'artifact_family_selected') {
        updated.artifactFamily = event.data?.artifact_family || updated.artifactFamily;
      }
      if (event.type === 'requirements_check_completed') {
        updated.requirementsChecklist = normalizeChecklist(event.data?.requirements_checklist) || updated.requirementsChecklist;
      }
      if (event.type === 'content_director_completed') {
        updated.contentDirector = event.data?.content_brief || null;
      }
      if (event.type === 'workflow_complete' && event.data?.final_answer) {
        updated.finalAnswer = event.data.final_answer;
        updated.status = 'complete';
        updated.currentAgent = null;
        updated.steps = updated.steps.map((s) => ({ ...s, status: 'done' }));
      }
      if (event.type === 'agent_catalog_snapshot') {
        updated.agentRoster = Array.isArray(event.data?.agents) ? event.data.agents : updated.agentRoster;
      }
      if (event.type === 'fanin_completed' && event.data?.evidence_pack) {
        updated.evidencePack = event.data.evidence_pack;
      }
      if (event.type === 'agent_completed' && event.phase === 'research' && event.data?.evidence_pack) {
        updated.evidencePack = event.data.evidence_pack;
      }
      if (event.type === 'parallel_branch_completed' && event.phase === 'research' && event.data?.evidence_pack) {
        updated.evidencePack = event.data.evidence_pack;
      }
      if (event.type === 'workflow_blocked' || event.type === 'hitl_prompt_required') {
        const rawQuestions = Array.isArray(event.data?.questions) && event.data.questions.length > 0
          ? event.data.questions
          : [event.data?.blocked_question || 'Please answer the required questions to continue.'];
        const questions = rawQuestions.map((item, index) => normalizeHitlQuestion(item, index));
        updated.hitl = {
          open: true,
          headline: event.data?.prompt_headline || 'Clarification needed',
          intro: event.data?.prompt_intro || event.data?.blocked_question || 'Clarification required',
          reason: event.data?.blocked_question || 'Clarification required',
          questions,
          answers: Object.fromEntries(questions.map((question, index) => [question.requirement_id || `q${index + 1}`, ''])),
          answerModes: {},
          currentIndex: 0,
          agentNode: event.data?.pending_node || 'hitl',
          expectedAnswerSchema: event.data?.expected_answer_schema || null,
        };
      }
      if (event.type === 'resume_accepted') {
        updated.hitl = { ...updated.hitl, open: false };
      }

      // Push curated live agent messages to the conversation.
      const liveMessage = formatAgentLiveMessage(event, mapped);
      if (liveMessage && event.type !== 'planning_started') {
        updated.messages = [
          ...(updated.messages || []),
          {
            id: generateId(),
            role: 'agent',
            agent: liveMessage.agent,
            content: liveMessage.content,
            eventType: event.type,
            at: event.timestamp || new Date().toISOString(),
          },
        ];
      }

      // Artifact sections (incremental preview)
      if (mapped.sectionData) {
        const sec = mapped.sectionData;
        const existing = updated.artifactSections.filter((s) => s.section_id !== sec.section_id);
        existing.push(sec);
        existing.sort((a, b) => (a.section_index || 0) - (b.section_index || 0));
        updated.artifactSections = existing;
      }

      // Artifact manifest from artifact_ready
      if (event.type === 'artifact_ready' && event.data?.artifact_manifest) {
        const manifest = event.data.artifact_manifest;
        updated.artifact = {
          id: manifest.artifact_id,
          title: manifest.title,
          sections: manifest.sections || [],
          theme: manifest.theme,
          html: '', // will be filled by workflow_complete
          css: '',
        };
      }

      // Final artifact from workflow_complete
      if (event.type === 'workflow_complete' && event.data?.final_artifact) {
        const fa = event.data.final_artifact;
        updated.artifact = {
          id: fa.artifact_id,
          title: fa.title,
          sections: fa.sections || [],
          theme: fa.theme,
          html: fa.html || '',
          css: fa.css || '',
          governance_status: fa.governance_status,
        };
        updated.status = 'complete';
        updated.currentAgent = null;
        updated.steps = updated.steps.map((s) => ({ ...s, status: 'done' }));
      }

      // Governance report
      if (mapped.governanceReport) {
        updated.governanceReport = mapped.governanceReport;
      }

      // Error
      if (event.type === 'workflow_error') {
        updated.status = 'error';
        updated.error = event.data?.error_message || 'Workflow failed';
      }

      return updated;
    }));

    // Auto-open preview when artifact is ready
    if (event.type === 'artifact_ready' || (event.type === 'workflow_complete' && event.data?.final_artifact)) {
      setPreviewOpen(true);
    }
  }

  // ─── Submit ──────────────────────────────────────────────────

  const submit = useCallback(async (userQuery, workflowMode) => {
    if (!userQuery?.trim() || isSubmitting) return;
    setIsSubmitting(true);

    const mode = workflowMode || 'hybrid';
    const task = createTask(userQuery.trim(), mode);
    const sessionId = ensureSession();

    try {
      await submitWorkflow(
        {
          user_query: userQuery.trim(),
          workflow_mode: mode,
          session_id: sessionId,
          artifact_type: 'visual_html',
          source_scope: 'web',
        },
        (event) => handleEvent(task.id, event)
      );
    } catch (err) {
      patchTask(task.id, { status: 'error', error: err.message });
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting]);

  // ─── Resume (HITL) ──────────────────────────────────────────

  const resume = useCallback(async (taskId, reason) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task?.threadId) return;
    const answers = Object.fromEntries(
      Object.entries(task.hitl?.answers || {}).filter(([, value]) => String(value).trim())
    );

    patchTask(taskId, {
      status: 'running',
      hitl: { open: false, headline: '', intro: '', reason: '' },
    });

    try {
      await resumeWorkflow(
        { thread_id: task.threadId, resume_reason: reason || 'User approved', answers },
        (event) => handleEvent(taskId, event)
      );
    } catch (err) {
      patchTask(taskId, { status: 'error', error: err.message });
    }
  }, [tasks]);

  const updateHitlAnswer = useCallback((taskId, requirementId, value) => {
    if (!taskId || !requirementId) return;
    setTasks((prev) => prev.map((task) => {
      if (task.id !== taskId) return task;
      const currentHitl = task.hitl || { open: false, headline: '', intro: '', reason: '' };
      return {
        ...task,
        hitl: {
          ...currentHitl,
          answers: {
            ...(currentHitl.answers || {}),
            [requirementId]: value,
          },
        },
      };
    }));
  }, []);

  const updateHitlAnswerMode = useCallback((taskId, requirementId, mode) => {
    if (!taskId || !requirementId) return;
    setTasks((prev) => prev.map((task) => {
      if (task.id !== taskId) return task;
      const currentHitl = task.hitl || { open: false, headline: '', intro: '', reason: '' };
      return {
        ...task,
        hitl: {
          ...currentHitl,
          answerModes: {
            ...(currentHitl.answerModes || {}),
            [requirementId]: mode,
          },
        },
      };
    }));
  }, []);

  const updateHitlIndex = useCallback((taskId, nextIndex) => {
    if (!taskId) return;
    setTasks((prev) => prev.map((task) => {
      if (task.id !== taskId) return task;
      const currentHitl = task.hitl || { open: false, headline: '', intro: '', reason: '' };
      return {
        ...task,
        hitl: {
          ...currentHitl,
          currentIndex: nextIndex,
        },
      };
    }));
  }, []);

  // ─── Reset ───────────────────────────────────────────────────

  function resetWorkspace() {
    setTasks([]);
    setActiveTaskId(null);
    setQuery('');
    setPreviewOpen(false);
  }

  const value = useMemo(
    () => ({
      isDayMode, toggleDayMode,
      tasks, activeTask, activeTaskId, setActiveTaskId,
      query, setQuery, isSubmitting,
      submit, resume, resetWorkspace,
      previewOpen, setPreviewOpen,
      messages,
      activeAgents,
      previewHtml: preview.html,
      previewTitle: preview.title,
      timeline,
      routingDecision,
      evidenceSummary,
      hivemindSummary,
      schema,
      governance,
      renderState,
      hitl,
      updateHitlAnswer,
      updateHitlAnswerMode,
      updateHitlIndex,
      artifactFamily: activeTask?.artifactFamily || null,
      requirementsChecklist: activeTask?.requirementsChecklist || null,
      contentDirector: activeTask?.contentDirector || null,
      agentRoster: activeTask?.agentRoster || [],
    }),
    [
      isDayMode,
      tasks,
      activeTask,
      activeTaskId,
      query,
      isSubmitting,
      previewOpen,
      submit,
      resume,
      messages,
      activeAgents,
      preview,
      timeline,
      routingDecision,
      evidenceSummary,
      schema,
      governance,
      renderState,
      hitl,
      updateHitlAnswer,
      updateHitlAnswerMode,
      updateHitlIndex,
      activeTask?.artifactFamily,
      activeTask?.requirementsChecklist,
      activeTask?.contentDirector,
      activeTask?.agentRoster,
      hivemindSummary,
    ]
  );

  return (
    <BlaiqWorkspaceContext.Provider value={value}>
      {children}
    </BlaiqWorkspaceContext.Provider>
  );
}

export function useBlaiqWorkspace() {
  const ctx = useContext(BlaiqWorkspaceContext);
  if (!ctx) throw new Error('useBlaiqWorkspace must be used within BlaiqWorkspaceProvider');
  return ctx;
}
