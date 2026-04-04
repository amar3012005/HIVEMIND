import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Cable,
  Copy,
  Check,
  Terminal,
  Code2,
  Globe,
  WifiOff,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Mail,
  MessageSquare,
  Github,
  FileText,
  Calendar,
  HardDrive,
  Layers,
  BookOpen,
  CheckCircle2,
  AlertCircle,
  Clock,
  Zap,
  Plus,
} from 'lucide-react';
import apiClient from '../shared/api-client';
import { useApiQuery, useCopyToClipboard } from '../shared/hooks';
import ApiKeyPrompt from '../shared/ApiKeyPrompt';

// ─── Connector Provider Definitions (Supermemory-style) ────────────────────

const CONNECTOR_CATEGORIES = [
  {
    key: 'mcp_clients',
    label: 'MCP Clients',
    description: 'AI assistants connected via MCP protocol',
  },
  {
    key: 'workspace',
    label: 'Workspace Apps',
    description: 'Email, calendar, and communication tools',
  },
  {
    key: 'knowledge',
    label: 'Knowledge Sources',
    description: 'Documentation and knowledge bases',
  },
  {
    key: 'code',
    label: 'Code Tools',
    description: 'Source code and development platforms',
  },
];

const CONNECTORS = [
  // MCP Clients (already working)
  {
    id: 'claude',
    name: 'Claude Desktop',
    description: 'Anthropic Claude via MCP stdio bridge',
    icon: Terminal,
    category: 'mcp_clients',
    status: 'connected',
    color: '#117dff',
    configKey: 'claude',
  },
  {
    id: 'vscode',
    name: 'VS Code',
    description: 'Visual Studio Code MCP extension',
    icon: Code2,
    category: 'mcp_clients',
    status: 'connected',
    color: '#3b82f6',
    configKey: 'vscode',
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    description: 'Google Antigravity MCP integration',
    icon: Cable,
    category: 'mcp_clients',
    status: 'connected',
    color: '#a855f7',
    configKey: 'antigravity',
  },
  {
    id: 'remote',
    name: 'Remote MCP',
    description: 'HTTP JSON-RPC endpoint for custom clients',
    icon: Globe,
    category: 'mcp_clients',
    status: 'available',
    color: '#22c55e',
    configKey: 'remote-mcp',
  },
  // Workspace (coming soon)
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Import emails and conversations as memories',
    icon: Mail,
    category: 'workspace',
    status: 'available',
    color: '#ef4444',
    priority: 1,
    oauthProvider: 'gmail',
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    description: 'Sync events, meetings, and agendas',
    icon: Calendar,
    category: 'workspace',
    status: 'coming_soon',
    color: '#3b82f6',
    priority: 1,
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Index documents, sheets, and presentations',
    icon: HardDrive,
    category: 'workspace',
    status: 'available',
    color: '#f59e0b',
    priority: 1,
    oauthProvider: 'gdrive',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Capture conversations and shared knowledge',
    icon: MessageSquare,
    category: 'workspace',
    status: 'available',
    color: '#e11d48',
    priority: 2,
    oauthProvider: 'slack',
  },
  // Knowledge
  {
    id: 'notion',
    name: 'Notion',
    description: 'Sync pages, databases, and wikis',
    icon: BookOpen,
    category: 'knowledge',
    status: 'available',
    color: '#f5f5f5',
    priority: 5,
    oauthProvider: 'notion',
  },
  {
    id: 'confluence',
    name: 'Confluence',
    description: 'Import team documentation and spaces',
    icon: Layers,
    category: 'knowledge',
    status: 'coming_soon',
    color: '#3b82f6',
    priority: 6,
  },
  // Code
  {
    id: 'github',
    name: 'GitHub',
    description: 'Index repos, issues, PRs, and discussions',
    icon: Github,
    category: 'code',
    status: 'available',
    color: '#f5f5f5',
    priority: 3,
    oauthProvider: 'github',
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Sync issues, projects, and roadmaps',
    icon: FileText,
    category: 'code',
    status: 'coming_soon',
    color: '#5e6ad2',
    priority: 4,
  },
];

