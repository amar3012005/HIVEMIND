import React from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import { useBlaiqWorkspace } from '../shared/blaiq-workspace-context';

export default function AppShell() {
  const { isDayMode } = useBlaiqWorkspace();

  return (
    <div
      className={`flex h-screen w-screen overflow-hidden font-[Inter,ui-sans-serif,system-ui,sans-serif] ${
        isDayMode ? 'bg-[#f6f1ea]' : 'bg-[#0a0a0a]'
      }`}
    >
      <div className="flex-shrink-0 max-lg:hidden">
        <Sidebar />
      </div>

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
