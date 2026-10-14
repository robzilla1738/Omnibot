import {
  Brain,
  Check,
  ChevronRight,
  Clock,
  ExternalLink,
  FileCode2,
  Folder,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  HardDrive,
  Laptop,
  LayoutGrid,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Share2,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  getComputerOverview,
  getGitFileDiff,
  listLocalFiles,
  openLocalItem,
} from "../../lib/omni-bridge";
import type {
  BotColor,
  BotProfile,
  BotShape,
  ChatThread,
  CliDriverKind,
  CliHarnessInfo,
  ComputerActivityEntry,
  GitRepoStatus,
  LocalFileEntry,
  OmniPreferences,
  RoutineEntry,
  SystemOverview,
  WorkspaceEntry,
} from "../../lib/types";
import {
  BOT_COLORS,
  BOT_SHAPES,
  BotCharacterAvatar,
} from "../icons/BotCharacterAvatar";
import type { OmniHubSection } from "../modals/OmniHubModal";

export type InspectorTab = "details" | "git" | "computer";

export interface InspectorDrawerProps {
  open: boolean;
  activeTab: InspectorTab;
  onSelectTab: (tab: InspectorTab) => void;
  onClose: () => void;
  chat: ChatThread;
  activeBot: BotProfile;
  bots: BotProfile[];
  harnesses: CliHarnessInfo[];
  projects: WorkspaceEntry[];
  routines: RoutineEntry[];
  gitStatus: GitRepoStatus;
  preferences: OmniPreferences;
  computerActivity: ComputerActivityEntry[];
  onUpdateChat: (params: {
    chatId: string;
    title?: string;
    participantBotIds?: string[];
    useWorktrees?: boolean;
    maxSwarmTurns?: number;
  }) => Promise<void>;
  onClearChat: (chatId: string) => Promise<void>;
  onToggleBotInChat: (botId: string) => Promise<void>;
  onUpsertBot: (bot: BotProfile) => Promise<void>;
  onUpdatePreferences: (next: OmniPreferences) => Promise<void>;
  onUpsertRoutine: (routine: RoutineEntry) => Promise<void>;
  onRunRoutineNow: (routine: RoutineEntry) => Promise<void>;
  onCommitGit: (message: string) => Promise<void>;
  onDiscardGitFile: (filePath: string) => Promise<void>;
  onRescan: () => Promise<void>;
  onOpenOmniHub: (section?: OmniHubSection) => void;
}

