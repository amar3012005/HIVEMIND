import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Globe,
  Search,
  FileText,
  Play,
  RefreshCw,
  Clock,
  AlertTriangle,
  Lock,
  ChevronDown,
  ChevronRight,
  Save,
  RotateCcw,
  ExternalLink,
  ShieldAlert,
  ShieldCheck,
  XCircle,
  Timer,
  Ban,
  Zap,
  CircuitBoard,
  CheckCircle2,
  Loader2,
  BookmarkPlus,
} from 'lucide-react';
import apiClient from '../shared/api-client';
import { useApiQuery } from '../shared/hooks';

/* ─── Animation Variants ─────────────────────────────────────────── */

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: 'easeOut' } },
};

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06 } },
};

const fadeIn = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.25 } },
  exit: { opacity: 0, transition: { duration: 0.15 } },
};

/* ─── Design Tokens ──────────────────────────────────────────────── */

const CARD = 'bg-white border border-[#e3e0db] rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.04)]';
const INPUT = 'bg-transparent border border-[#e3e0db] rounded-lg py-2 px-3 text-[#0a0a0a] text-sm placeholder:text-[#a3a3a3] focus:outline-none focus:border-[#117dff]/40 font-[\'Space_Grotesk\']';
const BTN_PRIMARY = 'flex items-center gap-1.5 bg-[#117dff] hover:bg-[#0066e0] disabled:opacity-40 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-all';
const BTN_GHOST = 'flex items-center gap-1.5 text-[#525252] hover:text-[#117dff] hover:bg-[#117dff]/5 text-xs font-medium px-2.5 py-1.5 rounded-lg transition-all';

/* ─── Error Type Labels ──────────────────────────────────────────── */

const ERROR_LABELS = {
  navigation_failed: { label: 'Navigation Failed', icon: XCircle, color: 'text-red-500' },
  timeout: { label: 'Timed Out', icon: Timer, color: 'text-amber-600' },
  blocked_site: { label: 'Blocked by Site', icon: Ban, color: 'text-red-500' },
  concurrency_limit: { label: 'Concurrency Limit', icon: Zap, color: 'text-amber-600' },
  circuit_open: { label: 'Circuit Breaker Open', icon: CircuitBoard, color: 'text-orange-500' },
};

function isFeatureNotEnabledError(err) {
  const status = err?.response?.status;
  const code = err?.response?.data?.code;
  const required = err?.response?.data?.required_entitlement;
  return status === 403 && (code === 'feature_not_enabled' || required === 'web_search' || required === 'web_crawl');
}

/* ─── Utility: Quota Color ───────────────────────────────────────── */

function quotaColor(used, limit) {
  if (!limit) return 'bg-[#117dff]';
  const pct = (used / limit) * 100;
  if (pct >= 80) return 'bg-red-500';
  if (pct >= 50) return 'bg-amber-400';
  return 'bg-emerald-500';
}

function quotaTextColor(used, limit) {
  if (!limit) return 'text-[#117dff]';
  const pct = (used / limit) * 100;
  if (pct >= 80) return 'text-red-600';
  if (pct >= 50) return 'text-amber-600';
  return 'text-emerald-600';
}

/* ─── Sub-Components ─────────────────────────────────────────────── */

function UsageCard({ label, used, limit, icon: Icon, period }) {
  const pct = limit ? Math.min((used / limit) * 100, 100) : 0;
  const isWarning = pct >= 80;
  return (
    <div className={CARD + ' p-4'}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Icon size={14} className="text-[#a3a3a3]" />
          <span className="text-[#525252] text-[11px] font-mono uppercase tracking-wider">{label}</span>
        </div>
        {period && (
          <span className="text-[9px] font-mono bg-[#f3f1ec] text-[#a3a3a3] px-1.5 py-0.5 rounded uppercase">{period}</span>
        )}
      </div>
      <div className="flex items-baseline gap-1 mb-2">
        <span className={`text-lg font-bold font-mono ${quotaTextColor(used ?? 0, limit)}`}>
          {used ?? 0}
        </span>
        <span className="text-[#d4d0ca] text-sm font-mono">/ {limit ?? '\u221e'}</span>
        <span className="text-[#a3a3a3] text-[10px] font-['Space_Grotesk'] ml-1">
          {label.toLowerCase()}
        </span>
      </div>
      <div className="w-full h-1.5 rounded-full bg-[#e3e0db] overflow-hidden">
        <motion.div
          className={`h-full rounded-full ${quotaColor(used ?? 0, limit)}`}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        />
      </div>
      {isWarning && (
        <div className="flex items-center gap-1 mt-2">
          <AlertTriangle size={10} className="text-amber-500" />
          <span className="text-amber-600 text-[10px] font-['Space_Grotesk']">Soft limit approaching</span>
        </div>
      )}
    </div>
  );
}

