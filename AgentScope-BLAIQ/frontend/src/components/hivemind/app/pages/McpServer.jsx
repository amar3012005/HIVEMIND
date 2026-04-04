import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import ApiKeyPrompt from '../shared/ApiKeyPrompt';
import {
  Server, Copy, Check, ChevronDown, ChevronRight,
  Brain, Search, Globe, Trash2, RefreshCw, BookOpen,
  Zap, Link2, MessageSquare, FileText, Network,
  HelpCircle, Terminal, Clipboard,
} from 'lucide-react';

/* ─── Animation ──────────────────────────────────────────────────── */
const fadeUp = { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 } };
const stagger = { animate: { transition: { staggerChildren: 0.04 } } };

/* ─── Copy button ────────────────────────────────────────────────── */
function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-['Space_Grotesk'] font-medium transition-all border border-[#e3e0db] hover:border-[#117dff]/30 bg-white text-[#525252] hover:text-[#117dff]"
    >
      {copied ? <><Check size={12} className="text-[#16a34a]" /> Copied</> : <><Copy size={12} /> {label}</>}
    </button>
  );
}

/* ─── Tool card ──────────────────────────────────────────────────── */
function ToolCard({ tool }) {
  const [open, setOpen] = useState(false);
  const Icon = tool.icon;
  return (
    <motion.div variants={fadeUp} className="bg-white border border-[#e3e0db] rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.04)] overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-[#faf9f4]/50 transition-colors"
      >
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${tool.colorClass}`}>
          <Icon size={14} className="text-current" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold font-['Space_Grotesk'] text-[#0a0a0a] truncate">
            {tool.name}
          </p>
          <p className="text-[11px] text-[#a3a3a3] font-['Space_Grotesk'] truncate">{tool.summary}</p>
        </div>
        {tool.badge && (
          <span className={`px-2 py-0.5 rounded-md text-[10px] font-semibold font-mono uppercase tracking-wider border ${tool.badgeClass}`}>
            {tool.badge}
          </span>
        )}
        {open ? <ChevronDown size={14} className="text-[#a3a3a3] shrink-0" /> : <ChevronRight size={14} className="text-[#a3a3a3] shrink-0" />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 border-t border-[#e3e0db]/50">
              <p className="text-xs text-[#525252] font-['Space_Grotesk'] mt-3 leading-relaxed">{tool.description}</p>
              {tool.params && (
                <div className="mt-3">
                  <p className="text-[10px] text-[#a3a3a3] font-mono uppercase tracking-wider mb-1.5">Parameters</p>
                  <div className="bg-[#faf9f4] border border-[#e3e0db] rounded-lg p-3 space-y-1.5">
                    {tool.params.map(p => (
                      <div key={p.name} className="flex items-start gap-2">
                        <code className="text-[11px] font-mono text-[#117dff] shrink-0">{p.name}</code>
                        {p.required && <span className="text-[9px] text-[#dc2626] font-mono mt-0.5">*</span>}
                        <span className="text-[11px] text-[#525252] font-['Space_Grotesk']">{p.desc}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {tool.example && (
                <div className="mt-3">
                  <p className="text-[10px] text-[#a3a3a3] font-mono uppercase tracking-wider mb-1.5">Example</p>
                  <div className="relative">
                    <pre className="bg-[#1e1e2e] text-[#cdd6f4] text-[11px] font-mono rounded-lg p-3 overflow-x-auto leading-relaxed">
                      {tool.example}
                    </pre>
                    <div className="absolute top-2 right-2">
                      <CopyButton text={tool.example} label="" />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* ─── Tool data ──────────────────────────────────────────────────── */
const MEMORY_TOOLS = [
  {
    name: 'hivemind_save_memory',
    icon: Brain,
    colorClass: 'bg-[#117dff]/10 text-[#117dff]',
    summary: 'Save facts, code, decisions to persistent memory',
    description: 'Use when the user shares a fact, preference, decision, code snippet, or anything worth remembering across sessions. Always tag memories for precise future retrieval.',
    params: [
      { name: 'title', required: true, desc: 'Short descriptive title' },
      { name: 'content', required: true, desc: 'The content to remember' },
      { name: 'tags', required: false, desc: 'Array of topic tags (e.g. ["react", "api-design"])' },
      { name: 'source_type', required: false, desc: 'text | code | conversation | documentation | decision' },
      { name: 'project', required: false, desc: 'Project this belongs to' },
      { name: 'relationship', required: false, desc: 'update | extend | derive — relation to existing memory' },
      { name: 'related_to', required: false, desc: 'Memory ID this relates to' },
    ],
    example: `hivemind_save_memory({
  title: "Prefers Tailwind over CSS modules",
  content: "User confirmed they use Tailwind CSS for all projects. Avoid suggesting CSS modules.",
  tags: ["preference", "css", "tailwind"],
  source_type: "decision"
})`,
  },
  {
    name: 'hivemind_recall',
    icon: Search,
    colorClass: 'bg-[#16a34a]/10 text-[#16a34a]',
    summary: 'Search memories — call FIRST before answering questions',
    description: 'Use to find previously stored information. Call this FIRST if the user references past conversations, preferences, or stored knowledge. Supports three search modes.',
    params: [
      { name: 'query', required: true, desc: 'Describe what you\'re looking for' },
      { name: 'mode', required: false, desc: 'quick (fast) | panorama (temporal) | insight (AI-powered)' },
      { name: 'limit', required: false, desc: 'Max results (1-20, default 5)' },
      { name: 'tags', required: false, desc: 'Filter by tags' },
      { name: 'project', required: false, desc: 'Filter by project' },
    ],
    example: `hivemind_recall({
  query: "user's preferred tech stack",
  mode: "quick",
  limit: 5
})`,
  },
  {
    name: 'hivemind_get_memory',
    icon: FileText,
    colorClass: 'bg-[#117dff]/10 text-[#117dff]',
    summary: 'Get full memory by ID',
    description: 'Use when you have a memory ID and need the complete content.',
    params: [{ name: 'memory_id', required: true, desc: 'The unique memory ID' }],
    example: `hivemind_get_memory({ memory_id: "abc-123" })`,
  },
  {
    name: 'hivemind_list_memories',
    icon: BookOpen,
    colorClass: 'bg-[#117dff]/10 text-[#117dff]',
    summary: 'Browse memories with filters and pagination',
    description: 'Use when the user asks "show me my memories about X" or wants to browse.',
    params: [
      { name: 'tags', required: false, desc: 'Filter by tags' },
      { name: 'project', required: false, desc: 'Filter by project' },
      { name: 'limit', required: false, desc: 'Max results (1-100)' },
      { name: 'page', required: false, desc: 'Page number' },
    ],
    example: `hivemind_list_memories({ tags: ["react"], limit: 10 })`,
  },
  {
    name: 'hivemind_update_memory',
    icon: RefreshCw,
    colorClass: 'bg-[#d97706]/10 text-[#d97706]',
    summary: 'Correct or modify a stored memory',
    description: 'Use when a stored fact is outdated and needs correction.',
    params: [
      { name: 'memory_id', required: true, desc: 'Memory ID to update' },
      { name: 'title', required: false, desc: 'New title' },
      { name: 'content', required: false, desc: 'New content' },
      { name: 'tags', required: false, desc: 'New tags (replaces existing)' },
    ],
    example: `hivemind_update_memory({ memory_id: "abc-123", content: "Updated fact" })`,
  },
  {
    name: 'hivemind_delete_memory',
    icon: Trash2,
    colorClass: 'bg-[#dc2626]/10 text-[#dc2626]',
    summary: 'Permanently delete a memory',
    description: 'Use only when the user explicitly asks to forget something. Deletion is permanent.',
    params: [
      { name: 'memory_id', required: true, desc: 'Memory ID to delete' },
      { name: 'reason', required: false, desc: 'Reason for deletion (audit log)' },
    ],
    example: `hivemind_delete_memory({ memory_id: "abc-123", reason: "user requested" })`,
  },
  {
    name: 'hivemind_save_conversation',
    icon: MessageSquare,
    colorClass: 'bg-[#117dff]/10 text-[#117dff]',
    summary: 'Save a conversation summary to memory',
    description: 'Use at the end of meaningful conversations. Summarise — don\'t dump raw transcripts.',
    params: [
      { name: 'title', required: true, desc: 'Conversation topic' },
      { name: 'messages', required: true, desc: 'Array of { role, content } messages' },
      { name: 'tags', required: false, desc: 'Tags for this conversation' },
      { name: 'platform', required: false, desc: 'claude | cursor | chatgpt | other' },
    ],
    example: `hivemind_save_conversation({
  title: "Discussed Q3 roadmap priorities",
  messages: [
    { role: "user", content: "What should we focus on?" },
    { role: "assistant", content: "Based on memory, priority is..." }
  ],
  tags: ["roadmap", "q3"],
  platform: "claude"
})`,
  },
  {
    name: 'hivemind_traverse_graph',
    icon: Network,
    colorClass: 'bg-[#8b5cf6]/10 text-[#8b5cf6]',
    summary: 'Explore connections between memories',
    description: 'Use when the user asks "what\'s related to X?" or you want to discover non-obvious connections.',
    params: [
      { name: 'memory_id', required: true, desc: 'Starting memory ID' },
      { name: 'relationship', required: false, desc: 'update | extend | derive | all' },
      { name: 'depth', required: false, desc: 'Hops to traverse (1-5, default 2)' },
    ],
    example: `hivemind_traverse_graph({ memory_id: "abc-123", depth: 2 })`,
  },
  {
    name: 'hivemind_query_with_ai',
    icon: Zap,
    colorClass: 'bg-[#d97706]/10 text-[#d97706]',
    summary: 'AI-powered question answering over your memory base',
    description: 'Use for complex synthesis questions like "summarise everything about our Q3 roadmap". Best for broad queries that need AI reasoning.',
    params: [
      { name: 'question', required: true, desc: 'Natural language question' },
      { name: 'context_limit', required: false, desc: 'How many memories to use as context (default 5)' },
    ],
    example: `hivemind_query_with_ai({ question: "What decisions have we made about the auth system?" })`,
  },
];

const WEB_TOOLS = [
  {
    name: 'hivemind_web_search',
    icon: Globe,
    colorClass: 'bg-[#16a34a]/10 text-[#16a34a]',
    badge: 'async',
    badgeClass: 'bg-[#16a34a]/10 text-[#16a34a] border-[#16a34a]/20',
    summary: 'Search the live web — returns async job receipt',
    description: 'Use when the user needs up-to-date info (news, docs, pricing). Returns a job ID — poll with hivemind_web_job_status until succeeded.',
    params: [
      { name: 'query', required: true, desc: 'Search query' },
      { name: 'domains', required: false, desc: 'Optional domain allowlist' },
      { name: 'limit', required: false, desc: 'Max results (default 10)' },
    ],
    example: `// 1. Submit
const job = hivemind_web_search({ query: "Tailwind v4 release date" })
// 2. Poll
hivemind_web_job_status({ job_id: job.job_id })
// 3. Once succeeded, results are in the response`,
  },
  {
    name: 'hivemind_web_crawl',
    icon: Link2,
    colorClass: 'bg-[#16a34a]/10 text-[#16a34a]',
    badge: 'async',
    badgeClass: 'bg-[#16a34a]/10 text-[#16a34a] border-[#16a34a]/20',
    summary: 'Crawl & extract content from URLs',
    description: 'Use when the user shares a URL or wants to extract page content. Same async pattern as web search.',
    params: [
      { name: 'urls', required: true, desc: 'Array of seed URLs to crawl' },
      { name: 'depth', required: false, desc: 'Crawl depth (default 1, max 3)' },
      { name: 'page_limit', required: false, desc: 'Max pages (default 10, max 50)' },
    ],
    example: `hivemind_web_crawl({
  urls: ["https://docs.example.com/api"],
  depth: 1,
  page_limit: 10
})`,
  },
  {
    name: 'hivemind_web_job_status',
    icon: HelpCircle,
    colorClass: 'bg-[#a3a3a3]/10 text-[#525252]',
    summary: 'Check status of a web search/crawl job',
    description: 'Poll every 3-5 seconds. Status: queued → running → succeeded / failed.',
    params: [{ name: 'job_id', required: true, desc: 'Job ID from search/crawl submission' }],
    example: `hivemind_web_job_status({ job_id: "9524aa79-..." })`,
  },
  {
    name: 'hivemind_web_usage',
    icon: HelpCircle,
    colorClass: 'bg-[#a3a3a3]/10 text-[#525252]',
    summary: 'Check your web intelligence quota',
    description: 'Returns daily and monthly search/crawl usage with limits. Check before submitting if unsure about quota.',
    params: [],
    example: `hivemind_web_usage({})`,
  },
];

