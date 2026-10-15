import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../../lib/omni-bridge";
import { getChatGitStatus } from "../../lib/omni-bridge";
import { runOmniRoutine } from "../../lib/omni-bridge";
import type React from "react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
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
  BotColor,
  BotProfile,
  BotShape,
  CliDriverKind,
  OmniPreferences,
  OmniSnapshot,
  RoutineEntry,
  WorkspaceEntry,
} from "../../lib/types";
import { ChatWorkspace } from "../chat/ChatWorkspace";
import {
  InspectorDrawer,
  type InspectorTab,
} from "../inspector/InspectorDrawer";
import { CliHarnessesModal } from "../modals/CliHarnessesModal";
import { OmniHubModal, type OmniHubSection } from "../modals/OmniHubModal";
import { SearchAndNewChatModal } from "../modals/SearchAndNewChatModal";
import { SetupWorkspace } from "../setup/SetupWorkspace";
import { AppSidebar } from "../sidebar/AppSidebar";

const TerminalPanel = lazy(() => import("../terminal/TerminalPanel").then(module => ({ default: module.TerminalPanel })));

export function DesktopShell({
  initialSnapshot,
}: {
  initialSnapshot: OmniSnapshot;
}) {
  const [snapshot, replaceSnapshot] = useState<OmniSnapshot>(initialSnapshot);
  const setSnapshot = useCallback((next: OmniSnapshot) => {
    replaceSnapshot(current => next.instanceId === current.instanceId && (next.revision ?? 0) < (current.revision ?? 0) ? current : next);
  }, []);
  const availableBots = useMemo(() => snapshot.bots.filter(bot => !bot.archived), [snapshot.bots]);
  const [activeChatId, setActiveChatId] = useState<string>(() => {
    const primary = initialSnapshot.chats.find((c) => c.isPrimary);
    return primary?.id ?? initialSnapshot.chats[0]?.id ?? "chat-omni-primary";
  });

  const [setupPreview, setSetupPreview] = useState<BotProfile | null>(null);
  const [setupOpen, setSetupOpen] = useState(!initialSnapshot.preferences.onboardingCompleted);
  const [actionError, setActionError] = useState("");
  const setupActive = setupOpen || !snapshot.preferences.onboardingCompleted;
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const unlisten = listen<string>("app-update-error", event => setActionError(event.payload));
    return () => { void unlisten.then(stop => stop()); };
  }, []);


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

  // Reconcile authoritative snapshots in one queue. Mixing snapshots with deltas
  // duplicates or loses text when an HTTP response races a streaming event.
  useEffect(() => {
    let disposed = false;
    let fetching = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      timer = undefined;
      if (disposed || fetching) return;
      fetching = true;
      dirty = false;
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
      if (!fetching && !timer && !disposed) timer = setTimeout(refresh, 150);
    };
    const unsubscribe = subscribeOmniEvents(schedule);
    const poll = setInterval(schedule, 3000);
    schedule();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearInterval(poll);
      unsubscribe();
    };
  }, []);

  // Install shortcuts before paint so the first interaction cannot beat listener registration.
  useLayoutEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (setupActive) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "`") {
        e.preventDefault(); toggleTerminal();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandModal({ open: true, mode: "search" });
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setCommandModal({ open: true, mode: "new-chat" });
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setInspectorOpen((v) => {
          const next = !v;
          setSidebarCollapsed(next);
          return next;
        });
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
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
      },
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
    async (bot: BotProfile) => {
      try {
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

      } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    },
    [snapshot.chats, handleSelectPrimary]
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
    []
  );

  const handleDeleteChat = useCallback(
    async (chatId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const next = await deleteOmniChat(chatId);
      setSnapshot(next);
      if (activeChatId === chatId) {
        const primary = next.chats.find((c) => c.isPrimary);
        if (primary) setActiveChatId(primary.id);
      }
    },
    [activeChatId]
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
    [activeChat]
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
    try {
      setSnapshot(await pinOmniBot(bot.id, !(snapshot.preferences.pinnedBotIds ?? []).includes(bot.id)));
      setActionError("");
    } catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
  };
  const openLibrary = () => { if (!setupActive) setOmniHubState({ open: true, section: "bots" }); };
  const openSetup = () => { setOmniHubState(prev => ({ ...prev, open: false })); setInspectorOpen(false); setSetupOpen(true); handleSelectPrimary(); };

  const handleRunRoutine = async (routine: RoutineEntry) => {
    if (!activeChat) return;
    try {
      await runOmniRoutine(routine.id, activeChat.id);
      setActiveChatId(routine.chatId ?? activeChat.id);
      setSnapshot(await getOmniSnapshot());
      setActionError("");
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
  };

  if (!activeChat) return null;

  return (
    <div className="h-screen w-screen bg-[#121212] text-[#f4f4f5] flex overflow-hidden">
      {/* Left Sidebar */}
      <AppSidebar
        workspaces={setupActive ? [] : snapshot.workspaces}
        onSelectProject={handleSelectProject}
        onUpsertProject={async project => { setSnapshot(await upsertOmniWorkspace(project)); }}
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
        pinnedBotIds={setupActive ? [] : snapshot.preferences.pinnedBotIds ?? []}
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
        onNewGroupChat={() => !setupActive && setCommandModal({ open: true, mode: "new-group" })}
        onNewBot={openLibrary}
        onOpenSearch={() => { if (!setupActive) setCommandModal({ open: true, mode: "search" }); }}
        onDeleteChat={handleDeleteChat}
        onUpdateChat={async (params) => {
          const next = await updateOmniChat(params);
          setSnapshot(next);
        }}
        onUpsertBot={async (bot) => {
          const next = await upsertOmniBot(bot);
          setSnapshot(next);
        }}
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

      {snapshot.storageError && <div role="alert" className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] rounded-xl bg-red-950 p-3 text-sm text-red-200">Changes are not saved: {snapshot.storageError}. Keep the app open. <button className="underline" onClick={() => void retryOmniStorage().then(setSnapshot).catch(error => setActionError(String(error)))}>Retry save</button></div>}
      {actionError && <div role="alert" className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[100] rounded-xl bg-red-950 border border-red-400/30 px-4 py-3 text-sm text-red-200">{actionError}<button className="ml-4 underline" onClick={() => setActionError("")}>Dismiss</button></div>}
      <div className="relative flex flex-1 min-w-0 h-full">
      {setupActive ? <SetupWorkspace
        snapshot={snapshot}
        primaryBot={primaryBot}
        onPreviewChange={setSetupPreview}
        onRescan={async () => { setSnapshot(await rescanOmniEnvironment()); }}
        onComplete={async input => {
          const next = await completeOmniSetup(input);
          setSnapshot(next);
          setSetupOpen(false);
          const primary = next.chats.find(c => c.isPrimary);
          if (primary) setActiveChatId(primary.id);
        }}
        onCancel={snapshot.preferences.onboardingCompleted ? () => setSetupOpen(false) : undefined}
      /> : <ChatWorkspace
        key={activeChat.id}
        chat={activeChat}
        initialDraft={projectDraft?.chatId === activeChat.id ? projectDraft.text : undefined}
        summarizeTeamResults={snapshot.preferences.summarizeTeamResults ?? false}
        onChooseProject={(prompt) => setCommandModal({ open: true, mode: activeChat.isGroup ? "new-group" : "new-chat", projectRequired: true, prompt, participantBotIds: activeChat.participantBotIds })}
        onManageTeam={openLibrary}
        onOpenMemory={() => setOmniHubState({ open: true, section: "memories" })}
        defaultSpeakerId={activeBot.id}
        workflowActive={snapshot.activeWorkflowChatIds.includes(activeChat.id)}
        terminalControlActive={activeChat.tasks?.some(task => task.mode === "interactive" && ["queued", "running"].includes(task.status))}
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
          const next = await getOmniSnapshot();
          setSnapshot(next);
        }}
        onStopChat={async () => {
          const next = await stopOmniChat(activeChat.id);
          setSnapshot(next);
        }}
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
        onResetSessions={async () => { try { setSnapshot(await resetOmniSessions(activeChat.id)); } catch (error) { setActionError(String(error)); } }}
        gitTaskId={gitTaskId}
        onSelectGitTask={setGitTaskId}
        gitStatus={chatGit}
        preferences={snapshot.preferences}
        computerActivity={snapshot.computerActivity}
        onUpdateChat={async (params) => {
          const next = await updateOmniChat(params);
          setSnapshot(next);
        }}
        onClearChat={async (chatId) => {
          const next = await clearOmniChat(chatId);
          setSnapshot(next);
        }}
        onToggleBotInChat={handleToggleBotInChat}
        onUpsertBot={async (bot) => {
          const next = await upsertOmniBot(bot);
          setSnapshot(next);
        }}
        onDeleteBot={async (botId) => {
          const next = await deleteOmniBot(botId);
          setSnapshot(next);
          const primary = next.chats.find((c) => c.isPrimary);
          if (primary) setActiveChatId(primary.id);
        }}
        onUpsertProject={async (ws: WorkspaceEntry) => {
          const next = await upsertOmniWorkspace(ws);
          setSnapshot(next);
        }}
        openStudioSignal={openStudioSignal}
        onUpdatePreferences={async (prefs: OmniPreferences) => {
          const next = await saveOmniPreferences(prefs);
          setSnapshot(next);
        }}
        onUpsertRoutine={async (routine: RoutineEntry) => {
          const next = await upsertOmniRoutine(routine);
          setSnapshot(next);
        }}
        onRunRoutineNow={handleRunRoutine}

        onCommitGit={async (message: string) => {
          const next = await commitGitChanges(message, activeChat.id, gitTaskId);
          setGitRevision(n => n + 1);
          setSnapshot(next);
        }}
        onDiscardGitFile={async (filePath: string) => {
          const next = await discardGitFile(filePath, activeChat.id, gitTaskId);
          setGitRevision(n => n + 1);
          setSnapshot(next);
        }}
        onRescan={async () => {
          const next = await rescanOmniEnvironment();
          setSnapshot(next);
        }}
        onOpenOmniHub={(section = "bots") =>
          setOmniHubState({ open: true, section })
        }
      />

      {/* Local CLI Harnesses, Bot Templates & MCPs Modal */}
      <CliHarnessesModal
        open={cliHarnessesOpen}
        onClose={() => setCliHarnessesOpen(false)}
        harnesses={snapshot.harnesses}
        bots={availableBots}
        skills={snapshot.skills}
        mcpServers={snapshot.mcpServers}
        onRescan={async () => {
          const next = await rescanOmniEnvironment();
          setSnapshot(next);
        }}
        onSelectBotDirectChat={handleSelectBotDirectChat}
        onCreateBotFromTemplate={async (tpl) => {
          const next = await upsertOmniBot({
            id: "",
            name: (() => { let name = tpl.name; let suffix = 2; while (snapshot.bots.some(bot => bot.name.toLowerCase() === name.toLowerCase() || bot.slug.toLowerCase() === name.toLowerCase())) name = `${tpl.name} ${suffix++}`; return name; })(),
            slug: "",
            roleTitle: tpl.roleTitle,
            description: tpl.description,
            shape: tpl.shape as BotShape,
            color: tpl.color as BotColor,
            isPrimary: false,
            cliDriver: tpl.cliDriver as CliDriverKind,
            model: null,
            reasoningEffort: "high",
            permissionMode: "auto",
            systemPrompt: tpl.systemPrompt,
            memories: [],
            autoCreatedForCli: false,
          });
          setSnapshot(next);
        }}
        onStartChatWithSkill={(skill) => {
          handleCreateSwarmOrChat({
            title: skill.name,
            participantBotIds: [activeBot.id],
            skillSlug: skill.slug,
            initialPrompt: `Run skill /${skill.slug} (${skill.name}) on this project.`,
          });
        }}
      />

      {/* Omnibot Hub Modal */}
      <OmniHubModal
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
        onUpsertBot={async (bot) => {
          const next = await upsertOmniBot(bot);
          setSnapshot(next);
        }}
        onDeleteBot={async (id) => {
          const next = await deleteOmniBot(id);
          setSnapshot(next);
        }}
        onUpdatePreferences={async (prefs) => {
          const next = await saveOmniPreferences(prefs);
          setSnapshot(next);
        }}
        onUpsertProject={async (ws: WorkspaceEntry) => {
          const next = await upsertOmniWorkspace(ws);
          setSnapshot(next);
        }}
        onDeleteProject={async (id) => {
          const next = await deleteOmniWorkspace(id);
          setSnapshot(next);
        }}
        onUpsertRoutine={async (routine) => {
          const next = await upsertOmniRoutine(routine);
          setSnapshot(next);
        }}
        onDeleteRoutine={async (id) => {
          const next = await deleteOmniRoutine(id);
          setSnapshot(next);
        }}
        onRunRoutineNow={handleRunRoutine}

        onSelectBotDirectChat={handleSelectBotDirectChat}
        onStartSidechatWithSkill={(skill) => {
          handleCreateSwarmOrChat({
            title: skill.name,
            participantBotIds: [activeBot.id],
            skillSlug: skill.slug,
          });
        }}
      />

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
