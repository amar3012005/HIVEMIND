import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  ArrowRight,
  BrainCircuit,
  Clock3,
  Eye,
  Network,
  Search,
  ShieldCheck,
  Sparkles,
  Zap,
} from 'lucide-react';
import { GlassBlogCard } from '@/components/ui/glass-blog-card-shadcnui';
import { useBlaiqWorkspace } from '../shared/blaiq-workspace-context';

const agentCatalog = [
  {
    id: 'core',
    title: 'Core',
    excerpt: 'Orchestrates the workflow, manages HITL, and keeps the mission state coherent end to end.',
    image: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=1200&q=80',
    author: { name: 'BLAIQ Control', avatar: 'https://images.unsplash.com/photo-1545239351-1141bd82e8a6?w=200&q=80' },
    date: 'Orchestration Layer',
    readTime: 'Core',
    tags: ['Core', 'Routing', 'HITL'],
    icon: Activity,
    capability: 'Mission control and workflow coordination',
    details: [
      'Receives user submissions, routes agents, and keeps the active mission legible.',
      'Owns HITL transitions, timeline state, and the final handoff back to the browser.',
      'Coordinates GraphRAG, Vangogh, and Governance as one workflow rather than separate tools.',
    ],
  },
  {
    id: 'strategist',
    title: 'Strategist',
    excerpt: 'Classifies intent, locks the workflow route, and determines which system should own the run.',
    image: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=1200&q=80',
    author: { name: 'BLAIQ Core', avatar: 'https://images.unsplash.com/photo-1545239351-1141bd82e8a6?w=200&q=80' },
    date: 'Routing Layer',
    readTime: 'Planner',
    tags: ['Routing', 'Intent', 'Policy'],
    icon: BrainCircuit,
    capability: 'Strategy and orchestration',
    details: [
      'Determines whether the request is retrieval, generation, or clarification-heavy.',
      'Assigns primary and helper agents before execution starts.',
      'Keeps the workflow legible for the operator and downstream systems.',
    ],
  },
  {
    id: 'graphrag',
    title: 'GraphRAG',
    excerpt: 'Fetches textual evidence from graph, vector, and keyword sources with tenant-scoped retrieval.',
    image: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=1200&q=80',
    author: { name: 'Knowledge Fabric', avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200&q=80' },
    date: 'Evidence Layer',
    readTime: 'Retriever',
    tags: ['Neo4j', 'Qdrant', 'Evidence'],
    icon: Search,
    capability: 'Retrieval and synthesis context',
    details: [
      'Retrieves ranked chunks, graph relationships, and evidence summaries.',
      'Handles textual analysis, revenue questions, and historical context retrieval.',
      'Feeds downstream renderers or replies with grounded evidence.',
    ],
  },
  {
    id: 'vangogh',
    title: 'Vangogh',
    excerpt: 'Transforms approved structure into premium artifacts, previews, sections, and render-ready outputs.',
    image: 'https://images.unsplash.com/photo-1516321497487-e288fb19713f?w=1200&q=80',
    author: { name: 'Artifact Studio', avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=200&q=80' },
    date: 'Rendering Layer',
    readTime: 'Creative',
    tags: ['Preview', 'Sections', 'Artifacts'],
    icon: Eye,
    capability: 'Rendering and artifact composition',
    details: [
      'Builds templates, sections, and live preview states for decks and posters.',
      'Streams section progress so operators can inspect what is being produced.',
      'Works only after routing, evidence, and clarification are ready.',
    ],
  },
  {
    id: 'content_director',
    title: 'Content Director',
    excerpt: 'Turns evidence and user constraints into a section-by-section content plan before rendering.',
    image: 'https://images.unsplash.com/photo-1517048676732-d65bc937f952?w=1200&q=80',
    author: { name: 'Content Studio', avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200&q=80' },
    date: 'Planning Layer',
    readTime: 'Director',
    tags: ['Planning', 'Templates', 'HITL'],
    icon: Sparkles,
    capability: 'Content distribution and render brief generation',
    details: [
      'Transforms requirements into a page-by-page or section-by-section brief.',
      'Decides how templates, evidence, and user answers should be distributed.',
      'Feeds Vangogh with a renderer-ready brief before final composition.',
    ],
  },
  {
    id: 'governance',
    title: 'Governance',
    excerpt: 'Applies review, safety, and policy checks before the output is finalized or handed back to the user.',
    image: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=1200&q=80',
    author: { name: 'Policy Engine', avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=200&q=80' },
    date: 'Control Layer',
    readTime: 'Validation',
    tags: ['Review', 'Rules', 'Checks'],
    icon: ShieldCheck,
    capability: 'Policy and release control',
    details: [
      'Evaluates schema quality, policy adherence, and output readiness.',
      'Signals pass/fail posture for operator review.',
      'Keeps the system auditable after rendering or retrieval completes.',
    ],
  },
  {
    id: 'memory',
    title: 'Memory',
    excerpt: 'Keeps browser-held context, session continuity, and long-run thread awareness aligned with CORE.',
    image: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=1200&q=80',
    author: { name: 'Session Fabric', avatar: 'https://images.unsplash.com/photo-1511367461989-f85a21fda167?w=200&q=80' },
    date: 'Context Layer',
    readTime: 'State',
    tags: ['Session', 'History', 'Context'],
    icon: Network,
    capability: 'Conversation continuity',
    details: [
      'Preserves session continuity across long-lived conversations.',
      'Stores browser-side history and passes it to CORE when the user resumes work.',
      'Maintains coherence between chat, preview, plan, and downstream agents.',
    ],
  },
  {
    id: 'composer',
    title: 'Composer',
    excerpt: 'Shapes the final response surface, merges section-level outputs, and readies the user-facing delivery.',
    image: 'https://images.unsplash.com/photo-1516321165247-4aa89a48be28?w=1200&q=80',
    author: { name: 'Delivery Layer', avatar: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=200&q=80' },
    date: 'Assembly Layer',
    readTime: 'Finalizer',
    tags: ['Compose', 'Assembly', 'Delivery'],
    icon: Sparkles,
    capability: 'Final assembly and presentation',
    details: [
      'Packages the run into a user-visible response surface.',
      'Turns section outputs into coherent artifact or assistant presentation.',
      'Keeps the handoff clean between generation and final viewing.',
    ],
  },
];

function normalizeAgentName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function formatTime(at) {
  if (!at) return 'Pending';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return String(at);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function AgentStatusPill({ active, label }) {
  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${
        active
          ? 'border-[#FF5C4B]/30 bg-[#FF5C4B]/10 text-[#8A2F25]'
          : 'border-[#000000]/10 bg-white/70 text-[#4B4B4B]'
      }`}
    >
      <span className="relative flex h-2.5 w-2.5">
        <span
          className={`absolute inline-flex h-full w-full rounded-full ${
            active ? 'animate-ping bg-[#FF5C4B]/70' : 'bg-[#B9B1A4]'
          }`}
        />
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${active ? 'bg-[#FF5C4B]' : 'bg-[#B9B1A4]'}`} />
      </span>
      {label}
    </div>
  );
}

export default function AgentSwarm() {
  const { activeAgents, routingDecision, renderState, hitl, timeline, messages } = useBlaiqWorkspace();
  const [selectedAgentId, setSelectedAgentId] = useState('strategist');
  const [liveAgents, setLiveAgents] = useState([]);
  const [liveAgentsError, setLiveAgentsError] = useState('');

  useEffect(() => {
    let alive = true;

    async function loadLiveAgents() {
      try {
        const response = await fetch('/api/v1/agents/live', {
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error(`Failed to load live agents: ${response.status}`);
        }
        const data = await response.json();
        if (!alive) return;
        const nextAgents = Array.isArray(data?.agents) ? data.agents : [];
        setLiveAgents(
          nextAgents.some((agent) => normalizeAgentName(agent.name).includes('core'))
            ? nextAgents
            : [
                ...nextAgents,
                {
                  name: 'core',
                  protocol: 'internal',
                  capabilities: ['routing', 'orchestration', 'hitl', 'state'],
                  supports_stream: true,
                  base_url: null,
                  ws_live: true,
                  rest_live: true,
                  is_live: true,
                  rest_error: null,
                },
              ]
        );
        setLiveAgentsError('');
      } catch (err) {
        if (!alive) return;
        setLiveAgentsError(err instanceof Error ? err.message : 'Failed to load live agents');
      }
    }

    loadLiveAgents();
    const timer = window.setInterval(loadLiveAgents, 10000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const normalizedActiveAgents = useMemo(
    () => activeAgents.map((agent) => normalizeAgentName(agent)),
    [activeAgents]
  );

  const normalizedLiveAgents = useMemo(
    () => liveAgents.map((agent) => normalizeAgentName(agent.name)),
    [liveAgents]
  );

  const cards = useMemo(
    () =>
      agentCatalog.map((agent) => {
        const active = normalizedActiveAgents.some((name) => name.includes(agent.id));
        const live = normalizedLiveAgents.some((name) => name.includes(agent.id));
        return {
          ...agent,
          active: active || live,
          live,
          status: live ? 'Live now' : active ? 'Running' : 'Standby',
        };
      }),
    [normalizedActiveAgents, normalizedLiveAgents]
  );

  const selectedAgent =
    cards.find((agent) => agent.id === selectedAgentId) || cards[0];

  const workflowStages = [
      {
        id: 'strategist',
        label: 'Strategist',
        active: normalizedActiveAgents.some((name) => name.includes('strategist')) || normalizedLiveAgents.some((name) => name.includes('strategist')),
        detail: routingDecision?.reasoning || 'Awaiting route selection.',
        time: formatTime(timeline.find((item) => /strategy|routing/i.test(item.label || ''))?.at),
        icon: BrainCircuit,
      },
      {
        id: 'graphrag',
        label: 'GraphRAG',
        active: normalizedActiveAgents.some((name) => name.includes('graphrag')) || normalizedLiveAgents.some((name) => name.includes('graphrag')),
        detail: messages.some((item) => String(item.content || '').toLowerCase().includes('evidence'))
          ? 'Evidence pass completed or in progress.'
          : 'No evidence summary yet.',
        time: formatTime(timeline.find((item) => /graph|evidence/i.test(item.label || ''))?.at),
        icon: Search,
    },
      {
        id: 'vangogh',
        label: 'Vangogh',
        active: normalizedActiveAgents.some((name) => name.includes('vangogh')) || normalizedLiveAgents.some((name) => name.includes('vangogh')),
        detail: renderState.loading
          ? renderState.label || 'Rendering in progress.'
          : 'No active artifact rendering.',
        time: formatTime(timeline.find((item) => /render|artifact|section/i.test(item.label || ''))?.at),
        icon: Eye,
    },
      {
        id: 'governance',
        label: 'Governance',
        active: normalizedActiveAgents.some((name) => name.includes('governance')) || normalizedLiveAgents.some((name) => name.includes('governance')),
        detail: timeline.some((item) => /governance|policy/i.test(item.label || ''))
          ? 'Review path has been engaged.'
          : 'Waiting for final review stage.',
        time: formatTime(timeline.find((item) => /governance|policy/i.test(item.label || ''))?.at),
        icon: ShieldCheck,
    },
  ];

  const recentSignals = [
    {
      label: 'Primary route',
      value: routingDecision?.primary_agent || 'Not assigned',
      icon: ArrowRight,
    },
    {
      label: 'Helper agents',
      value: routingDecision?.helper_agents?.join(', ') || 'None',
      icon: Zap,
    },
    {
      label: 'Pending HITL',
      value: hitl.open ? `${hitl.questions.length} question${hitl.questions.length === 1 ? '' : 's'}` : 'No',
      icon: Activity,
    },
    {
      label: 'Render state',
      value: renderState.loading ? renderState.label || 'Running' : 'Idle',
      icon: Clock3,
    },
    {
      label: 'Live registry',
      value: liveAgents.length ? `${liveAgents.length} agents` : 'Loading...',
      icon: Network,
    },
  ];

  return (
    <div className="h-full overflow-y-auto bg-[#E4DED2] text-[#111111] light-scrollbar">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-8 px-5 py-6 md:px-8 xl:px-10">
        <section className="grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_380px]">
          <div className="rounded-[2rem] border border-black/8 bg-[#F6F4F1]/92 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.06)] md:p-8">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-3xl">
                <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-black/10 bg-white/70 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.24em] text-[#6E675D]">
                  <span className="h-2 w-2 rounded-full bg-[#FF5C4B]" />
                  Agents
                </div>
                <h1 className="text-3xl font-semibold tracking-[-0.04em] text-[#111111] md:text-5xl">
                  BLAIQ operator surfaces for routing, retrieval, rendering, and control.
                </h1>
                <p className="mt-4 max-w-2xl text-sm leading-7 text-[#5E5850] md:text-[15px]">
                  This page tracks which agents exist, which one is live, and how the run is
                  moving through the backend workflow. Use the cards to inspect each system as a
                  product surface, not just a status label.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {recentSignals.map(({ label, value, icon: Icon }) => (
                  <div
                    key={label}
                    className="min-w-[180px] rounded-[1.4rem] border border-black/8 bg-white/80 px-4 py-3"
                  >
                    <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[#7A7267]">
                      <Icon size={13} />
                      {label}
                    </div>
                    <div className="mt-2 text-sm font-medium text-[#111111]">{value}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-[2rem] border border-black/8 bg-[#121212] p-6 text-white shadow-[0_24px_80px_rgba(0,0,0,0.12)]">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[11px] uppercase tracking-[0.2em] text-white/45">
                  Live Workflow
                </div>
                <div className="mt-2 text-2xl font-semibold tracking-[-0.04em]">
                  Active pipeline
                </div>
              </div>
              <AgentStatusPill
                active={cards.some((agent) => agent.live)}
                label={cards.some((agent) => agent.live) ? 'Live agents' : 'Loading'}
              />
            </div>

            {liveAgentsError && (
              <div className="mt-4 rounded-[1rem] border border-[#FF5C4B]/20 bg-[#FF5C4B]/8 px-4 py-3 text-xs text-[#FF5C4B]">
                {liveAgentsError}
              </div>
            )}

            <div className="mt-6 space-y-3">
              {workflowStages.map(({ id, label, active, detail, time, icon: Icon }) => (
                <motion.div
                  key={id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`rounded-[1.4rem] border px-4 py-3 ${
                    active
                      ? 'border-[#FF5C4B]/30 bg-[#FF5C4B]/10'
                      : 'border-white/10 bg-white/[0.03]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div
                        className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-2xl ${
                          active ? 'bg-[#FF5C4B] text-white' : 'bg-white/8 text-white/70'
                        }`}
                      >
                        <Icon size={16} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <div className="text-sm font-semibold">{label}</div>
                          {active && (
                            <span className="inline-flex h-2.5 w-2.5 rounded-full bg-[#FF5C4B] shadow-[0_0_18px_rgba(255,92,75,0.9)]" />
                          )}
                        </div>
                        <div className="mt-1 text-xs leading-6 text-white/58">{detail}</div>
                      </div>
                    </div>
                    <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-white/45">
                      {time}
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-[2rem] border border-black/8 bg-[#F6F4F1]/92 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.06)] md:p-8">
            <div className="mb-6 flex items-end justify-between gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-[0.2em] text-[#7A7267]">
                  Agent Directory
                </div>
                <div className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-[#111111]">
                  Product-grade operator cards
                </div>
              </div>
              <div className="text-sm text-[#6C655B]">
                Select a card to inspect its role in the BLAIQ Core workflow.
              </div>
            </div>

            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
              {cards.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => setSelectedAgentId(agent.id)}
                  className="text-left"
                >
                  <GlassBlogCard
                    title={agent.title}
                    excerpt={agent.excerpt}
                    image={agent.image}
                    author={agent.author}
                    date={agent.date}
                    readTime={agent.active ? 'Live now' : agent.readTime}
                    tags={agent.tags}
                    className={`max-w-none transition-transform duration-300 ${
                      selectedAgentId === agent.id ? 'scale-[1.01]' : ''
                    }`}
                  />
                </button>
              ))}
            </div>
          </div>

          <aside className="rounded-[2rem] border border-black/8 bg-white/78 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.06)] backdrop-blur-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.2em] text-[#7A7267]">
                  Agent Detail
                </div>
                <div className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-[#111111]">
                  {selectedAgent.title}
                </div>
              </div>
              <AgentStatusPill
                active={selectedAgent.active}
                label={selectedAgent.active ? 'Live agent' : 'Available'}
              />
            </div>

            <div className="mt-6 flex items-center gap-3 rounded-[1.4rem] border border-black/8 bg-[#F6F4F1] p-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-[1rem] bg-[#111111] text-white">
                <selectedAgent.icon size={20} />
              </div>
              <div>
                <div className="text-sm font-semibold text-[#111111]">{selectedAgent.capability}</div>
                <div className="text-xs text-[#6C655B]">{selectedAgent.date}</div>
              </div>
            </div>

            <div className="mt-6 space-y-3">
              {selectedAgent.details.map((detail) => (
                <div
                  key={detail}
                  className="rounded-[1.2rem] border border-black/8 bg-white px-4 py-3 text-sm leading-7 text-[#4D473F]"
                >
                  {detail}
                </div>
              ))}
            </div>

            <div className="mt-6 rounded-[1.5rem] bg-[#111111] p-5 text-white">
              <div className="text-[11px] uppercase tracking-[0.18em] text-white/45">
                Runtime summary
              </div>
              <div className="mt-3 text-sm leading-7 text-white/70">
                Primary agent: <span className="font-medium text-white">{routingDecision?.primary_agent || 'Pending'}</span>
                <br />
                Helpers: <span className="font-medium text-white">{routingDecision?.helper_agents?.join(', ') || 'None'}</span>
                <br />
                HITL: <span className="font-medium text-white">{hitl.open ? 'Waiting on answers' : 'Clear'}</span>
                <br />
                Rendering: <span className="font-medium text-white">{renderState.loading ? renderState.label || 'In progress' : 'Idle'}</span>
              </div>
            </div>
          </aside>
        </section>
      </div>
    </div>
  );
}