function JobStatusBadge({ status }) {
  const styles = {
    queued: 'bg-[#f3f1ec] text-[#525252] border-[#e3e0db]',
    running: 'bg-blue-50 text-blue-600 border-blue-200',
    succeeded: 'bg-emerald-50 text-emerald-600 border-emerald-200',
    failed: 'bg-red-50 text-red-600 border-red-200',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-mono uppercase tracking-wider border ${styles[status] || styles.queued}`}>
      {status === 'running' && <Loader2 size={10} className="animate-spin mr-1" />}
      {status}
    </span>
  );
}

function RuntimeBadge({ runtime, fallback }) {
  if (!runtime) return null;
  return (
    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${fallback ? 'bg-amber-50 text-amber-600 border border-amber-200' : 'bg-[#f3f1ec] text-[#525252] border border-[#e3e0db]'}`}>
      {runtime}{fallback ? ' (fallback)' : ''}
    </span>
  );
}

function ErrorDetail({ errorType }) {
  const info = ERROR_LABELS[errorType];
  if (!info) {
    return <span className="text-red-500 text-[10px] font-mono">{errorType || 'unknown'}</span>;
  }
  const ErrIcon = info.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-mono ${info.color}`}>
      <ErrIcon size={10} />
      {info.label}
    </span>
  );
}

function PartialBadge({ pagesProcessed, totalPages }) {
  if (!totalPages || !pagesProcessed || pagesProcessed >= totalPages) return null;
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono bg-amber-50 text-amber-600 border border-amber-200">
      Partial ({pagesProcessed}/{totalPages} pages)
    </span>
  );
}

function DomainPolicyBadge({ policy }) {
  if (!policy) return null;
  if (policy.blocked) {
    return (
      <motion.div variants={fadeIn} initial="hidden" animate="visible" className="flex items-center gap-1.5 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">
        <Ban size={12} className="text-red-500 shrink-0" />
        <span className="text-red-600 text-[11px] font-['Space_Grotesk']">
          This domain is blocked: {policy.reason || 'policy restriction'}
        </span>
      </motion.div>
    );
  }
  if (policy.warnings?.length > 0) {
    return (
      <motion.div variants={fadeIn} initial="hidden" animate="visible" className="flex items-start gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
        <ShieldAlert size={12} className="text-amber-500 shrink-0 mt-0.5" />
        <div className="text-amber-700 text-[11px] font-['Space_Grotesk']">
          {policy.warnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      </motion.div>
    );
  }
  if (policy.allowed) {
    return (
      <motion.div variants={fadeIn} initial="hidden" animate="visible" className="flex items-center gap-1.5 mt-2">
        <ShieldCheck size={11} className="text-emerald-500" />
        <span className="text-emerald-600 text-[10px] font-['Space_Grotesk']">Domain policy: OK</span>
      </motion.div>
    );
  }
  return null;
}

function InlineToast({ message, type = 'success' }) {
  if (!message) return null;
  const colors = type === 'success'
    ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
    : 'bg-red-50 border-red-200 text-red-600';
  const ToastIcon = type === 'success' ? CheckCircle2 : XCircle;
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-['Space_Grotesk'] ${colors}`}
    >
      <ToastIcon size={12} />
      {message}
    </motion.div>
  );
}

/* ─── Result Preview Components ──────────────────────────────────── */

