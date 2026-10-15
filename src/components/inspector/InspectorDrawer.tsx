import { RoutineEditor, routineScheduleLabel } from "../routines/RoutineEditor";
import { BotModelSelect } from "../bots/BotModelSelect";
import { Collapse } from "../ui/Collapse";
import { AvatarPicker } from "../bots/AvatarPicker";
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
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  getComputerOverview,
  getGitFileDiff,
  listLocalFiles,
  openLocalItem,
} from "../../lib/omni-bridge";
import type {
  BotProfile,
  ChatThread,
  CliHarnessInfo,
  ComputerActivityEntry,
  GitRepoStatus,
  LocalFileEntry,
  OmniPreferences,
  RoutineEntry,
  SystemOverview,
  WorkspaceEntry,
} from "../../lib/types";
import { BotCharacterAvatar } from "../icons/BotCharacterAvatar";
import type { OmniHubSection } from "../modals/OmniHubModal";
import { useConfirm } from "../ui/Dialog";
import { errorMessage, useNotices } from "../ui/Notices";

/** Enter commits through blur; Escape restores the saved value and skips the blur commit. */
function useInlineEdit(saved: string, commit: (value: string) => void) {
  const [draft, setDraft] = useState(saved);
  const cancelled = useRef(false);
  useEffect(() => { setDraft(saved); }, [saved]);
  return {
    value: draft,
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
    onBlur: () => {
      if (cancelled.current) { cancelled.current = false; return; }
      const next = draft.trim();
      if (next && next !== saved) commit(next);
      else setDraft(saved);
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
      else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelled.current = true;
        setDraft(saved);
        event.currentTarget.blur();
      }
    },
  };
}

export type InspectorTab = "details" | "git" | "computer";