// ─── Status Components ──────────────────────────────────────────────────────

function ConnectorStatusBadge({ status }) {
  const styles = {
    connected: {
      bg: 'bg-emerald-500/10',
      text: 'text-[#16a34a]',
      border: 'border-emerald-500/20',
      label: 'Connected',
      dot: 'bg-[#16a34a]',
    },
    syncing: {
      bg: 'bg-blue-500/10',
      text: 'text-blue-400',
      border: 'border-blue-500/20',
      label: 'Syncing',
      dot: 'bg-blue-400 animate-pulse',
    },
    error: {
      bg: 'bg-red-500/10',
      text: 'text-[#dc2626]',
      border: 'border-red-500/20',
      label: 'Error',
      dot: 'bg-[#dc2626]',
    },
    available: {
      bg: 'bg-[#f3f1ec]',
      text: 'text-[#525252]',
      border: 'border-[#e3e0db]',
      label: 'Available',
      dot: 'bg-[#a3a3a3]',
    },
    coming_soon: {
      bg: 'bg-white',
      text: 'text-[#a3a3a3]',
      border: 'border-[#e3e0db]',
      label: 'Coming Soon',
      dot: 'bg-[#e3e0db]',
    },
    needs_reauth: {
      bg: 'bg-amber-500/10',
      text: 'text-amber-400',
      border: 'border-amber-500/20',
      label: 'Needs Reauth',
      dot: 'bg-amber-400',
    },
  };

  const s = styles[status] || styles.available;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium font-['Space_Grotesk'] border ${s.bg} ${s.text} ${s.border}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

// ─── JSON Block ──────────────────────────────────────────────────────────────

function JsonBlock({ data }) {
  const raw = JSON.stringify(data, null, 2);
  const lines = raw.split('\n');

  return (
    <pre className="bg-[#faf9f4] rounded-xl p-4 overflow-x-auto text-[12px] leading-relaxed font-['JetBrains_Mono','Fira_Code',monospace] border border-[#eae7e1]">
      {lines.map((line, i) => (
        <div key={i}>{colorize(line)}</div>
      ))}
    </pre>
  );
}

function colorize(line) {
  const kvMatch = line.match(/^(\s*)"([^"]+)"(\s*:\s*)("(?:[^"\\]|\\.)*")(,?)$/);
  if (kvMatch) {
    const [, indent, key, colon, value, comma] = kvMatch;
    return (
      <>
        <span className="text-[#d4d0ca]">{indent}"</span>
        <span className="text-[#117dff]">{key}</span>
        <span className="text-[#d4d0ca]">"</span>
        <span className="text-[#d4d0ca]">{colon}</span>
        <span className="text-[#16a34a]">{value}</span>
        <span className="text-[#d4d0ca]">{comma}</span>
      </>
    );
  }

  const kvOther = line.match(/^(\s*)"([^"]+)"(\s*:\s*)(.+?)(,?)$/);
  if (kvOther) {
    const [, indent, key, colon, value, comma] = kvOther;
    return (
      <>
        <span className="text-[#d4d0ca]">{indent}"</span>
        <span className="text-[#117dff]">{key}</span>
        <span className="text-[#d4d0ca]">"</span>
        <span className="text-[#d4d0ca]">{colon}</span>
        <span className="text-orange-300">{value}</span>
        <span className="text-[#d4d0ca]">{comma}</span>
      </>
    );
  }

  const strMatch = line.match(/^(\s*)("(?:[^"\\]|\\.)*")(,?)$/);
  if (strMatch) {
    const [, indent, value, comma] = strMatch;
    return (
      <>
        <span className="text-[#d4d0ca]">{indent}</span>
        <span className="text-[#16a34a]">{value}</span>
        <span className="text-[#d4d0ca]">{comma}</span>
      </>
    );
  }

  return <span className="text-[#d4d0ca]">{line}</span>;
}

// ─── Copy Button ─────────────────────────────────────────────────────────────

