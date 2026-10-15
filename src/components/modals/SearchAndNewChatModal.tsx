import { NativeSelect } from "../ui/NativeSelect";
import {
  Check,
  FolderGit2,
  MessageSquare,
  Search,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  BotProfile,
  CliHarnessInfo,
  ChatThread,
  LocalSkillItem,
  WorkspaceEntry,
} from "../../lib/types";
import { BotModelSelect } from "../bots/BotModelSelect";
import { BotCharacterAvatar, SkillBrandIcon } from "../icons/BotCharacterAvatar";
import { Dialog } from "../ui/Dialog";
import { useNotices } from "../ui/Notices";

type SearchResult = { key: string; group: string; title: ReactNode; detail: string; icon: ReactNode; select: () => void };

export interface SearchAndNewChatModalProps {
  open: boolean;
  projectRequired?: boolean;
  initialParticipantBotIds?: string[];
  mode: "search" | "new-chat" | "new-group";
  harnesses: CliHarnessInfo[];
  bots: BotProfile[];
  chats: ChatThread[];
  skills: LocalSkillItem[];
  projects: WorkspaceEntry[];
  onClose: () => void;
  onSelectPrimary: () => void;
  onSelectBotDirectChat: (bot: BotProfile) => void;
  onSelectChat: (chatId: string) => void;
  onSelectProject: (path: string) => Promise<void>;
  onCreateSwarmOrChat: (params: {
    title?: string;
    participantBotIds: string[];
    modelOverrides?: Record<string, string | null>;
    useWorktrees?: boolean;
    workspacePath?: string;
    initialPrompt?: string;
    skillSlug?: string;
  }) => Promise<void>;
}

