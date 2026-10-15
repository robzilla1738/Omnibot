import { listen } from "@tauri-apps/api/event";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  type EventChannelStatus,
  getChatGitStatus,
  isTauriRuntime,
  runOmniRoutine,
  clearOmniChat,
  retryOmniStorage,
  resetOmniSessions,
  completeOmniSetup,
  pinOmniBot,
  commitGitChanges,
  createOmniChat,
  deleteOmniBot,
  deleteOmniChat,
  deleteOmniRoutine,
  deleteOmniWorkspace,
  discardGitFile,
  getOmniSnapshot,
  rescanOmniEnvironment,
  saveOmniPreferences,
  sendOmniMessage,
  stopOmniChat,
  subscribeOmniEvents,
  updateOmniChat,
  upsertOmniBot,
  upsertOmniRoutine,
  upsertOmniWorkspace,
} from "../../lib/omni-bridge";
import type {
  BotProfile,
  OmniPreferences,
  OmniSnapshot,
  RoutineEntry,
  WorkspaceEntry,
} from "../../lib/types";
import { uniqueBotName } from "../../lib/bots";
import { hasPrimaryModifier, isEditableTarget, isModalOpen } from "../../lib/keyboard";
import { shareSnapshot } from "../../lib/snapshot";
import { ChatWorkspace } from "../chat/ChatWorkspace";
import {
  InspectorDrawer,
  type InspectorTab,
} from "../inspector/InspectorDrawer";
import type { OmniHubSection } from "../modals/OmniHubModal";
import { SearchAndNewChatModal } from "../modals/SearchAndNewChatModal";
import { AppSidebar } from "../sidebar/AppSidebar";
import { useNotices } from "../ui/Notices";

const TerminalPanel = lazy(() => import("../terminal/TerminalPanel").then(module => ({ default: module.TerminalPanel })));
const OmniHubModal = lazy(() => import("../modals/OmniHubModal").then(module => ({ default: module.OmniHubModal })));
const CliHarnessesModal = lazy(() => import("../modals/CliHarnessesModal").then(module => ({ default: module.CliHarnessesModal })));
const SetupWorkspace = lazy(() => import("../setup/SetupWorkspace").then(module => ({ default: module.SetupWorkspace })));

/** True from the first time `value` is true; lets lazily loaded panels mount on demand and then stay mounted. */
function useLatch(value: boolean): boolean {
  const [latched, setLatched] = useState(value);
  if (value && !latched) setLatched(true);
  return latched || value;
}

const EVENT_REFRESH_INTERVAL_MS = 300;
const FALLBACK_POLL_MS = 3000;
const RECONNECTING_NOTICE_DELAY_MS = 2000;

function SetupFallback() {
  return <div className="flex-1 flex items-center justify-center text-xs text-zinc-500">Loading setup…</div>;
}