function CopyButton({ text, label = 'Copy' }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <button
      onClick={() => copy(text)}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all font-['Space_Grotesk'] border ${
        copied
          ? 'bg-emerald-500/10 text-[#16a34a] border-emerald-500/20'
          : 'bg-[#f3f1ec] text-[#525252] border-[#e3e0db] hover:bg-[#eae7e1] hover:text-[#525252]'
      }`}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? 'Copied!' : label}
    </button>
  );
}

// ─── Connector Card (Supermemory-style) ──────────────────────────────────────

function ConnectorCard({ connector, config, onConnect, onDisconnect, onResync, connecting }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = connector.icon;
  const isActive = connector.status === 'connected' || connector.status === 'syncing';
  const isComingSoon = connector.status === 'coming_soon';
  const hasConfig = config && connector.configKey;
  const configStr = hasConfig ? JSON.stringify(config, null, 2) : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`group rounded-xl border transition-all duration-200 shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${
        isActive
          ? 'bg-white border-[#e3e0db] hover:border-[#d4d0ca]'
          : isComingSoon
          ? 'bg-white border-[#eae7e1] opacity-60'
          : 'bg-white border-[#e3e0db] hover:border-[#d4d0ca]'
      }`}
    >
      <div className="p-4">
        {/* Top Row: Icon + Name + Status */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 border"
              style={{
                backgroundColor: `${connector.color}10`,
                borderColor: `${connector.color}20`,
              }}
            >
              <Icon
                size={20}
                style={{ color: connector.color }}
                strokeWidth={1.75}
              />
            </div>
            <div>
              <h3 className="text-[#0a0a0a] text-sm font-semibold font-['Space_Grotesk'] leading-tight">
                {connector.name}
              </h3>
              <p className="text-[#a3a3a3] text-[12px] font-['Space_Grotesk'] mt-0.5 leading-snug">
                {connector.accountRef ? connector.accountRef : connector.description}
              </p>
              {connector.lastSyncAt && (
                <p className="text-[#d4d0ca] text-[10px] font-mono mt-0.5">
                  Last sync: {new Date(connector.lastSyncAt).toLocaleString()}
                </p>
              )}
            </div>
          </div>
          <ConnectorStatusBadge status={connector.status} />
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          {isActive && hasConfig && (
            <>
              <button
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium font-['Space_Grotesk'] bg-[#f3f1ec] border border-[#e3e0db] text-[#525252] hover:bg-[#eae7e1] hover:text-[#525252] transition-all"
              >
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Config
              </button>
              <CopyButton text={configStr} label="Copy Config" />
            </>
          )}

          {connector.status === 'available' && (
            <button
              onClick={onConnect}
              disabled={connecting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold font-['Space_Grotesk'] bg-[#117dff] text-white hover:bg-[#0066e0] disabled:opacity-50 transition-all"
            >
              {connecting ? (
                <RefreshCw size={12} className="animate-spin" />
              ) : (
                <Plus size={12} />
              )}
              {connecting ? 'Connecting...' : 'Connect'}
            </button>
          )}

          {isActive && connector.oauthProvider && (
            <>
              <button
                onClick={onResync}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium font-['Space_Grotesk'] bg-[#f3f1ec] border border-[#e3e0db] text-[#525252] hover:bg-[#eae7e1] hover:text-[#525252] transition-all"
              >
                <RefreshCw size={12} />
                Sync Now
              </button>
              <button
                onClick={onDisconnect}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium font-['Space_Grotesk'] text-[#dc2626]/60 hover:text-[#dc2626] hover:bg-red-50 transition-all"
              >
                Disconnect
              </button>
            </>
          )}

          {isComingSoon && (
            <span className="text-[#d4d0ca] text-[11px] font-['Space_Grotesk'] flex items-center gap-1.5">
              <Clock size={12} />
              Coming soon
            </span>
          )}

          {connector.status === 'needs_reauth' && (
            <button
              onClick={onConnect}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold font-['Space_Grotesk'] bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-all"
            >
              <RefreshCw size={12} />
              Reconnect
            </button>
          )}

          {connector.status === 'error' && (
            <button
              onClick={onResync}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold font-['Space_Grotesk'] bg-red-500/10 text-[#dc2626] border border-red-500/20 hover:bg-red-500/20 transition-all"
            >
              <RefreshCw size={12} />
              Retry
            </button>
          )}
        </div>
      </div>

      {/* Expanded Config */}
      <AnimatePresence>
        {expanded && hasConfig && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-t border-[#eae7e1]"
          >
            <div className="p-4">
              <JsonBlock data={config} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Stats Row ───────────────────────────────────────────────────────────────

function StatsRow({ connectors, endpoints }) {
  const connected = connectors.filter(c => c.status === 'connected').length;
  const available = connectors.filter(c => c.status === 'available').length;
  const coming = connectors.filter(c => c.status === 'coming_soon').length;

  const stats = [
    { label: 'Connected', value: connected, icon: CheckCircle2, color: 'text-[#16a34a]' },
    { label: 'Available', value: available, icon: Zap, color: 'text-blue-400' },
    { label: 'Coming Soon', value: coming, icon: Clock, color: 'text-[#525252]' },
    { label: 'MCP Endpoints', value: endpoints?.length || 0, icon: Globe, color: 'text-[#117dff]' },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="bg-white border border-[#e3e0db] rounded-xl p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
        >
          <div className="flex items-center gap-2 mb-2">
            <stat.icon size={14} className={stat.color} />
            <span className="text-[#a3a3a3] text-[11px] font-['Space_Grotesk'] uppercase tracking-wider">
              {stat.label}
            </span>
          </div>
          <p className="text-[#0a0a0a] text-xl font-semibold font-mono">{stat.value}</p>
        </div>
      ))}
    </div>
  );
}

// ─── Endpoint Status Table ───────────────────────────────────────────────────

function EndpointTable({ endpoints, loading, onRefresh }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <RefreshCw size={16} className="text-[#117dff] animate-spin" />
      </div>
    );
  }

  if (!endpoints || endpoints.length === 0) {
    return (
      <div className="py-10 text-center">
        <WifiOff size={20} className="text-[#e3e0db] mx-auto mb-2" />
        <p className="text-[#d4d0ca] text-sm font-['Space_Grotesk']">
          No MCP endpoints registered
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[#e3e0db]">
            {['Endpoint', 'Health', 'Tools', 'Resources', 'Last Checked'].map((h) => (
              <th key={h} className="text-left text-[#d4d0ca] text-[10px] font-mono uppercase tracking-wider px-4 py-2.5">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {endpoints.map((ep, i) => (
            <tr key={ep.url || ep.name || i} className="border-b border-[#eae7e1] hover:bg-[#faf9f4] transition-colors">
              <td className="px-4 py-2.5">
                <span className="text-[#525252] font-mono text-[11px] truncate block max-w-[280px]">
                  {ep.url || ep.name}
                </span>
              </td>
              <td className="px-4 py-2.5">
                <ConnectorStatusBadge status={ep.healthy ? 'connected' : 'error'} />
              </td>
              <td className="px-4 py-2.5 text-[#525252] font-mono text-[11px]">
                {ep.tool_count ?? ep.toolCount ?? '-'}
              </td>
              <td className="px-4 py-2.5 text-[#525252] font-mono text-[11px]">
                {ep.resource_count ?? ep.resourceCount ?? '-'}
              </td>
              <td className="px-4 py-2.5 text-[#d4d0ca] font-mono text-[10px]">
                {ep.updated_at || ep.last_job_at
                  ? new Date(ep.updated_at || ep.last_job_at).toLocaleString()
                  : '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

// ─── Gmail Sync Settings Modal ──────────────────────────────────────────────

function GmailSyncSettings({ email, onSync, onClose }) {
  const [dateRange, setDateRange] = useState('30d');
  const [folders, setFolders] = useState(['INBOX', 'SENT']);
  const [excludeCategories, setExcludeCategories] = useState(['promotions', 'social']);
  const [maxEmails, setMaxEmails] = useState(500);
  const [syncing, setSyncing] = useState(false);

  const toggleFolder = (f) => setFolders(prev => prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f]);
  const toggleExclude = (c) => setExcludeCategories(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]);

  const handleStart = async () => {
    setSyncing(true);
    try {
      await onSync({ date_range: dateRange, folders, exclude_categories: excludeCategories, max_emails: maxEmails });
    } finally {
      setSyncing(false);
    }
  };

  const dateOptions = [
    { value: '7d', label: 'Last 7 days' },
    { value: '30d', label: 'Last 30 days' },
    { value: '90d', label: 'Last 90 days' },
    { value: '365d', label: 'Last year' },
    { value: 'all', label: 'All time' },
  ];

  const folderOptions = ['INBOX', 'SENT', 'STARRED', 'IMPORTANT', 'DRAFT'];
  const categoryOptions = ['promotions', 'social', 'updates', 'forums'];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center">
            <Mail size={18} className="text-[#ef4444]" />
          </div>
          <div>
            <h3 className="text-[#0a0a0a] text-base font-bold font-['Space_Grotesk']">Configure Gmail Sync</h3>
            {email && <p className="text-[#a3a3a3] text-xs font-mono">{email}</p>}
          </div>
        </div>

        {/* Date Range */}
        <div className="mb-4">
          <label className="text-[#525252] text-xs font-semibold font-['Space_Grotesk'] block mb-2">Date Range</label>
          <div className="flex flex-wrap gap-2">
            {dateOptions.map(opt => (
              <button
                key={opt.value}
                onClick={() => setDateRange(opt.value)}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-all ${
                  dateRange === opt.value
                    ? 'bg-[#117dff] text-white'
                    : 'bg-[#f3f1ec] text-[#525252] hover:bg-[#eae7e1]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Folders */}
        <div className="mb-4">
          <label className="text-[#525252] text-xs font-semibold font-['Space_Grotesk'] block mb-2">Folders to Sync</label>
          <div className="flex flex-wrap gap-2">
            {folderOptions.map(f => (
              <button
                key={f}
                onClick={() => toggleFolder(f)}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-all ${
                  folders.includes(f)
                    ? 'bg-[#22c55e]/10 text-[#16a34a] border border-[#bbf7d0]'
                    : 'bg-[#f3f1ec] text-[#a3a3a3] border border-[#e3e0db]'
                }`}
              >
                {f.toLowerCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Exclude Categories */}
        <div className="mb-4">
          <label className="text-[#525252] text-xs font-semibold font-['Space_Grotesk'] block mb-2">Exclude Categories</label>
          <div className="flex flex-wrap gap-2">
            {categoryOptions.map(c => (
              <button
                key={c}
                onClick={() => toggleExclude(c)}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-all ${
                  excludeCategories.includes(c)
                    ? 'bg-[#ef4444]/10 text-[#dc2626] border border-[#fecaca]'
                    : 'bg-[#f3f1ec] text-[#a3a3a3] border border-[#e3e0db]'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        {/* Max Emails */}
        <div className="mb-6">
          <label className="text-[#525252] text-xs font-semibold font-['Space_Grotesk'] block mb-2">
            Max Emails: <span className="text-[#117dff]">{maxEmails}</span>
          </label>
          <input
            type="range"
            min={50}
            max={2000}
            step={50}
            value={maxEmails}
            onChange={e => setMaxEmails(Number(e.target.value))}
            className="w-full accent-[#117dff]"
          />
          <div className="flex justify-between text-[10px] text-[#a3a3a3] font-mono mt-1">
            <span>50</span><span>500</span><span>1000</span><span>2000</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold font-['Space_Grotesk'] bg-[#f3f1ec] text-[#525252] hover:bg-[#eae7e1] transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleStart}
            disabled={syncing || folders.length === 0}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold font-['Space_Grotesk'] bg-[#117dff] text-white hover:bg-[#0066e0] disabled:opacity-40 transition-all flex items-center justify-center gap-2"
          >
            {syncing ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <>
                <Zap size={14} />
                Start Sync
              </>
            )}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function Connectors() {
  const [activeCategory, setActiveCategory] = useState(null);
  const [connectingProvider, setConnectingProvider] = useState(null);
  const [gmailSettingsOpen, setGmailSettingsOpen] = useState(false);
  const [gmailEmail, setGmailEmail] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [toastMessage, setToastMessage] = useState(null);

  // Auto-dismiss toast
  useEffect(() => {
    if (toastMessage) {
      const t = setTimeout(() => setToastMessage(null), 5000);
      return () => clearTimeout(t);
    }
  }, [toastMessage]);

  const {
    data: descriptors,
  } = useApiQuery(() => apiClient.getDescriptors(), []);

  const {
    data: connectorStatus,
    loading: statusLoading,
    refetch: refetchStatus,
  } = useApiQuery(() => apiClient.getConnectorStatus(), []);

  const {
    data: jobs,
    refetch: refetchJobs,
  } = useApiQuery(() => apiClient.listConnectorJobs(), []);

  // Fetch live OAuth connector statuses from control plane
  const {
    data: oauthConnectors,
    refetch: refetchOAuth,
  } = useApiQuery(() => apiClient.listOAuthConnectors().catch(() => null), []);

  // Check for OAuth callback params
  useEffect(() => {
    const success = searchParams.get('connector_success');
    const error = searchParams.get('connector_error');
    const connected = searchParams.get('connected');
    const needsConfig = searchParams.get('needs_config');
    const email = searchParams.get('email');

    if (connected === 'gmail' && needsConfig === 'true') {
      // Gmail connected — open settings modal before syncing
      setGmailEmail(email || null);
      setGmailSettingsOpen(true);
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('connected');
      nextParams.delete('needs_config');
      nextParams.delete('email');
      setSearchParams(nextParams, { replace: true });
      refetchOAuth();
    } else if (success) {
      setToastMessage({ type: 'success', text: `${success} connected successfully!` });
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('connector_success');
      setSearchParams(nextParams, { replace: true });
      refetchOAuth();
    } else if (error) {
      setToastMessage({ type: 'error', text: `Connection failed: ${error}` });
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('connector_error');
      setSearchParams(nextParams, { replace: true });
    }
  }, [refetchOAuth, searchParams, setSearchParams]);

  // Poll for status after connect
  useEffect(() => {
    if (searchParams.get('connector_success')) return;
    const interval = setInterval(() => {
      refetchOAuth();
    }, 10000);
    return () => clearInterval(interval);
  }, [refetchOAuth, searchParams]);

  const handleOAuthConnect = useCallback(async (provider) => {
    setConnectingProvider(provider);
    try {
      // Use direct Gmail API for Gmail, control plane for others
      if (provider === 'gmail') {
        const data = await apiClient.gmailConnect();
        if (data.url) {
          window.location.href = data.url;
        } else {
          throw new Error('No auth URL returned');
        }
        return;
      }

      const { auth_url } = await apiClient.startConnectorOAuth(
        provider,
        window.location.pathname,
      );
      if (auth_url) {
        window.location.href = auth_url;
      } else {
        throw new Error('No auth URL returned');
      }
    } catch (err) {
      setToastMessage({ type: 'error', text: err.response?.data?.error || err.message });
      setConnectingProvider(null);
    }
  }, []);

  const handleDisconnect = useCallback(async (provider) => {
    try {
      if (provider === 'gmail') {
        await apiClient.gmailDisconnect();
      } else {
        await apiClient.disconnectConnector(provider);
      }
      setToastMessage({ type: 'success', text: `${provider} disconnected` });
      refetchOAuth();
    } catch (err) {
      setToastMessage({ type: 'error', text: err.response?.data?.error || err.message });
    }
  }, [refetchOAuth]);

  const handleResync = useCallback(async (provider) => {
    try {
      if (provider === 'gmail') {
        setGmailSettingsOpen(true);
        return;
      }
      await apiClient.resyncConnector(provider);
      setToastMessage({ type: 'success', text: `${provider} sync started` });
      refetchOAuth();
    } catch (err) {
      setToastMessage({ type: 'error', text: err.response?.data?.error || err.message });
    }
  }, [refetchOAuth]);

  const handleGmailSync = useCallback(async (settings) => {
    try {
      await apiClient.gmailSync(settings);
      setToastMessage({ type: 'success', text: 'Gmail sync started! Check status for progress.' });
      setGmailSettingsOpen(false);
      refetchOAuth();
    } catch (err) {
      setToastMessage({ type: 'error', text: err.response?.data?.error || err.message });
    }
  }, [refetchOAuth]);

  const npxCommand = 'npx -y @amar_528/mcp-bridge hosted';
  const endpoints = connectorStatus?.statuses || [];
  const jobList = Array.isArray(jobs) ? jobs : jobs?.jobs || [];
  const oauthList = oauthConnectors?.connectors || [];

  // Merge static CONNECTORS with live OAuth status
  const mergedConnectors = CONNECTORS.map((c) => {
    if (c.oauthProvider) {
      const live = oauthList.find((o) => o.provider === c.oauthProvider);
      if (live) {
        const derivedStatus = live.status === 'connected'
          ? 'connected'
          : live.status === 'syncing'
            ? 'syncing'
            : live.status === 'error'
              ? 'error'
              : live.status === 'reauth_required'
                ? 'needs_reauth'
                : live.status === 'degraded'
                  ? 'error'
                  : live.status === 'not_configured'
                    ? 'coming_soon'
                    : c.status;
        return {
          ...c,
          status: derivedStatus,
          accountRef: live.account_ref,
          lastSyncAt: live.last_sync_at,
          lastError: live.last_error,
          description: live.configured === false && live.disabled_reason
            ? `${c.description} (${live.disabled_reason})`
            : c.description,
        };
      }
    }
    return c;
  });

  const filteredConnectors = activeCategory
    ? mergedConnectors.filter((c) => c.category === activeCategory)
    : mergedConnectors;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Toast Notification */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl border text-sm font-['Space_Grotesk'] shadow-lg ${
              toastMessage.type === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/20 text-[#16a34a]'
                : 'bg-red-500/10 border-red-500/20 text-[#dc2626]'
            }`}
          >
            <div className="flex items-center gap-2">
              {toastMessage.type === 'success' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
              {toastMessage.text}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* API Key prompt — shown only if user has no key yet */}
      <ApiKeyPrompt feature="connecting external clients" />

      {/* Quick Install Banner */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-gradient-to-r from-[#117dff]/[0.06] to-transparent border border-[#117dff]/15 rounded-xl p-4 flex items-center justify-between gap-4 flex-wrap"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-[#117dff]/10 border border-[#117dff]/20 flex items-center justify-center">
            <Terminal size={16} className="text-[#117dff]" />
          </div>
          <div>
            <h2 className="text-[#0a0a0a] text-sm font-semibold font-['Space_Grotesk']">
              Quick Install
            </h2>
            <p className="text-[#a3a3a3] text-[11px] font-['Space_Grotesk']">
              Start the MCP bridge in one command
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <code className="bg-[#faf9f4] border border-[#e3e0db] rounded-lg px-3.5 py-2 text-[12px] text-[#117dff] font-mono select-all">
            {npxCommand}
          </code>
          <CopyButton text={npxCommand} label="Copy" />
        </div>
      </motion.div>

      {/* Stats */}
      <StatsRow connectors={mergedConnectors} endpoints={endpoints} />

      {/* Category Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        <button
          onClick={() => setActiveCategory(null)}
          className={`px-3.5 py-1.5 rounded-lg text-[12px] font-medium font-['Space_Grotesk'] transition-all whitespace-nowrap ${
            !activeCategory
              ? 'bg-[#f3f1ec] text-[#0a0a0a] border border-[#d4d0ca]'
              : 'text-[#525252] hover:text-[#525252] border border-transparent'
          }`}
        >
          All Connectors
        </button>
        {CONNECTOR_CATEGORIES.map((cat) => (
          <button
            key={cat.key}
            onClick={() => setActiveCategory(cat.key)}
            className={`px-3.5 py-1.5 rounded-lg text-[12px] font-medium font-['Space_Grotesk'] transition-all whitespace-nowrap ${
              activeCategory === cat.key
                ? 'bg-[#f3f1ec] text-[#0a0a0a] border border-[#d4d0ca]'
                : 'text-[#525252] hover:text-[#525252] border border-transparent'
            }`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Connector Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {filteredConnectors.map((connector) => (
          <ConnectorCard
            key={connector.id}
            connector={connector}
            config={descriptors?.[connector.configKey]}
            onConnect={() => {
              if (connector.oauthProvider) {
                handleOAuthConnect(connector.oauthProvider);
              }
            }}
            onDisconnect={() => {
              if (connector.oauthProvider) {
                handleDisconnect(connector.oauthProvider);
              }
            }}
            onResync={() => {
              if (connector.oauthProvider) {
                handleResync(connector.oauthProvider);
              }
            }}
            connecting={connectingProvider === connector.oauthProvider}
          />
        ))}
      </div>

      {/* MCP Endpoints */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[#525252] text-[11px] font-mono uppercase tracking-wider">
            Live MCP Endpoints
          </h2>
          <button
            onClick={refetchStatus}
            className="flex items-center gap-1.5 text-[#a3a3a3] hover:text-[#117dff] text-[11px] font-['Space_Grotesk'] transition-colors"
          >
            <RefreshCw size={11} />
            Refresh
          </button>
        </div>
        <div className="bg-white border border-[#e3e0db] rounded-xl overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
          <EndpointTable endpoints={endpoints} loading={statusLoading} onRefresh={refetchStatus} />
        </div>
      </div>

      {/* Recent Jobs */}
      {jobList.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[#525252] text-[11px] font-mono uppercase tracking-wider">
              Recent Jobs
            </h2>
            <button
              onClick={refetchJobs}
              className="flex items-center gap-1.5 text-[#a3a3a3] hover:text-[#117dff] text-[11px] font-['Space_Grotesk'] transition-colors"
            >
              <RefreshCw size={11} />
              Refresh
            </button>
          </div>
          <div className="bg-white border border-[#e3e0db] rounded-xl overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#e3e0db]">
                  {['Job ID', 'Status', 'Endpoint', 'Time'].map((h) => (
                    <th key={h} className="text-left text-[#d4d0ca] text-[10px] font-mono uppercase tracking-wider px-4 py-2.5">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobList.slice(0, 10).map((job, i) => (
                  <tr key={job.id || i} className="border-b border-[#eae7e1] hover:bg-[#faf9f4] transition-colors">
                    <td className="px-4 py-2.5 text-[#525252] font-mono text-[11px]">
                      {(job.id || '').slice(0, 12)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-mono uppercase tracking-wider border ${
                          {
                            pending: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
                            running: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
                            completed: 'bg-emerald-500/10 text-[#16a34a] border-emerald-500/20',
                            failed: 'bg-red-500/10 text-[#dc2626] border-red-500/20',
                          }[job.status] || 'bg-[#f3f1ec] text-[#525252] border-[#e3e0db]'
                        }`}
                      >
                        {job.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-[#525252] font-mono text-[11px] truncate max-w-[200px]">
                      {job.endpoint || job.url || '-'}
                    </td>
                    <td className="px-4 py-2.5 text-[#d4d0ca] font-mono text-[10px]">
                      {job.timestamp || job.created_at
                        ? new Date(job.timestamp || job.created_at).toLocaleString()
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Gmail Sync Settings Modal */}
      <AnimatePresence>
        {gmailSettingsOpen && (
          <GmailSyncSettings
            email={gmailEmail}
            onSync={handleGmailSync}
            onClose={() => setGmailSettingsOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
