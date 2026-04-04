import React, { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  FlaskConical,
  TrendingUp,
  BarChart3,
  CheckCircle,
  XCircle,
  Clock,
  Play,
  Zap,
  Target,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronRight,
  Search,
  Database,
  Layers,
  CalendarClock,
  Star,
  Mail,
  Globe,
  Cpu,
  PenLine,
  Wifi,
  WifiOff,
  RefreshCw,
} from 'lucide-react';
import apiClient from '../shared/api-client';
import { useApiQuery } from '../shared/hooks';


const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: 'easeOut' } },
};

/* ─── Shared Helpers (kept from original) ─────────────────────────── */

function scoreColor(score) {
  if (score >= 0.8) return '#22c55e';
  if (score >= 0.5) return '#f59e0b';
  return '#ef4444';
}

function latencyColor(ms) {
  if (ms <= 100) return '#22c55e';
  if (ms <= 300) return '#f59e0b';
  return '#ef4444';
}

function ScoreDisplay({ label, value, suffix = '' }) {
  const display = value != null
    ? (suffix === 'ms' ? Math.round(value) : value.toFixed(3))
    : '--';
  const color = value != null
    ? (suffix === 'ms' ? latencyColor(value) : scoreColor(value))
    : '#a3a3a3';

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[#a3a3a3] text-[10px] font-mono uppercase tracking-wider">{label}</span>
      <span className="text-2xl font-bold font-mono leading-none" style={{ color }}>
        {display}{suffix && value != null ? suffix : ''}
      </span>
    </div>
  );
}

