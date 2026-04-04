import React from 'react';

export default function Settings() {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="w-full max-w-3xl border border-[#ddd6c8] bg-white p-6">
        <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-[#6b7280]">Standalone frontend</div>
        <h2 className="mt-2 font-['Space_Grotesk'] text-2xl font-semibold tracking-tight text-[#111827]">Runtime configuration</h2>
        <div className="mt-4 space-y-3 text-sm text-[#4b5563]">
          <div className="border border-[#e5dfd3] bg-[#faf7f1] p-4"><code>VITE_PROXY_TARGET</code> should point to the docker-backed BLAIQ Core API. Current default is <code>http://localhost:6080</code>.</div>
          <div className="border border-[#e5dfd3] bg-[#faf7f1] p-4"><code>VITE_TENANT_ID</code> defaults to <code>default</code>.</div>
          <div className="border border-[#e5dfd3] bg-[#faf7f1] p-4"><code>VITE_API_KEY</code> should be set when local core auth is enabled.</div>
        </div>
      </div>
    </div>
  );
}
