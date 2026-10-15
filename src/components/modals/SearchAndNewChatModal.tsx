import { NativeSelect } from "../ui/NativeSelect";
import {
  Check,
  FolderGit2,
  MessageSquare,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BotProfile,
  CliHarnessInfo,
  ChatThread,
  LocalSkillItem,
  WorkspaceEntry,
} from "../../lib/types";
import { BotModelSelect } from "../bots/BotModelSelect";
import { BotCharacterAvatar, SkillBrandIcon } from "../icons/BotCharacterAvatar";

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
  const [query, setQuery] = useState("");
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
    const timer = setTimeout(() => inputRef.current?.focus(), 40);
    return () => clearTimeout(timer);
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

  const filteredBots = useMemo(
    () =>
      bots.filter(
        (b) =>
          !trimmedQuery ||
          b.name.toLowerCase().includes(trimmedQuery) ||
          b.cliDriver.toLowerCase().includes(trimmedQuery) ||
          b.roleTitle.toLowerCase().includes(trimmedQuery)
      ),
    [bots, trimmedQuery]
  );

  const filteredChats = useMemo(
    () =>
      chats.filter(
        (c) =>
          !trimmedQuery ||
          c.title.toLowerCase().includes(trimmedQuery) ||
          c.subtitle.toLowerCase().includes(trimmedQuery)
      ),
    [chats, trimmedQuery]
  );

  const filteredSkills = useMemo(
    () =>
      skills
        .filter(
          (s) =>
            !trimmedQuery ||
            s.name.toLowerCase().includes(trimmedQuery) ||
            s.slug.toLowerCase().includes(trimmedQuery)
        )
        .slice(0, 10),
    [skills, trimmedQuery]
  );

  return (
    <div
      aria-hidden={!open}
      inert={!open}
      className={`fixed inset-0 z-50 flex items-start justify-center pt-16 px-4 select-none transition-opacity duration-220 spring-transition ${
        open
          ? "bg-black/65 backdrop-blur-md opacity-100 pointer-events-auto"
          : "bg-black/65 backdrop-blur-md opacity-0 pointer-events-none"
      }`}
      onClick={() => { if (!saving) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={mode === "search" ? "Search" : "New chat"}
        className={`w-full max-w-[560px] h-[min(720px,calc(100dvh-128px))] rounded-[22px] bg-[#121212] border border-white/[0.08] shadow-[0_28px_90px_rgba(0,0,0,0.85)] flex flex-col overflow-hidden transition-[opacity,scale,translate] duration-240 spring-transition ${
          open
            ? "scale-100 opacity-100 translate-y-0"
            : "scale-[0.985] opacity-0 -translate-y-1"
        }`}
        onClick={(e) => e.stopPropagation()}
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
            onKeyDown={(e) => {
              if (e.key === "Escape" && !saving) onClose();
              if (e.key === "Enter" && mode !== "search") void createChat();
            }}
            className="w-full bg-transparent text-[15px] text-zinc-100 placeholder:text-[#8e8d8a] focus:outline-none"
          />
          <button
            type="button"
            aria-label="Close dialog"
            disabled={saving}
            onClick={() => { if (!saving) onClose(); }}
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
            <div className="space-y-3">
              {/* Bots */}
              <div className="space-y-1">
                <div className="px-2 text-xs text-[#8e8d8a]">Bots</div>
                {filteredBots.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => {
                      if (b.isPrimary) onSelectPrimary();
                      else onSelectBotDirectChat(b);
                      onClose();
                    }}
                    className="w-full px-3 py-2 rounded-[16px] hover:bg-[#1b1b1b] flex items-center gap-3.5 text-left transition-colors"
                  >
                    <BotCharacterAvatar
                      bot={b}
                      size={38}
                      showCliBadge={!b.isPrimary}
                      showStarBadge={b.isPrimary}
                      useHeroMascot={b.isPrimary}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-[14.5px] font-medium text-[#f4f4f5] flex items-center gap-2">
                        <span>{b.name}</span>
                        <span className="text-[11px]  text-zinc-400">
                          ({b.cliDriver})
                        </span>
                      </div>
                      <div className="text-[12.5px] text-[#8e8d8a] truncate">
                        {b.roleTitle}
                      </div>
                    </div>
                  </button>
                ))}
              </div>

              {/* Threads & Group chats */}
              {filteredChats.length > 0 && (
                <div className="space-y-1">
                  <div className="px-2 text-xs text-[#8e8d8a]">
                    Group chats &amp; Threads
                  </div>
                  {filteredChats.slice(0, 8).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        onSelectChat(c.id);
                        onClose();
                      }}
                      className="w-full px-3 py-2 rounded-[16px] hover:bg-[#1b1b1b] flex items-center gap-3.5 text-left transition-colors"
                    >
                      <div className="w-[36px] h-[36px] rounded-[11px] bg-[#1b1b1b] border border-white/[0.06] text-zinc-400 flex items-center justify-center shrink-0">
                        <MessageSquare className="w-[17px] h-[17px]" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-[14.5px] font-medium text-[#f4f4f5] truncate">
                          {c.title}
                        </div>
                        <div className="text-[12.5px] text-[#8e8d8a] truncate">
                          {c.subtitle}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* Projects */}
              {projects.length > 0 && (
                <div className="space-y-1">
                  <div className="px-2 text-xs text-[#8e8d8a]">Projects</div>
                  {projects
                    .filter(
                      (p) =>
                        !trimmedQuery ||
                        p.name.toLowerCase().includes(trimmedQuery) ||
                        p.path.toLowerCase().includes(trimmedQuery)
                    )
                    .map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={async () => {
                          await onSelectProject(p.path);
                          onClose();
                        }}
                        className="w-full px-3 py-2 rounded-[16px] hover:bg-[#1b1b1b] flex items-center gap-3.5 text-left transition-colors"
                      >
                        <div className="w-[36px] h-[36px] rounded-[11px] bg-[#8cf1fb]/15 text-[#8cf1fb] flex items-center justify-center shrink-0">
                          <FolderGit2 className="w-[17px] h-[17px]" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[14.5px] font-medium text-[#f4f4f5] truncate">
                            {p.name}
                          </div>
                          <div className="text-[12px]  text-[#8e8d8a] truncate">
                            {p.path}
                          </div>
                        </div>
                      </button>
                    ))}
                </div>
              )}

              {/* Local Skills */}
              {filteredSkills.length > 0 && (
                <div className="space-y-1">
                  <div className="px-2 text-xs text-[#8e8d8a]">Local Skills</div>
                  {filteredSkills.map((sk) => (
                    <button
                      key={sk.id}
                      type="button"
                      onClick={() => {
                        onCreateSwarmOrChat({
                          title: sk.name,
                          participantBotIds: ["bot-omni"],
                          skillSlug: sk.slug,
                        });
                        onClose();
                      }}
                      className="w-full px-3 py-2 rounded-[16px] hover:bg-[#1b1b1b] flex items-center gap-3.5 text-left transition-colors"
                    >
                      <SkillBrandIcon name={sk.name} size={36} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[14.5px] font-medium text-[#f4f4f5] truncate">
                          {sk.name}
                        </div>
                        <div className="text-[12.5px] text-[#8e8d8a] truncate">
                          /{sk.slug} · {sk.description}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {mode !== "search" && <div className="shrink-0 p-3.5 pt-2 space-y-3">
              {error && <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
              <button type="button" disabled={!canCreate || saving} onClick={() => void createChat()} className="motion-cta w-full rounded-full bg-white text-black px-5 py-3 text-sm font-medium disabled:opacity-40">
                {saving ? "Creating…" : groupChat ? `Create group chat${selectedBotIds.length ? ` (${selectedBotIds.length} bots)` : ""}` : "Start chat"}
              </button>
        </div>}
      </div>
    </div>
  );
}
