import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  User,
  Brain,
  Tag,
  Link,
  Clock,
  Send,
  Building2,
  Shield,
  CreditCard,
  Eye,
  Download,
  Trash2,
  AlertTriangle,
  CheckCircle,
  MapPin,
  ExternalLink,
  Zap,
  BarChart2,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../shared/api-client';
import { useApiQuery } from '../shared/hooks';
import { useAuth } from '../auth/AuthProvider';

// ─── Animation Variants ───────────────────────────────────────────────────────

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06 } },
};

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: 'easeOut' } },
};

// ─── Small Reusable Components ────────────────────────────────────────────────

function SectionHeading({ children }) {
  return (
    <h3 className="text-[#0a0a0a] text-lg font-bold font-['Space_Grotesk'] mb-4">{children}</h3>
  );
}

function PillBadge({ children, variant = 'blue' }) {
  const variants = {
    blue: 'bg-[#117dff]/10 text-[#117dff] border-[#117dff]/20',
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    red: 'bg-red-50 text-red-600 border-red-200',
    gray: 'bg-[#f3f1ec] text-[#525252] border-[#e3e0db]',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
  };
  return (
    <span
      className={`inline-block px-3 py-1 rounded-full text-xs font-mono border ${variants[variant] || variants.blue}`}
    >
      {children}
    </span>
  );
}

function Card({ children, className = '' }) {
  return (
    <motion.div
      variants={fadeUp}
      className={`bg-white backdrop-blur-xl border border-[#e3e0db] rounded-xl p-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${className}`}
    >
      {children}
    </motion.div>
  );
}