function BenchmarkCard({ title, icon: Icon, passed, children }) {
  return (
    <div className={`rounded-xl border p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${
      passed === true
        ? 'bg-[#f0fdf4] border-[#bbf7d0]'
        : passed === false
        ? 'bg-[#fef2f2] border-[#fecaca]'
        : 'bg-white border-[#e3e0db]'
    }`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Icon size={15} className={passed === true ? 'text-[#16a34a]' : passed === false ? 'text-[#dc2626]' : 'text-[#a3a3a3]'} />
          <h4 className="text-[#0a0a0a] text-sm font-semibold font-['Space_Grotesk']">{title}</h4>
        </div>
        {passed != null && (
          passed ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono bg-[#22c55e]/10 text-[#16a34a] border border-[#bbf7d0]">
              <CheckCircle size={10} /> PASS
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono bg-[#ef4444]/10 text-[#dc2626] border border-[#fecaca]">
              <XCircle size={10} /> FAIL
            </span>
          )
        )}
      </div>
      {children}
    </div>
  );
}

function StatusBadge({ passed }) {
  if (passed == null) return null;
  return passed ? (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono bg-[#22c55e]/10 text-[#22c55e] border border-[#22c55e]/20">
      <CheckCircle size={12} />
      Passed
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono bg-[#ef4444]/10 text-[#ef4444] border border-[#ef4444]/20">
      <XCircle size={12} />
      Failed
    </span>
  );
}

function formatDate(ts) {
  if (!ts) return '--';
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return ts;
  }
}

/* ─── Benchmark helpers (preserved from original) ────────────────── */

function derivePassFail(run) {
  const report = run?.report || run;
  if (!report) return null;
  if (report.latency_benchmark?.pass != null && report.relevance_benchmark?.pass != null) {
    return report.latency_benchmark.pass && report.relevance_benchmark.pass;
  }
  if (run.status === 'passed' || run.passed === true) return true;
  if (run.status === 'failed' || run.passed === false) return false;
  const p = report.precision ?? report.scores?.precision ?? report.summary?.precisionAt5?.mean;
  const r = report.recall ?? report.scores?.recall ?? report.summary?.recallAt10?.mean;
  const f = report.f1 ?? report.scores?.f1 ?? report.summary?.f1At10?.mean;
  if (p != null && r != null && f != null) {
    const precisionTarget = report.targets?.precisionAt5 ?? 0.5;
    const recallTarget = report.targets?.recallAt10 ?? 0.5;
    const f1Target = report.targets?.f1Score ?? 0.5;
    return p >= precisionTarget && r >= recallTarget && f >= f1Target;
  }
  return null;
}

function extractScores(run) {
  const report = run?.report || run;
  const summary = report?.summary || {};
  return {
    precision: summary.semanticPrecisionAt5?.mean ?? report?.precision ?? report?.scores?.precision ?? summary.precisionAt5?.mean ?? null,
    uuidPrecision: summary.precisionAt5?.mean ?? null,
    semanticPrecision: summary.semanticPrecisionAt5?.mean ?? null,
    recall: report?.recall ?? report?.scores?.recall ?? summary.recallAt10?.mean ?? null,
    f1: report?.f1 ?? report?.scores?.f1 ?? summary.f1At10?.mean ?? null,
    ndcg: summary.ndcgAt10?.mean ?? null,
    mrr: summary.mrr?.mean ?? null,
    qualityScore: summary.qualityScore ?? null,
    latencyP50: summary.latencyP50 ?? null,
    latencyP95: summary.latencyP95 ?? null,
    latencyP99: summary.latencyP99 ?? null,
  };
}

function extractBenchmarks(run) {
  const report = run?.report || run;
  return {
    latency: report?.latency_benchmark || null,
    relevance: report?.relevance_benchmark || null,
  };
}

function getRunId(run) {
  const report = run?.report || run;
  return report?.evaluationId || report?.evaluation_id || report?.id || report?.run_id || null;
}

function getRunTimestamp(run) {
  const report = run?.report || run;
  return report?.timestamp || report?.created_at || null;
}

/* ─── Health Overview Card ──────────────────────────────────────── */

function HealthCard({ icon: Icon, label, value, sub, color }) {
  return (
    <motion.div
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      className="bg-white border border-[#e3e0db] rounded-xl p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] flex flex-col gap-2"
    >
      <div className="flex items-center gap-2">
        <Icon size={15} className="text-[#a3a3a3]" />
        <span className="text-[#525252] text-xs font-['Space_Grotesk'] uppercase tracking-wider">{label}</span>
      </div>
      <span className="text-2xl font-bold font-['Space_Grotesk'] leading-none" style={{ color: color || '#0a0a0a' }}>
        {value}
      </span>
      {sub && <span className="text-[#a3a3a3] text-[11px] font-mono">{sub}</span>}
    </motion.div>
  );
}

/* ─── Search Result Row ─────────────────────────────────────────── */

function SearchResultRow({ result, index }) {
  const score = result.score ?? result.similarity ?? result.relevance ?? 0;
  const title = result.title || result.content?.slice(0, 60) || `Result ${index + 1}`;
  const preview = result.content
    ? result.content.slice(0, 100) + (result.content.length > 100 ? '...' : '')
    : 'No content preview';
  const tags = result.tags || result.metadata?.tags || [];
  const barColor = score >= 0.8 ? '#22c55e' : score >= 0.5 ? '#f59e0b' : '#ef4444';

  return (
    <div className="bg-white border border-[#e3e0db] rounded-lg p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h5 className="text-[#0a0a0a] text-sm font-semibold font-['Space_Grotesk'] truncate flex-1">{title}</h5>
        <span className="text-xs font-mono shrink-0" style={{ color: barColor }}>
          {(score * 100).toFixed(0)}%
        </span>
      </div>
      {/* Score bar */}
      <div className="w-full h-1.5 bg-[#f3f1ec] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.min(score * 100, 100)}%`, backgroundColor: barColor }}
        />
      </div>
      <p className="text-[#525252] text-xs font-mono leading-relaxed">{preview}</p>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.slice(0, 5).map((tag, i) => (
            <span key={i} className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-[#f3f1ec] text-[#525252] border border-[#e3e0db]">
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Connector Status Card ─────────────────────────────────────── */

function ConnectorCard({ name, icon: Icon, connected, lastSync, memoryCount }) {
  return (
    <div className="bg-white border border-[#e3e0db] rounded-xl p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] flex items-center gap-4">
      <div className="w-10 h-10 rounded-lg bg-[#f3f1ec] flex items-center justify-center shrink-0">
        <Icon size={18} className="text-[#525252]" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[#0a0a0a] text-sm font-semibold font-['Space_Grotesk']">{name}</span>
          {connected ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono bg-[#22c55e]/10 text-[#16a34a] border border-[#bbf7d0]">
              <Wifi size={9} /> Connected
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono bg-[#f3f1ec] text-[#a3a3a3] border border-[#e3e0db]">
              <WifiOff size={9} /> Disconnected
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-1">
          {lastSync && (
            <span className="text-[#a3a3a3] text-[10px] font-mono flex items-center gap-1">
              <Clock size={9} /> {formatDate(lastSync)}
            </span>
          )}
          {memoryCount != null && (
            <span className="text-[#a3a3a3] text-[10px] font-mono">
              {memoryCount} memories
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Per-Query Breakdown (preserved from original) ─────────────── */

function PerQueryBreakdown({ results }) {
  const [expanded, setExpanded] = useState(false);
  if (!results || results.length === 0) return null;

  const hits = results.filter(q => {
    const resultIds = new Set(q.resultIds || []);
    return (q.relevantIds || []).some(id => resultIds.has(id));
  }).length;

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="visible" className="bg-white border border-[#e3e0db] rounded-xl p-5 mb-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between"
      >
        <div className="flex items-center gap-2">
          <Search size={15} className="text-[#525252]" />
          <h4 className="text-[#0a0a0a] text-sm font-semibold font-['Space_Grotesk']">
            Per-Query Results
          </h4>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-[#f3f1ec] text-[#525252]">
            {hits}/{results.length} hit
          </span>
        </div>
        {expanded ? <ChevronDown size={14} className="text-[#a3a3a3]" /> : <ChevronRight size={14} className="text-[#a3a3a3]" />}
      </button>

      {expanded && (
        <div className="mt-4 space-y-2">
          {results.map((q, idx) => {
            const resultIds = new Set(q.resultIds || []);
            const matched = (q.relevantIds || []).filter(id => resultIds.has(id)).length;
            const isHit = matched > 0;
            const m = q.metrics || {};

            return (
              <div
                key={idx}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-mono ${
                  isHit ? 'bg-[#f0fdf4] border border-[#bbf7d0]' : 'bg-[#fef2f2] border border-[#fecaca]'
                }`}
              >
                <span className={`shrink-0 ${isHit ? 'text-[#16a34a]' : 'text-[#dc2626]'}`}>
                  {isHit ? <CheckCircle size={12} /> : <XCircle size={12} />}
                </span>
                <span className="flex-1 text-[#0a0a0a] truncate">{q.query}</span>
                <span className="shrink-0 text-[#525252]">
                  P@5={m.precisionAt5?.toFixed(2) || '0'} R@10={m.recallAt10?.toFixed(2) || '0'} MRR={m.mrr?.toFixed(2) || '0'}
                </span>
                <span className={`shrink-0 font-semibold ${isHit ? 'text-[#16a34a]' : 'text-[#dc2626]'}`}>
                  {matched}/{(q.relevantIds || []).length}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </motion.div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN COMPONENT: Memory Health Dashboard
   ═══════════════════════════════════════════════════════════════════ */

export default function Evaluation() {
  /* ── Data fetching ───────────────────────────────────────────── */

  // Memories for health stats
  const { data: memoriesData, loading: memoriesLoading } =
    useApiQuery(() => apiClient.listMemories({ limit: 100 }));

  // Gmail connector status
  const { data: gmailData } =
    useApiQuery(() => apiClient.gmailStatus().catch(() => null));

  // Evaluation data (for admin benchmark section)
  const { data: latest, loading: latestLoading, error: latestError, refetch: refetchLatest } =
    useApiQuery(() => apiClient.getEvalResults());
  const { data: history, loading: historyLoading, refetch: refetchHistory } =
    useApiQuery(() => apiClient.getEvalHistory());

  /* ── Local state ─────────────────────────────────────────────── */

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);

  const [benchmarkOpen, setBenchmarkOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState(null);
  const [compareA, setCompareA] = useState(null);
  const [compareB, setCompareB] = useState(null);

  /* ── Computed stats from memories ────────────────────────────── */

  const memories = useMemo(() => {
    if (!memoriesData) return [];
    return memoriesData.memories || memoriesData.data || memoriesData.results || (Array.isArray(memoriesData) ? memoriesData : []);
  }, [memoriesData]);

  const totalCount = useMemo(() => {
    if (!memoriesData) return 0;
    return memoriesData.pagination?.total ?? memoriesData.total ?? memories.length;
  }, [memoriesData, memories]);

  const sourceCounts = useMemo(() => {
    const counts = {};
    memories.forEach(m => {
      const src = m.source_platform || m.sourcePlatform || m.source || 'unknown';
      counts[src] = (counts[src] || 0) + 1;
    });
    return counts;
  }, [memories]);

  const freshness = useMemo(() => {
    if (memories.length === 0) return { week: 0, month: 0, older: 0 };
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
    let week = 0, month = 0, older = 0;
    memories.forEach(m => {
      const ts = new Date(m.created_at || m.createdAt || 0).getTime();
      if (ts >= weekAgo) week++;
      else if (ts >= monthAgo) month++;
      else older++;
    });
    const total = memories.length;
    return {
      week: Math.round((week / total) * 100),
      month: Math.round((month / total) * 100),
      older: Math.round((older / total) * 100),
    };
  }, [memories]);

  const avgImportance = useMemo(() => {
    if (memories.length === 0) return null;
    const scores = memories
      .map(m => m.importance_score ?? m.importanceScore ?? m.importance)
      .filter(s => s != null && !isNaN(s));
    if (scores.length === 0) return null;
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }, [memories]);

  // Sources breakdown string
  const sourcesSub = useMemo(() => {
    const entries = Object.entries(sourceCounts);
    if (entries.length === 0) return 'No sources detected';
    return entries.map(([k, v]) => `${k}: ${v}`).join(', ');
  }, [sourceCounts]);

  /* ── Gmail connector info ────────────────────────────────────── */

  const gmailConnected = gmailData?.connected ?? gmailData?.authenticated ?? false;
  const gmailLastSync = gmailData?.last_sync ?? gmailData?.lastSync ?? null;
  const gmailMemoryCount = sourceCounts['gmail'] || 0;

  /* ── Other connector counts ──────────────────────────────────── */

  const webCount = sourceCounts['web-intelligence'] || sourceCounts['web'] || 0;
  const mcpCount = sourceCounts['mcp'] || 0;
  const manualCount = sourceCounts['manual'] || 0;

  /* ── Search handler ──────────────────────────────────────────── */

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchError(null);
    setSearchResults(null);
    try {
      const data = await apiClient.quickSearch(searchQuery.trim());
      const results = data.results || data.memories || data.data || (Array.isArray(data) ? data : []);
      setSearchResults(results.slice(0, 5));
    } catch (err) {
      setSearchError(err.response?.data?.error || err.message);
    } finally {
      setSearching(false);
    }
  };

  /* ── Benchmark handler (preserved) ──────────────────────────── */

  const handleRun = async () => {
    setRunning(true);
    setRunError(null);
    try {
      await apiClient.runEvaluation({ methods: ['hybrid'] });
      await Promise.all([refetchLatest(), refetchHistory()]);
    } catch (err) {
      setRunError(err.response?.data?.error || err.message);
    } finally {
      setRunning(false);
    }
  };

  const historyList = useMemo(() => {
    if (!history) return [];
    if (Array.isArray(history)) return history;
    return history.history || history.runs || history.results || [];
  }, [history]);

  const comparisonRuns = useMemo(() => {
    if (!compareA || !compareB) return null;
    const a = historyList.find((r) => getRunId(r) === compareA);
    const b = historyList.find((r) => getRunId(r) === compareB);
    if (!a || !b) return null;
    return [a, b];
  }, [compareA, compareB, historyList]);

  const latestReport = latest?.report || latest;
  const latestScores = latestReport ? extractScores(latestReport) : {};
  const latestPassed = latestReport ? derivePassFail(latestReport) : null;
  const benchmarks = latestReport ? extractBenchmarks(latestReport) : {};

  /* ── Loading state ───────────────────────────────────────────── */

  if (memoriesLoading && latestLoading && historyLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-[#117dff] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  /* ── Render ──────────────────────────────────────────────────── */

  return (
    <div className="min-h-full">
      {/* ═══ 1. Page Header ═══ */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
        <h1 className="text-[#0a0a0a] text-2xl font-bold font-['Space_Grotesk'] mb-1">Memory Health</h1>
        <p className="text-[#525252] text-sm font-['Space_Grotesk']">
          Monitor your memory graph quality and search performance
        </p>
      </motion.div>

      {/* ═══ 2. Health Overview Cards ═══ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <HealthCard
          icon={Database}
          label="Total Memories"
          value={totalCount.toLocaleString()}
          sub={memories.length === 0 ? 'Add memories to get started' : `${Object.keys(sourceCounts).length} source${Object.keys(sourceCounts).length === 1 ? '' : 's'}`}
        />
        <HealthCard
          icon={Layers}
          label="Sources"
          value={Object.keys(sourceCounts).length}
          sub={sourcesSub}
        />
        <HealthCard
          icon={CalendarClock}
          label="Freshness"
          value={memories.length > 0 ? `${freshness.week}%` : '--'}
          sub={memories.length > 0
            ? `${freshness.week}% <7d, ${freshness.month}% <30d, ${freshness.older}% older`
            : 'No data available'}
          color={memories.length > 0 ? (freshness.week >= 30 ? '#22c55e' : freshness.week >= 10 ? '#f59e0b' : '#ef4444') : '#a3a3a3'}
        />
        <HealthCard
          icon={Star}
          label="Avg Importance"
          value={avgImportance != null ? avgImportance.toFixed(2) : '--'}
          sub={avgImportance != null
            ? (avgImportance >= 0.7 ? 'High quality signals' : avgImportance >= 0.4 ? 'Moderate quality' : 'Consider curating low-value entries')
            : 'No importance data'}
          color={avgImportance != null ? scoreColor(avgImportance) : '#a3a3a3'}
        />
      </div>

      {/* ═══ 3. Search Tester ═══ */}
      <motion.div variants={fadeUp} initial="hidden" animate="visible" className="bg-white border border-[#e3e0db] rounded-xl p-6 mb-8 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
        <div className="flex items-center gap-2 mb-4">
          <Search size={16} className="text-[#525252]" />
          <h3 className="text-[#0a0a0a] text-lg font-bold font-['Space_Grotesk']">Search Tester</h3>
        </div>

        <div className="flex gap-3 mb-4">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Test a search query..."
            className="flex-1 bg-[#f3f1ec] border border-[#e3e0db] rounded-xl px-4 py-3 text-sm font-['Space_Grotesk'] text-[#0a0a0a] placeholder-[#a3a3a3] focus:outline-none focus:ring-2 focus:ring-[#117dff]/30 focus:border-[#117dff] transition-all"
          />
          <button
            onClick={handleSearch}
            disabled={searching || !searchQuery.trim()}
            className="flex items-center gap-2 bg-[#117dff] hover:bg-[#0066e0] disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 px-5 rounded-xl transition-all text-sm font-['Space_Grotesk']"
          >
            {searching ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <>
                <Search size={14} />
                Search
              </>
            )}
          </button>
        </div>

        {searchError && (
          <div className="flex items-center gap-2 bg-[#fef2f2] border border-[#fecaca] rounded-xl px-4 py-3 mb-4">
            <AlertTriangle size={14} className="text-[#dc2626] shrink-0" />
            <span className="text-[#dc2626] text-xs font-mono">{searchError}</span>
          </div>
        )}

        {searchResults && searchResults.length === 0 && (
          <div className="text-center py-8">
            <Search size={24} className="text-[#d4d0ca] mx-auto mb-2" />
            <p className="text-[#a3a3a3] text-sm font-['Space_Grotesk']">No results found for this query</p>
          </div>
        )}

        {searchResults && searchResults.length > 0 && (
          <div className="space-y-3">
            {searchResults.map((result, i) => (
              <SearchResultRow key={result.id || i} result={result} index={i} />
            ))}
          </div>
        )}

        {!searchResults && !searchError && (
          <p className="text-[#a3a3a3] text-xs font-mono text-center py-4">
            Enter a query above to test memory retrieval quality
          </p>
        )}
      </motion.div>

      {/* ═══ 4. Connector Status ═══ */}
      <motion.div variants={fadeUp} initial="hidden" animate="visible" className="mb-8">
        <div className="flex items-center gap-2 mb-4">
          <RefreshCw size={16} className="text-[#525252]" />
          <h3 className="text-[#0a0a0a] text-lg font-bold font-['Space_Grotesk']">Connector Status</h3>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <ConnectorCard
            name="Gmail"
            icon={Mail}
            connected={gmailConnected}
            lastSync={gmailLastSync}
            memoryCount={gmailMemoryCount}
          />
          <ConnectorCard
            name="Web Intelligence"
            icon={Globe}
            connected={webCount > 0}
            lastSync={null}
            memoryCount={webCount}
          />
          <ConnectorCard
            name="MCP Bridge"
            icon={Cpu}
            connected={mcpCount > 0}
            lastSync={null}
            memoryCount={mcpCount}
          />
          <ConnectorCard
            name="Manual"
            icon={PenLine}
            connected={manualCount > 0}
            lastSync={null}
            memoryCount={manualCount}
          />
        </div>
      </motion.div>

      {/* ═══ 5. Admin: Retrieval Benchmarks (collapsible) ═══ */}
      <motion.div variants={fadeUp} initial="hidden" animate="visible" className="bg-white border border-[#e3e0db] rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.04)] mb-8">
        <button
          onClick={() => setBenchmarkOpen(!benchmarkOpen)}
          className="w-full flex items-center justify-between p-6"
        >
          <div className="flex items-center gap-2">
            <FlaskConical size={16} className="text-[#525252]" />
            <h3 className="text-[#0a0a0a] text-lg font-bold font-['Space_Grotesk']">Admin: Retrieval Benchmarks</h3>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-[#f3f1ec] text-[#a3a3a3] border border-[#e3e0db]">
              Advanced
            </span>
          </div>
          {benchmarkOpen
            ? <ChevronDown size={16} className="text-[#a3a3a3]" />
            : <ChevronRight size={16} className="text-[#a3a3a3]" />}
        </button>

        {benchmarkOpen && (
          <div className="px-6 pb-6 pt-0">
            {/* Run button + error */}
            <div className="flex items-center gap-4 mb-6">
              <button
                onClick={handleRun}
                disabled={running}
                className="flex items-center gap-2 bg-[#117dff] hover:bg-[#0066e0] disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 px-5 rounded-xl transition-all text-sm font-['Space_Grotesk'] group"
              >
                {running ? (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <>
                    <Play size={14} className="group-hover:translate-x-0.5 transition-transform" />
                    Run Evaluation
                  </>
                )}
              </button>
              {runError && (
                <div className="flex items-center gap-2 bg-[#fef2f2] border border-[#fecaca] rounded-xl px-4 py-3">
                  <AlertTriangle size={14} className="text-[#dc2626] shrink-0" />
                  <span className="text-[#dc2626] text-xs font-mono">{runError}</span>
                </div>
              )}
            </div>

            {latestError && !latestReport && (
              <div className="flex items-center gap-2 bg-[#fffbeb] border border-[#fde68a] rounded-xl px-4 py-3 mb-4">
                <Info size={14} className="text-[#d97706] shrink-0" />
                <div>
                  <span className="text-[#92400e] text-xs font-['Space_Grotesk'] block">No evaluation data available</span>
                  <span className="text-[#a3a3a3] text-[10px] font-mono block mt-0.5">
                    {latestError.includes('404') || latestError.includes('not found')
                      ? 'Run your first evaluation to generate baseline metrics.'
                      : latestError}
                  </span>
                </div>
              </div>
            )}

            {/* Benchmark Cards */}
            {latestReport && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <BenchmarkCard title="Latency" icon={Zap} passed={benchmarks.latency?.pass ?? null}>
                  {benchmarks.latency ? (
                    <div className="grid grid-cols-3 gap-4">
                      <ScoreDisplay label="P50" value={benchmarks.latency.p50_ms} suffix="ms" />
                      <ScoreDisplay label="P95" value={benchmarks.latency.p95_ms} suffix="ms" />
                      <ScoreDisplay label="P99" value={benchmarks.latency.p99_ms} suffix="ms" />
                    </div>
                  ) : latestScores.latencyP99 != null ? (
                    <div className="grid grid-cols-3 gap-4">
                      <ScoreDisplay label="P50" value={latestScores.latencyP50} suffix="ms" />
                      <ScoreDisplay label="P95" value={latestScores.latencyP95} suffix="ms" />
                      <ScoreDisplay label="P99" value={latestScores.latencyP99} suffix="ms" />
                    </div>
                  ) : (
                    <p className="text-[#a3a3a3] text-xs font-mono text-center py-4">No latency data</p>
                  )}
                  {benchmarks.latency?.target_p99_ms && (
                    <p className="text-[#a3a3a3] text-[10px] font-mono mt-3 text-center">
                      Target: p99 &lt; {benchmarks.latency.target_p99_ms}ms
                    </p>
                  )}
                </BenchmarkCard>

                <BenchmarkCard title="Relevance" icon={Target} passed={benchmarks.relevance?.pass ?? null}>
                  {benchmarks.relevance ? (
                    <div className="grid grid-cols-2 gap-4">
                      <ScoreDisplay label="P@5" value={benchmarks.relevance.precision_at_5} />
                      <ScoreDisplay label="R@10" value={benchmarks.relevance.recall_at_10} />
                      <ScoreDisplay label="NDCG@10" value={benchmarks.relevance.ndcg_at_10} />
                      <ScoreDisplay label="MRR" value={benchmarks.relevance.mrr} />
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-4 mb-3">
                      <ScoreDisplay label="Sem. P@5" value={latestScores.precision} />
                      <ScoreDisplay label="R@10" value={latestScores.recall} />
                      <ScoreDisplay label="F1" value={latestScores.f1} />
                    </div>
                  )}
                  {(latestScores.ndcg != null || latestScores.mrr != null) && !benchmarks.relevance && (
                    <div className="grid grid-cols-2 gap-4 mt-2 pt-2 border-t border-[#e3e0db]">
                      <ScoreDisplay label="NDCG@10" value={latestScores.ndcg} />
                      <ScoreDisplay label="MRR" value={latestScores.mrr} />
                    </div>
                  )}
                  {benchmarks.relevance?.targets && (
                    <p className="text-[#a3a3a3] text-[10px] font-mono mt-3 text-center">
                      Target: P@5 &ge; {benchmarks.relevance.targets.precision_at_5}, R@10 &ge; {benchmarks.relevance.targets.recall_at_10}
                    </p>
                  )}
                  {!benchmarks.relevance && (
                    <p className="text-[#a3a3a3] text-[10px] font-mono mt-3 text-center">
                      Target: P@5 &ge; 0.80, R@10 &ge; 0.70, NDCG@10 &ge; 0.75, MRR &ge; 0.60
                    </p>
                  )}
                </BenchmarkCard>
              </div>
            )}

            {/* Overall Quality Score */}
            {latestReport && (
              <div className="bg-white border border-[#e3e0db] rounded-xl p-5 mb-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <FlaskConical size={16} className="text-[#117dff]" />
                    <div>
                      <h4 className="text-[#0a0a0a] text-sm font-semibold font-['Space_Grotesk']">Overall Quality</h4>
                      {getRunTimestamp(latestReport) && (
                        <span className="text-[#a3a3a3] text-[10px] font-mono">{formatDate(getRunTimestamp(latestReport))}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {latestScores.qualityScore != null && (
                      <span className="text-2xl font-bold font-mono" style={{ color: scoreColor(latestScores.qualityScore / 100) }}>
                        {Math.round(latestScores.qualityScore)}<span className="text-sm text-[#a3a3a3]">/100</span>
                      </span>
                    )}
                    <StatusBadge passed={latestPassed} />
                  </div>
                </div>
              </div>
            )}

            {/* Per-Query Results */}
            {latestReport?.rawResults?.length > 0 && (
              <PerQueryBreakdown results={latestReport.rawResults} />
            )}

            {/* Empty state */}
            {!latestReport && !latestLoading && !latestError && (
              <div className="bg-[#f3f1ec] border border-[#e3e0db] rounded-xl p-10 text-center mb-6">
                <FlaskConical size={28} className="text-[#d4d0ca] mx-auto mb-3" />
                <p className="text-[#525252] text-sm font-['Space_Grotesk'] mb-1">No evaluation results yet</p>
                <p className="text-[#a3a3a3] text-xs font-['Space_Grotesk']">
                  Click "Run Evaluation" to measure retrieval quality against your tenant dataset.
                </p>
              </div>
            )}

            {/* History */}
            <div className="bg-white border border-[#e3e0db] rounded-xl p-6 mb-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
              <div className="flex items-center gap-2 mb-6">
                <TrendingUp size={16} className="text-[#525252]" />
                <h3 className="text-[#0a0a0a] text-lg font-bold font-['Space_Grotesk']">History</h3>
              </div>

              {historyList.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-[#e3e0db]">
                        <th className="text-[#525252] text-xs font-mono uppercase tracking-wider pb-3 pr-4">Run ID</th>
                        <th className="text-[#525252] text-xs font-mono uppercase tracking-wider pb-3 pr-4">Date</th>
                        <th className="text-[#525252] text-xs font-mono uppercase tracking-wider pb-3 pr-4 text-right">Precision</th>
                        <th className="text-[#525252] text-xs font-mono uppercase tracking-wider pb-3 pr-4 text-right">Recall</th>
                        <th className="text-[#525252] text-xs font-mono uppercase tracking-wider pb-3 pr-4 text-right">F1</th>
                        <th className="text-[#525252] text-xs font-mono uppercase tracking-wider pb-3 pr-4 text-right">NDCG</th>
                        <th className="text-[#525252] text-xs font-mono uppercase tracking-wider pb-3 pr-4 text-right">MRR</th>
                        <th className="text-[#525252] text-xs font-mono uppercase tracking-wider pb-3 pr-4 text-center">Status</th>
                        <th className="text-[#525252] text-xs font-mono uppercase tracking-wider pb-3 text-center">Compare</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyList.map((run) => {
                        const id = getRunId(run);
                        const scores = extractScores(run);
                        const passed = derivePassFail(run);
                        const isSelectedA = compareA === id;
                        const isSelectedB = compareB === id;

                        return (
                          <tr key={id} className="border-b border-[#eae7e1] hover:bg-[#faf9f4] transition-colors">
                            <td className="py-3 pr-4">
                              <span className="text-[#525252] text-xs font-mono">
                                {typeof id === 'string' ? id.slice(0, 8) : id}
                              </span>
                            </td>
                            <td className="py-3 pr-4">
                              <span className="text-[#525252] text-xs font-mono">{formatDate(getRunTimestamp(run))}</span>
                            </td>
                            <td className="py-3 pr-4 text-right">
                              <span className="text-sm font-mono font-semibold" style={{ color: scores.precision != null ? scoreColor(scores.precision) : '#666' }}>
                                {scores.precision != null ? scores.precision.toFixed(3) : '--'}
                              </span>
                            </td>
                            <td className="py-3 pr-4 text-right">
                              <span className="text-sm font-mono font-semibold" style={{ color: scores.recall != null ? scoreColor(scores.recall) : '#666' }}>
                                {scores.recall != null ? scores.recall.toFixed(3) : '--'}
                              </span>
                            </td>
                            <td className="py-3 pr-4 text-right">
                              <span className="text-sm font-mono font-semibold" style={{ color: scores.f1 != null ? scoreColor(scores.f1) : '#666' }}>
                                {scores.f1 != null ? scores.f1.toFixed(3) : '--'}
                              </span>
                            </td>
                            <td className="py-3 pr-4 text-right">
                              <span className="text-sm font-mono font-semibold" style={{ color: scores.ndcg != null ? scoreColor(scores.ndcg) : '#666' }}>
                                {scores.ndcg != null ? scores.ndcg.toFixed(3) : '--'}
                              </span>
                            </td>
                            <td className="py-3 pr-4 text-right">
                              <span className="text-sm font-mono font-semibold" style={{ color: scores.mrr != null ? scoreColor(scores.mrr) : '#666' }}>
                                {scores.mrr != null ? scores.mrr.toFixed(3) : '--'}
                              </span>
                            </td>
                            <td className="py-3 pr-4 text-center">
                              <StatusBadge passed={passed} />
                            </td>
                            <td className="py-3 text-center">
                              <div className="flex items-center justify-center gap-2">
                                <button
                                  onClick={() => setCompareA(isSelectedA ? null : id)}
                                  className={`px-2 py-1 rounded text-[10px] font-mono transition-colors ${
                                    isSelectedA
                                      ? 'bg-[#117dff]/20 text-[#117dff] border border-[#117dff]/30'
                                      : 'bg-[#f3f1ec] text-[#525252] border border-[#e3e0db] hover:text-[#525252]'
                                  }`}
                                >
                                  A
                                </button>
                                <button
                                  onClick={() => setCompareB(isSelectedB ? null : id)}
                                  className={`px-2 py-1 rounded text-[10px] font-mono transition-colors ${
                                    isSelectedB
                                      ? 'bg-[#3b82f6]/20 text-[#3b82f6] border border-[#3b82f6]/30'
                                      : 'bg-[#f3f1ec] text-[#525252] border border-[#e3e0db] hover:text-[#525252]'
                                  }`}
                                >
                                  B
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-[#a3a3a3] text-sm font-mono text-center py-6">
                  No evaluation history available
                </p>
              )}
            </div>

            {/* Comparison */}
            {comparisonRuns && (
              <div className="bg-white border border-[#e3e0db] rounded-xl p-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                <div className="flex items-center gap-2 mb-6">
                  <BarChart3 size={16} className="text-[#525252]" />
                  <h3 className="text-[#0a0a0a] text-lg font-bold font-['Space_Grotesk']">Comparison</h3>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {comparisonRuns.map((run, idx) => {
                    const scores = extractScores(run);
                    const passed = derivePassFail(run);
                    const id = getRunId(run);
                    const label = idx === 0 ? 'A' : 'B';
                    const accent = idx === 0 ? '#117dff' : '#3b82f6';

                    return (
                      <div
                        key={id}
                        className="rounded-xl border p-5"
                        style={{ borderColor: `${accent}33`, background: `${accent}08` }}
                      >
                        <div className="flex items-center justify-between mb-4">
                          <div className="flex items-center gap-2">
                            <span
                              className="w-6 h-6 rounded flex items-center justify-center text-xs font-mono font-bold"
                              style={{ background: `${accent}22`, color: accent }}
                            >
                              {label}
                            </span>
                            <span className="text-[#525252] text-xs font-mono">
                              {typeof id === 'string' ? id.slice(0, 8) : id}
                            </span>
                          </div>
                          <StatusBadge passed={passed} />
                        </div>

                        <div className="grid grid-cols-3 gap-4 mb-3">
                          <ScoreDisplay label="Precision" value={scores.precision} />
                          <ScoreDisplay label="Recall" value={scores.recall} />
                          <ScoreDisplay label="F1" value={scores.f1} />
                        </div>

                        <div className="flex items-center gap-1.5 text-[#a3a3a3] text-xs font-mono">
                          <Clock size={12} />
                          {formatDate(getRunTimestamp(run))}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Delta row */}
                {(() => {
                  const aScores = extractScores(comparisonRuns[0]);
                  const bScores = extractScores(comparisonRuns[1]);
                  const deltas = {
                    precision: aScores.precision != null && bScores.precision != null ? bScores.precision - aScores.precision : null,
                    recall: aScores.recall != null && bScores.recall != null ? bScores.recall - aScores.recall : null,
                    f1: aScores.f1 != null && bScores.f1 != null ? bScores.f1 - aScores.f1 : null,
                  };

                  const hasDelta = Object.values(deltas).some((d) => d != null);
                  if (!hasDelta) return null;

                  return (
                    <div className="mt-4 pt-4 border-t border-[#e3e0db]">
                      <p className="text-[#525252] text-xs font-mono uppercase tracking-wider mb-3">
                        Delta (B - A)
                      </p>
                      <div className="grid grid-cols-3 gap-8 text-center">
                        {['precision', 'recall', 'f1'].map((key) => {
                          const d = deltas[key];
                          if (d == null) return <div key={key} className="text-[#d4d0ca] font-mono">--</div>;
                          const sign = d >= 0 ? '+' : '';
                          const color = d > 0 ? '#22c55e' : d < 0 ? '#ef4444' : '#666';
                          return (
                            <div key={key}>
                              <span className="text-[#525252] text-xs font-mono uppercase block mb-1">{key}</span>
                              <span className="text-lg font-mono font-bold" style={{ color }}>
                                {sign}{d.toFixed(3)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        )}
      </motion.div>
    </div>
  );
}
