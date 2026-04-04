import React from 'react';
import { ArrowRight, Bot, FileSearch, MessageSquareText } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useBlaiqWorkspace } from '../shared/blaiq-workspace-context';

export default function Overview() {
  const { messages, activeAgents, previewHtml, timeline } = useBlaiqWorkspace();

  const stats = [
    { label: 'Messages', value: messages.length },
    { label: 'Active agents', value: activeAgents.length },
    { label: 'Timeline steps', value: timeline.length },
    { label: 'Preview ready', value: previewHtml ? 'Yes' : 'No' },
  ];

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_360px] gap-6 overflow-hidden p-5 md:p-7 max-xl:grid-cols-[minmax(0,1fr)]">
      <section className="min-h-0 overflow-y-auto">
        <div className="mb-6">
          <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-[#6b7280]">Control center</div>
          <h2 className="mt-2 font-['Space_Grotesk'] text-3xl font-semibold tracking-tight">BLAIQ workflow workspace</h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {stats.map((item) => (
            <div key={item.label} className="rounded-[30px] border border-[rgba(0,0,0,0.05)] bg-white/92 p-5 shadow-[0_18px_44px_rgba(0,0,0,0.05)]">
              <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-[#6b7280]">{item.label}</div>
              <div className="mt-3 text-3xl font-semibold text-[#111827]">{item.value}</div>
            </div>
          ))}
        </div>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <Link to="/app/chat" className="rounded-[30px] border border-[rgba(0,0,0,0.05)] bg-white/92 p-5 shadow-[0_18px_44px_rgba(0,0,0,0.05)] transition-all hover:-translate-y-1 hover:bg-white">
            <MessageSquareText size={18} className="text-[#ff5c4b]" />
            <div className="mt-4 text-lg font-semibold text-[#111827]">Chat workflow</div>
            <div className="mt-1 text-sm text-[#6b7280]">Run strategist, GraphRAG, HITL, Vangogh, and governance in one lane.</div>
          </Link>
          <Link to="/app/agents" className="rounded-[30px] border border-[rgba(0,0,0,0.05)] bg-white/92 p-5 shadow-[0_18px_44px_rgba(0,0,0,0.05)] transition-all hover:-translate-y-1 hover:bg-white">
            <Bot size={18} className="text-[#ff5c4b]" />
            <div className="mt-4 text-lg font-semibold text-[#111827]">Agents</div>
            <div className="mt-1 text-sm text-[#6b7280]">Inspect routing decisions and active subsystems.</div>
          </Link>
          <Link to="/app/preview" className="rounded-[30px] border border-[rgba(0,0,0,0.05)] bg-white/92 p-5 shadow-[0_18px_44px_rgba(0,0,0,0.05)] transition-all hover:-translate-y-1 hover:bg-white">
            <FileSearch size={18} className="text-[#ff5c4b]" />
            <div className="mt-4 text-lg font-semibold text-[#111827]">Preview</div>
            <div className="mt-1 text-sm text-[#6b7280]">Review artifact output, schema, and governance feedback.</div>
          </Link>
        </div>
      </section>
      <aside className="rounded-[32px] border border-[rgba(0,0,0,0.05)] bg-white/92 p-5 shadow-[0_22px_48px_rgba(0,0,0,0.06)]">
        <div className="font-['Space_Grotesk'] text-lg font-semibold">Next recommended step</div>
        <div className="mt-3 text-sm leading-relaxed text-[#6b7280]">Use the chat workflow as the primary surface. The other pages support inspection and control, but chat owns the narrative.</div>
        <Link to="/app/chat" className="mt-5 inline-flex items-center gap-2 rounded-full bg-[#000000] px-4 py-2 text-sm font-semibold text-white shadow-[0_16px_34px_rgba(0,0,0,0.12)]">
          Open chat
          <ArrowRight size={14} />
        </Link>
      </aside>
    </div>
  );
}