function UsageBar({ label, used, limit, unit = '' }) {
  const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  const color =
    pct >= 80
      ? '#dc2626'
      : pct >= 50
      ? '#d97706'
      : '#059669';

  return (
    <div className="mb-4 last:mb-0">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[#525252] text-sm font-['Space_Grotesk']">{label}</span>
        <span className="text-[#0a0a0a] font-mono text-xs">
          {used?.toLocaleString() ?? '—'}{unit} / {limit ? `${limit.toLocaleString()}${unit}` : '∞'}
        </span>
      </div>
      <div className="w-full h-2 rounded-full bg-[#f3f1ec] overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.6, ease: 'easeOut', delay: 0.2 }}
          className="h-full rounded-full"
          style={{ background: color }}
        />
      </div>
    </div>
  );
}

function UserAvatar({ displayName, email }) {
  const initials = (displayName || email || '?')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');

  return (
    <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#117dff] to-[#6366f1] flex items-center justify-center shadow-lg select-none">
      <span className="text-white text-xl font-bold font-mono">{initials || '?'}</span>
    </div>
  );
}

function RoleBadge({ role }) {
  const map = {
    admin: { label: 'Admin', variant: 'blue' },
    developer: { label: 'Developer', variant: 'purple' },
    viewer: { label: 'Viewer', variant: 'gray' },
    owner: { label: 'Owner', variant: 'blue' },
  };
  const cfg = map[role?.toLowerCase()] || { label: role || 'Member', variant: 'gray' };
  return <PillBadge variant={cfg.variant}>{cfg.label}</PillBadge>;
}

function PlanBadge({ plan }) {
  const map = {
    free: { label: 'Free', variant: 'gray', dot: '#a3a3a3' },
    pro: { label: 'Pro', variant: 'blue', dot: '#117dff' },
    scale: { label: 'Scale', variant: 'purple', dot: '#a855f7' },
    enterprise: { label: 'Enterprise', variant: 'green', dot: '#059669' },
  };
  const cfg = map[plan?.toLowerCase()] || map.free;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono border ${
        { gray: 'bg-[#f3f1ec] text-[#525252] border-[#e3e0db]', blue: 'bg-[#117dff]/10 text-[#117dff] border-[#117dff]/20', purple: 'bg-purple-50 text-purple-700 border-purple-200', green: 'bg-emerald-50 text-emerald-700 border-emerald-200' }[cfg.variant]
      }`}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: cfg.dot }} />
      {cfg.label}
    </span>
  );
}

// ─── Confirmation Dialog ──────────────────────────────────────────────────────

function ConfirmDialog({ title, message, confirmLabel, confirmVariant = 'red', onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white rounded-2xl border border-[#e3e0db] shadow-2xl p-6 max-w-sm w-full mx-4"
      >
        <div className="flex items-start gap-3 mb-4">
          <AlertTriangle size={20} className="text-[#dc2626] mt-0.5 flex-shrink-0" />
          <div>
            <h4 className="text-[#0a0a0a] font-bold font-['Space_Grotesk'] mb-1">{title}</h4>
            <p className="text-[#525252] text-sm font-['Space_Grotesk']">{message}</p>
          </div>
        </div>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-xl text-sm font-['Space_Grotesk'] font-semibold border border-[#e3e0db] text-[#525252] hover:bg-[#f3f1ec] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 rounded-xl text-sm font-['Space_Grotesk'] font-semibold text-white transition-colors ${
              confirmVariant === 'red' ? 'bg-[#dc2626] hover:bg-red-700' : 'bg-[#117dff] hover:bg-[#0066e0]'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ─── Section 1: Account Info ──────────────────────────────────────────────────

function AccountSection({ user, org }) {
  const memberSince = user?.created_at
    ? new Date(user.created_at).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null;

  return (
    <Card>
      <div className="flex items-center gap-2 mb-5">
        <User size={16} className="text-[#525252]" />
        <SectionHeading>Account</SectionHeading>
      </div>
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5">
        <UserAvatar displayName={user?.display_name} email={user?.email} />
        <div className="flex-1 min-w-0">
          <p className="text-[#0a0a0a] text-xl font-bold font-['Space_Grotesk'] truncate">
            {user?.display_name || user?.email?.split('@')[0] || 'Unknown User'}
          </p>
          <p className="text-[#525252] text-sm font-mono mt-0.5 truncate">{user?.email}</p>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            {org && (
              <span className="inline-flex items-center gap-1.5 text-xs font-mono text-[#525252]">
                <Building2 size={12} className="text-[#a3a3a3]" />
                {org.name}
              </span>
            )}
            {user?.role && <RoleBadge role={user.role} />}
            {memberSince && (
              <span className="inline-flex items-center gap-1.5 text-xs font-mono text-[#a3a3a3]">
                <Clock size={12} />
                Joined {memberSince}
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─── Section 2: Plan & Usage ──────────────────────────────────────────────────

function PlanUsageSection() {
  const navigate = useNavigate();
  const { data: usageData, loading, error } = useApiQuery(
    () => apiClient.controlPlane.get('/v1/proxy/billing/usage').then((r) => r.data),
    []
  );

  const plan = usageData?.plan || 'free';
  const usage = usageData?.usage || {};

  return (
    <Card>
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <CreditCard size={16} className="text-[#117dff]" />
          <SectionHeading>Plan &amp; Usage</SectionHeading>
        </div>
        <PlanBadge plan={plan} />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-4">
          <div className="w-4 h-4 border-2 border-[#117dff] border-t-transparent rounded-full animate-spin" />
          <span className="text-[#a3a3a3] text-sm font-mono">Loading usage…</span>
        </div>
      ) : error ? (
        <p className="text-[#a3a3a3] text-sm font-['Space_Grotesk'] py-2">
          Usage tracking initializing…
        </p>
      ) : (
        <div className="mb-5">
          {usage.tokens !== undefined && (
            <UsageBar
              label="Tokens"
              used={usage.tokens?.used}
              limit={usage.tokens?.limit}
            />
          )}
          {usage.queries !== undefined && (
            <UsageBar
              label="Queries"
              used={usage.queries?.used}
              limit={usage.queries?.limit}
            />
          )}
          {usage.uploads !== undefined && (
            <UsageBar
              label="Uploads"
              used={usage.uploads?.used}
              limit={usage.uploads?.limit}
            />
          )}
          {Object.keys(usage).length === 0 && (
            <p className="text-[#a3a3a3] text-sm font-['Space_Grotesk'] py-1">
              Usage tracking initializing…
            </p>
          )}
        </div>
      )}

      <button
        onClick={() => navigate('/hivemind/app/billing')}
        className="inline-flex items-center gap-2 text-sm font-['Space_Grotesk'] font-semibold text-[#117dff] hover:text-[#0066e0] transition-colors"
      >
        <Zap size={14} />
        Manage Plan
        <ExternalLink size={12} />
      </button>
    </Card>
  );
}

// ─── Section 3: Memory Footprint ─────────────────────────────────────────────

function MemoryFootprintSection({ profile }) {
  const {
    memory_count = 0,
    observation_count = 0,
    relationship_count = 0,
    top_tags = [],
    top_source_platforms = [],
    graph_summary = {},
  } = profile || {};

  const relationshipTypes = [
    { label: 'Updates', count: graph_summary.update || 0, color: '#3b82f6' },
    { label: 'Extends', count: graph_summary.extend || 0, color: '#117dff' },
    { label: 'Derives', count: graph_summary.derive || 0, color: '#a855f7' },
  ];
  const maxRelCount = Math.max(...relationshipTypes.map((r) => r.count), 1);

  return (
    <Card>
      <div className="flex items-center gap-2 mb-5">
        <Brain size={16} className="text-[#117dff]" />
        <SectionHeading>Memory Footprint</SectionHeading>
      </div>

      {/* Stat pills */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { label: 'Memories', value: memory_count, accent: true },
          { label: 'Observations', value: observation_count, accent: false },
          { label: 'Relationships', value: relationship_count, accent: false },
        ].map(({ label, value, accent }) => (
          <div
            key={label}
            className="rounded-xl border border-[#e3e0db] p-4 bg-[#faf9f4]"
          >
            <p
              className="text-2xl font-bold font-mono leading-none mb-1"
              style={{ color: accent ? '#117dff' : '#0a0a0a' }}
            >
              {(value || 0).toLocaleString()}
            </p>
            <p className="text-[#a3a3a3] text-xs font-mono uppercase tracking-wider">{label}</p>
          </div>
        ))}
      </div>

      {/* Tags */}
      {top_tags.length > 0 && (
        <div className="mb-5">
          <div className="flex items-center gap-1.5 mb-2">
            <Tag size={13} className="text-[#117dff]" />
            <span className="text-[#525252] text-xs font-mono uppercase tracking-wider">Top Tags</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {top_tags.map((tag) => (
              <PillBadge key={tag} variant="blue">{tag}</PillBadge>
            ))}
          </div>
        </div>
      )}

      {/* Platforms */}
      {top_source_platforms.length > 0 && (
        <div className="mb-5">
          <div className="flex items-center gap-1.5 mb-2">
            <Link size={13} className="text-[#525252]" />
            <span className="text-[#525252] text-xs font-mono uppercase tracking-wider">Source Platforms</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {top_source_platforms.map((platform) => (
              <PillBadge key={platform} variant="gray">{platform}</PillBadge>
            ))}
          </div>
        </div>
      )}

      {/* Relationship distribution */}
      <div>
        <div className="flex items-center gap-1.5 mb-3">
          <BarChart2 size={13} className="text-[#525252]" />
          <span className="text-[#525252] text-xs font-mono uppercase tracking-wider">Relationship Distribution</span>
        </div>
        <div className="space-y-3">
          {relationshipTypes.map(({ label, count, color }) => (
            <div key={label}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[#525252] text-sm font-['Space_Grotesk']">{label}</span>
                <span className="text-[#0a0a0a] font-mono text-sm font-semibold">{count}</span>
              </div>
              <div className="w-full h-2 rounded-full bg-[#f3f1ec] overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${(count / maxRelCount) * 100}%` }}
                  transition={{ duration: 0.6, ease: 'easeOut', delay: 0.2 }}
                  className="h-full rounded-full"
                  style={{ background: color }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ─── Section 4: User Profile Preview ─────────────────────────────────────────

function extractUserProfile(injectionText) {
  if (!injectionText) return null;
  const match = injectionText.match(/<user-profile>([\s\S]*?)<\/user-profile>/);
  return match ? match[1].trim() : injectionText.trim();
}

function parseProfileFacts(raw) {
  if (!raw) return [];
  // Split on newlines, filter blank lines
  return raw
    .split('\n')
    .map((l) => l.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);
}

function UserProfilePreviewSection() {
  const { data, loading, error } = useApiQuery(
    () =>
      apiClient.controlPlane
        .post('/v1/proxy/recall', {
          query_context: 'Tell me about the user',
          max_memories: 1,
        })
        .then((r) => r.data),
    []
  );

  const rawProfile = extractUserProfile(data?.injectionText || data?.injection_text || '');
  const facts = parseProfileFacts(rawProfile);

  return (
    <Card>
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <Eye size={16} className="text-[#117dff]" />
          <SectionHeading>What HIVEMIND Knows About You</SectionHeading>
        </div>
      </div>
      <p className="text-[#525252] text-xs font-['Space_Grotesk'] mb-5">
        This is what your AI assistants know about you — auto-generated from your memory.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 py-4">
          <div className="w-4 h-4 border-2 border-[#117dff] border-t-transparent rounded-full animate-spin" />
          <span className="text-[#a3a3a3] text-sm font-mono">Loading profile…</span>
        </div>
      ) : error || (!loading && facts.length === 0) ? (
        <div className="px-4 py-5 rounded-xl bg-[#faf9f4] border border-[#e3e0db] text-center">
          <Brain size={24} className="text-[#d4d0ca] mx-auto mb-2" />
          <p className="text-[#a3a3a3] text-sm font-['Space_Grotesk']">
            Your profile builds automatically as you use HIVEMIND.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {facts.map((fact, i) => (
            <li
              key={i}
              className="flex items-start gap-3 px-4 py-3 rounded-xl bg-[#faf9f4] border border-[#eae7e1] hover:border-[#117dff]/20 transition-colors"
            >
              <CheckCircle size={14} className="text-[#117dff] flex-shrink-0 mt-0.5" />
              <span className="text-[#0a0a0a]/80 text-sm font-['Space_Grotesk']">{fact}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ─── Section 5: Context Preview ───────────────────────────────────────────────

function ContextPreviewSection() {
  const [query, setQuery] = useState('');
  const [contextResult, setContextResult] = useState(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState(null);

  const handleGenerateContext = async () => {
    if (!query.trim()) return;
    setContextLoading(true);
    setContextError(null);
    setContextResult(null);
    try {
      const result = await apiClient.getContext(query.trim());
      setContextResult(result);
    } catch (err) {
      setContextError(err.response?.data?.error || err.message);
    } finally {
      setContextLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleGenerateContext();
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <Brain size={16} className="text-[#117dff]" />
        <SectionHeading>Context Preview</SectionHeading>
      </div>
      <p className="text-[#525252] text-xs font-['Space_Grotesk'] mb-4">
        See what context would be injected into an AI conversation for a given query.
      </p>

      <div className="flex gap-3 mb-6">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter a query…"
          className="flex-1 bg-transparent border border-[#e3e0db] rounded-xl py-3 px-4 text-[#0a0a0a] text-sm font-['Space_Grotesk'] placeholder:text-[#a3a3a3] focus:outline-none focus:border-[#117dff]/40 transition-colors"
        />
        <button
          onClick={handleGenerateContext}
          disabled={!query.trim() || contextLoading}
          className="flex items-center gap-2 bg-[#117dff] hover:bg-[#0066e0] disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 px-5 rounded-xl transition-all text-sm font-['Space_Grotesk'] group"
        >
          {contextLoading ? (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            <>
              <Send size={14} className="group-hover:translate-x-0.5 transition-transform" />
              Generate Context
            </>
          )}
        </button>
      </div>

      {contextError && (
        <p className="text-[#dc2626] text-xs font-mono mb-4">{contextError}</p>
      )}

      {contextResult && (
        <div className="space-y-4">
          {contextResult.context?.system_prompt && (
            <div>
              <label className="block text-[#525252] text-xs font-mono uppercase tracking-wider mb-2">
                System Prompt
              </label>
              <pre className="bg-[#faf9f4] border border-[#e3e0db] rounded-xl p-4 text-[#525252] text-xs font-mono whitespace-pre-wrap overflow-auto max-h-48">
                {contextResult.context.system_prompt}
              </pre>
            </div>
          )}
          {contextResult.context?.injection_text && (
            <div>
              <label className="block text-[#525252] text-xs font-mono uppercase tracking-wider mb-2">
                Injection Text
              </label>
              <pre className="bg-[#faf9f4] border border-[#e3e0db] rounded-xl p-4 text-[#525252] text-xs font-mono whitespace-pre-wrap overflow-auto max-h-48">
                {contextResult.context.injection_text}
              </pre>
            </div>
          )}
          {contextResult.context?.memories?.length > 0 && (
            <div>
              <label className="block text-[#525252] text-xs font-mono uppercase tracking-wider mb-2">
                Matched Memories ({contextResult.context.memories.length})
              </label>
              <ul className="space-y-2">
                {contextResult.context.memories.map((mem, i) => (
                  <li
                    key={mem.id || i}
                    className="px-4 py-3 rounded-xl bg-white border border-[#eae7e1] text-[#525252] text-sm font-['Space_Grotesk']"
                  >
                    <span className="text-[#a3a3a3] font-mono text-xs mr-2">#{i + 1}</span>
                    {mem.title || mem.content?.slice(0, 120) || 'Untitled memory'}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {contextResult.profile && (
            <div>
              <label className="block text-[#525252] text-xs font-mono uppercase tracking-wider mb-2">
                Profile Data
              </label>
              <pre className="bg-[#faf9f4] border border-[#e3e0db] rounded-xl p-4 text-[#525252] text-xs font-mono whitespace-pre-wrap overflow-auto max-h-48">
                {JSON.stringify(contextResult.profile, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ─── Section 6: Data & Privacy ────────────────────────────────────────────────

function DataPrivacySection() {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportMsg, setExportMsg] = useState(null);

  const handleExport = async () => {
    setExportLoading(true);
    setExportMsg(null);
    try {
      await apiClient.controlPlane.post('/api/user/export');
      setExportMsg({ type: 'success', text: 'Export request received. You will receive an email when ready.' });
    } catch (err) {
      if (err.response?.status === 404 || err.response?.status === 405) {
        setExportMsg({ type: 'info', text: 'Data export is coming soon.' });
      } else {
        setExportMsg({ type: 'error', text: err.response?.data?.error || err.message });
      }
    } finally {
      setExportLoading(false);
    }
  };

  const handleDeleteConfirm = () => {
    setShowDeleteDialog(false);
    // Coming soon — no destructive action
  };

  return (
    <>
      <Card>
        <div className="flex items-center gap-2 mb-5">
          <Shield size={16} className="text-[#525252]" />
          <SectionHeading>Data &amp; Privacy</SectionHeading>
        </div>

        {/* Trust badge */}
        <div className="flex items-start gap-3 p-4 rounded-xl bg-emerald-50 border border-emerald-100 mb-5">
          <MapPin size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-emerald-800 text-sm font-['Space_Grotesk'] font-semibold">
              Your data is stored in Frankfurt, Germany
            </p>
            <p className="text-emerald-700 text-xs font-['Space_Grotesk'] mt-0.5">
              GDPR compliant &nbsp;·&nbsp; No US data transfer &nbsp;·&nbsp; EU data residency guaranteed
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="space-y-3">
          {/* Export */}
          <div className="flex items-center justify-between p-4 rounded-xl border border-[#e3e0db] bg-[#faf9f4]">
            <div>
              <p className="text-[#0a0a0a] text-sm font-['Space_Grotesk'] font-semibold">Export My Data</p>
              <p className="text-[#525252] text-xs font-['Space_Grotesk'] mt-0.5">
                Download all your memories, observations and settings as JSON.
              </p>
              {exportMsg && (
                <p
                  className={`text-xs font-mono mt-1.5 ${
                    exportMsg.type === 'error'
                      ? 'text-[#dc2626]'
                      : exportMsg.type === 'success'
                      ? 'text-emerald-600'
                      : 'text-[#a3a3a3]'
                  }`}
                >
                  {exportMsg.text}
                </p>
              )}
            </div>
            <button
              onClick={handleExport}
              disabled={exportLoading}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-[#e3e0db] bg-white text-[#525252] text-sm font-['Space_Grotesk'] font-semibold hover:bg-[#f3f1ec] disabled:opacity-40 disabled:cursor-not-allowed transition-colors ml-4 flex-shrink-0"
            >
              {exportLoading ? (
                <div className="w-4 h-4 border-2 border-[#525252] border-t-transparent rounded-full animate-spin" />
              ) : (
                <Download size={14} />
              )}
              Export
            </button>
          </div>

          {/* Delete */}
          <div className="flex items-center justify-between p-4 rounded-xl border border-red-100 bg-red-50">
            <div>
              <p className="text-[#0a0a0a] text-sm font-['Space_Grotesk'] font-semibold">Delete My Account</p>
              <p className="text-[#525252] text-xs font-['Space_Grotesk'] mt-0.5">
                Permanently delete all your data. This action cannot be undone.
              </p>
            </div>
            <button
              onClick={() => setShowDeleteDialog(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-red-200 bg-white text-[#dc2626] text-sm font-['Space_Grotesk'] font-semibold hover:bg-red-50 transition-colors ml-4 flex-shrink-0"
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>
        </div>

        {/* Privacy policy link */}
        <div className="mt-4 pt-4 border-t border-[#f3f1ec]">
          <a
            href="https://hivemind.davinciai.eu/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-mono text-[#a3a3a3] hover:text-[#117dff] transition-colors"
          >
            Privacy Policy
            <ExternalLink size={11} />
          </a>
        </div>
      </Card>

      {showDeleteDialog && (
        <ConfirmDialog
          title="Delete Account"
          message="Account deletion is coming soon. Our team will be in touch to process your request securely."
          confirmLabel="Got it"
          confirmVariant="red"
          onConfirm={handleDeleteConfirm}
          onCancel={() => setShowDeleteDialog(false)}
        />
      )}
    </>
  );
}

// ─── Main Profile Page ────────────────────────────────────────────────────────

export default function Profile() {
  const { user, org } = useAuth();
  const { data: profile, loading, error } = useApiQuery(() => apiClient.getProfile());

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-[#117dff] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-[#dc2626] text-sm font-mono">{error}</p>
      </div>
    );
  }

  return (
    <div className="min-h-full">
      {/* Page header */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
        <h1 className="text-[#0a0a0a] text-2xl font-bold font-['Space_Grotesk'] mb-1">Profile</h1>
        <p className="text-[#525252] text-sm font-['Space_Grotesk']">
          Your account, memory footprint and privacy controls
        </p>
      </motion.div>

      <motion.div
        variants={stagger}
        initial="hidden"
        animate="visible"
        className="space-y-6"
      >
        {/* Section 1: Account Info */}
        <AccountSection user={user} org={org} />

        {/* Section 2: Plan & Usage */}
        <PlanUsageSection />

        {/* Section 3: Memory Footprint */}
        <MemoryFootprintSection profile={profile} />

        {/* Section 4: What HIVEMIND Knows About You */}
        <UserProfilePreviewSection />

        {/* Section 5: Context Preview */}
        <ContextPreviewSection />

        {/* Section 6: Data & Privacy */}
        <DataPrivacySection />
      </motion.div>
    </div>
  );
}