export function SearchAndNewChatModal({
  open,
  projectRequired = false,
  initialParticipantBotIds,
  mode,
  harnesses,
  bots,
  chats,
  skills,
  projects,
  onClose,
  onSelectPrimary,
  onSelectBotDirectChat,
  onSelectChat,
  onSelectProject,
  onCreateSwarmOrChat,
}: SearchAndNewChatModalProps) {
  const { runAction } = useNotices();
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedBotIds, setSelectedBotIds] = useState<string[]>([]);
  const [useWorktrees, setUseWorktrees] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [projectPath, setProjectPath] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [groupChat, setGroupChat] = useState(false);
  const [models, setModels] = useState<Record<string, string | null>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const initialized = useRef(false);
  const submitting = useRef(false);
  useEffect(() => {
    if (!open) { initialized.current = false; return; }
    if (initialized.current) return;
    initialized.current = true;
    setQuery("");
    setGroupChat(mode === "new-group");
    setSelectedBotIds(initialParticipantBotIds?.filter(id => bots.some(bot => bot.id === id)) ?? (mode === "new-group" ? [] : bots.filter(b => b.isPrimary).slice(0, 1).map(b => b.id)));
    setModels(Object.fromEntries(bots.map(bot => [bot.id, bot.model ?? null])));
    setUseWorktrees(false);
    setProjectPath(""); setFolderPath("");
    setError("");
  }, [open, mode, bots, initialParticipantBotIds]);

  const trimmedQuery = query.trim().toLowerCase();
  const toggleBotSelection = (id: string) => {
    setSelectedBotIds(prev => !groupChat ? [id] : prev.includes(id) ? prev.filter(value => value !== id) : [...prev, id]);
  };
  const workspacePath = projectPath === "__folder__" ? folderPath.trim() : projectPath;
  const canCreate = selectedBotIds.length >= (groupChat ? 2 : 1) && (!projectRequired || !!workspacePath) && (projectPath !== "__folder__" || !!workspacePath);
  const createChat = async () => {
    if (!canCreate || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      await onCreateSwarmOrChat({ title: query.trim() || undefined, participantBotIds: selectedBotIds, modelOverrides: Object.fromEntries(selectedBotIds.map(id => [id, models[id] ?? null])), useWorktrees: groupChat && !!workspacePath && useWorktrees, workspacePath: workspacePath || undefined });
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { submitting.current = false; setSaving(false); }
  };

  const results = useMemo<SearchResult[]>(() => {
    const matches = (...fields: string[]) => !trimmedQuery || fields.some(field => field.toLowerCase().includes(trimmedQuery));
    const iconBox = (className: string, icon: ReactNode) => <div className={`w-[36px] h-[36px] rounded-[11px] flex items-center justify-center shrink-0 ${className}`}>{icon}</div>;
    return [
      ...bots.filter(b => matches(b.name, b.cliDriver, b.roleTitle)).map(b => ({
        key: `bot:${b.id}`, group: "Bots",
        title: <><span>{b.name}</span><span className="text-[11px] text-zinc-400">({b.cliDriver})</span></>,
        detail: b.roleTitle,
        icon: <BotCharacterAvatar bot={b} size={38} showCliBadge={!b.isPrimary} showStarBadge={b.isPrimary} useHeroMascot={b.isPrimary} />,
        select: () => { if (b.isPrimary) onSelectPrimary(); else onSelectBotDirectChat(b); onClose(); },
      })),
      ...chats.filter(c => matches(c.title, c.subtitle)).slice(0, 8).map(c => ({
        key: `chat:${c.id}`, group: "Group chats & Threads", title: c.title, detail: c.subtitle,
        icon: iconBox("bg-[#1b1b1b] border border-white/[0.06] text-zinc-400", <MessageSquare className="w-[17px] h-[17px]" />),
        select: () => { onSelectChat(c.id); onClose(); },
      })),
      ...projects.filter(p => matches(p.name, p.path)).map(p => ({
        key: `project:${p.id}`, group: "Projects", title: p.name, detail: p.path,
        icon: iconBox("bg-[#8cf1fb]/15 text-[#8cf1fb]", <FolderGit2 className="w-[17px] h-[17px]" />),
        select: () => { void runAction(`Couldn’t open ${p.name}`, async () => { await onSelectProject(p.path); onClose(); }); },
      })),
      ...skills.filter(sk => matches(sk.name, sk.slug)).slice(0, 10).map(sk => ({
        key: `skill:${sk.id}`, group: "Local Skills", title: sk.name, detail: `/${sk.slug} · ${sk.description}`,
        icon: <SkillBrandIcon name={sk.name} size={36} />,
        select: () => {
          void runAction(`Couldn’t start ${sk.name}`, () => onCreateSwarmOrChat({ title: sk.name, participantBotIds: [bots.find(b => b.isPrimary)?.id ?? "bot-omni"], skillSlug: sk.slug }));
          onClose();
        },
      })),
    ];
  }, [bots, chats, projects, skills, trimmedQuery, onSelectPrimary, onSelectBotDirectChat, onSelectChat, onSelectProject, onCreateSwarmOrChat, onClose, runAction]);

  useEffect(() => { setActiveIndex(0); }, [trimmedQuery, open]);
  const activeResult = results[Math.min(activeIndex, results.length - 1)];
  const optionId = (key: string) => `${listboxId}-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  useEffect(() => {
    if (mode !== "search" || !activeResult) return;
    document.getElementById(optionId(activeResult.key))?.scrollIntoView({ block: "nearest" });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only scroll when the highlighted result changes
  }, [mode, activeResult?.key]);

  const close = () => { if (!saving) onClose(); };

  return (
    <Dialog
      open={open}
      onClose={close}
      label={mode === "search" ? "Search" : "New chat"}
      dismissible={!saving}
      initialFocus={inputRef}
      overlayClassName="items-start justify-center pt-16 px-4"
      closedClassName="scale-[0.985] opacity-0 -translate-y-1"
      className="w-full max-w-[560px] h-[min(720px,calc(100dvh-128px))] rounded-[22px] bg-[#121212] border border-white/[0.08] shadow-[0_28px_90px_rgba(0,0,0,0.85)] flex flex-col overflow-hidden"
    >
        {/* Top Search / Input Bar */}
        <div className="shrink-0 px-4 py-3.5 flex items-center gap-3">
          <Search className="w-[18px] h-[18px] text-[#8e8d8a] shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              mode === "search"
                ? "Search Bots, Group chats, Projects, and Skills..."
                : groupChat ? "Group chat title (optional)…" : "Chat title (optional)…"
            }
            {...(mode === "search" ? {
              role: "combobox",
              "aria-expanded": results.length > 0,
              "aria-controls": listboxId,
              "aria-autocomplete": "list" as const,
              "aria-activedescendant": activeResult ? optionId(activeResult.key) : undefined,
            } : {})}
            aria-label={mode === "search" ? "Search" : "Chat title"}
            onKeyDown={(e) => {
              if (mode !== "search") {
                if (e.key === "Enter") void createChat();
                return;
              }
              if ((e.key === "ArrowDown" || e.key === "ArrowUp") && results.length > 0) {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : -1;
                setActiveIndex(index => (Math.min(index, results.length - 1) + step + results.length) % results.length);
              } else if (e.key === "Enter" && activeResult) {
                e.preventDefault();
                activeResult.select();
              }
            }}
            className="w-full bg-transparent text-[15px] text-zinc-100 placeholder:text-[#8e8d8a] focus:outline-none"
          />
          <button
            type="button"
            aria-label="Close dialog"
            disabled={saving}
            onClick={close}
            className="w-8 h-8 rounded-full bg-[#1f1f1f] hover:bg-[#272727] border border-white/[0.06] flex items-center justify-center text-zinc-300 hover:text-white shrink-0 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div key={mode} className="motion-view stable-scroll flex-1 min-h-0 p-3.5 overflow-y-auto space-y-4">
          {mode !== "search" ? (
            <>
              <div className="space-y-2 px-1">
                <label className="text-sm text-zinc-300 block space-y-2"><span>Project</span><NativeSelect aria-label="Chat project" value={projectPath} disabled={saving} onChange={event => { setProjectPath(event.target.value); setUseWorktrees(false); }} className="w-full rounded-xl bg-[#202020] px-3 text-sm">
                  <option value="">{projectRequired ? "Choose a project" : "No project · one-off task"}</option>
                  {projects.map(project => <option key={project.id} value={project.path}>{project.name}</option>)}
                  <option value="__folder__">Add a project folder…</option>
                </NativeSelect></label>
                {projectPath === "__folder__" && <input aria-label="Project folder path" placeholder="/Users/you/Projects/my-project" value={folderPath} onChange={event => setFolderPath(event.target.value)} className="w-full rounded-xl bg-[#202020] px-3 py-3 text-sm" />}
                <p className="text-xs text-zinc-500">{workspacePath ? "This work chat uses the selected folder and its project memory. Your home stays separate." : "Start a focused task. Your bot keeps its memory; a project is optional."}</p>
              </div>
              <div className="flex gap-1 rounded-full bg-white/[0.04] p-1" role="group" aria-label="Chat type">
                {[false, true].map(group => <button key={String(group)} type="button" disabled={saving} aria-pressed={groupChat === group} onClick={() => { setGroupChat(group); setSelectedBotIds(group ? [] : bots.filter(b => b.isPrimary).slice(0, 1).map(b => b.id)); }} className={`flex-1 rounded-full py-2 text-sm ${groupChat === group ? "bg-white/10 text-white" : "text-zinc-400 hover:text-white"}`}>{group ? "Group chat" : "Individual bot"}</button>)}
              </div>
              <p className="px-1 text-sm text-zinc-400">{groupChat ? "Choose two or more bots to work together." : "Choose a bot and the model that powers it."}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {bots.map(bot => {
                  const selected = selectedBotIds.includes(bot.id);
                  return <div key={bot.id} className={`rounded-2xl p-3 space-y-3 ${selected ? "bg-[#252525]" : "bg-[#191919]"}`}>
                    <button type="button" disabled={saving} aria-pressed={selected} aria-label={`Select ${bot.name}`} onClick={() => toggleBotSelection(bot.id)} className="w-full flex items-center gap-3 text-left rounded-lg">
                      <BotCharacterAvatar bot={bot} size={34} showCliBadge={!bot.isPrimary} showStarBadge={bot.isPrimary} />
                      <span className="min-w-0 flex-1"><span className="block text-sm font-medium truncate">{bot.name}</span><span className="block text-xs text-zinc-400 truncate">{harnesses.find(h => h.kind === bot.cliDriver)?.name ?? bot.cliDriver}</span></span>
                      {selected && <Check size={16} className="text-zinc-200 shrink-0" />}
                    </button>
                  </div>;
                })}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {bots.filter(bot => selectedBotIds.includes(bot.id)).map(bot => <BotModelSelect key={bot.id} label={`${bot.name} model`} value={models[bot.id] ?? null} harness={harnesses.find(h => h.kind === bot.cliDriver)} disabled={saving} onChange={model => setModels(previous => ({ ...previous, [bot.id]: model }))} />)}
              </div>
              {groupChat && !!workspacePath && <label className="rounded-2xl bg-[#191919] p-4 flex items-center gap-3 cursor-pointer">
                <FolderGit2 size={18} className="text-zinc-400 shrink-0" />
                <span className="flex-1"><span className="block text-sm">Separate working branches</span><span className="block text-xs text-zinc-400 mt-1">Give each bot its own Git worktree.</span></span>
                <input type="checkbox" className="accent-white" checked={useWorktrees} disabled={saving} onChange={event => setUseWorktrees(event.target.checked)} />
              </label>}
            </>
          ) : (
            <div id={listboxId} role="listbox" aria-label="Search results" className="space-y-3">
              {results.length === 0 && <p className="px-3 py-6 text-center text-sm text-zinc-500">No matches</p>}
              {results.map((result, index) => {
                const active = result === activeResult;
                return (
                  <div key={result.key} role="presentation">
                    {result.group !== results[index - 1]?.group && <div role="presentation" className="px-2 pb-1 text-xs text-[#8e8d8a]">{result.group}</div>}
                    <button
                      id={optionId(result.key)}
                      type="button"
                      role="option"
                      aria-selected={active}
                      tabIndex={-1}
                      onMouseMove={() => { if (!active) setActiveIndex(index); }}
                      onClick={result.select}
                      className={`w-full px-3 py-2 rounded-[16px] flex items-center gap-3.5 text-left transition-colors ${active ? "bg-[#1f1f1f]" : "hover:bg-[#1b1b1b]"}`}
                    >
                      {result.icon}
                      <div className="min-w-0 flex-1">
                        <div className="text-[14.5px] font-medium text-[#f4f4f5] flex items-center gap-2 truncate">{result.title}</div>
                        <div className="text-[12.5px] text-[#8e8d8a] truncate">{result.detail}</div>
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {mode !== "search" && <div className="shrink-0 p-3.5 pt-2 space-y-3">
              {error && <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
              <button type="button" disabled={!canCreate || saving} onClick={() => void createChat()} className="motion-cta w-full rounded-full bg-white text-black px-5 py-3 text-sm font-medium disabled:opacity-40">
                {saving ? "Creating…" : groupChat ? `Create group chat${selectedBotIds.length ? ` (${selectedBotIds.length} bots)` : ""}` : "Start chat"}
              </button>
        </div>}
    </Dialog>
  );
}
