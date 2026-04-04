import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Bot,
  Brain,
  CheckCircle2,
  ChevronRight,
  FileCog,
  GitBranch,
  Loader2,
  PanelRight,
  Play,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { getWorkflowStatus, resumeWorkflow, submitWorkflow } from '../shared/blaiq-client';

const tabs = [
  { id: 'preview', label: 'Preview', icon: PanelRight },
  { id: 'plan', label: 'Plan', icon: GitBranch },
  { id: 'schema', label: 'Schema', icon: FileCog },
  { id: 'governance', label: 'Governance', icon: ShieldCheck },
];

const promptSuggestions = [
  'Create a pitch deck from our last 12 months of sales',
  'Turn our strategy notes into an executive briefing',
  'Build a landing page narrative from uploaded materials',
];

const quickChips = (question) => {
  const lower = question.toLowerCase();
  if (lower.includes('audience') || lower.includes('target')) return ['Board', 'Investors', 'Enterprise buyers'];
  if (lower.includes('metric') || lower.includes('revenue') || lower.includes('kpi')) return ['Revenue growth', 'Pipeline', 'Gross margin'];
  if (lower.includes('style') || lower.includes('visual') || lower.includes('design')) return ['Minimal', 'Executive', 'Analytical'];
  return ['Use best judgement', 'Keep it concise', 'Show strongest proof'];
};

function eventType(event) {
  return event.normalized_type || event.type;
}

function normalizeQuestion(item, index) {
  if (typeof item === 'string') {
    return {
      requirement_id: `q${index + 1}`,
      question: item,
      why_it_matters: '',
      answer_hint: '',
      answer_options: quickChips(item),
    };
  }
  return item || {
    requirement_id: `q${index + 1}`,
    question: 'Please provide more detail.',
    why_it_matters: '',
    answer_hint: '',
    answer_options: ['Use best judgement', 'Keep it concise', 'I’ll type my own answer'],
  };
}

function normalizePreviewHtml(rawHtml) {
  let html = String(rawHtml || '').trim();
  if (!html) {
    return '<!doctype html><html><body style="margin:0;background:#faf9f4;color:#0a0a0a;font-family:Inter,system-ui;display:grid;place-items:center;height:100vh;"><div>No artifact yet</div></body></html>';
  }
  const containsHtmlTag = /<([a-z][\w-]*)(?:\s|>)/i.test(html);
  if (!containsHtmlTag) {
    const escaped = html
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<!doctype html><html><body style="margin:0;min-height:100vh;background:#F6F4F1;color:#0a0a0a;font-family:Manrope,Inter,system-ui;display:grid;place-items:center;padding:32px;"><div style="width:min(920px,100%);background:rgba(255,255,255,0.86);border:1px solid rgba(0,0,0,0.08);border-radius:28px;box-shadow:0 24px 80px rgba(0,0,0,0.08);overflow:hidden;"><div style="display:flex;justify-content:space-between;gap:16px;padding:18px 22px;background:rgba(228,222,210,0.55);border-bottom:1px solid rgba(0,0,0,0.06);"><div><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.18em;color:rgba(0,0,0,0.48);">Artifact Preview</div><div style="margin-top:4px;font-family:'Cormorant Garamond',serif;font-size:28px;font-weight:600;">Rendered Response</div></div><div style="align-self:flex-start;padding:8px 12px;border-radius:999px;background:#FF5C4B;color:#fff;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">Text fallback</div></div><div style="padding:28px 22px 32px;white-space:pre-wrap;line-height:1.8;font-size:15px;">${escaped}</div></div></body></html>`;
  }
  return html;
}

function extractArtifactHtml(event) {
  return (
    event?.final_artifact?.governance_report?.approved_output ||
    event?.final_artifact?.html_artifact ||
    event?.content_draft?.html_artifact ||
    ''
  );
}

function extractSchema(event) {
  return event?.final_artifact?.schema_data || event?.content_draft?.schema_data || null;
}