export function DesktopShell({
  initialSnapshot,
}: {
  initialSnapshot: OmniSnapshot;
}) {
  const { runAction, notifyError } = useNotices();
  const [snapshot, replaceSnapshot] = useState<OmniSnapshot>(initialSnapshot);
  const setSnapshot = useCallback((next: OmniSnapshot) => {
    replaceSnapshot(current => next.instanceId === current.instanceId && next.revision < current.revision ? current : shareSnapshot(current, next));
  }, []);
  const availableBots = useMemo(() => snapshot.bots.filter(bot => !bot.archived), [snapshot.bots]);
  const [activeChatId, setActiveChatId] = useState<string>(() => {
    const primary = initialSnapshot.chats.find((c) => c.isPrimary);
    return primary?.id ?? initialSnapshot.chats[0]?.id ?? "chat-omni-primary";
  });

  const [setupPreview, setSetupPreview] = useState<BotProfile | null>(null);
  const [setupOpen, setSetupOpen] = useState(!initialSnapshot.preferences.onboardingCompleted);
  const setupActive = setupOpen || !snapshot.preferences.onboardingCompleted;
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const unlisten = listen<string>("app-update-error", event => notifyError(event.payload));
    return () => { void unlisten.then(stop => stop()); };
  }, [notifyError]);


  // Panels & Modals
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalMounted, setTerminalMounted] = useState(false);
  const toggleTerminal = useCallback(() => { setTerminalMounted(true); setTerminalOpen(value => !value); setInspectorOpen(false); }, []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectedBotId, setInspectedBotId] = useState<string | null>(null);
  useEffect(() => { setInspectedBotId(null); setInspectorTab("details"); }, [activeChatId]);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("details");
  const [openStudioSignal, setOpenStudioSignal] = useState(0);
  const [cliHarnessesOpen, setCliHarnessesOpen] = useState(false);
  const [omniHubState, setOmniHubState] = useState<{
    open: boolean;
    section: OmniHubSection;
  }>({ open: false, section: "bots" });
  const [commandModal, setCommandModal] = useState<{
    open: boolean;
    mode: "search" | "new-chat" | "new-group";
    projectRequired?: boolean;
    prompt?: string;
    participantBotIds?: string[];
  }>({ open: false, mode: "search" });

  const [projectDraft, setProjectDraft] = useState<{ chatId: string; text: string } | null>(null);
  const [channelStatus, setChannelStatus] = useState<EventChannelStatus>("connecting");
  const [showReconnecting, setShowReconnecting] = useState(false);
  useEffect(() => {
    if (channelStatus !== "disconnected") { setShowReconnecting(false); return; }
    const timer = setTimeout(() => setShowReconnecting(true), RECONNECTING_NOTICE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [channelStatus]);

  // Reconcile authoritative snapshots in one queue. Mixing snapshots with deltas
  // duplicates or loses text when an HTTP response races a streaming event.
  // Event bursts are throttled with a trailing refresh so the final state is always fetched.
  useEffect(() => {
    let disposed = false;
    let fetching = false;
    let dirty = false;
    let lastFetchAt = 0;
    let status: EventChannelStatus = "connecting";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      timer = undefined;
      if (disposed || fetching) return;
      fetching = true;
      dirty = false;
      lastFetchAt = Date.now();
      try {
        const next = await getOmniSnapshot();
        if (!disposed) setSnapshot(next);
      } catch { /* Keep the last snapshot; the next event or poll retries. */ }
      finally {
        fetching = false;
        if (dirty && !disposed) schedule();
      }
    };
    const schedule = () => {
      dirty = true;
      if (fetching || timer || disposed) return;
      timer = setTimeout(refresh, Math.max(0, lastFetchAt + EVENT_REFRESH_INTERVAL_MS - Date.now()));
    };
    const unsubscribe = subscribeOmniEvents(schedule, next => {
      status = next;
      if (!disposed) setChannelStatus(next);
    });
    // Events drive refreshes while the channel is up; polling only covers outages.
    const poll = setInterval(() => { if (status !== "connected") schedule(); }, FALLBACK_POLL_MS);
    schedule();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearInterval(poll);
      unsubscribe();
    };
  }, [setSnapshot]);

  // Install shortcuts before paint so the first interaction cannot beat listener registration.
  useLayoutEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (setupActive || !hasPrimaryModifier(e) || e.altKey) return;
      const key = e.key.toLowerCase();
      const modalOpen = isModalOpen();
      const editing = isEditableTarget(e.target);
      if (e.code === "Backquote" || key === "`") {
        e.preventDefault(); toggleTerminal();
      } else if (key === "k") {
        // Ctrl+K is a line-editing key in shells; only Cmd+K is safe to claim inside the terminal.
        if (e.ctrlKey && e.target instanceof Element && e.target.closest(".xterm")) return;
        e.preventDefault();
        setCommandModal({ open: true, mode: "search" });
      } else if (modalOpen) {
        return;
      } else if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        setCommandModal({ open: true, mode: "new-chat" });
      } else if (key === "i" && !editing) {
        e.preventDefault();
        setInspectorOpen((v) => {
          const next = !v;
          setSidebarCollapsed(next);
          return next;
        });
      } else if (key === "b" && !editing) {
        e.preventDefault();
        setSidebarCollapsed((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setupActive, toggleTerminal]);

  const primaryBot = useMemo(
    () =>
      snapshot.bots.find((b) => b.isPrimary) ??
      snapshot.bots[0] ?? {
        id: "bot-omni",
        name: "Omnibot",
        slug: "omnibot",
        roleTitle: "Lead Coordinator",
        description: "",
        avatarImage: "/omnibot-gauntlet.png",
        shape: "blob",
        color: "cyan",
        isPrimary: true,
        cliDriver: "claude",
        reasoningEffort: "high",
        permissionMode: "auto",
        systemPrompt: "",
        memories: [],
        autoCreatedForCli: false,
        archived: false,
      } satisfies BotProfile,
    [snapshot.bots]
  );

  const activeChat = useMemo(
    () =>
      snapshot.chats.find((c) => c.id === activeChatId) ??
      snapshot.chats.find((c) => c.isPrimary) ??
      snapshot.chats[0],
    [snapshot.chats, activeChatId]
  );

  const [scopedGit, setScopedGit] = useState<{ chatId: string; path: string; taskId?: string; status: OmniSnapshot["gitStatus"] } | null>(null);
  const [gitTaskId, setGitTaskId] = useState<string | undefined>();
  useEffect(() => { setGitTaskId(undefined); }, [activeChatId]);
  const [gitRevision, setGitRevision] = useState(0);
  useEffect(() => {
    if (!inspectorOpen || !activeChat?.workspacePath) return;
    let disposed = false;
    const refresh = async () => { try { const status = await getChatGitStatus(activeChat.id, gitTaskId); if (!disposed) setScopedGit({ chatId: activeChat.id, path: activeChat.workspacePath!, taskId: gitTaskId, status }); } catch { /* Keep the last status until the next refresh. */ } };
    void refresh(); const timer = setInterval(refresh, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [activeChat?.id, activeChat?.workspacePath, inspectorOpen, gitRevision, gitTaskId]);
  const chatGit = scopedGit?.chatId === activeChat?.id && scopedGit?.path === activeChat?.workspacePath && scopedGit?.taskId === gitTaskId ? scopedGit.status : { isRepo: false, rootPath: activeChat?.workspacePath ?? "", branch: "", headShort: "", ahead: 0, behind: 0, changedFiles: [], diffStat: "", diffPreview: "", worktrees: [] };

  const activeBot = useMemo(() => {
    const project = snapshot.workspaces.find((p) => p.path === activeChat?.workspacePath);
    const firstId = activeChat?.ownerBotId ?? (activeChat?.isPrimary ? project?.leadBotId : undefined) ?? activeChat?.participantBotIds[0];
    return snapshot.bots.find((b) => b.id === firstId) ?? primaryBot;
  }, [activeChat, snapshot.bots, snapshot.workspaces, primaryBot]);

  const handleSelectPrimary = useCallback(() => {
    const primaryChat = snapshot.chats.find((c) => c.isPrimary);
    if (primaryChat) {
      setActiveChatId(primaryChat.id);
    }
  }, [snapshot.chats]);

  const handleSelectBotDirectChat = useCallback(
    (bot: BotProfile) => runAction(`Couldn’t open ${bot.name}`, async () => {
      if (bot.isPrimary) {
        handleSelectPrimary();
        return;
      }
      const existing = snapshot.chats.find(
        (c) =>
          c.isBotHome &&
          !c.isPrimary &&
          (c.ownerBotId ?? c.participantBotIds[0]) === bot.id
      );
      if (existing) {
        setActiveChatId(existing.id);
        return;
      }
      const { chat, snapshot: nextSnap } = await createOmniChat({
        botHome: true,
        title: bot.name,
        subtitle: `${bot.roleTitle} · ${bot.cliDriver}`,
        participantBotIds: [bot.id],
      });
      setSnapshot(nextSnap);
      setActiveChatId(chat.id);
    }),
    [snapshot.chats, handleSelectPrimary, runAction, setSnapshot]
  );

  const handleCreateSwarmOrChat = useCallback(
    async (params: {
      title?: string;
      participantBotIds: string[];
      modelOverrides?: Record<string, string | null>;
      useWorktrees?: boolean;
      workspacePath?: string;
      initialPrompt?: string;
      draftPrompt?: string;
      skillSlug?: string;
    }) => {
      const { chat, snapshot: nextSnap } = await createOmniChat({
        title: params.title,
        participantBotIds: params.participantBotIds,
        modelOverrides: params.modelOverrides,
        useWorktrees: params.useWorktrees,
        workspacePath: params.workspacePath,
      });
      setSnapshot(nextSnap);
      setActiveChatId(chat.id);
      if (params.draftPrompt) setProjectDraft({ chatId: chat.id, text: params.draftPrompt });

      if (params.initialPrompt) {
        await sendOmniMessage({
          chatId: chat.id,
          text: params.initialPrompt,
          skillSlug: params.skillSlug,
        });
      }
    },
    [setSnapshot]
  );

  const startSkillChat = (skill: { name: string; slug: string }, initialPrompt?: string) =>
    void runAction(`Couldn’t start ${skill.name}`, () => handleCreateSwarmOrChat({
      title: skill.name,
      participantBotIds: [activeBot.id],
      skillSlug: skill.slug,
      initialPrompt,
    }));

  const handleDeleteChat = useCallback(
    async (chatId: string) => {
      const next = await deleteOmniChat(chatId);
      setSnapshot(next);
      setActiveChatId(current => {
        if (current !== chatId) return current;
        return next.chats.find((c) => c.isPrimary)?.id ?? current;
      });
    },
    [setSnapshot]
  );

  const handleToggleBotInChat = useCallback(
    async (botId: string) => {
      if (!activeChat) return;
      const current = activeChat.participantBotIds;
      const exists = current.includes(botId);
      const nextIds = exists
        ? current.length > 1
          ? current.filter((id) => id !== botId)
          : current
        : [...current, botId];
      const nextSnap = await updateOmniChat({
        chatId: activeChat.id,
        participantBotIds: nextIds,
      });
      setSnapshot(nextSnap);
    },
    [activeChat, setSnapshot]
  );

  const handleSelectProject = useCallback(
    async (path: string) => {
      const existing = snapshot.chats.filter(c => !c.isPrimary && c.workspacePath === path).sort((a,b) => b.updatedAtMs-a.updatedAtMs)[0];
      if (existing) { setActiveChatId(existing.id); return; }
      await handleCreateSwarmOrChat({ participantBotIds: [primaryBot.id], workspacePath: path });
    },
    [snapshot.chats, primaryBot.id, handleCreateSwarmOrChat]
  );

  const handleTogglePin = async (bot: BotProfile) => {
    const pinned = snapshot.preferences.pinnedBotIds.includes(bot.id);
    await runAction(pinned ? `Couldn’t unpin ${bot.name}` : `Couldn’t pin ${bot.name}`, async () => {
      setSnapshot(await pinOmniBot(bot.id, !pinned));
    });
  };
  const openLibrary = () => { if (!setupActive) setOmniHubState({ open: true, section: "bots" }); };
  const openSetup = () => { setOmniHubState(prev => ({ ...prev, open: false })); setInspectorOpen(false); setSetupOpen(true); handleSelectPrimary(); };

  const handleRunRoutine = async (routine: RoutineEntry) => {
    if (!activeChat) return;
    await runOmniRoutine(routine.id, activeChat.id);
    setActiveChatId(routine.chatId ?? activeChat.id);
    try { setSnapshot(await getOmniSnapshot()); } catch { /* The event channel or poll picks the run up. */ }
  };

  const applySnapshot = async (request: Promise<OmniSnapshot>) => { setSnapshot(await request); };
  const hubMounted = useLatch(omniHubState.open);
  const harnessesMounted = useLatch(cliHarnessesOpen);

  if (!activeChat) return null;

  return (
    <div className="h-screen w-screen bg-[#121212] text-[#f4f4f5] flex overflow-hidden">
      {/* Left Sidebar */}
      <AppSidebar
        workspaces={setupActive ? [] : snapshot.workspaces}
        onSelectProject={handleSelectProject}
        onUpsertProject={project => applySnapshot(upsertOmniWorkspace(project))}
        onNewProject={() => setOmniHubState({ open: true, section: "projects" })}
        collapsed={sidebarCollapsed}
        setupMode={setupActive}
        terminalOpen={terminalOpen}
        onToggleTerminal={toggleTerminal}
        onCollapsedChange={setSidebarCollapsed}
        primaryBot={setupActive ? setupPreview ?? primaryBot : primaryBot}
        bots={availableBots}
        harnesses={snapshot.harnesses}
        chats={setupActive ? snapshot.chats.filter(c => c.isPrimary) : snapshot.chats}
        pinnedBotIds={setupActive ? [] : snapshot.preferences.pinnedBotIds}
        onTogglePin={handleTogglePin}
        onOpenSetup={openSetup}
        activeChatId={activeChat.id}
        activeRuns={snapshot.activeRuns}
        onSelectPrimary={handleSelectPrimary}
        onSelectBotDirectChat={handleSelectBotDirectChat}
        onSelectChat={setActiveChatId}
        onNewChatOrSwarm={() =>
          !setupActive && setCommandModal({ open: true, mode: "new-chat" })
        }
        onNewBot={openLibrary}
        onOpenSearch={() => { if (!setupActive) setCommandModal({ open: true, mode: "search" }); }}
        onDeleteChat={handleDeleteChat}
        onUpdateChat={params => applySnapshot(updateOmniChat(params))}
        onUpsertBot={bot => applySnapshot(upsertOmniBot(bot))}
        onDeleteBot={async (botId) => {
          const next = await deleteOmniBot(botId);
          setSnapshot(next);
          if (activeChat.participantBotIds.includes(botId)) {
            const primary = next.chats.find((c) => c.isPrimary);
            if (primary) setActiveChatId(primary.id);
          }
        }}
        onCustomizeBot={async (bot) => {
          await handleSelectBotDirectChat(bot);
          setInspectorTab("details");
          setInspectorOpen(true);
          setOpenStudioSignal((n) => n + 1);
        }}
      />

      {snapshot.storageError && <div role="alert" className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] rounded-xl bg-red-950 p-3 text-sm text-red-200">Changes are not saved: {snapshot.storageError}. Keep the app open. <button className="underline" onClick={() => void runAction("Retry save failed", () => applySnapshot(retryOmniStorage()))}>Retry save</button></div>}
      {showReconnecting && <div aria-live="polite" className="fixed top-3 right-4 z-[90] pointer-events-none rounded-full bg-[#1f1f1f] border border-white/[0.08] px-3 py-1.5 text-xs text-zinc-300 shadow-lg">Reconnecting…</div>}
      <div className="relative flex flex-1 min-w-0 h-full">
      {setupActive ? <Suspense fallback={<SetupFallback />}><SetupWorkspace
        snapshot={snapshot}
        primaryBot={primaryBot}
        onPreviewChange={setSetupPreview}
        onRescan={() => applySnapshot(rescanOmniEnvironment())}
        onComplete={async input => {
          const next = await completeOmniSetup(input);
          setSnapshot(next);
          setSetupOpen(false);
          const primary = next.chats.find(c => c.isPrimary);
          if (primary) setActiveChatId(primary.id);
        }}
        onCancel={snapshot.preferences.onboardingCompleted ? () => setSetupOpen(false) : undefined}
      /></Suspense> : <ChatWorkspace
        key={activeChat.id}
        chat={activeChat}
        initialDraft={projectDraft?.chatId === activeChat.id ? projectDraft.text : undefined}
        summarizeTeamResults={snapshot.preferences.summarizeTeamResults}
        onChooseProject={(prompt) => setCommandModal({ open: true, mode: activeChat.isGroup ? "new-group" : "new-chat", projectRequired: true, prompt, participantBotIds: activeChat.participantBotIds })}
        onManageTeam={openLibrary}
        onOpenMemory={() => setOmniHubState({ open: true, section: "memories" })}
        defaultSpeakerId={activeBot.id}
        workflowActive={snapshot.activeWorkflowChatIds.includes(activeChat.id)}
        terminalControlActive={activeChat.tasks.some(task => task.mode === "interactive" && ["queued", "running"].includes(task.status))}
        onOpenTerminal={() => { setTerminalMounted(true); setTerminalOpen(true); setInspectorOpen(false); }}
        bots={snapshot.bots}
        harnesses={snapshot.harnesses}
        skills={snapshot.skills}
        activeRuns={snapshot.activeRuns}
        inspectorOpen={inspectorOpen}
        onOpenBotSettings={bot => {
          setInspectedBotId(bot.id);
          setInspectorTab("details");
          setInspectorOpen(true);
          setOpenStudioSignal(n => n + 1);
        }}
        onToggleInspector={() => {
          setInspectedBotId(null);
          setTerminalOpen(false);
          setInspectorOpen((v) => {
            const next = !v;
            setSidebarCollapsed(next);
            return next;
          });
        }}
        onSendMessage={async (params) => {
          await sendOmniMessage({
            chatId: activeChat.id,
            ...params,
          });
          setProjectDraft(null);
          try { setSnapshot(await getOmniSnapshot()); } catch { /* The event channel or poll picks the send up. */ }
        }}
        onStopChat={() => applySnapshot(stopOmniChat(activeChat.id))}
      />}

      {terminalMounted && !setupActive && <Suspense fallback={null}><TerminalPanel open={terminalOpen} chat={activeChat} bots={snapshot.bots} workflowActive={snapshot.activeWorkflowChatIds.includes(activeChat.id)} onClose={() => setTerminalOpen(false)} /></Suspense>}
      </div>

      {/* Right-Hand Inspector Drawer (Opened by Clicking Bot Name Pill or Cmd+I) */}
      <InspectorDrawer
        open={!setupActive && inspectorOpen}
        activeTab={inspectorTab}
        onSelectTab={setInspectorTab}
        onClose={() => {
          setInspectorOpen(false);
          setSidebarCollapsed(false);
        }}
        chat={activeChat}
        onChooseProject={() => setCommandModal({ open: true, mode: "new-chat", projectRequired: true })}
        activeBot={snapshot.bots.find(bot => bot.id === inspectedBotId) ?? activeBot}
        bots={availableBots}
        harnesses={snapshot.harnesses}
        projects={snapshot.workspaces}
        routines={snapshot.routines}
        onResetSessions={() => applySnapshot(resetOmniSessions(activeChat.id))}
        gitTaskId={gitTaskId}
        onSelectGitTask={setGitTaskId}
        gitStatus={chatGit}
        preferences={snapshot.preferences}
        computerActivity={snapshot.computerActivity}
        onUpdateChat={params => applySnapshot(updateOmniChat(params))}
        onClearChat={chatId => applySnapshot(clearOmniChat(chatId))}
        onToggleBotInChat={handleToggleBotInChat}
        onUpsertBot={bot => applySnapshot(upsertOmniBot(bot))}
        onDeleteBot={async (botId) => {
          const next = await deleteOmniBot(botId);
          setSnapshot(next);
          const primary = next.chats.find((c) => c.isPrimary);
          if (primary) setActiveChatId(primary.id);
        }}
        onUpsertProject={(ws: WorkspaceEntry) => applySnapshot(upsertOmniWorkspace(ws))}
        openStudioSignal={openStudioSignal}
        onUpdatePreferences={(prefs: OmniPreferences) => applySnapshot(saveOmniPreferences(prefs))}
        onUpsertRoutine={(routine: RoutineEntry) => applySnapshot(upsertOmniRoutine(routine))}
        onRunRoutineNow={handleRunRoutine}

        onCommitGit={async (message: string) => {
          try { await applySnapshot(commitGitChanges(message, activeChat.id, gitTaskId)); }
          finally { setGitRevision(n => n + 1); }
        }}
        onDiscardGitFile={async (filePath: string) => {
          try { await applySnapshot(discardGitFile(filePath, activeChat.id, gitTaskId)); }
          finally { setGitRevision(n => n + 1); }
        }}
        onRescan={() => applySnapshot(rescanOmniEnvironment())}
        onOpenOmniHub={(section = "bots") =>
          setOmniHubState({ open: true, section })
        }
      />

      {/* Local CLI Harnesses, Bot Templates & MCPs Modal */}
      {harnessesMounted && <Suspense fallback={null}><CliHarnessesModal
        open={cliHarnessesOpen}
        onClose={() => setCliHarnessesOpen(false)}
        harnesses={snapshot.harnesses}
        bots={availableBots}
        skills={snapshot.skills}
        mcpServers={snapshot.mcpServers}
        onRescan={() => applySnapshot(rescanOmniEnvironment())}
        onSelectBotDirectChat={handleSelectBotDirectChat}
        onCreateBotFromTemplate={tpl => applySnapshot(upsertOmniBot({
          id: "",
          name: uniqueBotName(tpl.name, snapshot.bots),
          slug: "",
          roleTitle: tpl.roleTitle,
          description: tpl.description,
          shape: tpl.shape,
          color: tpl.color,
          isPrimary: false,
          archived: false,
          cliDriver: tpl.cliDriver,
          model: null,
          reasoningEffort: "high",
          permissionMode: "auto",
          systemPrompt: tpl.systemPrompt,
          memories: [],
          autoCreatedForCli: false,
        }))}
        onStartChatWithSkill={skill => startSkillChat(skill, `Run skill /${skill.slug} (${skill.name}) on this project.`)}
      /></Suspense>}

      {/* Omnibot Hub Modal */}
      {hubMounted && <Suspense fallback={null}><OmniHubModal
        open={omniHubState.open}
        initialSection={omniHubState.section}
        onOpenCliHarnesses={() => { setOmniHubState(prev => ({ ...prev, open: false })); setCliHarnessesOpen(true); }}
        onTogglePin={handleTogglePin}
        onOpenSetup={openSetup}
        onClose={() => setOmniHubState((prev) => ({ ...prev, open: false }))}
        bots={snapshot.bots}
        harnesses={snapshot.harnesses}
        skills={snapshot.skills}
        projects={snapshot.workspaces}
        routines={snapshot.routines}
        preferences={snapshot.preferences}
        onUpsertBot={bot => applySnapshot(upsertOmniBot(bot))}
        onDeleteBot={id => applySnapshot(deleteOmniBot(id))}
        onUpdatePreferences={prefs => applySnapshot(saveOmniPreferences(prefs))}
        onUpsertProject={(ws: WorkspaceEntry) => applySnapshot(upsertOmniWorkspace(ws))}
        onDeleteProject={id => applySnapshot(deleteOmniWorkspace(id))}
        onDeleteRoutine={id => applySnapshot(deleteOmniRoutine(id))}
        onRunRoutineNow={handleRunRoutine}
        onSelectBotDirectChat={handleSelectBotDirectChat}
        onStartSidechatWithSkill={skill => startSkillChat(skill)}
      /></Suspense>}

      {/* Search & New Group chat Modal */}
      <SearchAndNewChatModal
        open={commandModal.open}
        projectRequired={commandModal.projectRequired}
        initialParticipantBotIds={commandModal.participantBotIds}
        mode={commandModal.mode}
        harnesses={snapshot.harnesses}
        bots={availableBots}
        chats={snapshot.chats}
        skills={snapshot.skills}
        projects={snapshot.workspaces}
        onClose={() => setCommandModal((prev) => ({ ...prev, open: false }))}
        onSelectPrimary={handleSelectPrimary}
        onSelectBotDirectChat={handleSelectBotDirectChat}
        onSelectChat={setActiveChatId}
        onSelectProject={handleSelectProject}
        onCreateSwarmOrChat={params => handleCreateSwarmOrChat({ ...params, draftPrompt: commandModal.prompt })}
      />
    </div>
  );
}