/* ─── System prompt text ─────────────────────────────────────────── */
const SYSTEM_PROMPT = `You are connected to HIVEMIND — a persistent memory engine for AI agents.
HIVEMIND gives you long-term memory, semantic search, knowledge-graph traversal,
and live web intelligence. Use the tools below proactively to give the user
a personalised, context-aware experience.

WHEN TO USE EACH TOOL:

## Memory Tools
- hivemind_save_memory → User shares a fact, preference, decision, or code snippet worth remembering
- hivemind_recall → ALWAYS call FIRST before answering if the question might relate to stored knowledge
  Modes: "quick" (fast lookup), "panorama" (timeline-aware), "insight" (AI synthesis)
- hivemind_get_memory → You have a memory ID and need full content
- hivemind_list_memories → User asks "show me my memories about X"
- hivemind_update_memory → A stored fact is outdated
- hivemind_delete_memory → User explicitly asks to forget something
- hivemind_save_conversation → End of a meaningful conversation
- hivemind_traverse_graph → "What's related to X?" — explore connections
- hivemind_query_with_ai → Complex synthesis ("summarise everything about our roadmap")

## Web Intelligence Tools
- hivemind_web_search → User needs live/current info (news, docs, pricing)
  Flow: submit → poll hivemind_web_job_status → read results → offer to save to memory
- hivemind_web_crawl → User shares a URL or wants page content extracted
  Flow: same async pattern as search
- hivemind_web_job_status → Poll until "succeeded" or "failed"
- hivemind_web_usage → Check quota before submitting

DECISION FLOWCHART:
User asks a question →
  1. Might relate to stored knowledge? → hivemind_recall first
  2. Needs live/external data? → hivemind_web_search or hivemind_web_crawl
  3. Complex synthesis over memory? → hivemind_query_with_ai
  4. Answer worth remembering? → hivemind_save_memory after responding

User shares information → hivemind_save_memory with tags
User says "search the web" → hivemind_web_search → poll → present → offer to save
User shares a URL → hivemind_web_crawl → poll → present → offer to save

BEST PRACTICES:
- ALWAYS recall before answering if the question might relate to stored knowledge
- ALWAYS tag memories with relevant topics for precise retrieval
- NEVER save sensitive data (passwords, tokens, keys) to memory
- After web search/crawl, offer to save useful results to memory
- Prefer "quick" recall for simple lookups; use "insight" for synthesis`;