function formatEventSummary(event) {
  const type = eventType(event);
  const plan = event.data?.plan || event.plan || null;
  switch (type) {
    case 'routing_decision':
      return {
        title: 'Core routed the request',
        body: 'The system selected the primary agent path and helper flow.',
      };
    case 'evidence_summary':
    case 'evidence_ready':
      return {
        title: 'GraphRAG assembled evidence',
        body: 'Relevant sources are ready for downstream synthesis.',
      };
    case 'evidence_refreshed':
      return {
        title: 'GraphRAG refreshed the evidence',
        body: 'Your clarifications were merged back into the working context.',
      };
    case 'hitl_required':
    case 'workflow_blocked':
      return {
        title: 'Clarification needed',
        body: 'Answer the inline questions to continue rendering.',
      };
    case 'artifact_family_selected':
      return {
        title: 'Artifact family selected',
        body: `The strategist classified this run as ${event.data?.artifact_family || event.artifact_family || 'custom'}.`,
      };
    case 'planning_complete': {
      if (plan) {
        const mode = plan.workflow_mode || 'workflow';
        const family = plan.artifact_family || 'custom';
        const steps = Array.isArray(plan.tasks) ? plan.tasks : [];
        const stepSummary = steps.length
          ? `Sequence: ${steps
              .map((task, index) => `${index + 1}. ${task.task_role || task.agent_type || 'task'} -> ${task.purpose || 'work item'}`)
              .join(' | ')}`
          : 'No task sequence returned.';
        return {
          title: 'Strategic plan ready',
          body: `${plan.summary || 'The strategist resolved the workflow.'}\n\nMode: ${mode}\nArtifact family: ${family}\n${stepSummary}`,
        };
      }
      return {
        title: 'Strategic plan ready',
        body: 'The strategist resolved the workflow plan.',
      };
    }
    case 'requirements_check_completed':
      return {
        title: 'Requirements checked',
        body: 'The artifact checklist has been evaluated against the live request.',
      };
    case 'content_director_started':
      return {
        title: 'Content director started',
        body: 'The content planning brief is being prepared.',
      };
    case 'content_director_completed':
      return {
        title: 'Content director completed',
        body: 'Section planning and renderer handoff are ready.',
      };
    case 'workflow_blocked':
      return {
        title: event.data?.prompt_headline || 'Clarification needed',
        body: event.data?.prompt_intro || event.data?.blocked_question || 'I need a few clarification answers before I can continue.',
      };
    case 'rendering_started':
    case 'artifact_type_resolved':
      return {
        title: 'Vangogh started rendering',
        body: 'The artifact structure is now being composed section by section.',
      };
    case 'artifact_ready':
    case 'artifact_composed':
    case 'content_ready':
      return {
        title: 'Artifact ready',
        body: 'Preview, schema, and governance are available in the right rail.',
      };
    case 'governance':
      return {
        title: 'Governance evaluated the result',
        body: event.governance_report?.validation_passed ? 'Checks passed.' : 'Review the flagged items.',
      };
    default:
      return {
        title: type.replace(/_/g, ' '),
        body: event.message || 'Workflow update received.',
      };
  }
}

