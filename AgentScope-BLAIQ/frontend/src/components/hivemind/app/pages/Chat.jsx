import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowUp,
  Bot,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Circle,
  Clock,
  Eye,
  FileUp,
  Globe,
  Loader2,
  Maximize2,
  MessageSquare,
  Minimize2,
  Paperclip,
  Play,
  Search,
  Shield,
  Sparkles,
  User,
  X,
  XCircle,
} from 'lucide-react';
import { normalizePreviewHtml, useBlaiqWorkspace } from '../shared/blaiq-workspace-context';
import { uploadFile } from '../shared/blaiq-client';

const PREFERRED_AGENT_ORDER = [
  'BLAIQ-CORE',
  'Strategic Planner',
  'Research Agent',
  'HITL Agent',
  'Content Director',
  'Visual Designer',
  'Governance',
  'System',
];

function quickChips(question) {
  const value = String(question || '').toLowerCase();
  if (value.includes('audience') || value.includes('target')) return ['Board', 'Investors', 'Enterprise buyers'];
  if (value.includes('length') || value.includes('pages') || value.includes('slides')) return ['Short', 'Standard', 'Detailed'];
  if (value.includes('focus') || value.includes('goal') || value.includes('objective')) return ['Sales', 'Strategy', 'Awareness'];
  if (value.includes('style') || value.includes('visual') || value.includes('design')) return ['Minimal', 'Executive', 'Bold'];
  return ['Use best judgement', 'Keep it concise', 'I’ll type my own answer'];
}

/* ═══════════════════════════════════════════════════════════════════════════
   RIGHT PANEL — Steps progress + Artifact preview (tabbed)
   ═══════════════════════════════════════════════════════════════════════════ */

function StepIcon({ status, size = 16 }) {
  if (status === 'done') return <CheckCircle size={size} className="text-emerald-500" />;
  if (status === 'active') return <Loader2 size={size} className="animate-spin text-blue-500" />;
  if (status === 'error') return <XCircle size={size} className="text-red-500" />;
  return <Circle size={size} className="text-gray-200" />;
}

/* ─── Steps tab content ──────────────────────────────────────────────────── */