export function InspectorDrawer({
  open,
  activeTab,
  onSelectTab,
  onClose,
  chat,
  activeBot,
  bots,
  harnesses,
  projects,
  routines,
  gitStatus,
  preferences,
  computerActivity,
  onUpdateChat,
  onClearChat,
  onToggleBotInChat,
  onUpsertBot,
  onUpdatePreferences,
  onUpsertRoutine,
  onRunRoutineNow,
  onCommitGit,
  onDiscardGitFile,
  onRescan,
  onOpenOmniHub,
}: InspectorDrawerProps) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(chat.title);
  const [customizeAvatarOpen, setCustomizeAvatarOpen] = useState(false);
  const [swarmMembersOpen, setSwarmMembersOpen] = useState(false);

  const [showNewRoutineForm, setShowNewRoutineForm] = useState(false);
  const [newRoutineName, setNewRoutineName] = useState("");
  const [newRoutineCron, setNewRoutineCron] = useState("0 9 * * 1-5");
  const [newRoutinePrompt, setNewRoutinePrompt] = useState("");

  const [selectedDiffFile, setSelectedDiffFile] = useState<string | null>(null);
  const [selectedDiffContent, setSelectedDiffContent] = useState<string>("");
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);

  const [systemOverview, setSystemOverview] = useState<SystemOverview | null>(
    null
  );
  const [localFiles, setLocalFiles] = useState<LocalFileEntry[]>([]);
  const [workspaceInput, setWorkspaceInput] = useState(
    preferences.workspaceRoot
  );
  const [shareCopied, setShareCopied] = useState(false);

  useEffect(() => {
    setTitleDraft(chat.title);
  }, [chat.title]);

  useEffect(() => {
    setWorkspaceInput(preferences.workspaceRoot);
  }, [preferences.workspaceRoot]);

  const loadComputerData = useCallback(async () => {
    const [overview, files] = await Promise.all([
      getComputerOverview().catch(() => null),
      listLocalFiles(".").catch(() => []),
    ]);
    setSystemOverview(overview);
    setLocalFiles(files);
  }, []);

  useEffect(() => {
    if (!open) return;
    if (activeTab === "computer") {
      loadComputerData();
    }
  }, [open, activeTab, loadComputerData]);

  const handleLoadFileDiff = async (filePath: string) => {
    if (selectedDiffFile === filePath) {
      setSelectedDiffFile(null);
      return;
    }
    setSelectedDiffFile(filePath);
    setSelectedDiffContent("Loading diff...");
    try {
      const diff = await getGitFileDiff(filePath);
      setSelectedDiffContent(diff || "(No diff output)");
    } catch (err) {
      setSelectedDiffContent(
        err instanceof Error ? err.message : "Could not load diff"
      );
    }
  };

  const handleCommitAll = async () => {
    if (!commitMessage.trim()) return;
    setCommitting(true);
    try {
      await onCommitGit(commitMessage.trim());
      setCommitMessage("");
      setSelectedDiffFile(null);
    } finally {
      setCommitting(false);
    }
  };

  const handleCreateRoutine = async () => {
    if (!newRoutineName.trim() || !newRoutinePrompt.trim()) return;
    await onUpsertRoutine({
      id: "",
      name: newRoutineName.trim(),
      cron: newRoutineCron.trim() || "0 9 * * 1-5",
      prompt: newRoutinePrompt.trim(),
      botId: activeBot.id,
      enabled: true,
    });
    setNewRoutineName("");
    setNewRoutinePrompt("");
    setShowNewRoutineForm(false);
  };

  const handleShareTranscript = async () => {
    const md = chat.messages
      .map(
        (m) =>
          `### ${m.role === "user" ? "You" : `@${m.authorName || "Bot"} (${m.cliDriver || "cli"})`}\n\n${m.text}`
      )
      .join("\n\n---\n\n");
    await navigator.clipboard.writeText(md || chat.title);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 1800);
  };

  const installedHarnesses = harnesses.filter((h) => h.installed);
  const activeProjectName =
    projects.find((p) => p.path === preferences.workspaceRoot)?.name ||
    preferences.workspaceRoot.split("/").filter(Boolean).pop() ||
    "Project";

  return (
    <aside
      aria-hidden={!open}
      className={`relative shrink-0 h-full bg-[#0e0e0e] select-none z-20 overflow-hidden transition-[width,opacity,border-color] duration-300 spring-transition ${
        open
          ? "w-[372px] opacity-100 border-l border-white/[0.06]"
          : "w-0 opacity-0 border-l border-transparent pointer-events-none"
      }`}
    >
      <div
        className={`relative w-[372px] h-full flex flex-col overflow-x-hidden transition-transform duration-300 spring-transition ${
          open ? "translate-x-0" : "translate-x-6"
        }`}
      >
        {/* Top Share + Close Controls */}
        <div
          data-tauri-drag-region
          className="h-16 pt-2 px-4 flex items-center justify-end gap-2.5 shrink-0"
        >
          <button
            type="button"
            onClick={handleShareTranscript}
            title="Copy markdown transcript to clipboard"
            className="w-10 h-10 rounded-full bg-[#1f1f1f] hover:bg-[#272727] border border-white/[0.06] flex items-center justify-center text-zinc-200 hover:text-white active:scale-95 transition-colors"
          >
            {shareCopied ? (
              <Check className="w-[17px] h-[17px] text-emerald-400" />
            ) : (
              <Share2 className="w-[17px] h-[17px]" />
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close inspector (Cmd+I)"
            className="w-10 h-10 rounded-full bg-[#1f1f1f] hover:bg-[#272727] border border-white/[0.06] flex items-center justify-center text-zinc-200 hover:text-white active:scale-95 transition-colors"
          >
            <X className="w-[18px] h-[18px]" />
          </button>
        </div>

        {/* Center Character Avatar + Title + Segmented Tabs */}
        <div className="px-6 pt-1 pb-4 flex flex-col items-center shrink-0">
          <button
            type="button"
            onClick={() => setCustomizeAvatarOpen((v) => !v)}
            title="Click to customize Bot character shape, color & CLI driver"
            className="group relative transition-transform active:scale-95"
          >
            <BotCharacterAvatar
              bot={activeBot}
              size={72}
              showStarBadge={activeBot.isPrimary}
              showCliBadge={!activeBot.isPrimary}
            />
          </button>

          <h2 className="mt-2.5 text-[18px] font-semibold text-white tracking-tight text-center max-w-[280px] truncate">
            {chat.isPrimary ? activeBot.name : chat.title}
          </h2>

          {editingTitle && !chat.isPrimary ? (
            <input
              type="text"
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => {
                setEditingTitle(false);
                if (titleDraft.trim()) {
                  onUpdateChat({ chatId: chat.id, title: titleDraft.trim() });
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setEditingTitle(false);
                  if (titleDraft.trim()) {
                    onUpdateChat({ chatId: chat.id, title: titleDraft.trim() });
                  }
                }
              }}
              className="mt-1.5 w-60 bg-[#1f1f1f] border border-white/10 rounded-xl px-3 py-1.5 text-[13.5px] text-center text-zinc-100 focus:outline-none"
            />
          ) : (
            <div className="mt-1 flex items-center gap-2 text-[13px] text-[#8e8d8a]">
              <span className="font-mono text-zinc-400">
                {activeBot.cliDriver}
              </span>
              <span>·</span>
              <button
                type="button"
                onClick={() => setCustomizeAvatarOpen((v) => !v)}
                className="hover:text-zinc-200 transition-colors"
              >
                {customizeAvatarOpen ? "Close studio" : "Edit Bot"}
              </button>
              {!chat.isPrimary && (
                <>
                  <span>·</span>
                  <button
                    type="button"
                    onClick={() => setEditingTitle(true)}
                    className="hover:text-zinc-200 transition-colors"
                  >
                    Rename
                  </button>
                </>
              )}
            </div>
          )}

          {/* Segmented Tabs: Details | Project & Git | Computer */}
          <div className="mt-4 flex items-center gap-1.5">
            {(
              [
                { id: "details", label: "Details" },
                {
                  id: "git",
                  label:
                    gitStatus.changedFiles.length > 0
                      ? `Project & Git (${gitStatus.changedFiles.length})`
                      : "Project & Git",
                },
                { id: "computer", label: "Computer" },
              ] as const
            ).map((t) => {
              const active = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onSelectTab(t.id)}
                  className={`px-3.5 py-1.5 rounded-full text-[13.5px] font-medium transition-colors ${
                    active
                      ? "bg-[#1f1f1f] text-white border border-white/[0.06]"
                      : "text-[#8e8d8a] hover:text-zinc-200 border border-transparent"
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Scrollable Tab Body */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden sidebar-scroll-mask px-4 pt-1 pb-16 space-y-5">
          {activeTab === "details" && (
            <div className="space-y-5">
              {/* Collapsible Character & CLI Studio */}
              {customizeAvatarOpen && (
                <div className="liquid-glass-card rounded-2xl p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-[13.5px] font-semibold text-white">
                      {activeBot.name} · Character &amp; CLI
                    </span>
                    <button
                      type="button"
                      onClick={() => setCustomizeAvatarOpen(false)}
                      className="text-xs text-zinc-400 hover:text-white"
                    >
                      Done
                    </button>
                  </div>

                  {/* CLI Driver Assignment */}
                  <div className="space-y-1.5">
                    <label className="block text-xs text-[#8e8d8a]">
                      Local CLI Harness
                    </label>
                    <div className="grid grid-cols-2 gap-1.5">
                      {installedHarnesses.map((h) => {
                        const selected = activeBot.cliDriver === h.kind;
                        return (
                          <button
                            key={h.id}
                            type="button"
                            onClick={() =>
                              onUpsertBot({
                                ...activeBot,
                                cliDriver: h.kind as CliDriverKind,
                                model: h.models[0] ?? null,
                              })
                            }
                            className={`px-2.5 py-1.5 rounded-xl text-xs font-medium flex items-center justify-between transition-colors ${
                              selected
                                ? "bg-white text-black font-semibold"
                                : "bg-[#1f1f1f] text-zinc-300 hover:text-white"
                            }`}
                          >
                            <span className="truncate">{h.name}</span>
                            {selected && <Check className="w-3 h-3 shrink-0" />}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Color Palette Picker */}
                  <div className="space-y-1.5">
                    <label className="block text-xs text-[#8e8d8a]">
                      Character Color
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {BOT_COLORS.map((c) => {
                        const selected = activeBot.color === c.id;
                        return (
                          <button
                            key={c.id}
                            type="button"
                            title={c.label}
                            onClick={() =>
                              onUpsertBot({
                                ...activeBot,
                                color: c.id as BotColor,
                              })
                            }
                            style={{ backgroundColor: c.swatch }}
                            className={`w-6 h-6 rounded-full transition-transform ${
                              selected
                                ? "ring-2 ring-white scale-110"
                                : "opacity-80 hover:opacity-100"
                            }`}
                          />
                        );
                      })}
                    </div>
                  </div>

                  {/* Shape Grid */}
                  <div className="space-y-1.5">
                    <label className="block text-xs text-[#8e8d8a]">
                      Bot Shape ({BOT_SHAPES.length})
                    </label>
                    <div className="grid grid-cols-5 gap-1.5 max-h-52 overflow-y-auto p-1">
                      {BOT_SHAPES.map((s) => {
                        const selected = activeBot.shape === s.id;
                        return (
                          <button
                            key={s.id}
                            type="button"
                            title={s.label}
                            onClick={() =>
                              onUpsertBot({
                                ...activeBot,
                                shape: s.id as BotShape,
                              })
                            }
                            className={`p-1.5 rounded-xl flex items-center justify-center transition-all ${
                              selected
                                ? "bg-[#2a2a2e] ring-1 ring-white/30"
                                : "bg-[#151517] hover:bg-[#202024]"
                            }`}
                          >
                            <BotCharacterAvatar
                              shape={s.id}
                              color={activeBot.color}
                              size={32}
                            />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* Quick Project & Git Status Summary Row */}
              <div className="liquid-glass-card rounded-2xl divide-y divide-white/[0.06] overflow-hidden">
                <button
                  type="button"
                  onClick={() => onSelectTab("git")}
                  className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-white/[0.03] transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-[34px] h-[34px] rounded-[10px] bg-[#8cf1fb]/15 text-[#8cf1fb] flex items-center justify-center shrink-0">
                      <FolderGit2 className="w-[17px] h-[17px]" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[14.5px] font-medium text-[#f4f4f5] truncate">
                        {activeProjectName}
                      </div>
                      <div className="text-xs text-[#8e8d8a] font-mono truncate flex items-center gap-1.5">
                        <GitBranch className="w-3 h-3 text-emerald-400 shrink-0" />
                        <span>{gitStatus.branch || "main"}</span>
                        {gitStatus.changedFiles.length > 0 && (
                          <span className="text-amber-300">
                            · {gitStatus.changedFiles.length} modified
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-zinc-500 shrink-0" />
                </button>

                {/* Bots in Conversation (Swarm Participants) */}
                <div>
                  <button
                    type="button"
                    onClick={() => setSwarmMembersOpen((v) => !v)}
                    className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-white/[0.03] transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="w-[34px] h-[34px] rounded-[10px] bg-purple-500/15 text-purple-300 flex items-center justify-center shrink-0">
                        <Users className="w-[17px] h-[17px]" />
                      </span>
                      <div className="min-w-0">
                        <div className="text-[14.5px] font-medium text-[#f4f4f5] truncate">
                          Bots in Conversation ({chat.participantBotIds.length})
                        </div>
                        <div className="text-xs text-[#8e8d8a] truncate">
                          Add or remove CLI Bots in this thread
                        </div>
                      </div>
                    </div>
                    <ChevronRight
                      className={`w-4 h-4 text-zinc-500 transition-transform ${
                        swarmMembersOpen ? "rotate-90" : ""
                      }`}
                    />
                  </button>

                  {swarmMembersOpen && (
                    <div className="px-3 pb-3 pt-1 space-y-1 border-t border-white/[0.04]">
                      {bots.map((b) => {
                        const inChat = chat.participantBotIds.includes(b.id);
                        return (
                          <button
                            key={b.id}
                            type="button"
                            onClick={() => onToggleBotInChat(b.id)}
                            className={`w-full px-2.5 py-1.5 rounded-xl flex items-center justify-between text-xs transition-colors ${
                              inChat
                                ? "bg-white/[0.08] text-white"
                                : "hover:bg-white/[0.04] text-zinc-400"
                            }`}
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              <BotCharacterAvatar bot={b} size={22} />
                              <span className="font-medium truncate">
                                {b.name}
                              </span>
                              <span className="font-mono text-[10.5px] text-zinc-500">
                                ({b.cliDriver})
                              </span>
                            </span>
                            {inChat && (
                              <Check className="w-3.5 h-3.5 text-[#8cf1fb]" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* Multi-Bot Swarm Room Controls */}
              <div className="space-y-2">
                <span className="px-1.5 text-[13.5px] font-normal text-[#8e8d8a] block">
                  Swarm &amp; Execution Controls
                </span>
                <div className="liquid-glass-card rounded-2xl divide-y divide-white/[0.06] overflow-hidden">
                  <div className="px-4 py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[14.5px] font-medium text-[#f4f4f5]">
                        Isolate Bots in Git Worktrees
                      </div>
                      <div className="text-[12.5px] text-[#8e8d8a]">
                        Each Bot edits its own branch in ~/.omni-bot/worktrees
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={chat.useWorktrees}
                      onClick={() =>
                        onUpdateChat({
                          chatId: chat.id,
                          useWorktrees: !chat.useWorktrees,
                        })
                      }
                      className={`relative inline-flex h-6 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                        chat.useWorktrees ? "bg-[#3b82f6]" : "bg-white/[0.14]"
                      }`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition ${
                          chat.useWorktrees ? "translate-x-4" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  <div className="px-4 py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[14.5px] font-medium text-[#f4f4f5]">
                        Max Autonomous Handoffs
                      </div>
                      <div className="text-[12.5px] text-[#8e8d8a]">
                        Bot-to-Bot turns before pausing for review
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {[2, 4, 6].map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() =>
                            onUpdateChat({
                              chatId: chat.id,
                              maxSwarmTurns: n,
                            })
                          }
                          className={`w-7 h-7 rounded-lg text-xs font-semibold transition-colors ${
                            chat.maxSwarmTurns === n
                              ? "bg-white text-black"
                              : "bg-[#1f1f1f] text-zinc-400 hover:text-white"
                          }`}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>

                  {chat.messages.length > 0 && (
                    <button
                      type="button"
                      onClick={() => onClearChat(chat.id)}
                      className="w-full px-4 py-2.5 flex items-center justify-between text-xs text-zinc-400 hover:text-red-300 hover:bg-white/[0.02] transition-colors"
                    >
                      <span>Clear conversation history</span>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Routines Section */}
              <div className="space-y-2.5">
                <div className="px-1.5 flex items-center justify-between">
                  <span className="text-[13.5px] font-normal text-[#8e8d8a]">
                    Routines
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowNewRoutineForm((v) => !v)}
                    className="px-3 py-1 rounded-full bg-[#1f1f1f] hover:bg-[#272727] border border-white/[0.06] text-[12.5px] font-medium text-zinc-200 hover:text-white flex items-center gap-1.5 active:scale-95 transition-colors"
                  >
                    <Plus
                      className={`w-3.5 h-3.5 transition-transform duration-200 ${
                        showNewRoutineForm ? "rotate-45" : ""
                      }`}
                    />
                    <span>{showNewRoutineForm ? "Close" : "New"}</span>
                  </button>
                </div>

                {showNewRoutineForm && (
                  <div className="liquid-glass-card rounded-2xl p-4 space-y-2.5">
                    <input
                      type="text"
                      value={newRoutineName}
                      onChange={(e) => setNewRoutineName(e.target.value)}
                      placeholder="Routine name (e.g. Daily PR & Lint Check)"
                      className="w-full rounded-xl bg-[#1f1f1f] border border-white/[0.07] px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
                    />
                    <input
                      type="text"
                      value={newRoutineCron}
                      onChange={(e) => setNewRoutineCron(e.target.value)}
                      placeholder="Cron schedule (e.g. 0 9 * * 1-5)"
                      className="w-full rounded-xl bg-[#1f1f1f] border border-white/[0.07] px-3 py-2 text-[13px] text-zinc-100 font-mono placeholder:text-zinc-500 focus:outline-none"
                    />
                    <textarea
                      rows={2}
                      value={newRoutinePrompt}
                      onChange={(e) => setNewRoutinePrompt(e.target.value)}
                      placeholder="Prompt the Bot will execute..."
                      className="w-full rounded-xl bg-[#1f1f1f] border border-white/[0.07] px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none resize-none"
                    />
                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={handleCreateRoutine}
                        className="px-4 py-1.5 rounded-full bg-[#3b82f6] hover:bg-[#2563eb] text-white text-[12.5px] font-medium"
                      >
                        Save Routine
                      </button>
                    </div>
                  </div>
                )}

                <div className="liquid-glass-card rounded-2xl divide-y divide-white/[0.06] overflow-hidden">
                  {routines.length === 0 ? (
                    <div className="p-4 text-[13px] text-[#8e8d8a]">
                      No scheduled routines yet.
                    </div>
                  ) : (
                    routines.map((routine) => {
                      const rBot =
                        bots.find((b) => b.id === routine.botId) ?? activeBot;
                      return (
                        <div
                          key={routine.id}
                          className="px-4 py-3 flex items-center justify-between gap-3"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="text-[14.5px] font-medium text-[#f4f4f5] truncate">
                              {routine.name}
                            </div>
                            <div className="text-[12.5px] text-[#8e8d8a] truncate mt-0.5 flex items-center gap-2">
                              <span>@{rBot.name}</span>
                              <span>·</span>
                              <span>{routine.cron}</span>
                              <button
                                type="button"
                                onClick={() => onRunRoutineNow(routine)}
                                title="Run routine now in active chat"
                                className="text-cyan-300 hover:text-white inline-flex items-center gap-0.5"
                              >
                                <Play className="w-3 h-3" />
                                <span>Run</span>
                              </button>
                            </div>
                          </div>

                          <button
                            type="button"
                            role="switch"
                            aria-checked={routine.enabled}
                            onClick={() =>
                              onUpsertRoutine({
                                ...routine,
                                enabled: !routine.enabled,
                              })
                            }
                            className={`relative inline-flex h-6 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                              routine.enabled ? "bg-[#3b82f6]" : "bg-white/[0.14]"
                            }`}
                          >
                            <span
                              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition ${
                                routine.enabled ? "translate-x-4" : "translate-x-0"
                              }`}
                            />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Quick Launch into Botfinity Hub */}
              <div className="space-y-2">
                <span className="px-1.5 text-[13.5px] font-normal text-[#8e8d8a] block">
                  Botfinity Hub
                </span>
                <div className="liquid-glass-card rounded-2xl divide-y divide-white/[0.06] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => onOpenOmniHub("memories")}
                    className="w-full px-4 py-3 flex items-center justify-between gap-3.5 text-left hover:bg-white/[0.04] transition-colors"
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <span className="w-[34px] h-[34px] rounded-[10px] bg-cyan-500/15 text-cyan-400 flex items-center justify-center shrink-0">
                        <Brain className="w-[17px] h-[17px]" />
                      </span>
                      <span className="text-[14.5px] font-medium text-[#f4f4f5] truncate">
                        Shared &amp; Bot Memories
                      </span>
                    </span>
                    <ChevronRight className="w-4 h-4 text-zinc-500 shrink-0" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenOmniHub("projects")}
                    className="w-full px-4 py-3 flex items-center justify-between gap-3.5 text-left hover:bg-white/[0.04] transition-colors"
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <span className="w-[34px] h-[34px] rounded-[10px] bg-[#8cf1fb]/15 text-[#8cf1fb] flex items-center justify-center shrink-0">
                        <LayoutGrid className="w-[17px] h-[17px]" />
                      </span>
                      <span className="text-[14.5px] font-medium text-[#f4f4f5] truncate">
                        Projects, Skills &amp; Hub
                      </span>
                    </span>
                    <ChevronRight className="w-4 h-4 text-zinc-500 shrink-0" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === "git" && (
            <div className="space-y-5">
              {/* Project Switcher Card */}
              <div className="liquid-glass-card rounded-2xl p-4 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-[#8e8d8a]">
                    Active Project
                  </span>
                  <button
                    type="button"
                    onClick={() => onOpenOmniHub("projects")}
                    className="text-xs text-cyan-300 hover:text-white"
                  >
                    Manage Projects
                  </button>
                </div>
                <div className="space-y-1">
                  {projects.map((p) => {
                    const isCurrent = p.path === preferences.workspaceRoot;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() =>
                          onUpdatePreferences({
                            ...preferences,
                            workspaceRoot: p.path,
                          })
                        }
                        className={`w-full px-3 py-2 rounded-xl flex items-center justify-between gap-2 text-left text-xs transition-colors ${
                          isCurrent
                            ? "bg-white/[0.08] text-white font-semibold"
                            : "hover:bg-white/[0.04] text-zinc-300"
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate">{p.name}</div>
                          <div className="text-[11px] font-mono text-zinc-400 truncate">
                            {p.path}
                          </div>
                        </div>
                        {isCurrent && (
                          <Check className="w-4 h-4 text-[#8cf1fb] shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Git Branch & Commit Card */}
              <div className="liquid-glass-card rounded-2xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="text-[14.5px] font-semibold text-white truncate">
                      {gitStatus.isRepo
                        ? `Branch: ${gitStatus.branch}`
                        : "Not a Git repository"}
                    </div>
                    <div className="text-xs text-[#8e8d8a] font-mono truncate">
                      {gitStatus.rootPath}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={onRescan}
                    title="Refresh Git status"
                    className="w-8 h-8 rounded-full bg-[#1f1f1f] hover:bg-[#272727] border border-white/[0.06] flex items-center justify-center text-zinc-300 hover:text-white shrink-0"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </div>

                {gitStatus.changedFiles.length > 0 && (
                  <div className="flex gap-2 pt-1">
                    <input
                      type="text"
                      value={commitMessage}
                      onChange={(e) => setCommitMessage(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleCommitAll();
                      }}
                      placeholder="Commit message..."
                      className="min-w-0 flex-1 rounded-xl bg-[#1f1f1f] border border-white/[0.07] px-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={committing || !commitMessage.trim()}
                      onClick={handleCommitAll}
                      className="px-3 py-1.5 rounded-xl bg-white hover:bg-zinc-200 disabled:opacity-40 text-black text-xs font-semibold flex items-center gap-1.5 shrink-0"
                    >
                      <GitCommitHorizontal className="w-3.5 h-3.5" />
                      <span>{committing ? "..." : "Commit"}</span>
                    </button>
                  </div>
                )}

                {gitStatus.diffStat && (
                  <pre className="text-[11px] font-mono text-zinc-400 bg-black/40 rounded-xl p-2.5 overflow-x-auto">
                    {gitStatus.diffStat}
                  </pre>
                )}
              </div>

              <div className="space-y-2">
                <span className="px-1.5 text-[13.5px] font-normal text-[#8e8d8a] block">
                  Changed Files ({gitStatus.changedFiles.length})
                </span>
                <div className="liquid-glass-card rounded-2xl divide-y divide-white/[0.06] overflow-hidden">
                  {gitStatus.changedFiles.length === 0 ? (
                    <div className="p-4 text-[13px] text-[#8e8d8a]">
                      Working tree is clean.
                    </div>
                  ) : (
                    gitStatus.changedFiles.map((f) => {
                      const expanded = selectedDiffFile === f.path;
                      return (
                        <div key={f.path}>
                          <div className="px-3.5 py-2.5 flex items-center justify-between gap-2 hover:bg-white/[0.04] transition-colors">
                            <button
                              type="button"
                              onClick={() => handleLoadFileDiff(f.path)}
                              className="flex items-center gap-2.5 min-w-0 flex-1 text-left"
                            >
                              <FileCode2 className="w-4 h-4 text-cyan-400 shrink-0" />
                              <span className="text-[13px] font-mono text-zinc-100 truncate">
                                {f.path}
                              </span>
                            </button>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <span
                                className={`text-[11px] px-2 py-0.5 rounded-full capitalize ${
                                  f.status === "added"
                                    ? "bg-emerald-500/15 text-emerald-300"
                                    : f.status === "deleted"
                                      ? "bg-red-500/15 text-red-300"
                                      : "bg-amber-500/15 text-amber-300"
                                }`}
                              >
                                {f.status}
                              </span>
                              <button
                                type="button"
                                onClick={() => onDiscardGitFile(f.path)}
                                title="Discard changes in this file"
                                className="p-1 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-white/[0.06]"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                          {expanded && (
                            <pre className="px-3.5 py-2.5 bg-black/60 border-t border-white/[0.06] text-[11px] font-mono text-zinc-300 overflow-x-auto max-h-60">
                              {selectedDiffContent}
                            </pre>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {gitStatus.worktrees.length > 0 && (
                <div className="space-y-2">
                  <span className="px-1.5 text-[13.5px] font-normal text-[#8e8d8a] block">
                    Git Worktrees ({gitStatus.worktrees.length})
                  </span>
                  <div className="liquid-glass-card rounded-2xl divide-y divide-white/[0.06] overflow-hidden">
                    {gitStatus.worktrees.map((wt) => (
                      <div key={wt.path} className="px-3.5 py-2.5 space-y-0.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-mono font-semibold text-[#8cf1fb]">
                            {wt.branch}
                          </span>
                          <span className="font-mono text-zinc-500">{wt.head}</span>
                        </div>
                        <div className="text-[11.5px] font-mono text-zinc-400 truncate">
                          {wt.path}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === "computer" && (
            <div className="space-y-5">
              {/* Local Mac Project Root */}
              <div className="liquid-glass-card rounded-2xl p-4 space-y-3.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="w-[34px] h-[34px] rounded-[10px] bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0">
                      <Laptop className="w-[17px] h-[17px]" />
                    </span>
                    <div>
                      <div className="text-[14.5px] font-medium text-[#f4f4f5]">
                        Active Project Directory
                      </div>
                      {systemOverview && (
                        <div className="text-[12.5px] text-[#8e8d8a] truncate">
                          {systemOverview.hostname} ({systemOverview.os}/{systemOverview.arch})
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => openLocalItem(".", { revealInFinder: false })}
                    className="text-xs text-cyan-300 hover:text-cyan-200 inline-flex items-center gap-1"
                  >
                    <span>Finder</span>
                    <ExternalLink className="w-3 h-3" />
                  </button>
                </div>

                <div className="space-y-2">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={workspaceInput}
                      onChange={(e) => setWorkspaceInput(e.target.value)}
                      className="min-w-0 flex-1 rounded-xl bg-[#1f1f1f] border border-white/[0.07] px-3 py-2 text-[12.5px] text-zinc-100 font-mono focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        await onUpdatePreferences({
                          ...preferences,
                          workspaceRoot: workspaceInput.trim(),
                        });
                        loadComputerData();
                      }}
                      className="px-3.5 py-2 rounded-xl bg-white text-black text-xs font-semibold shrink-0 active:scale-95"
                    >
                      Set
                    </button>
                  </div>
                </div>
              </div>

              {/* Project Files Preview */}
              <div className="space-y-2">
                <div className="px-1.5 flex items-center justify-between">
                  <span className="text-[13.5px] font-normal text-[#8e8d8a]">
                    Project Files ({localFiles.length})
                  </span>
                  <button
                    type="button"
                    onClick={loadComputerData}
                    className="w-7 h-7 rounded-full bg-[#1f1f1f] hover:bg-[#272727] border border-white/[0.06] flex items-center justify-center text-zinc-300 hover:text-white"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="liquid-glass-card rounded-2xl max-h-56 overflow-y-auto divide-y divide-white/[0.06]">
                  {localFiles.slice(0, 30).map((f) => (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => openLocalItem(f.path, { revealInFinder: true })}
                      className="w-full px-3.5 py-2.5 flex items-center justify-between gap-2.5 text-[13px] text-left hover:bg-white/[0.04] transition-colors"
                    >
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        {f.isDir ? (
                          <Folder className="w-4 h-4 text-[#8cf1fb] shrink-0" />
                        ) : (
                          <HardDrive className="w-4 h-4 text-zinc-400 shrink-0" />
                        )}
                        <span className="text-[#f4f4f5] font-medium truncate">
                          {f.name}
                        </span>
                      </div>
                      {!f.isDir && (
                        <span className="text-[11.5px] text-[#8e8d8a] shrink-0">
                          {Math.max(1, Math.round(f.sizeBytes / 1024))} KB
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* CLI Process Activity Log */}
              <div className="space-y-2">
                <span className="px-1.5 text-[13.5px] font-normal text-[#8e8d8a] block">
                  Recent CLI &amp; Tool Telemetry
                </span>
                <div className="liquid-glass-card rounded-2xl divide-y divide-white/[0.06] overflow-hidden">
                  {computerActivity.length === 0 ? (
                    <div className="p-4 text-[13px] text-[#8e8d8a]">
                      No CLI subprocess runs recorded yet in this session.
                    </div>
                  ) : (
                    computerActivity.slice(0, 12).map((act) => (
                      <div key={act.id} className="px-3.5 py-2.5 space-y-0.5">
                        <div className="flex items-center justify-between text-[12.5px]">
                          <span className="font-mono text-[#f4f4f5] truncate">
                            {act.toolName}
                          </span>
                          <span className="text-[11.5px] text-[#8e8d8a] flex items-center gap-1 shrink-0">
                            <Clock className="w-3 h-3" />
                            {(act.durationMs / 1000).toFixed(1)}s
                          </span>
                        </div>
                        <p className="text-[12px] text-[#8e8d8a] truncate">
                          {act.summary}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div
          aria-hidden
          className="pointer-events-none absolute bottom-0 inset-x-0 h-16 sidebar-bottom-feather z-10"
        />
      </div>
    </aside>
  );
}