function MessageCard({ item }) {
  if (item.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[72%] rounded-md bg-[#111827] px-4 py-3 text-sm leading-relaxed text-white shadow-[0_10px_24px_rgba(17,24,39,0.12)]">
          {item.content}
        </div>
      </div>
    );
  }

  const isSystem = item.role === 'system';
  return (
    <div className="flex justify-start">
      <div className={`max-w-[85%] rounded-md border px-4 py-3 shadow-[0_8px_24px_rgba(17,24,39,0.04)] ${
        isSystem ? 'border-[#dbe8fb] bg-[#f8fbff]' : 'border-[#e3e0db] bg-white'
      }`}>
        <div className="mb-1.5 flex items-center gap-2">
          <div className={`flex h-6 w-6 items-center justify-center rounded-sm ${isSystem ? 'bg-[#117dff]/10' : 'bg-[#f3f1ec]'}`}>
            {isSystem ? <Sparkles size={13} className="text-[#117dff]" /> : <Bot size={13} className="text-[#525252]" />}
          </div>
          <span className="font-['Space_Grotesk'] text-xs font-semibold text-[#0a0a0a]">{item.title}</span>
        </div>
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-[#525252]">{item.content}</div>
      </div>
    </div>
  );
}

function RailTabButton({ tab, activeTab, setActiveTab }) {
  const Icon = tab.icon;
  return (
    <button
      type="button"
      onClick={() => setActiveTab(tab.id)}
      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-semibold transition-colors ${
        activeTab === tab.id
          ? 'border-[#117dff]/20 bg-[#117dff]/8 text-[#117dff]'
          : 'border-[#e3e0db] bg-white text-[#525252] hover:bg-[#faf9f4]'
      }`}
    >
      <Icon size={14} />
      {tab.label}
    </button>
  );
}

export default function BlaiqWorkspace() {
  const [messages, setMessages] = useState([]);
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState('plan');
  const [workflowMode, setWorkflowMode] = useState('standard');
  const [threadId, setThreadId] = useState('');
  const [timeline, setTimeline] = useState([]);
  const [previewHtml, setPreviewHtml] = useState('');
  const [schema, setSchema] = useState(null);
  const [governance, setGovernance] = useState(null);
  const [strategyPlan, setStrategyPlan] = useState(null);
  const [hitl, setHitl] = useState({ open: false, headline: '', intro: '', questions: [], answers: {}, answerModes: {}, currentIndex: 0, agentNode: 'content_node' });
  const [renderState, setRenderState] = useState({ loading: false, label: '', section: 0, total: 0, artifactKind: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const transcriptRef = useRef(null);
  const atBottomRef = useRef(true);
  const hasConversation = messages.length > 0;
  const currentQuestion = hitl.questions[hitl.currentIndex] || null;
  const currentQuestionId = currentQuestion?.requirement_id || '';
  const currentQuestionAnswer = currentQuestionId ? (hitl.answers[currentQuestionId] || '') : '';
  const currentQuestionMode = currentQuestionId ? (hitl.answerModes[currentQuestionId] || 'option') : 'option';
  const currentQuestionOptions = currentQuestion?.answer_options?.length ? currentQuestion.answer_options : quickChips(currentQuestion?.question || '');

  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const onScroll = () => {
      const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
      atBottomRef.current = remaining < 80;
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = transcriptRef.current;
    if (!el || !atBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, renderState, hitl.open]);

  const rightRailOpen = useMemo(() => {
    return Boolean(previewHtml || renderState.loading || schema || governance || timeline.length);
  }, [previewHtml, renderState.loading, schema, governance, timeline.length]);

  function pushSystemEvent(event) {
    const summary = formatEventSummary(event);
    setMessages((current) => [
      ...current,
      {
        id: `${Date.now()}-${Math.random()}`,
        role: 'system',
        title: summary.title,
        content: summary.body,
      },
    ]);
  }

  function pushTimeline(label, state = 'active') {
    setTimeline((current) => {
      const existing = current.find((item) => item.label === label);
      if (existing) {
        return current.map((item) => item.label === label ? { ...item, state, at: new Date().toLocaleTimeString() } : item);
      }
      return [...current, { label, state, at: new Date().toLocaleTimeString() }];
    });
  }

  function setHitlAnswer(questionId, value) {
    if (!questionId) return;
    setHitl((current) => ({
      ...current,
      answers: { ...current.answers, [questionId]: value },
    }));
  }

  function setHitlAnswerMode(questionId, mode) {
    if (!questionId) return;
    setHitl((current) => ({
      ...current,
      answerModes: { ...current.answerModes, [questionId]: mode },
    }));
  }

  function advanceHitlQuestion() {
    if (!currentQuestionId) return;
    const answer = String(currentQuestionAnswer || '').trim();
    if (!answer) return;

    if (hitl.currentIndex < Math.max(hitl.questions.length - 1, 0)) {
      setHitl((current) => ({
        ...current,
        currentIndex: current.currentIndex + 1,
      }));
      return;
    }

    handleResume();
  }

  function handleEvent(event) {
    const type = eventType(event);
    if (event.thread_id) setThreadId(event.thread_id);

    if (type === 'routing_decision') {
      pushTimeline('Routing', 'done');
      pushSystemEvent(event);
    }

    if (type === 'evidence_summary' || type === 'evidence_ready' || type === 'evidence_refreshed') {
      pushTimeline('Evidence', 'done');
      pushSystemEvent(event);
    }

    if (type === 'rendering_started' || type === 'artifact_type_resolved') {
      setActiveTab('preview');
      setRenderState({
        loading: true,
        label: event.message || 'Rendering artifact',
        section: 0,
        total: Number(event.total_sections || 0),
        artifactKind: String(event.kind || ''),
      });
      pushTimeline('Rendering', 'active');
      pushSystemEvent(event);
    }

  if (type === 'artifact_family_selected') {
      pushTimeline('Planning', 'active');
      pushSystemEvent(event);
    }

    if (type === 'planning_complete') {
      setStrategyPlan(event.data?.plan || null);
      pushTimeline('Strategy', 'done');
      pushSystemEvent(event);
    }

    if (type === 'requirements_check_started' || type === 'requirements_check_completed') {
      pushTimeline('Requirements', type === 'requirements_check_completed' ? 'done' : 'active');
      pushSystemEvent(event);
    }

    if (type === 'content_director_started' || type === 'content_director_completed') {
      pushTimeline('Content director', type === 'content_director_completed' ? 'done' : 'active');
      pushSystemEvent(event);
    }

    if (type === 'section_started') {
      setRenderState((current) => ({
        ...current,
        loading: true,
        label: String(event.section_label || event.message || 'Rendering section'),
        section: Number(event.section_index || 0) + 1,
        total: current.total || Number(event.total_sections || 0),
      }));
    }

    if (type === 'section_ready') {
      setRenderState((current) => ({
        ...current,
        loading: true,
        label: String(event.section_label || current.label),
        section: Number(event.section_index || 0) + 1,
      }));
    }

    if (type === 'artifact_ready' || type === 'artifact_composed' || type === 'content_ready' || type === 'complete') {
      const html = extractArtifactHtml(event);
      if (html) {
        setPreviewHtml(html);
        setActiveTab('preview');
      }
      const schemaDraft = extractSchema(event);
      if (schemaDraft) setSchema(schemaDraft);
      if (event.governance_report) setGovernance(event.governance_report);
      setRenderState((current) => ({ ...current, loading: false }));
      pushTimeline('Rendering', 'done');
      if (type !== 'complete') pushSystemEvent(event);
    }

    if (type === 'governance' && event.governance_report) {
      setGovernance(event.governance_report);
      pushTimeline('Governance', event.governance_report.validation_passed ? 'done' : 'warning');
      pushSystemEvent(event);
    }

    if (type === 'hitl_required') {
      setHitl({
        open: true,
        headline: event.headline || 'Clarification needed',
        intro: event.intro || 'Please answer the questions to continue.',
        questions: event.questions || [],
        answers: Object.fromEntries((event.questions || []).map((item, index) => {
          const question = normalizeQuestion(item, index);
          return [question.requirement_id || `q${index + 1}`, ''];
        })),
        answerModes: {},
        currentIndex: 0,
        agentNode: event.node || 'content_node',
      });
      pushTimeline('Awaiting input', 'blocked');
      pushSystemEvent(event);
    }

    if (type === 'workflow_blocked') {
      const blockedQuestion = event.data?.blocked_question || event.blocked_question || 'Please answer the required questions to continue.';
      const rawQuestions = event.data?.questions || event.questions || [blockedQuestion];
      const questions = rawQuestions.map((item, index) => normalizeQuestion(item, index));
      setHitl({
        open: true,
        headline: event.data?.prompt_headline || 'Clarification needed',
        intro: event.data?.prompt_intro || blockedQuestion,
        questions,
        answers: Object.fromEntries(questions.map((question, index) => [question.requirement_id || `q${index + 1}`, ''])),
        answerModes: {},
        currentIndex: 0,
        agentNode: event.data?.pending_node || event.pending_node || 'hitl',
      });
      pushTimeline('Awaiting input', 'blocked');
      pushSystemEvent(event);
    }

    if (type === 'resume_accepted') {
      setHitl((current) => ({ ...current, open: false }));
      pushTimeline('Awaiting input', 'done');
      pushSystemEvent(event);
    }
  }

  async function handleSubmit() {
    const value = query.trim();
    if (!value || isSubmitting || isResuming) return;

    setMessages((current) => [
      ...current,
      { id: `${Date.now()}`, role: 'user', content: value },
    ]);
    setQuery('');
    setIsSubmitting(true);
    setTimeline([{ label: 'Submit', state: 'active', at: new Date().toLocaleTimeString() }]);
    setPreviewHtml('');
    setSchema(null);
    setGovernance(null);
    setStrategyPlan(null);

    try {
      await submitWorkflow(
        {
          user_query: value,
          workflow_mode: workflowMode,
          session_id: crypto.randomUUID(),
          use_template_engine: true,
        },
        handleEvent
      );
    } catch (error) {
      setMessages((current) => [
        ...current,
        { id: `${Date.now()}-err`, role: 'system', title: 'Request failed', content: error.message || 'Unknown error' },
      ]);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleResume() {
    if (!threadId || isResuming) return;
    const answers = Object.fromEntries(Object.entries(hitl.answers).filter(([, value]) => String(value).trim()));
    if (!Object.keys(answers).length) return;

    setIsResuming(true);
    try {
      await resumeWorkflow(
        {
          thread_id: threadId,
          agent_node: hitl.agentNode,
          answers,
        },
        handleEvent
      );
      setHitl((current) => ({ ...current, open: false }));
      pushTimeline('Awaiting input', 'done');
    } catch (error) {
      setMessages((current) => [
        ...current,
        { id: `${Date.now()}-resume`, role: 'system', title: 'Resume failed', content: error.message || 'Unknown error' },
      ]);
    } finally {
      setIsResuming(false);
    }
  }

  useEffect(() => {
    if (!threadId) return;
    getWorkflowStatus(threadId).catch(() => {});
  }, [threadId]);

  return (
    <div className="h-screen w-full overflow-hidden bg-[#faf9f4] font-[Inter,ui-sans-serif,system-ui,sans-serif] text-[#0a0a0a]">
      <div className={`grid h-full ${hasConversation ? 'grid-cols-[248px_minmax(0,1fr)]' : 'grid-cols-[minmax(0,1fr)]'}`}>
        {hasConversation ? (
        <aside className="flex h-full flex-col border-r border-[#e3e0db] bg-[#f5f2eb] px-3 py-4">
          <div className="mb-6 flex items-center gap-3 px-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-[#111827] text-sm font-semibold text-white">B</div>
            <div>
              <div className="font-['Space_Grotesk'] text-sm font-semibold">BLAIQ</div>
              <div className="text-[11px] text-[#a3a3a3]">Orchestration workspace</div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setMessages([]);
              setTimeline([]);
      setPreviewHtml('');
      setSchema(null);
      setGovernance(null);
      setStrategyPlan(null);
      setThreadId('');
      setHitl({ open: false, headline: '', intro: '', questions: [], answers: {}, agentNode: 'content_node' });
      setRenderState({ loading: false, label: '', section: 0, total: 0, artifactKind: '' });
            }}
            className="mb-4 flex items-center gap-2 rounded-md border border-[#e3e0db] bg-white px-3 py-2.5 text-sm font-medium text-[#525252] transition-colors hover:bg-[#f3f1ec]"
          >
            <Play size={15} />
            New workspace
          </button>
          <div className="space-y-1">
            {['Workspace', 'Agents', 'Uploads', 'Governance', 'Settings'].map((label, index) => (
              <div
                key={label}
                className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-sm ${
                  index === 0 ? 'bg-[#117dff]/8 text-[#117dff]' : 'text-[#525252]'
                }`}
              >
                {index === 0 ? <Brain size={15} /> : index === 1 ? <Bot size={15} /> : index === 2 ? <PanelRight size={15} /> : index === 3 ? <ShieldCheck size={15} /> : <Settings2 size={15} />}
                {label}
              </div>
            ))}
          </div>
          <div className="mt-auto rounded-md border border-[#e3e0db] bg-white p-4 shadow-[0_8px_24px_rgba(17,24,39,0.04)]">
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-[#a3a3a3]">System</div>
            <div className="text-sm font-medium text-[#0a0a0a]">Docker-backed</div>
            <div className="mt-1 text-xs leading-relaxed text-[#737373]">This standalone page talks to the local orchestrator through the dev proxy.</div>
          </div>
        </aside>
        ) : null}

        <div className="grid h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
          <header className="flex items-center justify-between border-b border-[#e3e0db] bg-[#faf9f4] px-6 py-4">
            <div>
              <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-[#a3a3a3]">BLAIQ workspace</div>
              <h1 className="font-['Space_Grotesk'] text-xl font-semibold text-[#0a0a0a]">Chat-first orchestration</h1>
            </div>
            <div className="flex items-center gap-3">
              <div className="rounded-md border border-[#e3e0db] bg-white px-3 py-2 text-xs text-[#525252]">Thread {threadId ? threadId.slice(0, 8) : 'new'}</div>
              <div className="rounded-md border border-[#117dff]/20 bg-[#117dff]/8 px-3 py-2 text-xs font-semibold text-[#117dff]">Production</div>
            </div>
          </header>

          <div className={`grid min-h-0 ${rightRailOpen ? 'grid-cols-[minmax(0,1fr)_420px]' : 'grid-cols-[minmax(0,1fr)]'} overflow-hidden`}>
            <section className={`grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] ${rightRailOpen ? 'border-r border-[#e3e0db]' : ''}`}>
              <div className="flex flex-wrap items-center gap-2 px-6 py-4">
                <div className="rounded-md border border-[#e3e0db] bg-white px-3 py-2 text-xs text-[#525252]">Mode {workflowMode}</div>
                <div className="rounded-md border border-[#e3e0db] bg-white px-3 py-2 text-xs text-[#525252]">{renderState.loading ? 'Rendering active' : 'Idle'}</div>
              </div>

              <div ref={transcriptRef} className="min-h-0 overflow-y-auto px-6 pb-6">
                {messages.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
                    <div className="flex h-16 w-16 items-center justify-center rounded-md border border-[#117dff]/10 bg-[#117dff]/8">
                      <Brain size={28} className="text-[#117dff]" />
                    </div>
                    <div>
                      <div className="font-['Space_Grotesk'] text-3xl font-semibold tracking-tight text-[#0a0a0a]">Build with BLAIQ</div>
                      <p className="mx-auto mt-2 max-w-2xl text-sm leading-relaxed text-[#737373]">One conversation lane for routing, evidence, rendering, HITL, schema, and governance. The right rail stays fixed and the page does not shift when new information arrives.</p>
                    </div>
                    <div className="flex flex-wrap justify-center gap-2">
                      {promptSuggestions.map((prompt) => (
                        <button key={prompt} type="button" onClick={() => setQuery(prompt)} className="rounded-md border border-[#e3e0db] bg-white px-4 py-2 text-xs text-[#525252] transition-colors hover:border-[#117dff]/20 hover:text-[#117dff]">
                          {prompt}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="mx-auto flex max-w-4xl flex-col gap-4 pt-2">
                    {messages.map((item) => <MessageCard key={item.id} item={item} />)}
                    {renderState.loading ? (
                      <div className="flex justify-start">
                        <div className="max-w-[85%] rounded-md border border-[#dbe8fb] bg-[#f8fbff] px-4 py-3 shadow-[0_8px_24px_rgba(17,24,39,0.04)]">
                          <div className="mb-2 flex items-center gap-2">
                            <Loader2 size={14} className="animate-spin text-[#117dff]" />
                            <span className="font-['Space_Grotesk'] text-sm font-semibold text-[#0a0a0a]">Vangogh is rendering</span>
                          </div>
                          <div className="text-sm text-[#525252]">{renderState.label || 'Composing artifact'}</div>
                          {renderState.total > 0 ? (
                            <div className="mt-2 text-xs font-mono text-[#a3a3a3]">{renderState.section} / {renderState.total}</div>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              <div className="border-t border-[#e3e0db] bg-white px-6 py-5">
                <AnimatePresence mode="wait">
                  {hitl.open ? (
                    <motion.div
                      key={currentQuestionId || 'hitl'}
                      initial={{ opacity: 0, y: 28 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 18 }}
                      transition={{ duration: 0.24, ease: 'easeOut' }}
                      className="mb-4 overflow-hidden rounded-2xl border border-[#117dff]/15 bg-[#f8fbff] shadow-[0_18px_50px_rgba(17,24,39,0.08)]"
                    >
                      <div className="border-b border-[#dbe8fb] px-4 py-3">
                        <div className="mb-1 flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-[#a3a3a3]">Clarification needed</div>
                            <div className="font-['Space_Grotesk'] text-base font-semibold text-[#0a0a0a]">{hitl.headline || 'Answer inline and continue rendering'}</div>
                          </div>
                          <div className="rounded-md border border-[#dbe8fb] bg-white px-3 py-1.5 text-[11px] font-mono text-[#117dff]">{hitl.agentNode}</div>
                        </div>
                        {hitl.intro ? <div className="max-w-2xl text-sm leading-relaxed text-[#525252]">{hitl.intro}</div> : null}
                      </div>

                      <div className="px-4 py-4">
                        {currentQuestion ? (
                          <AnimatePresence mode="wait">
                            <motion.div
                              key={currentQuestionId || currentQuestion.question}
                              initial={{ opacity: 0, y: 18 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: -12 }}
                              transition={{ duration: 0.2, ease: 'easeOut' }}
                              className="space-y-4"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-[#a3a3a3]">
                                  Question {hitl.currentIndex + 1} / {hitl.questions.length || 1}
                                </div>
                                {hitl.questions.length > 1 ? (
                                  <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-[#a3a3a3]">
                                    {Math.round(((hitl.currentIndex + 1) / hitl.questions.length) * 100)}%
                                  </div>
                                ) : null}
                              </div>

                              <div>
                                <div className="mb-1 text-[13px] font-semibold text-[#0a0a0a]">{currentQuestion.question}</div>
                                {currentQuestion.why_it_matters ? <div className="text-xs leading-relaxed text-[#737373]">{currentQuestion.why_it_matters}</div> : null}
                              </div>

                              <div className="flex flex-wrap gap-2">
                                {currentQuestionOptions.map((chip) => {
                                  const selected = currentQuestionMode === 'option' && currentQuestionAnswer === chip;
                                  return (
                                    <button
                                      key={chip}
                                      type="button"
                                      onClick={() => {
                                        setHitlAnswer(currentQuestionId, chip);
                                        setHitlAnswerMode(currentQuestionId, 'option');
                                      }}
                                      className={`rounded-full border px-3 py-1.5 text-[12px] transition-colors ${
                                        selected
                                          ? 'border-[#117dff]/35 bg-[#117dff] text-white'
                                          : 'border-[#e3e0db] bg-white text-[#525252] hover:border-[#117dff]/20 hover:text-[#117dff]'
                                      }`}
                                    >
                                      {chip}
                                    </button>
                                  );
                                })}
                                <button
                                  type="button"
                                  onClick={() => setHitlAnswerMode(currentQuestionId, 'custom')}
                                  className={`rounded-full border px-3 py-1.5 text-[12px] transition-colors ${
                                    currentQuestionMode === 'custom'
                                      ? 'border-[#117dff]/35 bg-[#117dff] text-white'
                                      : 'border-[#e3e0db] bg-white text-[#525252] hover:border-[#117dff]/20 hover:text-[#117dff]'
                                  }`}
                                >
                                  Type something else
                                </button>
                              </div>

                              <AnimatePresence mode="wait">
                                {currentQuestionMode === 'custom' ? (
                                  <motion.div
                                    key="custom-answer"
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -8 }}
                                    className="space-y-2"
                                  >
                                    <textarea
                                      value={currentQuestionAnswer}
                                      onChange={(event) => setHitlAnswer(currentQuestionId, event.target.value)}
                                      rows={3}
                                      placeholder="Type your own answer..."
                                      className="w-full resize-none rounded-xl border border-[#e3e0db] bg-white px-3 py-2.5 text-sm text-[#0a0a0a] outline-none focus:border-[#117dff]/40"
                                    />
                                  </motion.div>
                                ) : null}
                              </AnimatePresence>

                              <div className="flex items-center justify-between gap-3 border-t border-[#dbe8fb] pt-4">
                                <div className="text-[11px] text-[#737373]">
                                  {currentQuestionMode === 'custom' && !String(currentQuestionAnswer || '').trim()
                                    ? 'Type a response to continue.'
                                    : 'Pick an option or type a custom answer.'}
                                </div>
                                <button
                                  type="button"
                                  disabled={isResuming || !String(currentQuestionAnswer || '').trim()}
                                  onClick={advanceHitlQuestion}
                                  className="rounded-md bg-[#111827] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#1f2937] disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {hitl.currentIndex < Math.max(hitl.questions.length - 1, 0) ? 'Next' : (isResuming ? 'Resuming...' : 'Continue rendering')}
                                </button>
                              </div>
                            </motion.div>
                          </AnimatePresence>
                        ) : null}
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>

                <div className="rounded-md border border-[#e3e0db] bg-[#faf9f4] p-3 shadow-[0_8px_24px_rgba(17,24,39,0.03)]">
                  <div className="mb-3 flex items-center gap-3">
                    <select value={workflowMode} onChange={(event) => setWorkflowMode(event.target.value)} className="rounded-sm border border-[#e3e0db] bg-white px-3 py-2 text-xs text-[#525252] outline-none">
                      <option value="standard">Standard</option>
                      <option value="deep_research">Deep research</option>
                      <option value="creative">Creative</option>
                    </select>
                  </div>
                  <div className="flex items-end gap-3">
                    <textarea
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          handleSubmit();
                        }
                      }}
                      rows={1}
                      placeholder="Create a pitch deck based on our last year of sales"
                      className="min-h-[26px] max-h-40 flex-1 resize-none bg-transparent px-1 py-2 text-sm leading-relaxed text-[#0a0a0a] outline-none placeholder:text-[#a3a3a3]"
                    />
                    <button type="button" onClick={handleSubmit} disabled={!query.trim() || isSubmitting || isResuming} className="flex h-10 w-10 items-center justify-center rounded-md bg-[#111827] text-white transition-colors hover:bg-[#1f2937] disabled:opacity-50">
                      {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                    </button>
                  </div>
                </div>
              </div>
            </section>

            {rightRailOpen ? (
            <aside className="flex min-h-0 flex-col bg-[#f3f1ec]">
              <div className="flex gap-2 border-b border-[#e3e0db] px-4 py-4">
                {tabs.map((tab) => <RailTabButton key={tab.id} tab={tab} activeTab={activeTab} setActiveTab={setActiveTab} />)}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {activeTab === 'preview' ? (
                  <div className="h-full rounded-md border border-[#e3e0db] bg-white shadow-[0_8px_24px_rgba(17,24,39,0.04)]">
                    <div className="flex items-center justify-between border-b border-[#e3e0db] px-4 py-3">
                      <div>
                        <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-[#a3a3a3]">Preview</div>
                        <div className="font-['Space_Grotesk'] text-sm font-semibold text-[#0a0a0a]">{previewHtml ? 'Live artifact' : 'Waiting for output'}</div>
                      </div>
                      <div className="rounded-md border border-[#e3e0db] bg-[#faf9f4] px-3 py-1.5 text-[11px] text-[#525252]">{renderState.artifactKind || 'content'}</div>
                    </div>
                    <div className="h-[calc(100%-72px)] p-3">
                      {previewHtml ? (
                        <iframe title="Artifact preview" srcDoc={normalizePreviewHtml(previewHtml)} className="h-full w-full border border-[#e3e0db] bg-white" />
                      ) : (
                        <div className="flex h-full flex-col items-center justify-center gap-3 border border-dashed border-[#d4d0ca] bg-[#faf9f4] px-6 text-center">
                          <PanelRight size={22} className="text-[#117dff]" />
                          <div className="font-['Space_Grotesk'] text-sm font-semibold text-[#0a0a0a]">Preview rail is ready</div>
                          <div className="max-w-xs text-xs leading-relaxed text-[#737373]">When Vangogh starts producing sections or a final artifact, the preview will stay docked here without shifting the page.</div>
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}

                {activeTab === 'plan' ? (
                  <div className="rounded-md border border-[#e3e0db] bg-white p-4 shadow-[0_8px_24px_rgba(17,24,39,0.04)]">
                    <div className="mb-4 font-['Space_Grotesk'] text-sm font-semibold text-[#0a0a0a]">Execution plan</div>
                    {strategyPlan ? (
                      <div className="mb-4 rounded-md border border-[#dbe8fb] bg-[#f8fbff] p-4">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <div className="rounded-md border border-[#dbe8fb] bg-white px-2.5 py-1 text-[11px] font-mono text-[#117dff]">
                            {strategyPlan.workflow_mode || workflowMode}
                          </div>
                          <div className="rounded-md border border-[#dbe8fb] bg-white px-2.5 py-1 text-[11px] font-mono text-[#117dff]">
                            {strategyPlan.artifact_family || 'custom'}
                          </div>
                          <div className="rounded-md border border-[#dbe8fb] bg-white px-2.5 py-1 text-[11px] font-mono text-[#117dff]">
                            {Array.isArray(strategyPlan.tasks) ? `${strategyPlan.tasks.length} tasks` : 'plan'}
                          </div>
                        </div>
                        <div className="text-sm leading-relaxed text-[#0a0a0a]">
                          {strategyPlan.summary || 'The strategist resolved the workflow plan.'}
                        </div>
                        {Array.isArray(strategyPlan.notes) && strategyPlan.notes.length > 0 ? (
                          <div className="mt-3 space-y-1">
                            {strategyPlan.notes.map((note, index) => (
                              <div key={`${note}-${index}`} className="rounded-sm border border-[#dbe8fb] bg-white px-3 py-2 text-xs leading-relaxed text-[#525252]">
                                {note}
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {Array.isArray(strategyPlan.tasks) && strategyPlan.tasks.length > 0 ? (
                          <div className="mt-4 space-y-2">
                            <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-[#a3a3a3]">Sequence</div>
                            {strategyPlan.tasks.map((task, index) => (
                              <div key={task.node_id || `${task.task_id}-${index}`} className="flex items-start gap-3 rounded-md border border-[#dbe8fb] bg-white p-3">
                                <div className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-[#117dff]/10 text-[11px] font-semibold text-[#117dff]">
                                  {index + 1}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="text-sm font-medium text-[#0a0a0a]">
                                    {task.task_role || task.agent_type || task.task_id}
                                  </div>
                                  <div className="mt-1 text-xs leading-relaxed text-[#525252]">
                                    {task.purpose || task.reason || 'Work item'}
                                  </div>
                                  {Array.isArray(task.depends_on) && task.depends_on.length > 0 ? (
                                    <div className="mt-1 text-[11px] font-mono text-[#a3a3a3]">
                                      Depends on: {task.depends_on.join(', ')}
                                    </div>
                                  ) : null}
                                </div>
                                {task.parallel_group ? (
                                  <div className="rounded-sm border border-[#dbe8fb] bg-[#f8fbff] px-2 py-1 text-[11px] font-mono text-[#117dff]">
                                    {task.parallel_group}
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="space-y-3">
                      {timeline.length === 0 ? (
                        <div className="text-sm text-[#737373]">Workflow updates will appear here once the run starts.</div>
                      ) : timeline.map((item) => (
                        <div key={item.label} className="flex items-start gap-3 rounded-md border border-[#e3e0db] bg-[#faf9f4] p-3">
                          <div className={`mt-0.5 h-2.5 w-2.5 rounded-full ${
                            item.state === 'done' ? 'bg-[#16a34a]' : item.state === 'blocked' ? 'bg-[#d97706]' : item.state === 'warning' ? 'bg-[#d97706]' : 'bg-[#117dff]'
                          }`} />
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-[#0a0a0a]">{item.label}</div>
                            <div className="mt-1 text-[11px] font-mono text-[#a3a3a3]">{item.at}</div>
                          </div>
                          {item.state === 'done' ? <CheckCircle2 size={14} className="text-[#16a34a]" /> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {activeTab === 'schema' ? (
                  <div className="rounded-md border border-[#e3e0db] bg-white p-4 shadow-[0_8px_24px_rgba(17,24,39,0.04)]">
                    <div className="mb-4 font-['Space_Grotesk'] text-sm font-semibold text-[#0a0a0a]">Schema</div>
                    {schema ? (
                      <pre className="overflow-auto rounded-md bg-[#faf9f4] p-3 text-xs leading-relaxed text-[#525252]">{JSON.stringify(schema, null, 2)}</pre>
                    ) : (
                      <div className="text-sm text-[#737373]">Schema appears here when Vangogh returns structured content.</div>
                    )}
                  </div>
                ) : null}

                {activeTab === 'governance' ? (
                  <div className="rounded-md border border-[#e3e0db] bg-white p-4 shadow-[0_8px_24px_rgba(17,24,39,0.04)]">
                    <div className="mb-4 font-['Space_Grotesk'] text-sm font-semibold text-[#0a0a0a]">Governance</div>
                    {governance ? (
                      <div className="space-y-3">
                        <div className={`rounded-md px-3 py-2 text-sm font-medium ${
                          governance.validation_passed ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                        }`}>
                          {governance.validation_passed ? 'Validation passed' : 'Review required'}
                        </div>
                        {(governance.policy_checks || []).map((check) => (
                          <div key={`${check.rule}-${check.detail}`} className="rounded-md border border-[#e3e0db] bg-[#faf9f4] p-3">
                            <div className="text-sm font-medium text-[#0a0a0a]">{check.rule}</div>
                            <div className="mt-1 text-xs text-[#737373]">{check.detail}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-sm text-[#737373]">Governance results will appear here after the artifact is evaluated.</div>
                    )}
                  </div>
                ) : null}
              </div>
            </aside>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
