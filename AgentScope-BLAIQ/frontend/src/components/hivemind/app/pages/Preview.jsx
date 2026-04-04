import React from 'react';
import { FileCode2, ShieldCheck } from 'lucide-react';
import { useBlaiqWorkspace } from '../shared/blaiq-workspace-context';

export default function Preview() {
  const { previewHtml, schema, governance, renderState } = useBlaiqWorkspace();

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_360px] gap-6 overflow-hidden p-5 md:p-7 max-xl:grid-cols-[minmax(0,1fr)]">
      <section className="min-h-0 rounded-[32px] border border-[rgba(0,0,0,0.06)] bg-[#faf9f4] p-4 shadow-[0_22px_50px_rgba(0,0,0,0.06)]">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-[#7a7267]">Artifact</div>
            <div className="mt-1 font-['Space_Grotesk'] text-lg font-semibold text-[#111827]">
              {previewHtml ? 'Live preview' : renderState.loading ? 'Rendering pages' : 'Preview pending'}
            </div>
          </div>
          <div className="rounded-full border border-[#e3e0db] bg-white px-3 py-1.5 text-[11px] text-[#4b5563]">{renderState.artifactKind || 'content'}</div>
        </div>
        <div className="h-[calc(100%-68px)] overflow-hidden rounded-[26px] border border-[#e3e0db] bg-white">
          {previewHtml ? (
            <iframe title="Artifact preview" srcDoc={previewHtml} className="h-full w-full bg-white" />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center text-sm text-[#6b7280]">
              <div className="font-semibold text-[#111827]">
                {renderState.loading ? 'Rendering is in progress' : 'The preview opens as soon as Vangogh returns the first fragment.'}
              </div>
              {renderState.loading ? (
                <div className="w-full max-w-[240px] rounded-full bg-[#e3e0db]">
                  <div
                    className="h-2 rounded-full bg-[#ff5c4b]"
                    style={{ width: `${Math.min(100, Math.max(8, renderState.total ? (renderState.section / Math.max(1, renderState.total)) * 100 : 12))}%` }}
                  />
                </div>
              ) : null}
            </div>
          )}
        </div>
      </section>
      <aside className="min-h-0 overflow-y-auto space-y-4">
        <div className="rounded-[30px] border border-[rgba(0,0,0,0.06)] bg-[#faf9f4] p-5 shadow-[0_18px_44px_rgba(0,0,0,0.05)]">
          <div className="mb-3 flex items-center gap-2">
            <FileCode2 size={16} className="text-[#ff5c4b]" />
            <div className="font-['Space_Grotesk'] text-lg font-semibold">Schema</div>
          </div>
          {schema ? <pre className="overflow-auto rounded-[24px] bg-white p-3 text-xs leading-relaxed text-[#4b5563]">{JSON.stringify(schema, null, 2)}</pre> : <div className="text-sm text-[#6b7280]">Schema is not available yet.</div>}
        </div>
        <div className="rounded-[30px] border border-[rgba(0,0,0,0.06)] bg-[#faf9f4] p-5 shadow-[0_18px_44px_rgba(0,0,0,0.05)]">
          <div className="mb-3 flex items-center gap-2">
            <ShieldCheck size={16} className="text-[#ff5c4b]" />
            <div className="font-['Space_Grotesk'] text-lg font-semibold">Governance</div>
          </div>
          {governance ? (
            <div className="space-y-3">
              <div className={`rounded-[22px] px-3 py-2 text-sm font-medium ${governance.approved ? 'bg-emerald-50 text-emerald-700' : 'bg-[rgba(255,92,75,0.12)] text-[#ff5c4b]'}`}>
                {governance.approved ? 'Validation passed' : 'Review required'}
              </div>
              <div className="rounded-[22px] bg-white p-3">
                <div className="text-sm font-medium text-[#111827]">Readiness score</div>
                <div className="mt-1 text-xs text-[#6b7280]">{governance.readiness_score}</div>
              </div>
              {(governance.issues || []).map((issue, index) => (
                <div key={`${issue}-${index}`} className="rounded-[22px] bg-white p-3">
                  <div className="text-sm font-medium text-[#111827]">Issue {index + 1}</div>
                  <div className="mt-1 text-xs text-[#6b7280]">{issue}</div>
                </div>
              ))}
              {(governance.notes || []).map((note, index) => (
                <div key={`${note}-${index}`} className="rounded-[22px] bg-white p-3">
                  <div className="text-sm font-medium text-[#111827]">Note {index + 1}</div>
                  <div className="mt-1 text-xs text-[#6b7280]">{note}</div>
                </div>
              ))}
            </div>
          ) : <div className="text-sm text-[#6b7280]">Governance appears after artifact evaluation.</div>}
        </div>
      </aside>
    </div>
  );
}