function SearchResultCard({ result, jobId, index, onSave }) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiClient.saveWebResultToMemory(jobId, {
        resultIndex: index,
        title: result.title || result.url,
        tags: ['web-search'],
      });
      setSaved(true);
      if (onSave) onSave();
    } catch {
      // silent
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div variants={fadeUp} className="border border-[#e3e0db] rounded-lg p-3 hover:border-[#117dff]/30 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <a
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#117dff] text-sm font-semibold font-['Space_Grotesk'] hover:underline flex items-center gap-1 truncate"
          >
            {result.title || result.url}
            <ExternalLink size={10} className="shrink-0" />
          </a>
          <p className="text-[#a3a3a3] text-[10px] font-mono truncate mt-0.5">{result.url}</p>
          {result.snippet && (
            <p className="text-[#525252] text-xs font-['Space_Grotesk'] mt-1.5 line-clamp-2">{result.snippet}</p>
          )}
        </div>
        <button
          onClick={handleSave}
          disabled={saving || saved}
          className={`shrink-0 ${saved ? 'text-emerald-500' : 'text-[#a3a3a3] hover:text-[#117dff]'} transition-colors`}
          title={saved ? 'Saved' : 'Save this result'}
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <CheckCircle2 size={14} /> : <BookmarkPlus size={14} />}
        </button>
      </div>
    </motion.div>
  );
}

function CrawlResultCard({ result, jobId, index, onSave }) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiClient.saveWebResultToMemory(jobId, {
        resultIndex: index,
        title: result.title || result.url,
        tags: ['web-crawl'],
      });
      setSaved(true);
      if (onSave) onSave();
    } catch {
      // silent
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div variants={fadeUp} className="flex items-center justify-between border border-[#e3e0db] rounded-lg px-3 py-2 hover:border-[#117dff]/30 transition-colors">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <FileText size={13} className="text-[#a3a3a3] shrink-0" />
        <div className="min-w-0">
          <p className="text-[#0a0a0a] text-xs font-semibold font-['Space_Grotesk'] truncate">{result.title || result.url}</p>
          <p className="text-[#a3a3a3] text-[10px] font-mono truncate">{result.url}</p>
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {result.word_count != null && (
          <span className="text-[9px] font-mono text-[#a3a3a3] bg-[#f3f1ec] px-1.5 py-0.5 rounded">
            {result.word_count.toLocaleString()} words
          </span>
        )}
        <button
          onClick={handleSave}
          disabled={saving || saved}
          className={`${saved ? 'text-emerald-500' : 'text-[#a3a3a3] hover:text-[#117dff]'} transition-colors`}
          title={saved ? 'Saved' : 'Save this result'}
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <CheckCircle2 size={14} /> : <BookmarkPlus size={14} />}
        </button>
      </div>
    </motion.div>
  );
}

/* ─── Expandable Job Row ─────────────────────────────────────────── */