function StepsContent({ task, isDayMode }) {
  const d = isDayMode;
  const { resume } = useBlaiqWorkspace();
  const doneCount = task.steps.filter((s) => s.status === 'done').length;
  const total = task.steps.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Progress header */}
      <div className={`px-4 py-4 border-b ${d ? 'border-gray-100' : 'border-[#1e1e1e]'}`}>
        <div className={`text-[13px] font-semibold leading-snug ${d ? 'text-gray-900' : 'text-white'}`}>
          {task.query.length > 55 ? task.query.slice(0, 55) + '...' : task.query}
        </div>
        <div className="mt-3 flex items-center gap-2.5">
          <div className={`h-2 flex-1 overflow-hidden rounded-full ${d ? 'bg-gray-100' : 'bg-[#1e1e1e]'}`}>
            <div
              className={`h-full rounded-full transition-all duration-700 ease-out ${
                task.status === 'error' ? 'bg-red-400' : task.status === 'complete' ? 'bg-emerald-500' : 'bg-blue-500'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className={`text-[12px] font-bold tabular-nums ${d ? 'text-gray-600' : 'text-[#a1a1a1]'}`}>
            {doneCount}/{total}
          </span>
        </div>
      </div>

      {/* Steps */}
      <div className="px-3 py-2 space-y-0.5">
        {task.steps.map((step, i) => {
          const isActive = step.status === 'active';
          const isDone = step.status === 'done';

          return (
            <div
              key={step.id}
              className={`rounded-xl px-3 py-2.5 transition-all ${
                isActive ? (d ? 'bg-blue-50' : 'bg-blue-950/30') : ''
              }`}
            >
              <div className="flex items-center gap-2.5">
                <StepIcon status={step.status} />
                <div className={`flex-1 text-[12px] font-medium ${
                  isDone ? (d ? 'text-gray-500' : 'text-[#6b6b6b]')
                  : isActive ? (d ? 'text-gray-900' : 'text-white')
                  : (d ? 'text-gray-300' : 'text-[#3a3a3a]')
                }`}>
                  {step.label}
                </div>
                <span className={`text-[10px] tabular-nums ${d ? 'text-gray-300' : 'text-[#3a3a3a]'}`}>
                  {i + 1}/{total}
                </span>
              </div>
              {(isActive || isDone) && (
                <div className="ml-[26px] mt-1 space-y-0.5">
                  <div className={`text-[11px] font-medium ${isActive ? 'text-blue-500' : (d ? 'text-gray-400' : 'text-[#525252]')}`}>
                    {step.agent}
                  </div>
                  {isDone && <div className={`text-[10px] ${d ? 'text-emerald-600' : 'text-emerald-500'}`}>Completed</div>}
                  {isActive && (
                    <div className="flex items-center gap-1 text-[10px] text-blue-500">
                      <Loader2 size={8} className="animate-spin" /> Working...
                    </div>
                  )}
                  {step.detail && (
                    <div className={`text-[10px] ${d ? 'text-gray-400' : 'text-[#525252]'}`}>{step.detail}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Governance */}
      {task.governanceReport && (
        <div className={`mx-3 mb-3 rounded-xl border px-3 py-3 ${
          task.governanceReport.approved
            ? d ? 'border-emerald-200 bg-emerald-50' : 'border-emerald-800/30 bg-emerald-950/20'
            : d ? 'border-orange-200 bg-orange-50' : 'border-orange-800/30 bg-orange-950/20'
        }`}>
          <div className="flex items-center gap-2">
            <Shield size={13} className={task.governanceReport.approved ? 'text-emerald-500' : 'text-orange-500'} />
            <span className={`text-[11px] font-semibold ${
              task.governanceReport.approved ? (d ? 'text-emerald-700' : 'text-emerald-400') : (d ? 'text-orange-700' : 'text-orange-400')
            }`}>
              {task.governanceReport.approved ? 'Governance Approved' : 'Revision Required'}
            </span>
          </div>
          <div className={`mt-1 ml-[21px] text-[10px] ${task.governanceReport.approved ? (d ? 'text-emerald-600' : 'text-emerald-500') : (d ? 'text-orange-600' : 'text-orange-500')}`}>
            Readiness score: {task.governanceReport.readiness_score}
          </div>
          {task.governanceReport.notes?.map((note, i) => (
            <div key={i} className={`ml-[21px] text-[10px] ${task.governanceReport.approved ? (d ? 'text-emerald-600' : 'text-emerald-500/80') : (d ? 'text-orange-600' : 'text-orange-500/80')}`}>
              {note}
            </div>
          ))}
        </div>
      )}

      {/* HITL / Error actions */}
      {task.status === 'blocked' && (
        <div className={`mx-3 mb-3 rounded-xl border px-3 py-3 ${d ? 'border-amber-200 bg-amber-50' : 'border-amber-800/30 bg-amber-950/20'}`}>
          <div className={`text-[11px] font-semibold ${d ? 'text-amber-800' : 'text-amber-400'}`}>Waiting for input</div>
          <button
            type="button"
            onClick={() => resume(task.id, 'User approved')}
            className="mt-2 flex items-center gap-1.5 rounded-lg bg-amber-100 px-3 py-1.5 text-[11px] font-medium text-amber-800 hover:bg-amber-200 transition-colors"
          >
            <Play size={10} /> Continue
          </button>
        </div>
      )}
      {task.status === 'error' && task.error && (
        <div className={`mx-3 mb-3 rounded-xl border px-3 py-3 ${d ? 'border-red-200 bg-red-50' : 'border-red-800/30 bg-red-950/20'}`}>
          <div className={`text-[11px] font-semibold ${d ? 'text-red-700' : 'text-red-400'}`}>Error</div>
          <div className={`mt-1 text-[10px] ${d ? 'text-red-600' : 'text-red-500'}`}>{task.error}</div>
          <button
            type="button"
            onClick={() => resume(task.id, 'Retry')}
            className="mt-2 flex items-center gap-1.5 rounded-lg bg-red-100 px-3 py-1.5 text-[11px] font-medium text-red-700 hover:bg-red-200 transition-colors"
          >
            <Play size={10} /> Retry
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── Preview tab content ─────────────────────────────────────────────────── */

function PreviewContent({ task, isDayMode }) {
  const iframeRef = useRef(null);
  const [maximized, setMaximized] = useState(false);

  const rawPreviewHtml = (() => {
    if (task.artifact?.html) return task.artifact.html;
    const sections = task.artifactSections || [];
    if (sections.length === 0) return '';
    const fragments = sections.map((s) => s.html_fragment || '').filter(Boolean).join('\n');
    if (!fragments) return '';
    return `<!doctype html><html><head><meta charset="UTF-8"/><style>body{font-family:system-ui,sans-serif;margin:0;padding:40px;background:#f3efe7;color:#101010}section{margin-bottom:24px;padding:24px;border-radius:16px;background:#fff}${task.artifact?.css || ''}</style></head><body>${fragments}</body></html>`;
  })();
  const previewHtml = rawPreviewHtml
    ? normalizePreviewHtml(rawPreviewHtml, { title: task.artifact?.title || task.query || 'Artifact preview', css: task.artifact?.css || '' })
    : '';

  const hasPreview = Boolean(rawPreviewHtml.trim());

  useEffect(() => {
    if (hasPreview && iframeRef.current) {
      const doc = iframeRef.current.contentDocument || iframeRef.current.contentWindow?.document;
      if (doc) { doc.open(); doc.write(previewHtml); doc.close(); }
    }
  }, [previewHtml, hasPreview]);

  if (!hasPreview) {
    return (
      <div className="flex flex-1 items-center justify-center text-center">
        <div>
          <div className={`mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl ${isDayMode ? 'bg-gray-100' : 'bg-[#1e1e1e]'}`}>
            <Globe size={22} className={isDayMode ? 'text-gray-300' : 'text-[#3a3a3a]'} />
          </div>
          <div className={`text-[13px] font-medium ${isDayMode ? 'text-gray-400' : 'text-[#525252]'}`}>Preview</div>
          <div className={`mt-1 text-[11px] ${isDayMode ? 'text-gray-300' : 'text-[#3a3a3a]'}`}>
            {task.status === 'running' ? 'Generating artifact...' : 'No artifact yet'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-1 flex-col ${maximized ? 'fixed inset-0 z-50 bg-white' : ''}`}>
      <div className={`flex items-center justify-between px-3 py-2 border-b ${isDayMode ? 'border-gray-100' : 'border-[#1e1e1e]'}`}>
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${task.status === 'complete' ? 'bg-emerald-400' : 'bg-blue-400 animate-pulse'}`} />
          <span className={`text-[12px] font-medium ${isDayMode ? 'text-gray-700' : 'text-[#a1a1a1]'}`}>
            {task.artifact?.title || 'Artifact'}
          </span>
        </div>
        <button type="button" onClick={() => setMaximized((v) => !v)} className={`rounded-lg p-1.5 ${isDayMode ? 'text-gray-400 hover:bg-gray-50' : 'text-[#525252] hover:bg-[#1e1e1e]'}`}>
          {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>
      <div className="flex-1 overflow-hidden bg-[#f3efe7]">
        <iframe ref={iframeRef} title="preview" className="h-full w-full border-0" sandbox="allow-scripts allow-same-origin" />
      </div>
    </div>
  );
}

/* ─── Combined right panel with tabs ──────────────────────────────────────── */

function RightPanel({ task, onClose }) {
  const { isDayMode } = useBlaiqWorkspace();
  const d = isDayMode;
  const [tab, setTab] = useState('steps');

  // Auto-switch to preview when artifact arrives
  useEffect(() => {
    if (task.artifact?.html || (task.artifactSections || []).length > 0) {
      setTab('preview');
    }
  }, [task.artifact?.html, task.artifactSections?.length]);

  return (
    <div className={`flex h-full flex-col ${d ? 'bg-white' : 'bg-[#0f0f0f]'}`}>
      {/* Tab bar */}
      <div className={`flex items-center justify-between border-b px-3 py-2 ${d ? 'border-gray-100' : 'border-[#1e1e1e]'}`}>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTab('steps')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors ${
              tab === 'steps'
                ? d ? 'bg-blue-50 text-blue-700' : 'bg-blue-950/30 text-blue-400'
                : d ? 'text-gray-400 hover:bg-gray-50 hover:text-gray-600' : 'text-[#525252] hover:bg-[#1a1a1a] hover:text-[#a1a1a1]'
            }`}
          >
            <Clock size={12} /> Progress
          </button>
          <button
            type="button"
            onClick={() => setTab('preview')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors ${
              tab === 'preview'
                ? d ? 'bg-blue-50 text-blue-700' : 'bg-blue-950/30 text-blue-400'
                : d ? 'text-gray-400 hover:bg-gray-50 hover:text-gray-600' : 'text-[#525252] hover:bg-[#1a1a1a] hover:text-[#a1a1a1]'
            }`}
          >
            <Eye size={12} /> Preview
          </button>
        </div>
        <button type="button" onClick={onClose} className={`rounded-lg p-1.5 ${d ? 'text-gray-400 hover:bg-gray-50' : 'text-[#525252] hover:bg-[#1a1a1a]'}`}>
          <X size={14} />
        </button>
      </div>

      {/* Tab content */}
      {tab === 'steps' && <StepsContent task={task} isDayMode={d} />}
      {tab === 'preview' && <PreviewContent task={task} isDayMode={d} />}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   CENTER — Agent conversation
   ═══════════════════════════════════════════════════════════════════════════ */

function agentColor(agent) {
  const a = String(agent || '').toLowerCase();
  if (a.includes('strateg')) return { bg: 'bg-purple-100', text: 'text-purple-700', dark: 'bg-purple-900/20', darkText: 'text-purple-400' };
  if (a.includes('research')) return { bg: 'bg-cyan-100', text: 'text-cyan-700', dark: 'bg-cyan-900/20', darkText: 'text-cyan-400' };
  if (a.includes('visual') || a.includes('vangogh')) return { bg: 'bg-pink-100', text: 'text-pink-700', dark: 'bg-pink-900/20', darkText: 'text-pink-400' };
  if (a.includes('govern')) return { bg: 'bg-emerald-100', text: 'text-emerald-700', dark: 'bg-emerald-900/20', darkText: 'text-emerald-400' };
  return { bg: 'bg-gray-100', text: 'text-gray-700', dark: 'bg-[#1e1e1e]', darkText: 'text-[#a1a1a1]' };
}

function buildAgentStreams(messages) {
  const byAgent = new Map();

  for (const msg of messages) {
    if (!String(msg?.content || '').trim()) {
      continue;
    }
    const agent = msg.agent || 'System';
    if (!byAgent.has(agent)) {
      byAgent.set(agent, []);
    }
    byAgent.get(agent).push(msg);
  }

  const orderedAgents = [
    ...PREFERRED_AGENT_ORDER.filter((agent) => byAgent.has(agent)),
    ...Array.from(byAgent.keys()).filter((agent) => !PREFERRED_AGENT_ORDER.includes(agent)),
  ];

  return orderedAgents.map((agent) => ({
    agent,
    entries: byAgent.get(agent) || [],
  }));
}

function AgentStreamRow({ agent, entries, isDayMode, active, expanded, onToggle, visibleText }) {
  const d = isDayMode;
  const colors = agentColor(agent);
  const lastEntry = entries[entries.length - 1];

  return (
    <div className={`py-3 ${active ? (d ? 'text-gray-900' : 'text-white') : ''}`}>
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onToggle}
          className={`mt-0.5 rounded-full p-1 transition-colors ${d ? 'text-gray-400 hover:bg-gray-100' : 'text-[#5b5b5b] hover:bg-[#171717]'}`}
          aria-label={expanded ? `Collapse ${agent} logs` : `Expand ${agent} logs`}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        <div className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${d ? colors.bg : colors.dark}`}>
          {active ? <Loader2 size={14} className={`animate-spin ${d ? colors.text : colors.darkText}`} /> : <Bot size={14} className={d ? colors.text : colors.darkText} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-[12px] font-semibold ${d ? colors.text : colors.darkText}`}>{agent}</span>
            <span className={`text-[10px] ${d ? 'text-gray-400' : 'text-[#5b5b5b]'}`}>
              {lastEntry?.at ? new Date(lastEntry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}
            </span>
            {active ? (
              <span className={`text-[10px] ${d ? 'text-blue-500' : 'text-blue-300'}`}>live</span>
            ) : null}
          </div>
          <div className={`mt-1 text-[13px] leading-relaxed ${d ? 'text-gray-700' : 'text-[#d4d4d4]'}`}>
            {visibleText}
            {active ? <span className={`ml-0.5 inline-block h-[14px] w-[1px] animate-pulse align-middle ${d ? 'bg-blue-500' : 'bg-blue-300'}`} /> : null}
          </div>
          {expanded && entries.length > 1 ? (
            <div className={`mt-3 space-y-2 border-l pl-4 ${d ? 'border-gray-200' : 'border-[#242424]'}`}>
              {entries.map((entry) => (
                <div key={entry.id} className="space-y-0.5">
                  <div className={`text-[10px] ${d ? 'text-gray-400' : 'text-[#5b5b5b]'}`}>
                    {entry.at ? new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}
                  </div>
                  <div className={`text-[12px] leading-relaxed ${d ? 'text-gray-500' : 'text-[#a1a1a1]'}`}>{entry.content}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ConversationArea({ task }) {
  const { submit, isSubmitting, isDayMode, previewOpen, setPreviewOpen, hitl, updateHitlAnswer, updateHitlAnswerMode, updateHitlIndex, resume } = useBlaiqWorkspace();
  const [input, setInput] = useState('');
  const scrollRef = useRef(null);
  const d = isDayMode;

  const messages = task.messages || [];
  const userMessages = useMemo(() => messages.filter((msg) => msg.role === 'user'), [messages]);
  const agentMessages = useMemo(() => messages.filter((msg) => msg.role === 'agent'), [messages]);
  const finalAnswer = String(task.finalAnswer || '').trim();
  const [expandedAgents, setExpandedAgents] = useState({});
  const [renderedAgentMessages, setRenderedAgentMessages] = useState([]);
  const [typingState, setTypingState] = useState(null);
  const [renderedFinalAnswer, setRenderedFinalAnswer] = useState('');
  const [finalAnswerTyping, setFinalAnswerTyping] = useState('');
  const pendingQueueRef = useRef([]);
  const seenIdsRef = useRef(new Set());
  const typingTimerRef = useRef(null);
  const finalAnswerTimerRef = useRef(null);
  const questions = hitl?.questions || [];
  const currentIndex = Number.isFinite(hitl?.currentIndex) ? hitl.currentIndex : 0;
  const currentQuestion = questions[currentIndex] || null;
  const currentQuestionId = currentQuestion?.requirement_id || '';
  const currentQuestionAnswer = currentQuestionId ? (hitl?.answers?.[currentQuestionId] || '') : '';
  const currentQuestionMode = currentQuestionId ? (hitl?.answerModes?.[currentQuestionId] || 'option') : 'option';
  const currentQuestionOptions = Array.isArray(currentQuestion?.answer_options) && currentQuestion.answer_options.length > 0
    ? currentQuestion.answer_options
    : quickChips(currentQuestion?.question || '');

  useEffect(() => {
    setExpandedAgents({});
    setRenderedAgentMessages([]);
    setTypingState(null);
    setRenderedFinalAnswer('');
    setFinalAnswerTyping('');
    pendingQueueRef.current = [];
    seenIdsRef.current = new Set();
    if (typingTimerRef.current) {
      window.clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }
    if (finalAnswerTimerRef.current) {
      window.clearTimeout(finalAnswerTimerRef.current);
      finalAnswerTimerRef.current = null;
    }
  }, [task.id]);

  function handlePollNext() {
    if (!currentQuestionId) return;
    if (!String(currentQuestionAnswer || '').trim()) return;
    if (currentIndex < Math.max(questions.length - 1, 0)) {
      updateHitlIndex(task.id, currentIndex + 1);
      return;
    }
    resume(task.id, 'User answered HITL prompt');
  }

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [userMessages.length, renderedAgentMessages.length, typingState?.text]);

  useEffect(() => {
    const unseen = agentMessages.filter((msg) => !seenIdsRef.current.has(msg.id));
    if (unseen.length > 0) {
      unseen.forEach((msg) => {
        pendingQueueRef.current.push(msg);
        seenIdsRef.current.add(msg.id);
      });
    }
  }, [agentMessages]);

  useEffect(() => {
    if (typingState || pendingQueueRef.current.length === 0) {
      return undefined;
    }

    const next = pendingQueueRef.current.shift();
    const content = String(next.content || '');
    const isStrategic = next.agent === 'BLAIQ-CORE' || next.agent === 'Strategic Planner';
    const step = isStrategic ? 1 : 3;
    const delay = isStrategic ? 18 : 8;
    const startDelay = isStrategic ? 180 : 50;

    setTypingState({
      id: next.id,
      agent: next.agent || 'System',
      at: next.at,
      source: next,
      text: '',
      fullText: content,
      step,
      delay,
    });
    return undefined;
  }, [typingState, agentMessages.length]);

  useEffect(() => {
    if (!typingState) {
      return undefined;
    }

    const fullText = String(typingState.fullText || '');
    const currentText = String(typingState.text || '');
    const nextLength = Math.min(fullText.length, currentText.length + Number(typingState.step || 1));
    const nextText = fullText.slice(0, nextLength);
    const isComplete = nextLength >= fullText.length;
    const wait = currentText.length === 0
      ? (typingState.agent === 'BLAIQ-CORE' || typingState.agent === 'Strategic Planner' ? 180 : 50)
      : Number(typingState.delay || 12);

    typingTimerRef.current = window.setTimeout(() => {
      if (isComplete) {
        setRenderedAgentMessages((prev) => [...prev, { ...typingState.source, content: fullText }]);
        setTypingState(null);
        typingTimerRef.current = null;
        return;
      }
      setTypingState((prev) => prev ? { ...prev, text: nextText } : prev);
      typingTimerRef.current = null;
    }, wait);

    return () => {
      if (typingTimerRef.current) {
        window.clearTimeout(typingTimerRef.current);
        typingTimerRef.current = null;
      }
    };
  }, [typingState]);

  useEffect(() => () => {
    if (typingTimerRef.current) {
      window.clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }
    if (finalAnswerTimerRef.current) {
      window.clearTimeout(finalAnswerTimerRef.current);
      finalAnswerTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const canRenderFinalAnswer = (
      finalAnswer &&
      task.status === 'complete' &&
      !typingState &&
      pendingQueueRef.current.length === 0
    );

    if (!canRenderFinalAnswer) {
      return undefined;
    }

    if (renderedFinalAnswer === finalAnswer) {
      if (finalAnswerTyping !== finalAnswer) {
        setFinalAnswerTyping(finalAnswer);
      }
      return undefined;
    }

    if (finalAnswerTyping.length >= finalAnswer.length) {
      setRenderedFinalAnswer(finalAnswer);
      return undefined;
    }

    finalAnswerTimerRef.current = window.setTimeout(() => {
      const nextLength = Math.min(finalAnswer.length, finalAnswerTyping.length + 3);
      const nextText = finalAnswer.slice(0, nextLength);
      setFinalAnswerTyping(nextText);
      if (nextLength >= finalAnswer.length) {
        setRenderedFinalAnswer(finalAnswer);
      }
      finalAnswerTimerRef.current = null;
    }, finalAnswerTyping.length === 0 ? 180 : 18);

    return () => {
      if (finalAnswerTimerRef.current) {
        window.clearTimeout(finalAnswerTimerRef.current);
        finalAnswerTimerRef.current = null;
      }
    };
  }, [finalAnswer, finalAnswerTyping, renderedFinalAnswer, task.status, typingState]);

  const streams = useMemo(() => {
    const visibleMessages = typingState?.source && String(typingState?.text || '').trim()
      ? [...renderedAgentMessages, { ...typingState.source, content: typingState.text }]
      : renderedAgentMessages;
    return buildAgentStreams(visibleMessages);
  }, [renderedAgentMessages, typingState]);

  const hitlVisible = useMemo(() => {
    if (!(hitl?.open && currentQuestion)) {
      return false;
    }
    return streams.some((stream) => stream.agent === 'HITL Agent' && stream.entries.length > 0);
  }, [currentQuestion, hitl?.open, streams]);

  function toggleAgent(agent) {
    setExpandedAgents((prev) => ({
      ...prev,
      [agent]: !prev[agent],
    }));
  }

  function handleSend(e) {
    e?.preventDefault();
    if (!input.trim()) return;
    submit(input.trim());
    setInput('');
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Top bar */}
      <div className={`flex items-center justify-between border-b px-5 py-3 ${d ? 'border-gray-100' : 'border-[#1e1e1e]'}`}>
        <div className="flex items-center gap-2">
          {task.currentAgent && task.status === 'running' && (
            <span className="flex items-center gap-1.5 text-[12px] text-blue-500">
              <Loader2 size={12} className="animate-spin" /> {task.currentAgent}
            </span>
          )}
          {task.status === 'complete' && (
            <span className="flex items-center gap-1.5 text-[12px] text-emerald-500">
              <CheckCircle size={12} /> Complete
            </span>
          )}
          {!task.currentAgent && task.status === 'running' && (
            <span className={`text-[12px] ${d ? 'text-gray-400' : 'text-[#525252]'}`}>Processing...</span>
          )}
        </div>
        {!previewOpen && (
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors ${
              d ? 'text-gray-500 hover:bg-gray-50 hover:text-gray-700' : 'text-[#525252] hover:bg-[#1a1a1a] hover:text-[#a1a1a1]'
            }`}
          >
            <Eye size={12} /> Show panel
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-5">
          {userMessages.length > 0 ? (
            <div className="pb-4">
              <div className="mb-3 flex items-center gap-2">
                <div className={`flex h-8 w-8 items-center justify-center rounded-full ${d ? 'bg-gray-900 text-white' : 'bg-white text-black'}`}>
                  <User size={14} />
                </div>
                <div>
                  <div className={`text-[12px] font-semibold ${d ? 'text-gray-900' : 'text-white'}`}>You</div>
                  <div className={`text-[10px] ${d ? 'text-gray-400' : 'text-[#5b5b5b]'}`}>Task brief</div>
                </div>
              </div>
              <div className="space-y-2 pl-10">
                {userMessages.map((msg) => (
                  <div key={msg.id} className={`text-[14px] leading-relaxed ${d ? 'text-gray-900' : 'text-white'}`}>
                    {msg.content}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {streams.map((stream) => (
            <AgentStreamRow
              key={stream.agent}
              agent={stream.agent}
              entries={stream.entries}
              isDayMode={d}
              active={task.status === 'running' && task.currentAgent === stream.agent}
              expanded={Boolean(expandedAgents[stream.agent])}
              onToggle={() => toggleAgent(stream.agent)}
              visibleText={stream.entries[stream.entries.length - 1]?.content || ''}
            />
          ))}

          {finalAnswerTyping ? (
            <div className="pt-2">
              <div className={`pl-10 text-[15px] font-semibold leading-relaxed ${d ? 'text-gray-900' : 'text-white'}`}>
                {finalAnswerTyping}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Input */}
      <div className={`border-t px-6 py-4 ${d ? 'border-gray-100' : 'border-[#1e1e1e]'}`}>
        <div className="mx-auto max-w-2xl">
          <AnimatePresence mode="wait">
            {hitlVisible && (
              <motion.div
                key={currentQuestionId || 'hitl'}
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 12 }}
                transition={{ duration: 0.24, ease: 'easeOut' }}
                className={`mb-3 overflow-hidden rounded-2xl border shadow-sm ${d ? 'border-blue-100 bg-[#f8fbff]' : 'border-[#2a2a2a] bg-[#111827]'}`}
              >
                <div className="px-4 py-4">
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={currentQuestionId || currentQuestion.question}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.2, ease: 'easeOut' }}
                      className="space-y-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className={`text-[11px] font-mono uppercase tracking-[0.12em] ${d ? 'text-gray-400' : 'text-[#a1a1a1]'}`}>
                          Question {currentIndex + 1} / {questions.length || 1}
                        </div>
                        {questions.length > 1 ? (
                          <div className={`text-[11px] font-mono uppercase tracking-[0.12em] ${d ? 'text-gray-400' : 'text-[#a1a1a1]'}`}>
                            {Math.round(((currentIndex + 1) / questions.length) * 100)}%
                          </div>
                        ) : null}
                      </div>

                      <div>
                        <div className={`text-[13px] font-semibold leading-snug ${d ? 'text-gray-900' : 'text-white'}`}>
                          {currentQuestion.question}
                        </div>
                        {currentQuestion.why_it_matters ? (
                          <div className={`mt-1 text-[12px] leading-relaxed ${d ? 'text-gray-600' : 'text-[#a1a1a1]'}`}>
                            {currentQuestion.why_it_matters}
                          </div>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {currentQuestionOptions.map((option) => {
                          const selected = currentQuestionMode === 'option' && currentQuestionAnswer === option;
                          return (
                            <button
                              key={option}
                              type="button"
                              onClick={() => {
                                updateHitlAnswer(task.id, currentQuestionId, option);
                                updateHitlAnswerMode(task.id, currentQuestionId, 'option');
                              }}
                              className={`rounded-full border px-3 py-1.5 text-[12px] transition-colors ${
                                selected
                                  ? 'border-blue-500 bg-blue-500 text-white'
                                  : d
                                    ? 'border-gray-200 bg-white text-gray-700 hover:border-blue-200 hover:text-blue-600'
                                    : 'border-[#2a2a2a] bg-[#111827] text-[#d4d4d4] hover:border-blue-500 hover:text-white'
                              }`}
                            >
                              {option}
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          onClick={() => updateHitlAnswerMode(task.id, currentQuestionId, 'custom')}
                          className={`rounded-full border px-3 py-1.5 text-[12px] transition-colors ${
                            currentQuestionMode === 'custom'
                              ? 'border-blue-500 bg-blue-500 text-white'
                              : d
                                ? 'border-gray-200 bg-white text-gray-700 hover:border-blue-200 hover:text-blue-600'
                                : 'border-[#2a2a2a] bg-[#111827] text-[#d4d4d4] hover:border-blue-500 hover:text-white'
                          }`}
                        >
                          Type something else
                        </button>
                      </div>

                      <AnimatePresence mode="wait">
                        {currentQuestionMode === 'custom' ? (
                          <motion.div
                            key="custom-answer"
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                          >
                            <textarea
                              value={currentQuestionAnswer}
                              onChange={(e) => updateHitlAnswer(task.id, currentQuestionId, e.target.value)}
                              rows={3}
                              placeholder="Type your answer here..."
                              className={`w-full resize-none rounded-xl border px-3 py-2.5 text-[13px] outline-none ${
                                d
                                  ? 'border-gray-200 bg-white text-gray-900 placeholder-gray-400 focus:border-blue-300'
                                  : 'border-[#2a2a2a] bg-[#0f172a] text-white placeholder-[#525252] focus:border-blue-500'
                              }`}
                            />
                          </motion.div>
                        ) : null}
                      </AnimatePresence>

                      <div className="flex items-center justify-between gap-3 border-t border-opacity-40 pt-3" style={{ borderColor: d ? '#dbeafe' : '#2a2a2a' }}>
                        <div className={`text-[11px] ${d ? 'text-gray-500' : 'text-[#a1a1a1]'}`}>
                          {currentQuestionMode === 'custom' ? 'Type a response or pick an option.' : 'Select an option or switch to custom input.'}
                        </div>
                        <button
                          type="button"
                          onClick={handlePollNext}
                          disabled={!String(currentQuestionAnswer || '').trim()}
                          className={`rounded-lg px-4 py-2 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                            d ? 'bg-gray-900 text-white hover:bg-gray-700' : 'bg-white text-black hover:bg-gray-200'
                          }`}
                        >
                          {currentIndex < Math.max(questions.length - 1, 0) ? 'Next' : 'Continue'}
                        </button>
                      </div>
                    </motion.div>
                  </AnimatePresence>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

        <form onSubmit={handleSend} className="mx-auto max-w-2xl">
          <div className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 shadow-sm transition-all focus-within:ring-2 ${
            d ? 'border-gray-200 bg-white focus-within:ring-blue-100' : 'border-[#2a2a2a] bg-[#141414] focus-within:ring-blue-900/30'
          }`}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Send a message..."
              className={`flex-1 border-0 bg-transparent text-[14px] outline-none ${d ? 'text-gray-900 placeholder-gray-400' : 'text-white placeholder-[#525252]'}`}
              disabled={isSubmitting}
            />
            <button
              type="submit"
              disabled={!input.trim() || isSubmitting}
              className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                d ? 'bg-gray-900 text-white hover:bg-gray-700 disabled:bg-gray-200 disabled:text-gray-400'
                  : 'bg-white text-black hover:bg-gray-200 disabled:bg-[#1e1e1e] disabled:text-[#525252]'
              }`}
            >
              {isSubmitting ? <Loader2 size={12} className="animate-spin" /> : <ArrowUp size={12} />}
            </button>
          </div>
        </form>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   EMPTY STATE — "What can I do for you?"
   ═══════════════════════════════════════════════════════════════════════════ */

function EmptyState({ onSubmit, query, setQuery, isSubmitting }) {
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const { isDayMode } = useBlaiqWorkspace();
  const d = isDayMode;

  function handleSubmit(e) {
    e?.preventDefault();
    if (query.trim()) onSubmit(query.trim());
  }

  async function handleFileUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await uploadFile(file, 'default', null);
      setQuery((prev) => prev ? `${prev} (uploaded: ${file.name})` : `Analyze ${file.name}`);
    } catch { /* ignore */ }
  }

  const quickActions = [
    { icon: Sparkles, label: 'Create slides', hint: 'Create a professional pitch deck presentation' },
    { icon: Globe, label: 'Build website', hint: 'Design a modern landing page' },
    { icon: Search, label: 'Research', hint: 'Research and create a comprehensive overview of' },
    { icon: FileUp, label: 'Analyze document', hint: 'Analyze the uploaded document and create a summary' },
  ];

  return (
    <div className={`flex h-full flex-col items-center justify-center px-6 ${d ? '' : 'bg-[#0a0a0a]'}`}>
      <div className="w-full max-w-2xl">
        <h1 className={`mb-10 text-center text-[32px] font-semibold ${d ? 'text-gray-900' : 'text-white'}`}>
          What can I do for you?
        </h1>

        <form onSubmit={handleSubmit}>
          <div className={`overflow-hidden rounded-2xl border shadow-sm transition-all focus-within:shadow-md focus-within:ring-2 ${
            d ? 'border-gray-200 bg-white focus-within:ring-blue-100' : 'border-[#2a2a2a] bg-[#141414] focus-within:ring-blue-900/30'
          }`}>
            <textarea
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
              placeholder="Assign a task or ask anything"
              className={`w-full resize-none border-0 bg-transparent px-5 pt-5 pb-2 text-[15px] outline-none ${
                d ? 'text-gray-900 placeholder-gray-400' : 'text-white placeholder-[#525252]'
              }`}
              rows={3}
              disabled={isSubmitting}
            />
            <div className="flex items-center justify-between px-4 pb-3">
              <div className="flex items-center gap-0.5">
                <button type="button" onClick={() => fileRef.current?.click()} className={`rounded-lg p-2 ${d ? 'text-gray-400 hover:bg-gray-100' : 'text-[#525252] hover:bg-[#1e1e1e]'}`}>
                  <Paperclip size={16} />
                </button>
                <button type="button" className={`rounded-lg p-2 ${d ? 'text-gray-400 hover:bg-gray-100' : 'text-[#525252] hover:bg-[#1e1e1e]'}`}>
                  <Globe size={16} />
                </button>
                <button type="button" className={`rounded-lg p-2 ${d ? 'text-gray-400 hover:bg-gray-100' : 'text-[#525252] hover:bg-[#1e1e1e]'}`}>
                  <MessageSquare size={16} />
                </button>
              </div>
              <button
                type="submit"
                disabled={!query.trim() || isSubmitting}
                className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                  d ? 'bg-gray-900 text-white hover:bg-gray-700 disabled:bg-gray-200 disabled:text-gray-400'
                    : 'bg-white text-black hover:bg-gray-200 disabled:bg-[#1e1e1e] disabled:text-[#525252]'
                }`}
              >
                {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={14} />}
              </button>
            </div>
          </div>
          <input ref={fileRef} type="file" className="hidden" onChange={handleFileUpload} />
        </form>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {quickActions.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={() => setQuery(a.hint)}
              className={`flex items-center gap-2 rounded-full border px-4 py-2 text-[13px] transition-all ${
                d ? 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                  : 'border-[#2a2a2a] bg-[#141414] text-[#a1a1a1] hover:border-[#3a3a3a] hover:bg-[#1e1e1e]'
              }`}
            >
              <a.icon size={14} /> {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   ACTIVE TASK VIEW — Center (conversation) + Right (steps + preview)
   ═══════════════════════════════════════════════════════════════════════════ */

function ActiveTaskView({ task }) {
  const { previewOpen, setPreviewOpen } = useBlaiqWorkspace();

  // Auto-open right panel on first event
  useEffect(() => {
    if (task.events.length > 0 && !previewOpen) setPreviewOpen(true);
  }, [task.events.length]);

  return (
    <div className="flex h-full flex-1 overflow-hidden">
      {/* Center — conversation */}
      <ConversationArea task={task} />

      {/* Right — steps + preview panel */}
      {previewOpen && (
        <div className="w-[380px] flex-shrink-0 border-l border-gray-100 dark:border-[#1e1e1e]">
          <RightPanel task={task} onClose={() => setPreviewOpen(false)} />
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN
   ═══════════════════════════════════════════════════════════════════════════ */

export default function Chat() {
  const { activeTask, query, setQuery, submit, isSubmitting } = useBlaiqWorkspace();

  if (!activeTask) {
    return <EmptyState query={query} setQuery={setQuery} onSubmit={submit} isSubmitting={isSubmitting} />;
  }

  return <ActiveTaskView task={activeTask} />;
}