export interface InspectorDrawerProps {
  open: boolean;
  activeTab: InspectorTab;
  onSelectTab: (tab: InspectorTab) => void;
  onClose: () => void;
  chat: ChatThread;
  onChooseProject: () => void;
  activeBot: BotProfile;
  bots: BotProfile[];
  harnesses: CliHarnessInfo[];
  projects: WorkspaceEntry[];
  routines: RoutineEntry[];
  gitStatus: GitRepoStatus;
  gitTaskId?: string;
  onSelectGitTask: (id: string | undefined) => void;
  preferences: OmniPreferences;
  computerActivity: ComputerActivityEntry[];
  onUpdateChat: (params: {
    chatId: string;
    title?: string;
    participantBotIds?: string[];
    workspacePath?: string;
    useWorktrees?: boolean;
    maxSwarmTurns?: number;
  }) => Promise<void>;
  onResetSessions: () => Promise<void>;
  onClearChat: (chatId: string) => Promise<void>;
  onToggleBotInChat: (botId: string) => Promise<void>;
  onUpsertBot: (bot: BotProfile) => Promise<void>;
  onDeleteBot?: (botId: string) => Promise<void>;
  onUpsertProject?: (ws: WorkspaceEntry) => Promise<void>;
  openStudioSignal?: number;
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
  onChooseProject,
  activeBot,
  bots,
  harnesses,
  projects,
  routines,
  gitStatus,
  gitTaskId,
  onSelectGitTask,
  preferences,
  computerActivity,
  onUpdateChat,
  onClearChat,
  onResetSessions,
  onToggleBotInChat,
  onUpsertBot,
  onDeleteBot,
  onUpsertProject,
  openStudioSignal,
  onUpdatePreferences,
  onUpsertRoutine,
  onRunRoutineNow,
  onCommitGit,
  onDiscardGitFile,
  onRescan,
  onOpenOmniHub,
}: InspectorDrawerProps) {
  const { runAction } = useNotices();
  const { confirm, confirmElement } = useConfirm();
  const act = (label: string, action: () => Promise<unknown>) => { void runAction(label, action); };
  const [editingTitle, setEditingTitle] = useState(false);
  const titleEdit = useInlineEdit(chat.title, title => act("Couldn’t rename the chat", () => onUpdateChat({ chatId: chat.id, title })));
  const disclosureId = useId();
  const [customizeAvatarOpen, setCustomizeAvatarOpen] = useState(false);
  const [swarmMembersOpen, setSwarmMembersOpen] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [botSaving, setBotSaving] = useState(false);
  const botSavePending = useRef(false);
  const saveBot = async (bot: BotProfile) => {
    if (botSavePending.current) throw new Error("Wait for the current profile change to finish.");
    botSavePending.current = true;
    setBotSaving(true);
    try { await onUpsertBot(bot); }
    finally { botSavePending.current = false; setBotSaving(false); }
  };
  const botNameEdit = useInlineEdit(activeBot.name, name => act(`Couldn’t rename ${activeBot.name}`, () => saveBot({ ...activeBot, name })));
  const botRoleEdit = useInlineEdit(activeBot.roleTitle, roleTitle => act(`Couldn’t update ${activeBot.name}`, () => saveBot({ ...activeBot, roleTitle })));

  useEffect(() => {
    if (openStudioSignal && openStudioSignal > 0) {
      setCustomizeAvatarOpen(true);
    }
  }, [openStudioSignal]);

  const [showNewRoutineForm, setShowNewRoutineForm] = useState(false);
  const [routineDraftVersion, setRoutineDraftVersion] = useState(0);

  const [selectedDiffFile, setSelectedDiffFile] = useState<string | null>(null);
  const [selectedDiffContent, setSelectedDiffContent] = useState<string>("");
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [gitError, setGitError] = useState("");
  const gitContext = JSON.stringify([chat.id, chat.workspacePath, gitTaskId, gitStatus.rootPath]);
  const gitContextRef = useRef(0);
  const diffRequest = useRef(0);
  useLayoutEffect(() => {
    gitContextRef.current++;
    diffRequest.current++;
    setSelectedDiffFile(null);
    setSelectedDiffContent("");
    setCommitMessage("");
    setCommitting(false);
    setGitError("");
  }, [gitContext]);

  const [systemOverview, setSystemOverview] = useState<SystemOverview | null>(
    null
  );
  const [localFiles, setLocalFiles] = useState<LocalFileEntry[]>([]);
  const [workspaceInput, setWorkspaceInput] = useState(
    preferences.workspaceRoot
  );

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
      void loadComputerData();
    }
  }, [open, activeTab, loadComputerData]);

  const handleLoadFileDiff = async (filePath: string) => {
    const context = gitContextRef.current;
    const request = ++diffRequest.current;
    if (selectedDiffFile === filePath) {
      setSelectedDiffFile(null);
      return;
    }
    setSelectedDiffFile(filePath);
    setSelectedDiffContent("Loading diff...");
    try {
      const diff = await getGitFileDiff(filePath, chat.id, gitTaskId);
      if (request === diffRequest.current && gitContextRef.current === context) setSelectedDiffContent(diff || "(No diff output)");
    } catch (err) {
      if (request !== diffRequest.current || gitContextRef.current !== context) return;
      setSelectedDiffContent(
        err instanceof Error ? err.message : "Could not load diff"
      );
    }
  };

  const handleCommitAll = async () => {
    if (!commitMessage.trim() || committing) return;
    const context = gitContextRef.current;
    const submitted = commitMessage;
    setCommitting(true);
    setGitError("");
    try {
      await onCommitGit(submitted.trim());
      if (gitContextRef.current !== context) return;
      setCommitMessage(current => current === submitted ? "" : current);
      diffRequest.current++;
      setSelectedDiffFile(null);
    } catch (error) {
      if (gitContextRef.current === context) setGitError(`Commit failed: ${errorMessage(error)}`);
    } finally {
      if (gitContextRef.current === context) setCommitting(false);
    }
  };

  const handleDiscardFile = async (filePath: string) => {
    const context = gitContextRef.current;
    const confirmed = await confirm({
      title: "Discard changes?",
      message: <>All uncommitted changes to <code className="text-zinc-100 break-all">{filePath}</code> will be lost. This can’t be undone.</>,
      confirmLabel: "Discard changes",
      destructive: true,
    });
    if (!confirmed || gitContextRef.current !== context) return;
    setGitError("");
    try {
      await onDiscardGitFile(filePath);
      if (gitContextRef.current !== context) return;
      diffRequest.current++;
      setSelectedDiffFile(null);
    } catch (error) {
      if (gitContextRef.current === context) setGitError(`Couldn’t discard ${filePath}: ${errorMessage(error)}`);
    }
  };

  const handleClearChat = async () => {
    const confirmed = await confirm({
      title: "Clear conversation history?",
      message: `All ${chat.messages.length} messages in “${chat.isPrimary ? activeBot.name : chat.title}” will be permanently removed. Bot memory and project files are kept.`,
      confirmLabel: "Clear history",
      destructive: true,
    });
    if (confirmed) act("Couldn’t clear the conversation", () => onClearChat(chat.id));
  };

  const openItem = (path: string, revealInFinder: boolean) => act(`Couldn’t open ${path}`, () => openLocalItem(path, { revealInFinder }));

  const installedHarnesses = harnesses.filter((h) => h.installed);
  const activeProjectName =
    projects.find((p) => p.path === chat.workspacePath)?.name ||
    (chat.workspacePath ?? "").split("/").filter(Boolean).pop() ||
    "Project";

  return (
    <aside
      aria-hidden={!open}
      inert={!open}
      className={`relative shrink-0 h-full bg-[#0e0e0e] select-none z-20 overflow-hidden transition-[width,opacity,border-color] duration-300 spring-transition ${
        open
          ? "w-[372px] opacity-100 "
          : "w-0 opacity-0 pointer-events-none"
      }`}
    >
      <div
        className={`relative w-[372px] h-full flex flex-col overflow-x-hidden transition-transform duration-300 spring-transition ${
          open ? "translate-x-0" : "translate-x-6"
        }`}
      >
        {/* Top Close Control */}
        <div
          data-tauri-drag-region
          className="h-16 pt-2 px-4 flex items-center justify-end gap-2.5 shrink-0"
        >
          <button
            type="button"
            onClick={onClose}
            aria-label="Close inspector"
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
              aria-label="Chat title"
              maxLength={120}
              {...titleEdit}
              onBlur={() => { titleEdit.onBlur(); setEditingTitle(false); }}
              className="mt-1.5 w-60 bg-[#1f1f1f] border border-white/10 rounded-xl px-3 py-1.5 text-[13.5px] text-center text-zinc-100 focus:outline-none"
            />
          ) : (
            <div className="mt-1 flex items-center gap-2 text-[13px] text-[#8e8d8a]">
              <span className=" text-zinc-400">
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
            ).filter(t => t.id !== "git" || !!chat.workspacePath).map((t) => {
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
        <div key={activeTab} className="motion-view stable-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden inspector-scroll-mask px-4 pt-3 pb-8 space-y-5">
          {activeTab === "details" && (
            <div className="space-y-5">
              {/* Collapsible Character & CLI Studio */}
              <Collapse open={customizeAvatarOpen} id={disclosureId + '-customizeAvatarOpen'}><fieldset disabled={avatarBusy || botSaving} className="liquid-glass-card rounded-2xl p-4 space-y-4 min-w-0">
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

                  {/* Bot Name & Role Inputs */}
                  <div className="space-y-2">
                    <label className="block text-xs text-[#8e8d8a]">
                      Bot Name &amp; Role
                    </label>
                    <input
                      type="text"
                      aria-label="Bot name"
                      {...botNameEdit}
                      placeholder="Bot name"
                      className="w-full rounded-xl bg-[#1f1f1f] border border-white/[0.08] px-3 py-1.5 text-xs text-white focus:outline-none"
                    />
                    <input
                      type="text"
                      aria-label="Bot role"
                      {...botRoleEdit}
                      placeholder="Role subtitle"
                      className="w-full rounded-xl bg-[#1f1f1f] border border-white/[0.08] px-3 py-1.5 text-xs text-zinc-300 focus:outline-none"
                    />
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
                              act(`Couldn’t switch ${activeBot.name} to ${h.name}`, () => saveBot({
                                ...activeBot,
                                cliDriver: h.kind,
                                customCommand: null,
                                model: null,
                              }))
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

                  <BotModelSelect key={activeBot.id} value={activeBot.model ?? null} harness={installedHarnesses.find(h => h.kind === activeBot.cliDriver)} onChange={model => saveBot({ ...activeBot, model })} />

                  <AvatarPicker key={activeBot.id} active={open && customizeAvatarOpen} onBusyChange={setAvatarBusy} value={activeBot} onChange={async appearance => { await saveBot({ ...activeBot, ...appearance }); }} />

                  {!activeBot.isPrimary && onDeleteBot && (
                    <div className="pt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          setCustomizeAvatarOpen(false);
                          act(`Couldn’t archive ${activeBot.name}`, () => onDeleteBot(activeBot.id));
                        }}
                        className="px-3 py-1.5 rounded-xl bg-red-500/15 hover:bg-red-500/25 text-red-300 text-xs font-medium flex items-center gap-1.5"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Archive @{activeBot.name}</span>
                      </button>
                    </div>
                  )}
                </fieldset></Collapse>

              <div className="rounded-2xl liquid-glass-card px-4 py-4 space-y-3">
                <div className="text-sm text-zinc-200">{chat.workspacePath ? "This chat’s project" : "Personal conversation"}</div>
                <p className="text-xs text-zinc-400 break-words leading-relaxed">{chat.workspacePath ?? "Your bot uses its personal home and memory. Choose a project to start a separate work chat."}</p>
                <button type="button" className="rounded-full bg-white/10 px-3 py-2 text-xs text-zinc-200" onClick={onChooseProject}>{chat.workspacePath ? "Start another project chat" : "Choose a project"}</button>
              </div>
              {/* Quick Project & Git Status Summary Row */}
              <div className="liquid-glass-card rounded-2xl overflow-hidden">
                <button
                  type="button"
                  onClick={() => onSelectTab("git")}
                  hidden={!chat.workspacePath}
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
                      <div className="text-xs text-[#8e8d8a]  truncate flex items-center gap-1.5">
                        <GitBranch className="w-3 h-3 text-emerald-400 shrink-0" />
                        <span>{gitStatus.branch || "Unknown branch"}</span>
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

                  <Collapse open={swarmMembersOpen} id={disclosureId + '-swarmMembersOpen'}><div className="px-3 pb-3 pt-1 space-y-1 ">
                      {bots.map((b) => {
                        const inChat = chat.participantBotIds.includes(b.id);
                        return (
                          <button
                            key={b.id}
                            type="button"
                            onClick={() => act(`Couldn’t update chat members`, () => onToggleBotInChat(b.id))}
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
                              <span className=" text-[10.5px] text-zinc-500">
                                ({b.cliDriver})
                              </span>
                            </span>
                            {inChat && (
                              <Check className="w-3.5 h-3.5 text-[#8cf1fb]" />
                            )}
                          </button>
                        );
                      })}
                    </div></Collapse>
                </div>
              </div>

              {/* Multi-Bot Group chat Controls */}
              <div className="space-y-2">
                <span className="px-1.5 text-[13.5px] font-normal text-[#8e8d8a] block">
                  Group &amp; Execution Controls
                </span>
                <div className="liquid-glass-card rounded-2xl overflow-hidden">
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
                        act("Couldn’t change worktree isolation", () => onUpdateChat({
                          chatId: chat.id,
                          useWorktrees: !chat.useWorktrees,
                        }))
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
                          aria-pressed={chat.maxSwarmTurns === n}
                          onClick={() =>
                            act("Couldn’t change the handoff limit", () => onUpdateChat({
                              chatId: chat.id,
                              maxSwarmTurns: n,
                            }))
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

                  <button type="button" onClick={() => act("Couldn’t reset CLI sessions", onResetSessions)} className="w-full px-4 py-2.5 text-left text-xs text-zinc-400 hover:text-white">Reset CLI sessions · keep conversation history</button>
                  <p className="px-4 pb-2 text-xs text-zinc-500">Use after changing accounts or settings outside Omnibot.</p>
                  {chat.messages.length > 0 && (
                    <button
                      type="button"
                      onClick={() => void handleClearChat()}
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
                    aria-label={showNewRoutineForm ? "Close new routine" : "New routine"}
                    aria-expanded={showNewRoutineForm}
                    aria-controls={disclosureId + "-showNewRoutineForm"}
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

                <Collapse open={showNewRoutineForm} id={disclosureId + '-showNewRoutineForm'}>
                  <RoutineEditor key={`${chat.id}-${activeBot.id}-${routineDraftVersion}`} bots={bots} harnesses={harnesses} chat={chat} initialBotId={activeBot.id} onSave={async routine => { await onUpsertRoutine(routine); setShowNewRoutineForm(false); setRoutineDraftVersion(version => version + 1); }} />
                </Collapse>

                <div className="liquid-glass-card rounded-2xl overflow-hidden">
                  {routines.length === 0 ? (
                    <div className="p-4 text-[13px] text-[#8e8d8a]">
                      Save a routine to repeat a useful task.
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
                              <span title={routine.model || rBot.model || "CLI default"}>@{rBot.name}</span>
                              <span>·</span>
                              <span>{routineScheduleLabel(routine)}</span>
                              <button
                                type="button"
                                onClick={() => act(`Couldn’t run ${routine.name}`, () => onRunRoutineNow(routine))}
                                title="Run routine with its saved bot and model"
                                className="text-cyan-300 hover:text-white inline-flex items-center gap-0.5"
                              >
                                <Play className="w-3 h-3" />
                                <span>Run</span>
                              </button>
                            </div>
                            {routine.lastError && <p className="mt-1 text-xs text-red-300">{routine.lastError}</p>}
                          </div>

                          {routine.schedule && routine.schedule.frequency !== "manual" && <button
                            type="button"
                            role="switch"
                            aria-label={`Enable ${routine.name}`}
                            aria-checked={routine.enabled}
                            onClick={() =>
                              act(`Couldn’t update ${routine.name}`, () => onUpsertRoutine({
                                ...routine,
                                enabled: !routine.enabled,
                              }))
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
                          </button>}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Quick Launch into Omnibot Hub */}
              <div className="space-y-2">
                <span className="px-1.5 text-[13.5px] font-normal text-[#8e8d8a] block">
                  Omnibot Hub
                </span>
                <div className="liquid-glass-card rounded-2xl overflow-hidden">
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

          {activeTab === "git" && chat.workspacePath && (
            <div className="space-y-5">
              {/* Project Switcher & Bot Assignment Card */}
              <div className="liquid-glass-card rounded-2xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-[#8e8d8a]">
                    Active Project
                  </span>
                  <button
                    type="button"
                    onClick={() => onOpenOmniHub("projects")}
                    className="text-xs text-cyan-300 hover:text-white"
                  >
                    Configure Projects
                  </button>
                </div>
                <div className="space-y-2"><p className="text-sm text-zinc-200">{activeProjectName}</p><p className="text-xs text-zinc-500 break-all">{chat.workspacePath}</p><button className="text-xs text-zinc-300 hover:text-white" onClick={onChooseProject}>Open another project chat</button></div>

                {/* Quick Bot Assignment for Active Project */}
                {(() => {
                  const activeProj = projects.find(
                    (p) => p.path === chat.workspacePath
                  );
                  if (!activeProj || !onUpsertProject) return null;
                  const assignedIds = activeProj.assignedBotIds ?? [];
                  return (
                    <div className="pt-2 space-y-2">
                      <div className="flex items-center justify-between text-[11.5px] text-[#8e8d8a]">
                        <span>
                          Bots on {activeProj.name}{" "}
                          {assignedIds.length === 0
                            ? "(All)"
                            : `(${assignedIds.length})`}
                        </span>
                        {assignedIds.length > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              act("Couldn’t update project bots", () => onUpsertProject({
                                ...activeProj,
                                assignedBotIds: [],
                              }))
                            }
                            className="text-[11px] text-cyan-300 hover:text-white"
                          >
                            Enable all
                          </button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {bots.map((b) => {
                          const enabled =
                            assignedIds.length === 0 ||
                            assignedIds.includes(b.id);
                          return (
                            <button
                              key={b.id}
                              type="button"
                              onClick={() => {
                                const nextIds =
                                  assignedIds.length === 0
                                    ? bots
                                        .filter((x) => x.id !== b.id)
                                        .map((x) => x.id)
                                    : assignedIds.includes(b.id)
                                      ? assignedIds.filter((id) => id !== b.id)
                                      : [...assignedIds, b.id];
                                act("Couldn’t update project bots", () => onUpsertProject({
                                  ...activeProj,
                                  assignedBotIds: nextIds,
                                }));
                              }}
                              className={`px-2 py-1 rounded-full text-[11px] flex items-center gap-1.5 transition-colors ${
                                enabled
                                  ? "bg-white/[0.1] text-white border border-white/15"
                                  : "bg-[#17171a] text-zinc-500 border border-white/[0.04]"
                              }`}
                            >
                              <BotCharacterAvatar bot={b} size={15} />
                              <span>{b.name}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
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
                    <div className="text-xs text-[#8e8d8a]  truncate">
                      {gitStatus.rootPath}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => act("Couldn’t refresh Git status", onRescan)}
                    title="Refresh Git status"
                    aria-label="Refresh Git status"
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
                        if (e.key === "Enter") void handleCommitAll();
                      }}
                      aria-label="Commit message"
                      placeholder="Commit message..."
                      className="min-w-0 flex-1 rounded-xl bg-[#1f1f1f] border border-white/[0.07] px-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={committing || !commitMessage.trim()}
                      onClick={() => void handleCommitAll()}
                      className="px-3 py-1.5 rounded-xl bg-white hover:bg-zinc-200 disabled:opacity-40 text-black text-xs font-semibold flex items-center gap-1.5 shrink-0"
                    >
                      <GitCommitHorizontal className="w-3.5 h-3.5" />
                      <span>{committing ? "..." : "Commit"}</span>
                    </button>
                  </div>
                )}

                {gitError && <p role="alert" className="text-xs text-red-300 break-words">{gitError}</p>}

                {gitStatus.diffStat && (
                  <pre className="font-mono text-[11px]  text-zinc-400 bg-black/40 rounded-xl p-2.5 overflow-x-auto">
                    {gitStatus.diffStat}
                  </pre>
                )}
              </div>

              <div className="space-y-2">
                <span className="px-1.5 text-[13.5px] font-normal text-[#8e8d8a] block">
                  Changed Files ({gitStatus.changedFiles.length})
                </span>
                <div className="liquid-glass-card rounded-2xl overflow-hidden">
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
                              onClick={() => void handleLoadFileDiff(f.path)}
                              className="flex items-center gap-2.5 min-w-0 flex-1 text-left"
                            >
                              <FileCode2 className="w-4 h-4 text-cyan-400 shrink-0" />
                              <span className="text-[13px]  text-zinc-100 truncate">
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
                                onClick={() => void handleDiscardFile(f.path)}
                                title="Discard changes in this file"
                                aria-label={`Discard changes to ${f.path}`}
                                className="p-1 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-white/[0.06]"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                          {expanded && (
                            <pre className="font-mono px-3.5 py-2.5 bg-black/60 text-[11px]  text-zinc-300 overflow-x-auto max-h-60">
                              {selectedDiffContent}
                            </pre>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {!!chat.tasks?.some(t => t.workspacePath) && <label className="block text-xs text-zinc-400 p-3">Review working folder
                <select aria-label="Git working folder" className="block w-full bg-zinc-900 p-2 mt-2 rounded" value={gitTaskId ?? ""} onChange={e => onSelectGitTask(e.target.value || undefined)}>
                  <option value="">Project checkout · {chat.workspacePath}</option>
                  {chat.tasks.filter((task, index, tasks) => task.workspacePath && tasks.findIndex(other => other.workspacePath === task.workspacePath) === index).map(task => <option key={task.id} value={task.id}>{bots.find(b => b.id === task.botId)?.name ?? task.botId} · {task.workspacePath}</option>)}
                </select>
              </label>}
              {gitStatus.worktrees.length > 0 && (
                <div className="space-y-2">
                  <span className="px-1.5 text-[13.5px] font-normal text-[#8e8d8a] block">
                    Git Worktrees ({gitStatus.worktrees.length})
                  </span>
                  <div className="liquid-glass-card rounded-2xl overflow-hidden">
                    {gitStatus.worktrees.map((wt) => (
                      <div key={wt.path} className="px-3.5 py-2.5 space-y-0.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className=" font-semibold text-[#8cf1fb]">
                            {wt.branch}
                          </span>
                          <span className=" text-zinc-500">{wt.head}</span>
                        </div>
                        <div className="text-[11.5px]  text-zinc-400 truncate">
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
                    onClick={() => openItem(".", false)}
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
                      className="min-w-0 flex-1 rounded-xl bg-[#1f1f1f] border border-white/[0.07] px-3 py-2 text-[12.5px] text-zinc-100  focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => act("Couldn’t set the project directory", async () => {
                        await onUpdatePreferences({
                          ...preferences,
                          workspaceRoot: workspaceInput.trim(),
                        });
                        await loadComputerData();
                      })}
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
                    onClick={() => void loadComputerData()}
                    aria-label="Refresh project files"
                    className="w-7 h-7 rounded-full bg-[#1f1f1f] hover:bg-[#272727] border border-white/[0.06] flex items-center justify-center text-zinc-300 hover:text-white"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="liquid-glass-card rounded-2xl max-h-56 overflow-y-auto ">
                  {localFiles.slice(0, 30).map((f) => (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => openItem(f.path, true)}
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
                <div className="liquid-glass-card rounded-2xl overflow-hidden">
                  {computerActivity.length === 0 ? (
                    <div className="p-4 text-[13px] text-[#8e8d8a]">
                      No CLI subprocess runs recorded yet in this session.
                    </div>
                  ) : (
                    computerActivity.slice(0, 12).map((act) => (
                      <div key={act.id} className="px-3.5 py-2.5 space-y-0.5">
                        <div className="flex items-center justify-between text-[12.5px]">
                          <span className=" text-[#f4f4f5] truncate">
                            {act.toolName}
                          </span>
                          <span className="text-[11.5px] text-[#8e8d8a] flex items-center gap-1 shrink-0">
                            <Clock className="w-3 h-3" />
                            {(act.durationMs / 1000).toFixed(1)}s
                          </span>
                        </div>
                        <p className="text-[12px] text-[#8e8d8a] truncate" title={act.summary}>
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
      {confirmElement}
    </aside>
  );
}