function JobRow({ job, onRetry, onSaveAll, pollingJobId }) {
  const [expanded, setExpanded] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryToast, setRetryToast] = useState(null);
  const [saveToast, setSaveToast] = useState(null);
  const [savingAll, setSavingAll] = useState(false);

  const results = job.results || [];
  const hasResults = results.length > 0;
  const isPolling = pollingJobId === job.id;

  const handleRetry = async (e) => {
    e.stopPropagation();
    setRetrying(true);
    setRetryToast(null);
    try {
      await apiClient.retryWebJob(job.id);
      setRetryToast({ type: 'success', message: 'Job re-queued' });
      if (onRetry) onRetry();
    } catch (err) {
      setRetryToast({ type: 'error', message: err.response?.data?.error || 'Retry failed' });
    } finally {
      setRetrying(false);
      setTimeout(() => setRetryToast(null), 3000);
    }
  };

  const handleSaveAll = async (e) => {
    e.stopPropagation();
    setSavingAll(true);
    setSaveToast(null);
    try {
      await apiClient.saveWebResultToMemory(job.id, {
        title: job.query || job.urls?.[0] || `Web ${job.type} results`,
        tags: [`web-${job.type}`],
      });
      setSaveToast({ type: 'success', message: 'Saved to memory' });
      if (onSaveAll) onSaveAll();
    } catch (err) {
      setSaveToast({ type: 'error', message: err.response?.data?.error || 'Save failed' });
    } finally {
      setSavingAll(false);
      setTimeout(() => setSaveToast(null), 3000);
    }
  };

  return (
    <>
      <tr
        className="border-b border-[#eae7e1] hover:bg-[#faf9f4] transition-colors cursor-pointer"
        onClick={() => hasResults && setExpanded(!expanded)}
      >
        <td className="py-2.5 pr-3 text-[#525252] text-[11px] font-mono">
          <div className="flex items-center gap-1">
            {hasResults && (expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />)}
            {isPolling && <Loader2 size={10} className="animate-spin text-blue-500" />}
            {(job.id || '').slice(0, 8)}
          </div>
        </td>
        <td className="py-2.5 pr-3">
          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${job.type === 'search' ? 'bg-[#117dff]/10 text-[#117dff]' : 'bg-[#f3f1ec] text-[#525252]'}`}>
            {job.type}
          </span>
        </td>
        <td className="py-2.5 pr-3">
          <div className="flex items-center gap-2">
            <JobStatusBadge status={job.status} />
            {job.status === 'failed' && job.error_type && <ErrorDetail errorType={job.error_type} />}
            <PartialBadge pagesProcessed={job.pages_processed} totalPages={job.total_pages} />
          </div>
        </td>
        <td className="py-2.5 pr-3"><RuntimeBadge runtime={job.runtime_used} fallback={job.fallback_applied} /></td>
        <td className="py-2.5 pr-3 text-[#525252] text-[11px] font-mono">{job.pages_processed ?? '-'}</td>
        <td className="py-2.5 pr-3 text-[#a3a3a3] text-[11px] font-mono">{job.duration_ms ? `${job.duration_ms}ms` : '-'}</td>
        <td className="py-2.5 pr-3 text-[#a3a3a3] text-[10px] font-mono">{job.created_at ? new Date(job.created_at).toLocaleString() : '-'}</td>
        <td className="py-2.5">
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {job.status === 'failed' && (
              <button onClick={handleRetry} disabled={retrying} className={BTN_GHOST} title="Retry">
                {retrying ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
              </button>
            )}
            {(job.status === 'succeeded' || hasResults) && (
              <button onClick={handleSaveAll} disabled={savingAll} className={BTN_GHOST} title="Save to Memory">
                {savingAll ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              </button>
            )}
            <AnimatePresence>
              {retryToast && <InlineToast {...retryToast} />}
              {saveToast && <InlineToast {...saveToast} />}
            </AnimatePresence>
          </div>
        </td>
      </tr>
      <AnimatePresence>
        {expanded && hasResults && (
          <tr>
            <td colSpan={8} className="px-2 pb-3">
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="bg-[#faf9f4] rounded-lg p-3 mt-1 space-y-2 max-h-64 overflow-y-auto">
                  <motion.div variants={stagger} initial="hidden" animate="visible" className="space-y-2">
                    {results.map((r, i) =>
                      job.type === 'search' ? (
                        <SearchResultCard key={i} result={r} jobId={job.id} index={i} />
                      ) : (
                        <CrawlResultCard key={i} result={r} jobId={job.id} index={i} />
                      )
                    )}
                  </motion.div>
                </div>
              </motion.div>
            </td>
          </tr>
        )}
      </AnimatePresence>
    </>
  );
}

/* ─── Locked Overlay ─────────────────────────────────────────────── */

function LockedOverlay() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="absolute inset-0 z-20 flex items-center justify-center backdrop-blur-sm bg-white/60 rounded-xl"
    >
      <div className="text-center max-w-xs">
        <div className="w-14 h-14 rounded-full bg-[#f3f1ec] flex items-center justify-center mx-auto mb-4">
          <Lock size={24} className="text-[#a3a3a3]" />
        </div>
        <h3 className="text-[#0a0a0a] text-lg font-bold font-['Space_Grotesk'] mb-2">
          Web Intelligence is Locked
        </h3>
        <p className="text-[#525252] text-sm font-['Space_Grotesk'] mb-5">
          Upgrade your plan to unlock web search, crawling, and page intelligence features.
        </p>
        <a
          href="/hivemind/app/billing"
          className="inline-flex items-center gap-2 bg-[#117dff] hover:bg-[#0066e0] text-white text-sm font-semibold px-6 py-2.5 rounded-lg transition-all font-['Space_Grotesk']"
        >
          <Lock size={14} />
          Upgrade to unlock Web Intelligence
        </a>
      </div>
    </motion.div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Main Component ─────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

export default function WebIntelligence() {
  // ─── Core state ────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [crawlUrl, setCrawlUrl] = useState('');
  const [crawlDepth, setCrawlDepth] = useState(1);
  const [crawlPageLimit, setCrawlPageLimit] = useState(10);
  const [submitting, setSubmitting] = useState(null);
  const [submitError, setSubmitError] = useState(null);

  // ─── Entitlement state ─────────────────────────
  const [featureLocked, setFeatureLocked] = useState(false);
  const [limitsLoaded, setLimitsLoaded] = useState(false);

  // ─── Domain policy state ───────────────────────
  const [domainPolicy, setDomainPolicy] = useState(null);
  const [checkingPolicy, setCheckingPolicy] = useState(false);

  // ─── Polling state ─────────────────────────────
  const [pollingJobId, setPollingJobId] = useState(null);
  const pollingRef = useRef(null);

  // ─── API queries ───────────────────────────────
  const { data: usage, refetch: refetchUsage } = useApiQuery(() => apiClient.getWebUsage().catch(() => null));
  const { data: monthlyUsage, refetch: refetchMonthly } = useApiQuery(() => apiClient.getWebMonthlyUsage().catch(() => null));
  const { data: jobs, refetch: refetchJobs } = useApiQuery(() => apiClient.listWebJobs({ limit: 30 }).catch(() => null));

  // ─── Entitlement check on mount ────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const limits = await apiClient.getWebLimits();
        if (!cancelled) {
          if (limits?.feature_not_enabled) {
            setFeatureLocked(true);
          }
          setLimitsLoaded(true);
        }
      } catch (err) {
        if (!cancelled) {
          if (isFeatureNotEnabledError(err) || err?.response?.data?.code === 'feature_not_enabled') {
            setFeatureLocked(true);
          }
          setLimitsLoaded(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ─── Normalize job list ────────────────────────
  const jobList = useMemo(() => {
    if (!jobs) return [];
    return Array.isArray(jobs) ? jobs : jobs.jobs || [];
  }, [jobs]);

  // ─── Polling cleanup ──────────────────────────
  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  // ─── Start polling a job ──────────────────────
  const startPolling = useCallback((jobId) => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    setPollingJobId(jobId);

    pollingRef.current = setInterval(async () => {
      try {
        const result = await apiClient.getWebJob(jobId);
        if (result?.status === 'succeeded' || result?.status === 'failed') {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
          setPollingJobId(null);
          refetchJobs();
          refetchUsage();
          refetchMonthly();
        }
      } catch {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
        setPollingJobId(null);
        refetchJobs();
      }
    }, 2000);
  }, [refetchJobs, refetchUsage, refetchMonthly]);

  // ─── Domain policy check ──────────────────────
  const handleCrawlUrlBlur = useCallback(async () => {
    const url = crawlUrl.trim();
    if (!url) {
      setDomainPolicy(null);
      return;
    }
    try {
      new URL(url); // validate
    } catch {
      setDomainPolicy(null);
      return;
    }
    setCheckingPolicy(true);
    try {
      const policy = await apiClient.checkDomainPolicy(url);
      setDomainPolicy(policy);
    } catch {
      setDomainPolicy(null);
    } finally {
      setCheckingPolicy(false);
    }
  }, [crawlUrl]);

  // ─── Submit handlers ──────────────────────────
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSubmitting('search');
    setSubmitError(null);
    try {
      const result = await apiClient.submitWebSearch({ query: searchQuery.trim(), limit: 10 });
      setSearchQuery('');
      refetchJobs();
      refetchUsage();
      const searchJobId = result?.job_id || result?.id;
      if (searchJobId) startPolling(searchJobId);
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      if (isFeatureNotEnabledError(err)) {
        setFeatureLocked(true);
      }
      setSubmitError(
        isFeatureNotEnabledError(err) || err?.response?.data?.code === 'feature_not_enabled'
          ? 'Web Search is not enabled on your plan. Upgrade to access.'
          : msg
      );
    } finally {
      setSubmitting(null);
    }
  };

  const handleCrawl = async () => {
    if (!crawlUrl.trim()) return;
    if (domainPolicy?.blocked) return;
    setSubmitting('crawl');
    setSubmitError(null);
    try {
      const result = await apiClient.submitWebCrawl({
        urls: [crawlUrl.trim()],
        depth: crawlDepth,
        page_limit: crawlPageLimit,
      });
      setCrawlUrl('');
      setDomainPolicy(null);
      refetchJobs();
      refetchUsage();
      const crawlJobId = result?.job_id || result?.id;
      if (crawlJobId) startPolling(crawlJobId);
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      if (isFeatureNotEnabledError(err)) {
        setFeatureLocked(true);
      }
      setSubmitError(
        isFeatureNotEnabledError(err) || err?.response?.data?.code === 'feature_not_enabled'
          ? 'Web Crawl is not enabled on your plan. Upgrade to access.'
          : msg
      );
    } finally {
      setSubmitting(null);
    }
  };

  // ─── Render ───────────────────────────────────

  return (
    <div className="max-w-5xl mx-auto font-['Space_Grotesk']">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <Globe size={20} className="text-[#117dff]" />
          <h1 className="text-[#0a0a0a] text-2xl font-bold">Web Intelligence</h1>
          <span className="text-[9px] font-mono bg-[#117dff]/10 text-[#117dff] px-2 py-0.5 rounded uppercase">Add-on</span>
          {featureLocked && (
            <span className="text-[9px] font-mono bg-red-50 text-red-500 px-2 py-0.5 rounded uppercase border border-red-200 flex items-center gap-1">
              <Lock size={8} /> Locked
            </span>
          )}
        </div>
        <p className="text-[#525252] text-sm ml-8">Search the web and crawl pages as async jobs.</p>
      </motion.div>

      {/* Global submit error */}
      <AnimatePresence>
        {submitError && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="flex items-center gap-2 bg-[#fef2f2] border border-[#fecaca] rounded-xl px-4 py-3 mb-4"
          >
            <AlertTriangle size={14} className="text-[#dc2626] shrink-0" />
            <span className="text-[#dc2626] text-xs">{submitError}</span>
            <button onClick={() => setSubmitError(null)} className="ml-auto text-[#dc2626]/50 hover:text-[#dc2626]">
              <XCircle size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main content wrapper — lockable */}
      <div className="relative">
        {featureLocked && limitsLoaded && <LockedOverlay />}

        <motion.div
          variants={stagger}
          initial="hidden"
          animate="visible"
          className={`space-y-6 ${featureLocked ? 'opacity-30 blur-[2px] select-none pointer-events-none' : ''}`}
        >
          {/* ─── Quota Section ──────────────────────────── */}
          <motion.div variants={fadeUp} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <UsageCard
              label="Searches today"
              used={usage?.web_search_requests?.used}
              limit={usage?.web_search_requests?.limit}
              icon={Search}
              period="Daily"
            />
            <UsageCard
              label="Crawl pages today"
              used={usage?.web_crawl_pages?.used}
              limit={usage?.web_crawl_pages?.limit}
              icon={FileText}
              period="Daily"
            />
            <UsageCard
              label="Searches this month"
              used={monthlyUsage?.web_search_requests?.used}
              limit={monthlyUsage?.web_search_requests?.limit}
              icon={Search}
              period="Monthly"
            />
            <UsageCard
              label="Crawl pages this month"
              used={monthlyUsage?.web_crawl_pages?.used}
              limit={monthlyUsage?.web_crawl_pages?.limit}
              icon={FileText}
              period="Monthly"
            />
          </motion.div>

          {/* ─── Search & Crawl Forms ───────────────────── */}
          <motion.div variants={fadeUp} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Search Form */}
            <div className={CARD + ' p-5'}>
              <div className="flex items-center gap-2 mb-3">
                <Search size={15} className="text-[#117dff]" />
                <h3 className="text-[#0a0a0a] text-sm font-semibold">Web Search</h3>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  placeholder="Search query..."
                  className={INPUT + ' flex-1'}
                />
                <button
                  onClick={handleSearch}
                  disabled={!searchQuery.trim() || submitting === 'search'}
                  className={BTN_PRIMARY}
                >
                  {submitting === 'search' ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                  Search
                </button>
              </div>
            </div>

            {/* Crawl Form */}
            <div className={CARD + ' p-5'}>
              <div className="flex items-center gap-2 mb-3">
                <FileText size={15} className="text-[#525252]" />
                <h3 className="text-[#0a0a0a] text-sm font-semibold">Web Crawl</h3>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={crawlUrl}
                  onChange={(e) => { setCrawlUrl(e.target.value); setDomainPolicy(null); }}
                  onBlur={handleCrawlUrlBlur}
                  onKeyDown={(e) => e.key === 'Enter' && handleCrawl()}
                  placeholder="https://example.com"
                  className={INPUT + ' flex-1'}
                />
                <button
                  onClick={handleCrawl}
                  disabled={!crawlUrl.trim() || submitting === 'crawl' || domainPolicy?.blocked}
                  className={BTN_PRIMARY}
                >
                  {submitting === 'crawl' ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                  Crawl
                </button>
              </div>

              {/* Domain policy feedback */}
              {checkingPolicy && (
                <div className="flex items-center gap-1.5 mt-2 text-[#a3a3a3] text-[10px]">
                  <Loader2 size={10} className="animate-spin" /> Checking domain policy...
                </div>
              )}
              <DomainPolicyBadge policy={domainPolicy} />

              {/* Crawl options */}
              <div className="flex items-center gap-4 mt-3">
                <div className="flex items-center gap-2">
                  <label className="text-[#a3a3a3] text-[10px] font-mono uppercase tracking-wider">Depth</label>
                  <select
                    value={crawlDepth}
                    onChange={(e) => setCrawlDepth(Number(e.target.value))}
                    className="bg-[#faf9f4] border border-[#e3e0db] rounded-md text-[#0a0a0a] text-xs px-2 py-1 focus:outline-none focus:border-[#117dff]/40"
                  >
                    {[1, 2, 3, 4].map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[#a3a3a3] text-[10px] font-mono uppercase tracking-wider">Page Limit</label>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={crawlPageLimit}
                    onChange={(e) => setCrawlPageLimit(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
                    className="bg-[#faf9f4] border border-[#e3e0db] rounded-md text-[#0a0a0a] text-xs px-2 py-1 w-20 focus:outline-none focus:border-[#117dff]/40 font-mono"
                  />
                </div>
              </div>
            </div>
          </motion.div>

          {/* ─── Active Polling Indicator ────────────────── */}
          <AnimatePresence>
            {pollingJobId && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
                  <Loader2 size={14} className="animate-spin text-blue-500" />
                  <span className="text-blue-700 text-xs">
                    Job <span className="font-mono">{pollingJobId?.slice(0, 8)}</span> is running... Polling for updates.
                  </span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ─── Job History ────────────────────────────── */}
          <motion.div variants={fadeUp} className={CARD + ' p-5'}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Clock size={15} className="text-[#a3a3a3]" />
                <h3 className="text-[#0a0a0a] text-sm font-semibold">Job History</h3>
                {jobList.length > 0 && (
                  <span className="text-[9px] font-mono bg-[#f3f1ec] text-[#a3a3a3] px-1.5 py-0.5 rounded">
                    {jobList.length} jobs
                  </span>
                )}
              </div>
              <button
                onClick={() => { refetchJobs(); refetchUsage(); refetchMonthly(); }}
                className="text-[#a3a3a3] hover:text-[#117dff] transition-colors"
                title="Refresh"
              >
                <RefreshCw size={14} />
              </button>
            </div>

            {jobList.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-[#e3e0db]">
                      {['Job ID', 'Type', 'Status', 'Runtime', 'Pages', 'Duration', 'Created', 'Actions'].map((h) => (
                        <th key={h} className="text-[#a3a3a3] text-[10px] font-mono uppercase tracking-wider pb-2.5 pr-3">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {jobList.map((job) => (
                      <JobRow
                        key={job.id}
                        job={job}
                        pollingJobId={pollingJobId}
                        onRetry={() => { refetchJobs(); refetchUsage(); }}
                        onSaveAll={refetchJobs}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-10">
                <Globe size={28} className="text-[#e3e0db] mx-auto mb-3" />
                <p className="text-[#a3a3a3] text-sm mb-1">No web jobs yet</p>
                <p className="text-[#d4d0ca] text-xs">Submit a search or crawl above to get started.</p>
              </div>
            )}
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}
