import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  Cpu, Brain, Clock, Shield, GitBranch, Zap,
  Play, RefreshCw, AlertTriangle,
  CheckCircle2, XCircle, Loader2, Search,
  Network
} from 'lucide-react';
import apiClient from '../shared/api-client';

const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };
const stagger = { show: { transition: { staggerChildren: 0.06 } } };

function Badge({ children, color = 'blue' }) {
  const colors = {
    blue: 'bg-blue-500/10 text-blue-600',
    green: 'bg-emerald-500/10 text-emerald-600',
    amber: 'bg-amber-500/10 text-amber-600',
    red: 'bg-red-500/10 text-red-600',
    purple: 'bg-purple-500/10 text-purple-600',
    cyan: 'bg-cyan-500/10 text-cyan-600',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold ${colors[color] || colors.blue}`}>
      {children}
    </span>
  );
}

function Card({ children, className = '' }) {
  return (
    <motion.div
      variants={fadeUp}
      className={`bg-white border border-[#e3e0db] rounded-xl p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${className}`}
    >
      {children}
    </motion.div>
  );
}

function SectionHeader({ icon: Icon, title, description }) {
  return (
    <div className="flex items-center gap-2.5 mb-4">
      <div className="w-8 h-8 rounded-lg bg-[#117dff]/10 flex items-center justify-center">
        <Icon size={16} className="text-[#117dff]" />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-[#0a0a0a]" style={{ fontFamily: 'Space Grotesk' }}>{title}</h3>
        {description && <p className="text-[11px] text-[#a3a3a3]">{description}</p>}
      </div>
    </div>
  );
}

/* ─── Cognitive Frame Viewer ─────────────────────────────────── */

function CognitiveFramePanel() {
  const [query, setQuery] = useState('');
  const [frame, setFrame] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchFrame = async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const data = await apiClient.getCognitiveFrame(query, { maxTokens: 4000, contextBudget: 2000 });
      setFrame(data);
    } catch (e) {
      console.error('Frame fetch failed:', e);
    }
    setLoading(false);
  };

  const intentColors = { temporal: 'amber', action: 'blue', factual: 'green', emotional: 'purple', exploratory: 'cyan' };

  return (
    <Card>
      <SectionHeader icon={Brain} title="Cognitive Frame" description="Intent detection + tiered memory assembly" />
      <div className="flex gap-2 mb-4">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && fetchFrame()}
          placeholder="Enter a query to assemble cognitive frame..."
          className="flex-1 bg-transparent border border-[#e3e0db] rounded-lg py-2 px-3 text-xs focus:border-[#117dff]/40 focus:outline-none"
        />
        <button onClick={fetchFrame} disabled={loading} className="bg-[#117dff] hover:bg-[#0066e0] text-white text-xs font-semibold py-2 px-4 rounded-lg disabled:opacity-50 flex items-center gap-1.5">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
          Assemble
        </button>
      </div>

      {frame && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge color={intentColors[frame.intent?.type] || 'blue'}>{frame.intent?.type || 'unknown'}</Badge>
            <span className="text-[10px] text-[#a3a3a3] font-mono">confidence: {((frame.intent?.confidence || 0) * 100).toFixed(0)}%</span>
            <span className="text-[10px] text-[#a3a3a3] font-mono">{frame.token_count} tokens</span>
            {frame.intent?.entities?.length > 0 && (
              <span className="text-[10px] text-[#525252]">entities: {frame.intent.entities.join(', ')}</span>
            )}
          </div>

          <div className="text-[10px] font-mono text-[#a3a3a3] flex gap-3 flex-wrap">
            {frame.dynamic_weights && Object.entries(frame.dynamic_weights).map(([k, v]) => (
              <span key={k}>{k}: <span className="text-[#0a0a0a]">{(v * 100).toFixed(1)}%</span></span>
            ))}
          </div>

          {frame.frame && Object.entries(frame.frame).map(([tier, data]) => (
            <div key={tier} className="border border-[#e3e0db] rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-semibold text-[#0a0a0a] capitalize">{tier}</span>
                <span className="text-[10px] text-[#a3a3a3] font-mono">{data.count} memories / {data.tokenCount} tok</span>
              </div>
              <p className="text-[10px] text-[#a3a3a3] mb-2">{data.description}</p>
              <div className="space-y-1.5">
                {(data.memories || []).slice(0, 3).map((m, i) => (
                  <div key={i} className="text-[11px] text-[#525252] bg-[#f3f1ec] rounded px-2 py-1.5 flex items-start gap-2">
                    <Badge color={m.memory_type === 'fact' ? 'blue' : m.memory_type === 'event' ? 'cyan' : m.memory_type === 'decision' ? 'red' : 'green'}>
                      {m.memory_type}
                    </Badge>
                    <span className="line-clamp-2">{(m.content || '').slice(0, 150)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {frame.injection && (
            <div className="text-[10px] text-[#a3a3a3] font-mono">
              Injection: {frame.injection.injected_count} injected, {frame.injection.dropped_count} dropped, {frame.injection.total_tokens} tokens
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/* ─── Temporal Explorer ──────────────────────────────────────── */

function TemporalExplorer() {
  const [mode, setMode] = useState('diff');
  const [timeA, setTimeA] = useState('');
  const [timeB, setTimeB] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const now = new Date();
    const weekAgo = new Date(now - 7 * 86400000);
    setTimeB(now.toISOString().slice(0, 16));
    setTimeA(weekAgo.toISOString().slice(0, 16));
  }, []);

  const runQuery = async () => {
    setLoading(true);
    try {
      if (mode === 'diff') {
        const data = await apiClient.temporalDiff(new Date(timeA).toISOString(), new Date(timeB).toISOString());
        setResult({ type: 'diff', data });
      } else {
        const data = await apiClient.temporalAsOf({
          transactionTime: new Date(timeA).toISOString(),
          ...(timeB ? { validTime: new Date(timeB).toISOString() } : {}),
        });
        setResult({ type: 'snapshot', data });
      }
    } catch (e) {
      console.error('Temporal query failed:', e);
    }
    setLoading(false);
  };

  return (
    <Card>
      <SectionHeader icon={Clock} title="Temporal Explorer" description="Bi-temporal time-travel queries" />
      <div className="flex gap-2 mb-3">
        <button onClick={() => setMode('diff')} className={`text-[11px] px-3 py-1.5 rounded-lg font-medium ${mode === 'diff' ? 'bg-[#117dff] text-white' : 'bg-[#f3f1ec] text-[#525252]'}`}>
          Temporal Diff
        </button>
        <button onClick={() => setMode('snapshot')} className={`text-[11px] px-3 py-1.5 rounded-lg font-medium ${mode === 'snapshot' ? 'bg-[#117dff] text-white' : 'bg-[#f3f1ec] text-[#525252]'}`}>
          Time Travel
        </button>
      </div>

      <div className="flex gap-2 mb-3 items-end">
        <div className="flex-1">
          <label className="text-[10px] text-[#a3a3a3] font-mono mb-1 block">{mode === 'diff' ? 'From' : 'Transaction Time'}</label>
          <input type="datetime-local" value={timeA} onChange={e => setTimeA(e.target.value)} className="w-full bg-transparent border border-[#e3e0db] rounded-lg py-1.5 px-2 text-[11px] focus:border-[#117dff]/40 focus:outline-none font-mono" />
        </div>
        <div className="flex-1">
          <label className="text-[10px] text-[#a3a3a3] font-mono mb-1 block">{mode === 'diff' ? 'To' : 'Valid Time (optional)'}</label>
          <input type="datetime-local" value={timeB} onChange={e => setTimeB(e.target.value)} className="w-full bg-transparent border border-[#e3e0db] rounded-lg py-1.5 px-2 text-[11px] focus:border-[#117dff]/40 focus:outline-none font-mono" />
        </div>
        <button onClick={runQuery} disabled={loading} className="bg-[#117dff] hover:bg-[#0066e0] text-white text-xs font-semibold py-2 px-4 rounded-lg disabled:opacity-50 flex items-center gap-1.5 shrink-0">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
          Query
        </button>
      </div>

      {result?.type === 'diff' && result.data && (
        <div className="space-y-2">
          <div className="flex gap-3 text-[11px] font-mono">
            <span className="text-emerald-600">+{result.data.added?.length || 0} added</span>
            <span className="text-red-500">-{result.data.removed?.length || 0} removed</span>
            <span className="text-amber-600">~{result.data.modified?.length || 0} modified</span>
          </div>
          {(result.data.added || []).slice(0, 5).map((m, i) => (
            <div key={i} className="text-[11px] bg-emerald-50 border border-emerald-200 rounded px-2.5 py-1.5 flex items-center gap-2">
              <span className="text-emerald-600 font-mono text-[10px]">+</span>
              <Badge color="green">{m.memory_type}</Badge>
              <span className="text-[#525252] line-clamp-1">{(m.content || '').slice(0, 120)}</span>
            </div>
          ))}
        </div>
      )}

      {result?.type === 'snapshot' && result.data && (
        <div className="space-y-2">
          <span className="text-[11px] font-mono text-[#a3a3a3]">{result.data.count} memories at this point in time</span>
          {(result.data.memories || []).slice(0, 5).map((m, i) => (
            <div key={i} className="text-[11px] bg-[#f3f1ec] rounded px-2.5 py-1.5 flex items-center gap-2">
              <Badge>{m.memory_type}</Badge>
              <span className="text-[#525252] line-clamp-1">{(m.content || '').slice(0, 120)}</span>
              <span className="text-[10px] text-[#a3a3a3] font-mono shrink-0">v{m.version}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ─── Consensus Evaluator ────────────────────────────────────── */

function ConsensusEvaluator() {
  const [content, setContent] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const evaluate = async () => {
    if (!content.trim()) return;
    setLoading(true);
    try {
      const data = await apiClient.evaluateConsensus(content);
      setResult(data);
    } catch (e) {
      console.error('Consensus failed:', e);
    }
    setLoading(false);
  };

  const scoreColor = (val) => val >= 80 ? 'text-emerald-600' : val >= 60 ? 'text-amber-600' : 'text-red-500';

  return (
    <Card>
      <SectionHeader icon={Shield} title="Byzantine Consensus" description="Multi-voter evaluation for memory integrity" />
      <div className="flex gap-2 mb-4">
        <input
          value={content}
          onChange={e => setContent(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && evaluate()}
          placeholder="Enter memory content to evaluate..."
          className="flex-1 bg-transparent border border-[#e3e0db] rounded-lg py-2 px-3 text-xs focus:border-[#117dff]/40 focus:outline-none"
        />
        <button onClick={evaluate} disabled={loading} className="bg-[#117dff] hover:bg-[#0066e0] text-white text-xs font-semibold py-2 px-4 rounded-lg disabled:opacity-50 flex items-center gap-1.5">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <Shield size={13} />}
          Evaluate
        </button>
      </div>

      {result && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            {result.shouldCommit ? (
              <div className="flex items-center gap-1.5 text-emerald-600">
                <CheckCircle2 size={16} />
                <span className="text-xs font-semibold">COMMIT APPROVED</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-red-500">
                <XCircle size={16} />
                <span className="text-xs font-semibold">COMMIT REJECTED</span>
              </div>
            )}
            <span className="text-[10px] text-[#a3a3a3] font-mono">{result.voterCount} voters, {result.outliers?.length || 0} outliers</span>
          </div>

          {result.consensusScores && (
            <div className="grid grid-cols-4 gap-3">
              {[
                { label: 'Factuality', value: result.consensusScores.factuality },
                { label: 'Relevance', value: result.consensusScores.relevance },
                { label: 'Consistency', value: result.consensusScores.consistency },
                { label: 'Average', value: result.consensusScores.average },
              ].map(({ label, value }) => (
                <div key={label} className="text-center">
                  <div className={`text-lg font-bold font-mono ${scoreColor(value || 0)}`}>{(value || 0).toFixed(1)}</div>
                  <div className="text-[10px] text-[#a3a3a3]">{label}</div>
                </div>
              ))}
            </div>
          )}

          <p className="text-[11px] text-[#525252] font-mono">{result.reasoning}</p>
        </div>
      )}
    </Card>
  );
}

/* ─── Swarm Activity ─────────────────────────────────────────── */

function SwarmActivity() {
  const [traces, setTraces] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchTraces = async () => {
    setLoading(true);
    try {
      const data = await apiClient.swarmFollowTraces({ limit: 20 });
      setTraces(data);
    } catch (e) {
      console.error('Swarm fetch failed:', e);
    }
    setLoading(false);
  };

  useEffect(() => { fetchTraces(); }, []);

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <SectionHeader icon={Network} title="Swarm Activity" description="Stigmergic agent coordination traces" />
        <button onClick={fetchTraces} className="text-[#a3a3a3] hover:text-[#117dff] transition-colors">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {traces && (
        <div className="space-y-2">
          <div className="flex gap-3 text-[11px] font-mono text-[#a3a3a3]">
            <span>{traces.totalTraces || 0} active traces</span>
            <span className="text-emerald-600">{traces.affordances?.length || 0} affordances</span>
            <span className="text-red-400">{traces.disturbances?.length || 0} disturbances</span>
          </div>

          {traces.currentHead && (
            <div className="border border-[#117dff]/20 bg-[#117dff]/5 rounded-lg p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <Zap size={12} className="text-[#117dff]" />
                <span className="text-[10px] font-semibold text-[#117dff]">Current Head</span>
              </div>
              <p className="text-[11px] text-[#525252] line-clamp-2">{(traces.currentHead.content || '').slice(0, 200)}</p>
            </div>
          )}

          {(traces.affordances || []).map((t, i) => (
            <div key={i} className="text-[11px] bg-emerald-50 border border-emerald-200 rounded px-2.5 py-1.5 flex items-center gap-2">
              <CheckCircle2 size={12} className="text-emerald-500 shrink-0" />
              <span className="text-[#525252] line-clamp-1">{(t.content || '').slice(0, 150)}</span>
            </div>
          ))}

          {(traces.disturbances || []).map((t, i) => (
            <div key={i} className="text-[11px] bg-red-50 border border-red-200 rounded px-2.5 py-1.5 flex items-center gap-2">
              <AlertTriangle size={12} className="text-red-400 shrink-0" />
              <span className="text-[#525252] line-clamp-1">{(t.content || '').slice(0, 150)}</span>
            </div>
          ))}

          {!traces.totalTraces && (
            <p className="text-[11px] text-[#a3a3a3] text-center py-4">No active swarm traces. Agents leave traces when they reason collaboratively.</p>
          )}
        </div>
      )}
    </Card>
  );
}

/* ─── Main Engine Page ───────────────────────────────────────── */

export default function Engine() {
  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-6 max-w-6xl">
      <motion.div variants={fadeUp}>
        <h2 className="text-lg font-bold text-[#0a0a0a] flex items-center gap-2" style={{ fontFamily: 'Space Grotesk' }}>
          <Cpu size={20} className="text-[#117dff]" />
          Memory Engine Intelligence
        </h2>
        <p className="text-xs text-[#a3a3a3] mt-1">
          6 SOTA features powering your memory engine: predict-calibrate extraction, cognitive framing, context autopilot, bi-temporal queries, stigmergic reasoning, and Byzantine consensus.
        </p>
      </motion.div>

      {/* Feature status bar */}
      <motion.div variants={fadeUp} className="flex gap-2 flex-wrap">
        {[
          { icon: Zap, label: 'Predict-Calibrate', color: 'blue' },
          { icon: Brain, label: 'Cognitive Frame', color: 'purple' },
          { icon: RefreshCw, label: 'Context Autopilot', color: 'cyan' },
          { icon: Clock, label: 'Bi-Temporal', color: 'amber' },
          { icon: GitBranch, label: 'Stigmergic CoT', color: 'green' },
          { icon: Shield, label: 'Byzantine Consensus', color: 'red' },
        ].map(({ icon: Icon, label, color }) => (
          <div key={label} className="flex items-center gap-1.5 bg-white border border-[#e3e0db] rounded-lg px-3 py-1.5">
            <Icon size={12} className="text-[#117dff]" />
            <span className="text-[11px] font-medium text-[#0a0a0a]">{label}</span>
            <Badge color={color}>active</Badge>
          </div>
        ))}
      </motion.div>

      {/* Main content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <CognitiveFramePanel />
        <ConsensusEvaluator />
        <TemporalExplorer />
        <SwarmActivity />
      </div>
    </motion.div>
  );
}
