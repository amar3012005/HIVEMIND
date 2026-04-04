import React from 'react';
import {
  BookOpen,
  Bot,
  CheckCircle2,
  CircleDashed,
  Database,
  Folder,
  Loader2,
  Moon,
  PanelLeftClose,
  Plus,
  Search,
  Sparkles,
  Sun,
  XCircle,
} from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useBlaiqWorkspace } from '../shared/blaiq-workspace-context';

function TaskStatusIcon({ status }) {
  if (status === 'complete') return <CheckCircle2 size={14} className="text-emerald-500" />;
  if (status === 'running') return <Loader2 size={14} className="animate-spin text-amber-500" />;
  if (status === 'error') return <XCircle size={14} className="text-rose-500" />;
  return <CircleDashed size={14} className="text-[#c7bfb3]" />;
}

function NavButton({ icon: Icon, label, active, onClick, muted = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-[16px] px-3 py-2.5 text-left text-[14px] transition-all ${
        active
          ? 'bg-white text-[#1f1b18] shadow-[0_6px_18px_rgba(38,30,24,0.06)]'
          : muted
            ? 'text-[#aea59a] hover:bg-white/65 hover:text-[#554d45]'
            : 'text-[#554d45] hover:bg-white/65 hover:text-[#1f1b18]'
      }`}
    >
      <Icon size={18} strokeWidth={1.8} />
      <span className="font-medium">{label}</span>
    </button>
  );
}

function truncateLabel(text, max = 33) {
  if (!text) return 'Untitled task';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export default function Sidebar() {
  const {
    tasks,
    activeTaskId,
    setActiveTaskId,
    resetWorkspace,
    isDayMode,
    toggleDayMode,
  } = useBlaiqWorkspace();
  const navigate = useNavigate();
  const location = useLocation();

  const activePath = location.pathname;
  const activeTask = tasks.find((task) => task.id === activeTaskId) || null;
  const sortedTasks = [...tasks].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const openChat = () => navigate('/app/chat');
  const openHivemind = () => navigate('/app/hivemind');

  return (
    <aside
      className={`flex h-full w-[318px] flex-shrink-0 flex-col border-r ${
        isDayMode
          ? 'border-[#e5ddd2] bg-[#f3efe8] text-[#1f1b18]'
          : 'border-[#1c1a19] bg-[#11100f] text-[#f4efe7]'
      }`}
    >
      <div className={`flex items-center justify-between px-5 pb-4 pt-5 ${isDayMode ? '' : 'border-b border-[#1c1a19]'}`}>
        <button type="button" onClick={openChat} className="flex items-center gap-3 text-left">
          <div className={`flex h-9 w-9 items-center justify-center rounded-[14px] ${isDayMode ? 'bg-[#1f1b18] text-[#f5efe6]' : 'bg-[#f5efe6] text-[#1f1b18]'}`}>
            <Sparkles size={18} strokeWidth={2} />
          </div>
          <div>
            <div className={`text-[14px] font-semibold tracking-tight ${isDayMode ? 'text-[#2b2622]' : 'text-white'}`}>blaiq</div>
            <div className={`text-[11px] ${isDayMode ? 'text-[#8d8378]' : 'text-[#9f968d]'}`}>Agent workspace</div>
          </div>
        </button>
        <button
          type="button"
          className={`rounded-[12px] p-2 ${isDayMode ? 'text-[#7f766c] hover:bg-white/75' : 'text-[#9f968d] hover:bg-[#171514]'}`}
          title="Sidebar"
        >
          <PanelLeftClose size={17} />
        </button>
      </div>

      <div className="px-4">
        <NavButton
          icon={Plus}
          label="New task"
          active={activePath === '/app/chat'}
          onClick={() => {
            resetWorkspace();
            openChat();
          }}
        />
        <div className="mt-1" />
        <NavButton icon={Bot} label="Agents" onClick={openChat} muted />
        <NavButton icon={Search} label="Search" onClick={openChat} muted />
        <NavButton icon={BookOpen} label="Library" onClick={openChat} muted />
        <NavButton
          icon={Database}
          label="HIVEMIND"
          active={activePath === '/app/hivemind'}
          onClick={openHivemind}
        />
      </div>

      <div className="px-5 pt-7">
        <div className="flex items-center justify-between">
          <div className={`text-[12px] font-semibold ${isDayMode ? 'text-[#8d8378]' : 'text-[#9f968d]'}`}>Projects</div>
          <button
            type="button"
            onClick={openChat}
            className={`rounded-[10px] px-2 py-1 text-[16px] leading-none ${isDayMode ? 'text-[#8d8378] hover:bg-white/70' : 'text-[#9f968d] hover:bg-[#171514]'}`}
            title="Add project"
          >
            +
          </button>
        </div>
        <button
          type="button"
          onClick={openChat}
          className={`mt-3 flex w-full items-center gap-3 rounded-[16px] px-3 py-2.5 text-left transition-all ${
            isDayMode ? 'text-[#2b2622] hover:bg-white/70' : 'text-[#f3eee6] hover:bg-[#171514]'
          }`}
        >
          <Folder size={18} strokeWidth={1.8} />
          <div>
            <div className="text-[14px] font-medium">BLAIQ</div>
            <div className={`text-[11px] ${isDayMode ? 'text-[#9b9185]' : 'text-[#91887d]'}`}>Active workspace</div>
          </div>
        </button>
      </div>

      <div className="min-h-0 flex-1 px-4 pb-4 pt-7">
        <div className="flex items-center justify-between px-1">
          <div className={`text-[12px] font-semibold ${isDayMode ? 'text-[#8d8378]' : 'text-[#9f968d]'}`}>All tasks</div>
          <button
            type="button"
            onClick={openChat}
            className={`rounded-[10px] px-2 py-1 text-[13px] ${isDayMode ? 'text-[#8d8378] hover:bg-white/70' : 'text-[#9f968d] hover:bg-[#171514]'}`}
            title="Open workspace"
          >
            ≈
          </button>
        </div>

        <div className="mt-3 space-y-1.5 overflow-y-auto pr-1">
          {sortedTasks.length === 0 ? (
            <div className={`rounded-[18px] border px-4 py-4 text-[13px] ${isDayMode ? 'border-[#e4dbcf] bg-white/70 text-[#8b8277]' : 'border-[#1c1a19] bg-[#171514] text-[#9f968d]'}`}>
              No tasks yet. Start a new BLAIQ run from chat.
            </div>
          ) : (
            sortedTasks.map((task) => {
              const selected = task.id === activeTaskId;
              const subtitle = task.status === 'running' ? task.currentAgent || 'Working...' : task.status;
              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => {
                    setActiveTaskId(task.id);
                    openChat();
                  }}
                  className={`flex w-full items-start gap-3 rounded-[18px] px-3 py-3 text-left transition-all ${
                    selected
                      ? isDayMode
                        ? 'bg-[#e7e1d8] text-[#1f1b18]'
                        : 'bg-[#1b1918] text-white'
                      : isDayMode
                        ? 'text-[#433c35] hover:bg-white/72'
                        : 'text-[#d7d0c7] hover:bg-[#171514]'
                  }`}
                >
                  <div className="pt-0.5">
                    <TaskStatusIcon status={task.status} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium leading-snug">
                      {truncateLabel(task.query)}
                    </div>
                    <div className={`mt-1 text-[11px] ${selected ? (isDayMode ? 'text-[#74695d]' : 'text-[#a89f95]') : (isDayMode ? 'text-[#9b9185]' : 'text-[#8f867b]')}`}>
                      {subtitle}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className={`border-t px-4 pb-4 pt-3 ${isDayMode ? 'border-[#e5ddd2]' : 'border-[#1c1a19]'}`}>
        <button
          type="button"
          onClick={toggleDayMode}
          className={`flex w-full items-center justify-between rounded-[18px] px-3 py-3 text-left transition-all ${
            isDayMode ? 'bg-white/72 text-[#544c44] hover:bg-white' : 'bg-[#171514] text-[#d7d0c7] hover:bg-[#1d1a19]'
          }`}
        >
          <div>
            <div className="text-[14px] font-medium">{isDayMode ? 'Day mode' : 'Night mode'}</div>
            <div className={`text-[11px] ${isDayMode ? 'text-[#9b9185]' : 'text-[#8f867b]'}`}>
              Switch workspace theme
            </div>
          </div>
          {isDayMode ? <Moon size={16} /> : <Sun size={16} />}
        </button>
        <div className={`mt-3 text-center text-[11px] ${isDayMode ? 'text-[#a59a8d]' : 'text-[#7f776e]'}`}>
          {activeTask ? `Focused on: ${truncateLabel(activeTask.query, 24)}` : 'No active task selected'}
        </div>
      </div>
    </aside>
  );
}
