import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Shield,
  RefreshCw,
  Activity,
  CheckCircle,
  XCircle,
  Clock,
  Layers,
  Zap,
  AlertTriangle,
  TrendingUp,
  Info,
} from 'lucide-react';
import apiClient from '../shared/api-client';
import { useApiQuery } from '../shared/hooks';


const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: 'easeOut' } },
};

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.07 } },
};

function formatMs(ms) {
  if (ms == null) return '--';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatUptime(seconds) {
  if (seconds == null) return '--';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function successRateColor(rate) {
  if (rate >= 90) return '#22c55e';
  if (rate >= 70) return '#f59e0b';
  return '#ef4444';
}

function MetricCard({ label, value, subtitle, icon: Icon, valueColor }) {
  return (
    <motion.div
      variants={fadeUp}
      className="bg-white border border-[#e3e0db] rounded-xl p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
    >
      <div className="flex items-center gap-2 mb-3">
        <Icon size={14} className="text-[#a3a3a3]" />
        <span className="text-[#525252] text-xs font-mono uppercase tracking-wider">{label}</span>
      </div>
      <div
        className="text-2xl font-bold font-mono leading-none mb-1"
        style={{ color: valueColor || '#0a0a0a' }}
      >
        {value}
      </div>
      {subtitle && (
        <span className="text-[#a3a3a3] text-[10px] font-mono">{subtitle}</span>
      )}
    </motion.div>
  );
}

function RuntimeBar({ label, count, total, color }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-[#525252] text-xs font-mono w-28 shrink-0">{label}</span>
      <div className="flex-1 h-6 bg-[#f3f1ec] rounded-full overflow-hidden relative">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
          className="h-full rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="absolute inset-0 flex items-center justify-center text-[10px] font-mono font-semibold text-[#0a0a0a]">
          {count.toLocaleString()} ({pct.toFixed(1)}%)
        </span>
      </div>
    </div>
  );
}

function TelemetryRow({ label, value, warn }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[#eae7e1] last:border-b-0">
      <span className="text-[#525252] text-xs font-['Space_Grotesk']">{label}</span>
      <span
        className="text-sm font-mono font-semibold"
        style={{ color: warn ? '#ef4444' : '#0a0a0a' }}
      >
        {value}
      </span>
    </div>
  );
}

export default function WebAdmin() {
  const { data: metrics, loading, error, refetch } = useApiQuery(
    () => apiClient.getWebAdminMetrics(),
  );

  const [refreshing, setRefreshing] = useState(false);
  const intervalRef = useRef(null);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      refetch();
    }, 30000);
    return () => clearInterval(intervalRef.current);
  }, [refetch]);

  const handleManualRefresh = async () => {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  };

  if (loading && !metrics) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-[#117dff] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const m = metrics || {};
  const totalJobs = m.total_jobs ?? 0;
  const succeeded = m.succeeded ?? 0;
  const failed = m.failed ?? 0;
  const queued = m.queued ?? 0;
  const running = m.running ?? 0;
  const successRate = totalJobs > 0 ? ((succeeded / totalJobs) * 100) : 0;
  const avgDuration = m.avg_duration_ms;
  const p95Duration = m.p95_duration_ms;
  const queueDepth = queued + running;
  const jobs24h = m.jobs_last_24h ?? 0;

  const runtimeDist = m.runtime_distribution || {};
  const lightpandaCount = runtimeDist.lightpanda ?? 0;
  const fetchCount = runtimeDist.fetch ?? 0;
  const runtimeTotal = lightpandaCount + fetchCount;

  const telemetry = m.runtime_telemetry || {};
  const topErrors = m.top_errors || [];

  return (
    <div className="min-h-full">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8"
      >
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Shield size={20} className="text-[#117dff]" />
            <h1 className="text-[#0a0a0a] text-2xl font-bold font-['Space_Grotesk']">
              Web Intelligence Admin
            </h1>
          </div>
          <p className="text-[#525252] text-sm font-['Space_Grotesk']">
            Operational metrics and system health
          </p>
        </div>
        <button
          onClick={handleManualRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 bg-[#117dff] hover:bg-[#0066e0] disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 px-5 rounded-xl transition-all text-sm font-['Space_Grotesk'] group self-start"
        >
          <RefreshCw
            size={14}
            className={`transition-transform ${refreshing ? 'animate-spin' : 'group-hover:rotate-45'}`}
          />
          Refresh
        </button>
      </motion.div>

      {/* Error state */}
      {error && !metrics && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex items-center gap-2 bg-[#fef2f2] border border-[#fecaca] rounded-xl px-4 py-3 mb-4"
        >
          <AlertTriangle size={14} className="text-[#dc2626] shrink-0" />
          <span className="text-[#dc2626] text-xs font-mono">{error}</span>
        </motion.div>
      )}

      {/* Key Metrics Grid */}
      <motion.div
        variants={stagger}
        initial="hidden"
        animate="visible"
        className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6"
      >
        <MetricCard
          label="Total Jobs"
          icon={Layers}
          value={totalJobs.toLocaleString()}
          subtitle={`${succeeded} ok / ${failed} fail / ${queued} queued / ${running} running`}
        />
        <MetricCard
          label="Success Rate"
          icon={CheckCircle}
          value={`${successRate.toFixed(1)}%`}
          valueColor={successRateColor(successRate)}
          subtitle={`${succeeded.toLocaleString()} of ${totalJobs.toLocaleString()}`}
        />
        <MetricCard
          label="Avg Duration"
          icon={Clock}
          value={formatMs(avgDuration)}
          subtitle="Mean job runtime"
        />
        <MetricCard
          label="P95 Duration"
          icon={TrendingUp}
          value={formatMs(p95Duration)}
          subtitle="95th percentile"
        />
        <MetricCard
          label="Queue Depth"
          icon={Activity}
          value={queueDepth.toLocaleString()}
          subtitle={`${queued} queued + ${running} running`}
          valueColor={queueDepth > 50 ? '#f59e0b' : '#0a0a0a'}
        />
        <MetricCard
          label="Jobs (24h)"
          icon={Zap}
          value={jobs24h.toLocaleString()}
          subtitle="Last 24 hours"
        />
      </motion.div>

      {/* Runtime Distribution */}
      <motion.div
        variants={fadeUp}
        initial="hidden"
        animate="visible"
        className="bg-white border border-[#e3e0db] rounded-xl p-6 mb-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
      >
        <div className="flex items-center gap-2 mb-5">
          <Activity size={16} className="text-[#525252]" />
          <h3 className="text-[#0a0a0a] text-lg font-bold font-['Space_Grotesk']">
            Runtime Distribution
          </h3>
        </div>
        {runtimeTotal > 0 ? (
          <div className="space-y-3">
            <RuntimeBar
              label="Lightpanda"
              count={lightpandaCount}
              total={runtimeTotal}
              color="#117dff"
            />
            <RuntimeBar
              label="Fetch fallback"
              count={fetchCount}
              total={runtimeTotal}
              color="#f59e0b"
            />
          </div>
        ) : (
          <p className="text-[#a3a3a3] text-sm font-mono text-center py-6">
            No runtime distribution data
          </p>
        )}
      </motion.div>

      {/* Runtime Telemetry */}
      <motion.div
        variants={fadeUp}
        initial="hidden"
        animate="visible"
        className="bg-white border border-[#e3e0db] rounded-xl p-6 mb-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
      >
        <div className="flex items-center gap-2 mb-5">
          <Info size={16} className="text-[#525252]" />
          <h3 className="text-[#0a0a0a] text-lg font-bold font-['Space_Grotesk']">
            Runtime Telemetry
          </h3>
        </div>
        {Object.keys(telemetry).length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
            <div>
              <TelemetryRow
                label="Lightpanda successes"
                value={(telemetry.lightpanda_success ?? 0).toLocaleString()}
              />
              <TelemetryRow
                label="Lightpanda failures"
                value={(telemetry.lightpanda_failure ?? 0).toLocaleString()}
                warn={(telemetry.lightpanda_failure ?? 0) > 0}
              />
              <TelemetryRow
                label="Fallback successes"
                value={(telemetry.fallback_success ?? 0).toLocaleString()}
              />
              <TelemetryRow
                label="Fallback failures"
                value={(telemetry.fallback_failure ?? 0).toLocaleString()}
                warn={(telemetry.fallback_failure ?? 0) > 0}
              />
            </div>
            <div>
              <TelemetryRow
                label="Circuit breaker trips"
                value={(telemetry.circuit_breaker_trips ?? 0).toLocaleString()}
                warn={(telemetry.circuit_breaker_trips ?? 0) > 0}
              />
              <TelemetryRow
                label="Domain concurrency rejections"
                value={(telemetry.domain_concurrency_rejections ?? 0).toLocaleString()}
                warn={(telemetry.domain_concurrency_rejections ?? 0) > 0}
              />
              <TelemetryRow
                label="Uptime"
                value={formatUptime(telemetry.uptime_seconds)}
              />
            </div>
          </div>
        ) : (
          <p className="text-[#a3a3a3] text-sm font-mono text-center py-6">
            No telemetry data available
          </p>
        )}
      </motion.div>

      {/* Top Errors Table */}
      <motion.div
        variants={fadeUp}
        initial="hidden"
        animate="visible"
        className="bg-white border border-[#e3e0db] rounded-xl p-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
      >
        <div className="flex items-center gap-2 mb-5">
          <XCircle size={16} className="text-[#525252]" />
          <h3 className="text-[#0a0a0a] text-lg font-bold font-['Space_Grotesk']">
            Top Errors
          </h3>
        </div>
        {topErrors.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-[#e3e0db]">
                  <th className="text-[#525252] text-xs font-mono uppercase tracking-wider pb-3 pr-4">
                    Error
                  </th>
                  <th className="text-[#525252] text-xs font-mono uppercase tracking-wider pb-3 pr-4 text-right">
                    Count
                  </th>
                  <th className="text-[#525252] text-xs font-mono uppercase tracking-wider pb-3 text-right">
                    % of Failures
                  </th>
                </tr>
              </thead>
              <tbody>
                {topErrors.map((err, idx) => {
                  const pct = failed > 0
                    ? ((err.count / failed) * 100).toFixed(1)
                    : '0.0';
                  return (
                    <tr
                      key={idx}
                      className="border-b border-[#eae7e1] last:border-b-0 hover:bg-[#faf9f4] transition-colors"
                    >
                      <td className="py-3 pr-4">
                        <span className="text-[#525252] text-xs font-mono break-all">
                          {err.message || err.error || 'Unknown error'}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-right">
                        <span className="text-sm font-mono font-semibold text-[#ef4444]">
                          {(err.count ?? 0).toLocaleString()}
                        </span>
                      </td>
                      <td className="py-3 text-right">
                        <span className="text-sm font-mono text-[#525252]">{pct}%</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[#a3a3a3] text-sm font-mono text-center py-6">
            No errors recorded
          </p>
        )}
      </motion.div>
    </div>
  );
}