/* ─── Main Page ──────────────────────────────────────────────────── */
export default function McpServer() {
  const [activeTab, setActiveTab] = useState('tools');

  return (
    <div className="min-h-screen bg-[#faf9f4] p-6 md:p-10">
      <div className="max-w-4xl mx-auto">
        <ApiKeyPrompt feature="MCP server connections" />

        {/* Header */}
        <motion.div {...fadeUp} className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-[#117dff]/10 border border-[#117dff]/20 flex items-center justify-center">
              <Server size={20} className="text-[#117dff]" />
            </div>
            <h1 className="text-[#0a0a0a] text-2xl font-bold font-['Space_Grotesk']">MCP Server</h1>
          </div>
          <p className="text-[#525252] text-sm font-['Space_Grotesk'] ml-[52px]">
            HIVEMIND exposes 13 MCP tools that give AI platforms persistent memory, semantic search, knowledge-graph traversal, and live web intelligence.
          </p>
        </motion.div>

        {/* System Prompt Card */}
        <motion.div {...fadeUp} transition={{ delay: 0.05 }} className="mb-8">
          <div className="bg-white border border-[#e3e0db] rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.04)] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#e3e0db]/50">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-[#d97706]/10 flex items-center justify-center">
                  <Clipboard size={14} className="text-[#d97706]" />
                </div>
                <div>
                  <p className="text-sm font-semibold font-['Space_Grotesk'] text-[#0a0a0a]">System Prompt</p>
                  <p className="text-[11px] text-[#a3a3a3] font-['Space_Grotesk']">Copy and paste into your AI platform's system instructions</p>
                </div>
              </div>
              <CopyButton text={SYSTEM_PROMPT} label="Copy Prompt" />
            </div>
            <div className="relative max-h-[300px] overflow-y-auto">
              <pre className="px-5 py-4 text-[11px] font-mono text-[#525252] leading-relaxed whitespace-pre-wrap">{SYSTEM_PROMPT}</pre>
            </div>
          </div>
        </motion.div>

        {/* Quick Setup Cards */}
        <motion.div {...fadeUp} transition={{ delay: 0.1 }} className="mb-8">
          <h2 className="text-[#525252] text-xs font-mono uppercase tracking-wider mb-3">Quick Setup</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {[
              {
                title: 'Claude Desktop / Claude Code',
                icon: Terminal,
                config: `{
  "mcpServers": {
    "hivemind": {
      "command": "npx",
      "args": [
        "-y",
        "@amar_528/mcp-bridge",
        "hosted",
        "--url",
        "https://core.hivemind.davinciai.eu:8050/api/mcp/servers/YOUR_USER_ID"
      ],
      "env": {
        "HIVEMIND_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}`,
              },
              {
                title: 'Cursor / VS Code',
                icon: Terminal,
                config: `{
  "mcpServers": {
    "hivemind": {
      "command": "npx",
      "args": [
        "-y",
        "@amar_528/mcp-bridge",
        "hosted",
        "--url",
        "https://core.hivemind.davinciai.eu:8050/api/mcp/servers/YOUR_USER_ID"
      ],
      "env": {
        "HIVEMIND_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}`,
              },
              {
                title: 'REST API (Direct)',
                icon: Globe,
                config: `curl -X POST https://core.hivemind.davinciai.eu:8050/api/mcp/rpc \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"method":"tools/list","params":{},"id":1}'`,
              },
              {
                title: 'HTTP (Any Client)',
                icon: Link2,
                config: `Endpoint: POST /api/mcp/rpc
Headers:
  Authorization: Bearer YOUR_API_KEY
  Content-Type: application/json
Body:
  {"method":"tools/call","params":{"name":"hivemind_recall","arguments":{"query":"..."}},"id":1}`,
              },
            ].map((setup) => {
              const Icon = setup.icon;
              return (
                <div key={setup.title} className="bg-white border border-[#e3e0db] rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.04)] overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-[#e3e0db]/50">
                    <div className="flex items-center gap-2">
                      <Icon size={14} className="text-[#a3a3a3]" />
                      <p className="text-xs font-semibold font-['Space_Grotesk'] text-[#0a0a0a]">{setup.title}</p>
                    </div>
                    <CopyButton text={setup.config} label="" />
                  </div>
                  <pre className="px-4 py-3 text-[10px] font-mono text-[#525252] leading-relaxed overflow-x-auto whitespace-pre-wrap max-h-[160px] overflow-y-auto bg-[#faf9f4]">
                    {setup.config}
                  </pre>
                </div>
              );
            })}
          </div>
        </motion.div>

        {/* Tab bar */}
        <div className="flex gap-1 mb-4 bg-white border border-[#e3e0db] rounded-xl p-1 w-fit">
          {[
            { id: 'tools', label: 'Memory Tools', count: MEMORY_TOOLS.length },
            { id: 'web', label: 'Web Intelligence', count: WEB_TOOLS.length },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 rounded-lg text-xs font-['Space_Grotesk'] font-medium transition-all ${
                activeTab === tab.id
                  ? 'bg-[#117dff]/10 text-[#117dff]'
                  : 'text-[#a3a3a3] hover:text-[#525252]'
              }`}
            >
              {tab.label} <span className="ml-1 text-[10px] opacity-60">{tab.count}</span>
            </button>
          ))}
        </div>

        {/* Tool cards */}
        <motion.div variants={stagger} initial="initial" animate="animate" className="space-y-2">
          {(activeTab === 'tools' ? MEMORY_TOOLS : WEB_TOOLS).map(tool => (
            <ToolCard key={tool.name} tool={tool} />
          ))}
        </motion.div>

        {/* Decision flowchart */}
        <motion.div {...fadeUp} transition={{ delay: 0.2 }} className="mt-8">
          <div className="bg-white border border-[#e3e0db] rounded-xl p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
            <h3 className="text-sm font-semibold font-['Space_Grotesk'] text-[#0a0a0a] mb-4 flex items-center gap-2">
              <Zap size={14} className="text-[#d97706]" /> Decision Flowchart
            </h3>
            <div className="space-y-3 text-xs font-['Space_Grotesk'] text-[#525252]">
              <div className="flex gap-3">
                <div className="w-6 h-6 rounded-full bg-[#117dff]/10 flex items-center justify-center shrink-0 text-[10px] font-bold text-[#117dff]">1</div>
                <div><span className="font-semibold text-[#0a0a0a]">User asks a question</span> → Call <code className="text-[#117dff] bg-[#117dff]/5 px-1 rounded">hivemind_recall</code> first to check stored knowledge</div>
              </div>
              <div className="flex gap-3">
                <div className="w-6 h-6 rounded-full bg-[#16a34a]/10 flex items-center justify-center shrink-0 text-[10px] font-bold text-[#16a34a]">2</div>
                <div><span className="font-semibold text-[#0a0a0a]">Needs live data?</span> → <code className="text-[#16a34a] bg-[#16a34a]/5 px-1 rounded">hivemind_web_search</code> or <code className="text-[#16a34a] bg-[#16a34a]/5 px-1 rounded">hivemind_web_crawl</code></div>
              </div>
              <div className="flex gap-3">
                <div className="w-6 h-6 rounded-full bg-[#d97706]/10 flex items-center justify-center shrink-0 text-[10px] font-bold text-[#d97706]">3</div>
                <div><span className="font-semibold text-[#0a0a0a]">Complex synthesis?</span> → <code className="text-[#d97706] bg-[#d97706]/5 px-1 rounded">hivemind_query_with_ai</code></div>
              </div>
              <div className="flex gap-3">
                <div className="w-6 h-6 rounded-full bg-[#8b5cf6]/10 flex items-center justify-center shrink-0 text-[10px] font-bold text-[#8b5cf6]">4</div>
                <div><span className="font-semibold text-[#0a0a0a]">Worth remembering?</span> → <code className="text-[#8b5cf6] bg-[#8b5cf6]/5 px-1 rounded">hivemind_save_memory</code> after responding</div>
              </div>
              <div className="flex gap-3">
                <div className="w-6 h-6 rounded-full bg-[#16a34a]/10 flex items-center justify-center shrink-0 text-[10px] font-bold text-[#16a34a]">5</div>
                <div><span className="font-semibold text-[#0a0a0a]">Web results useful?</span> → Offer to save to memory with source URL tags</div>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
