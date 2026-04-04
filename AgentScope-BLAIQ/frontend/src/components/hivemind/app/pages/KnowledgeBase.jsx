import React from 'react';
import { AlertTriangle, ArrowUpRight, Database, FileStack, Globe, Link2, Loader2, Search, ShieldCheck } from 'lucide-react';
import { useBlaiqWorkspace } from '../shared/blaiq-workspace-context';
import { getHivemindConfig, testHivemindQuery } from '../shared/blaiq-client';

function StatCard({ label, value, tone = 'neutral' }) {
  const toneClass = tone === 'warn'
    ? 'border-amber-200 bg-amber-50 text-amber-900'
    : tone === 'good'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
      : 'border-[#e5dfd3] bg-[#faf7f1] text-[#111827]';
  return (
    <div className={`rounded-[18px] border px-4 py-3 ${toneClass}`}>
      <div className="text-[11px] font-mono uppercase tracking-[0.12em] opacity-70">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function SourceList({ title, icon: Icon, items, empty }) {
  return (
    <section className="rounded-[24px] border border-[#ddd6c8] bg-white p-5">
      <div className="mb-4 flex items-center gap-2">
        <Icon size={16} className="text-[#117dff]" />
        <div className="font-['Space_Grotesk'] text-lg font-semibold">{title}</div>
      </div>
      {items.length === 0 ? (
        <div className="text-sm text-[#6b7280]">{empty}</div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div key={item.source_id || item.location} className="rounded-[18px] border border-[#ece6da] bg-[#faf7f1] px-4 py-3">
              <div className="text-sm font-medium text-[#111827]">{item.title || item.source_id}</div>
              <div className="mt-1 text-xs text-[#6b7280] break-all">{item.location || item.source_id}</div>
              {item.metadata && Object.keys(item.metadata).length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {Object.entries(item.metadata).map(([key, value]) => (
                    <span key={key} className="rounded-full bg-white px-2.5 py-1 text-[11px] text-[#5f5a54]">
                      {key}: {String(value)}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function KnowledgeBase() {
  const { hivemindSummary, routingDecision, timeline, evidenceSummary, activeTask } = useBlaiqWorkspace();
  const contradictionClass = hivemindSummary?.contradictions?.length
    ? 'border-amber-200 bg-amber-50 text-amber-900'
    : 'border-emerald-200 bg-emerald-50 text-emerald-900';
  const [config, setConfig] = React.useState(null);
  const [configError, setConfigError] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [testing, setTesting] = React.useState(false);
  const [testError, setTestError] = React.useState('');
  const [testResult, setTestResult] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await getHivemindConfig();
        if (!cancelled) {
          setConfig(result);
          setConfigError('');
        }
      } catch (error) {
        if (!cancelled) {
          setConfigError(error.message || 'Failed to load HIVEMIND config');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleTest(event) {
    event.preventDefault();
    if (!query.trim()) return;
    setTesting(true);
    setTestError('');
    try {
      const result = await testHivemindQuery({ query: query.trim(), limit: 5, mode: 'insight' });
      setTestResult(result);
    } catch (error) {
      setTestError(error.message || 'HIVEMIND test failed');
      setTestResult(null);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_380px] gap-6 overflow-hidden p-6 max-xl:grid-cols-1">
      <section className="min-h-0 overflow-y-auto space-y-6">
        <div className="rounded-[28px] border border-[#ddd6c8] bg-white p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-[#117dff]">
                <Database size={16} />
                <span className="text-[12px] font-mono uppercase tracking-[0.16em]">HIVEMIND</span>
              </div>
              <h1 className="mt-3 font-['Space_Grotesk'] text-[28px] font-semibold leading-tight text-[#111827]">
                Memory-first research trace
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-[#4b5563]">
                {hivemindSummary?.policy || 'Run a workflow to inspect how BLAIQ split memory, uploaded knowledge, and live web evidence.'}
              </p>
            </div>
            <div className="rounded-full border border-[#d8d2c8] bg-[#faf7f1] px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.12em] text-[#6b7280]">
              {activeTask?.threadId ? `Thread ${activeTask.threadId.slice(0, 8)}` : 'No active run'}
            </div>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Memory findings" value={hivemindSummary?.memoryFindings?.length || 0} />
            <StatCard label="Web findings" value={hivemindSummary?.webFindings?.length || 0} />
            <StatCard label="Upload findings" value={hivemindSummary?.uploadFindings?.length || 0} />
            <StatCard
              label="Save-back"
              value={hivemindSummary?.saveBackEligible ? 'Eligible' : 'Manual only'}
              tone={hivemindSummary?.saveBackEligible ? 'good' : 'neutral'}
            />
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <section className="rounded-[24px] border border-[#ddd6c8] bg-white p-5">
            <div className="mb-4 flex items-center gap-2">
              <ShieldCheck size={16} className="text-[#117dff]" />
              <div className="font-['Space_Grotesk'] text-lg font-semibold">Connection status</div>
            </div>
            {configError ? (
              <div className="rounded-[18px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{configError}</div>
            ) : (
              <div className="space-y-3 text-sm text-[#111827]">
                <div className="rounded-[18px] border border-[#ece6da] bg-[#faf7f1] px-4 py-3">
                  Enabled: <span className="font-semibold">{config?.enabled ? 'Yes' : 'No'}</span>
                </div>
                <div className="rounded-[18px] border border-[#ece6da] bg-[#faf7f1] px-4 py-3">
                  User ID: <span className="font-semibold">{config?.user_id || 'Not configured'}</span>
                </div>
                <div className="rounded-[18px] border border-[#ece6da] bg-[#faf7f1] px-4 py-3 break-all">
                  RPC URL: <span className="font-semibold">{config?.rpc_url || 'Not configured'}</span>
                </div>
              </div>
            )}
          </section>

          <section className="rounded-[24px] border border-[#ddd6c8] bg-white p-5">
            <div className="mb-4 flex items-center gap-2">
              <Search size={16} className="text-[#117dff]" />
              <div className="font-['Space_Grotesk'] text-lg font-semibold">Test query</div>
            </div>
            <form className="space-y-4" onSubmit={handleTest}>
              <textarea
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Ask HIVE-MIND something, for example: What do we already know about Hannover Messe positioning?"
                className="min-h-[120px] w-full rounded-[18px] border border-[#ddd6c8] bg-[#faf7f1] px-4 py-3 text-sm text-[#111827] outline-none transition focus:border-[#117dff] focus:bg-white"
              />
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-[#6b7280]">This runs `hivemind_recall` through the backend proxy.</div>
                <button
                  type="submit"
                  disabled={testing || !query.trim()}
                  className="inline-flex items-center gap-2 rounded-full bg-[#117dff] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#0a68d1] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {testing ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                  Test query
                </button>
              </div>
            </form>
            {testError ? (
              <div className="mt-4 rounded-[18px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{testError}</div>
            ) : null}
            {testResult ? (
              <div className="mt-4 space-y-3">
                <div className="rounded-[18px] border border-[#ece6da] bg-[#faf7f1] px-4 py-3 text-sm text-[#111827]">
                  Found <span className="font-semibold">{testResult.count}</span> memory result{testResult.count === 1 ? '' : 's'} for <span className="font-semibold">{testResult.query}</span>.
                </div>
                <div className="space-y-2">
                  {(testResult.preview || []).map((item) => (
                    <div key={item.id || item.title} className="rounded-[18px] border border-[#ece6da] bg-[#faf7f1] px-4 py-3">
                      <div className="text-sm font-medium text-[#111827]">{item.title}</div>
                      <div className="mt-1 text-xs text-[#6b7280]">{item.id || 'No id'}{item.project ? ` · ${item.project}` : ''}</div>
                      <div className="mt-2 text-sm text-[#4b5563]">{item.summary || 'No summary available.'}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-[24px] border border-[#ddd6c8] bg-white p-5">
            <div className="mb-4 flex items-center gap-2">
              <ShieldCheck size={16} className="text-[#117dff]" />
              <div className="font-['Space_Grotesk'] text-lg font-semibold">Provenance split</div>
            </div>
            <div className="space-y-3 text-sm text-[#111827]">
              <div className="rounded-[18px] border border-[#ece6da] bg-[#faf7f1] px-4 py-3">
                Primary ground truth: <span className="font-semibold">{hivemindSummary?.provenance?.primary_ground_truth || 'n/a'}</span>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <StatCard label="Memory sources" value={hivemindSummary?.provenance?.memory_sources || 0} />
                <StatCard label="Web sources" value={hivemindSummary?.provenance?.web_sources || 0} />
                <StatCard label="Uploads" value={hivemindSummary?.provenance?.upload_sources || 0} />
              </div>
              <div className="rounded-[18px] border border-[#ece6da] bg-[#faf7f1] px-4 py-3 text-sm text-[#4b5563]">
                {evidenceSummary?.summary || 'Evidence summary will appear here after research fan-in.'}
              </div>
            </div>
          </section>

          <section className="rounded-[24px] border border-[#ddd6c8] bg-white p-5">
            <div className="mb-4 flex items-center gap-2">
              <AlertTriangle size={16} className="text-[#117dff]" />
              <div className="font-['Space_Grotesk'] text-lg font-semibold">Freshness and contradictions</div>
            </div>
            <div className="space-y-3">
              <div className="rounded-[18px] border border-[#ece6da] bg-[#faf7f1] px-4 py-3 text-sm text-[#111827]">
                Freshness: <span className="font-semibold">{hivemindSummary?.freshness?.freshness_summary || 'No freshness signal yet.'}</span>
              </div>
              <div className={`rounded-[18px] border px-4 py-3 text-sm ${contradictionClass}`}>
                {hivemindSummary?.contradictions?.length
                  ? `${hivemindSummary.contradictions.length} contradiction(s) need review before save-back or final delivery.`
                  : 'No contradictions detected between memory and web evidence.'}
              </div>
              {Array.isArray(hivemindSummary?.recommendedFollowups) && hivemindSummary.recommendedFollowups.length > 0 ? (
                <div className="rounded-[18px] border border-[#ece6da] bg-[#faf7f1] px-4 py-3">
                  <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-[#6b7280]">Recommended follow-ups</div>
                  <ul className="mt-3 space-y-2 text-sm text-[#374151]">
                    {hivemindSummary.recommendedFollowups.map((item) => (
                      <li key={item} className="flex items-start gap-2">
                        <ArrowUpRight size={14} className="mt-0.5 text-[#117dff]" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </section>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <SourceList
            title="Memory references"
            icon={Database}
            items={hivemindSummary?.memorySources || []}
            empty="No HIVE-MIND memory sources were used in this run."
          />
          <SourceList
            title="Live web references"
            icon={Globe}
            items={hivemindSummary?.webSources || []}
            empty="No freshness verification was required for this run."
          />
          <SourceList
            title="Uploaded knowledge"
            icon={FileStack}
            items={hivemindSummary?.uploadSources || []}
            empty="No uploaded tenant documents contributed to this run."
          />
        </div>
      </section>

      <aside className="min-h-0 overflow-y-auto space-y-6">
        <section className="rounded-[24px] border border-[#ddd6c8] bg-white p-5">
          <div className="mb-4 flex items-center gap-2">
            <Link2 size={16} className="text-[#117dff]" />
            <div className="font-['Space_Grotesk'] text-lg font-semibold">Planner context</div>
          </div>
          <div className="rounded-[18px] border border-[#ece6da] bg-[#faf7f1] px-4 py-3 text-sm leading-7 text-[#111827]">
            {routingDecision?.reasoning || 'Planner context will appear after the strategist resolves the task graph.'}
          </div>
        </section>

        <section className="rounded-[24px] border border-[#ddd6c8] bg-white p-5">
          <div className="mb-4 flex items-center gap-2">
            <FileStack size={16} className="text-[#117dff]" />
            <div className="font-['Space_Grotesk'] text-lg font-semibold">Run ledger</div>
          </div>
          <div className="space-y-2">
            {timeline.length === 0 ? (
              <div className="text-sm text-[#6b7280]">No run history yet.</div>
            ) : timeline.map((item) => (
              <div key={`${item.label}-${item.at}`} className="rounded-[18px] border border-[#ece6da] bg-[#faf7f1] px-3 py-2.5">
                <div className="text-sm font-medium text-[#111827]">{item.label}</div>
                <div className="mt-1 text-[11px] font-mono text-[#6b7280]">{item.state} · {item.at}</div>
              </div>
            ))}
          </div>
        </section>
      </aside>
    </div>
  );
}
