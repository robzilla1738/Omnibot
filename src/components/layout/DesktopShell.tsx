import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  clearOmniChat,
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
  OmniStreamEvent,
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
import { AppSidebar } from "../sidebar/AppSidebar";

export function DesktopShell({
  initialSnapshot,
}: {
  initialSnapshot: OmniSnapshot;
}) {
  const [snapshot, setSnapshot] = useState<OmniSnapshot>(initialSnapshot);
  const [activeChatId, setActiveChatId] = useState<string>(() => {
    const primary = initialSnapshot.chats.find((c) => c.isPrimary);
    return primary?.id ?? initialSnapshot.chats[0]?.id ?? "chat-omni-primary";
  });

  // Panels & Modals
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("details");
  const [cliHarnessesOpen, setCliHarnessesOpen] = useState(false);
  const [omniHubState, setOmniHubState] = useState<{
    open: boolean;
    section: OmniHubSection;
  }>({ open: false, section: "bots" });
  const [commandModal, setCommandModal] = useState<{
    open: boolean;
    mode: "search" | "new-swarm";
  }>({ open: false, mode: "search" });

  // Subscribe to real-time streaming events from Rust backend (Tauri IPC or SSE)
  useEffect(() => {
    const applyEvent = (ev: OmniStreamEvent) => {
      if (ev.type === "state-updated" || ev.type === "turn-finished") {
        getOmniSnapshot()
          .then((next) => setSnapshot(next))
          .catch(() => undefined);
      }

      setSnapshot((prev) => {
        if (ev.type === "turn-started") {
          const filtered = prev.activeRuns.filter(
            (r) => r.messageId !== ev.messageId
          );
          const speakingBot = prev.bots.find((b) => b.id === ev.botId);
          return {
            ...prev,
            activeRuns: [
              ...filtered,
              {
                chatId: ev.chatId,
                messageId: ev.messageId,
                botId: ev.botId,
                botName: ev.botName,
                cliDriver: ev.cliDriver,
                activity: "thinking",
                startedAtMs: Date.now(),
              },
            ],
            chats: prev.chats.map((c) => {
              if (c.id !== ev.chatId) return c;
              const hasMsg = c.messages.some((m) => m.id === ev.messageId);
              if (hasMsg) return c;
              return {
                ...c,
                messages: [
                  ...c.messages,
                  {
                    id: ev.messageId,
                    role: "assistant",
                    authorBotId: ev.botId,
                    authorName: ev.botName,
                    authorShape: speakingBot?.shape ?? "blob",
                    authorColor: speakingBot?.color ?? "cyan",
                    cliDriver: ev.cliDriver,
                    model: ev.model,
                    text: "",
                    thinking: "",
                    toolCalls: [],
                    handoffs: [],
                    mentionedBotIds: [],
                    status: "streaming",
                    createdAtMs: Date.now(),
                  },
                ],
              };
            }),
          };
        }

        if (ev.type === "text-delta" || ev.type === "thinking-delta") {
          return {
            ...prev,
            chats: prev.chats.map((c) => {
              if (c.id !== ev.chatId) return c;
              return {
                ...c,
                messages: c.messages.map((m) => {
                  if (m.id !== ev.messageId) return m;
                  return ev.type === "thinking-delta"
                    ? { ...m, thinking: m.thinking + ev.delta }
                    : { ...m, text: m.text + ev.delta };
                }),
              };
            }),
          };
        }

        if (ev.type === "tool-call") {
          return {
            ...prev,
            chats: prev.chats.map((c) => {
              if (c.id !== ev.chatId) return c;
              return {
                ...c,
                messages: c.messages.map((m) => {
                  if (m.id !== ev.messageId) return m;
                  const exists = m.toolCalls.some((t) => t.id === ev.tool.id);
                  return {
                    ...m,
                    toolCalls: exists
                      ? m.toolCalls.map((t) =>
                          t.id === ev.tool.id ? ev.tool : t
                        )
                      : [...m.toolCalls, ev.tool],
                  };
                }),
              };
            }),
          };
        }

        if (ev.type === "handoff") {
          return {
            ...prev,
            chats: prev.chats.map((c) => {
              if (c.id !== ev.chatId) return c;
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === ev.messageId
                    ? { ...m, handoffs: [...m.handoffs, ev.handoff] }
                    : m
                ),
              };
            }),
          };
        }

        if (ev.type === "turn-finished") {
          return {
            ...prev,
            activeRuns: prev.activeRuns.filter(
              (r) => r.messageId !== ev.messageId
            ),
            chats: prev.chats.map((c) => {
              if (c.id !== ev.chatId) return c;
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === ev.messageId
                    ? {
                        ...m,
                        status: ev.status,
                        durationMs: ev.durationMs,
                      }
                    : m
                ),
              };
            }),
          };
        }

        return prev;
      });
    };

    return subscribeOmniEvents(applyEvent);
  }, []);

  // Global keyboard shortcuts: Cmd+K (search), Cmd+N (new swarm), Cmd+I (inspector), Cmd+B (sidebar)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandModal({ open: true, mode: "search" });
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setCommandModal({ open: true, mode: "new-swarm" });
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
  }, []);

  const primaryBot = useMemo(
    () =>
      snapshot.bots.find((b) => b.isPrimary) ??
      snapshot.bots[0] ?? {
        id: "bot-omni",
        name: "Botfinity",
        slug: "botfinity",
        roleTitle: "Lead Swarm Coordinator",
        description: "",
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

  const activeBot = useMemo(() => {
    const firstId = activeChat?.participantBotIds[0];
    return snapshot.bots.find((b) => b.id === firstId) ?? primaryBot;
  }, [activeChat, snapshot.bots, primaryBot]);

  const handleSelectPrimary = useCallback(() => {
    const primaryChat = snapshot.chats.find((c) => c.isPrimary);
    if (primaryChat) {
      setActiveChatId(primaryChat.id);
    }
  }, [snapshot.chats]);

  const handleSelectBotDirectChat = useCallback(
    async (bot: BotProfile) => {
      if (bot.isPrimary) {
        handleSelectPrimary();
        return;
      }
      const existing = snapshot.chats.find(
        (c) =>
          !c.isGroup &&
          !c.isPrimary &&
          c.participantBotIds.length === 1 &&
          c.participantBotIds[0] === bot.id
      );
      if (existing) {
        setActiveChatId(existing.id);
        return;
      }
      const { chat, snapshot: nextSnap } = await createOmniChat({
        title: bot.name,
        subtitle: `${bot.roleTitle} · ${bot.cliDriver}`,
        participantBotIds: [bot.id],
      });
      setSnapshot(nextSnap);
      setActiveChatId(chat.id);
    },
    [snapshot.chats, handleSelectPrimary]
  );

  const handleCreateSwarmOrChat = useCallback(
    async (params: {
      title?: string;
      participantBotIds: string[];
      useWorktrees?: boolean;
      initialPrompt?: string;
      skillSlug?: string;
    }) => {
      const { chat, snapshot: nextSnap } = await createOmniChat({
        title: params.title,
        participantBotIds: params.participantBotIds,
        useWorktrees: params.useWorktrees,
      });
      setSnapshot(nextSnap);
      setActiveChatId(chat.id);

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
      const nextSnap = await saveOmniPreferences({
        ...snapshot.preferences,
        workspaceRoot: path,
      });
      setSnapshot(nextSnap);
    },
    [snapshot.preferences]
  );

  if (!activeChat) return null;

  return (
    <div className="h-screen w-screen bg-[#121212] text-[#f4f4f5] flex overflow-hidden">
      {/* Left Sidebar */}
      <AppSidebar
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
        primaryBot={primaryBot}
        bots={snapshot.bots}
        chats={snapshot.chats}
        activeChatId={activeChat.id}
        activeRuns={snapshot.activeRuns}
        harnesses={snapshot.harnesses}
        onSelectPrimary={handleSelectPrimary}
        onSelectBotDirectChat={handleSelectBotDirectChat}
        onSelectChat={setActiveChatId}
        onNewChatOrSwarm={() =>
          setCommandModal({ open: true, mode: "new-swarm" })
        }
        onNewBot={() => setOmniHubState({ open: true, section: "bots" })}
        onOpenSearch={() => setCommandModal({ open: true, mode: "search" })}
        onDeleteChat={handleDeleteChat}
        onOpenCliHarnesses={() => setCliHarnessesOpen(true)}
        onOpenOmniHub={() => setOmniHubState({ open: true, section: "bots" })}
      />

      {/* Center Multi-Bot Chat Workspace */}
      <ChatWorkspace
        key={activeChat.id}
        chat={activeChat}
        bots={snapshot.bots}
        harnesses={snapshot.harnesses}
        skills={snapshot.skills}
        activeRuns={snapshot.activeRuns}
        inspectorOpen={inspectorOpen}
        onToggleInspector={() =>
          setInspectorOpen((v) => {
            const next = !v;
            setSidebarCollapsed(next);
            return next;
          })
        }
        onSendMessage={async (params) => {
          await sendOmniMessage({
            chatId: activeChat.id,
            ...params,
          });
          const next = await getOmniSnapshot();
          setSnapshot(next);
        }}
        onStopChat={async () => {
          const next = await stopOmniChat(activeChat.id);
          setSnapshot(next);
        }}
      />

      {/* Right-Hand Inspector Drawer (Opened by Clicking Bot Name Pill or Cmd+I) */}
      <InspectorDrawer
        open={inspectorOpen}
        activeTab={inspectorTab}
        onSelectTab={setInspectorTab}
        onClose={() => {
          setInspectorOpen(false);
          setSidebarCollapsed(false);
        }}
        chat={activeChat}
        activeBot={activeBot}
        bots={snapshot.bots}
        harnesses={snapshot.harnesses}
        projects={snapshot.workspaces}
        routines={snapshot.routines}
        gitStatus={snapshot.gitStatus}
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
        onUpdatePreferences={async (prefs: OmniPreferences) => {
          const next = await saveOmniPreferences(prefs);
          setSnapshot(next);
        }}
        onUpsertRoutine={async (routine: RoutineEntry) => {
          const next = await upsertOmniRoutine(routine);
          setSnapshot(next);
        }}
        onRunRoutineNow={async (routine: RoutineEntry) => {
          await sendOmniMessage({
            chatId: activeChat.id,
            text: routine.prompt,
            overrideBotId: routine.botId,
          });
        }}
        onCommitGit={async (message: string) => {
          const next = await commitGitChanges(message);
          setSnapshot(next);
        }}
        onDiscardGitFile={async (filePath: string) => {
          const next = await discardGitFile(filePath);
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
        bots={snapshot.bots}
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
            name: tpl.name,
            slug: tpl.name.toLowerCase(),
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

      {/* Botfinity Hub Modal */}
      <OmniHubModal
        open={omniHubState.open}
        initialSection={omniHubState.section}
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
        onRunRoutineNow={async (routine) => {
          await sendOmniMessage({
            chatId: activeChat.id,
            text: routine.prompt,
            overrideBotId: routine.botId,
          });
        }}
        onSelectBotDirectChat={handleSelectBotDirectChat}
        onStartSidechatWithSkill={(skill) => {
          handleCreateSwarmOrChat({
            title: skill.name,
            participantBotIds: [activeBot.id],
            skillSlug: skill.slug,
          });
        }}
      />

      {/* Search & New Swarm Room Modal */}
      <SearchAndNewChatModal
        open={commandModal.open}
        mode={commandModal.mode}
        bots={snapshot.bots}
        chats={snapshot.chats}
        skills={snapshot.skills}
        projects={snapshot.workspaces}
        onClose={() => setCommandModal((prev) => ({ ...prev, open: false }))}
        onSelectPrimary={handleSelectPrimary}
        onSelectBotDirectChat={handleSelectBotDirectChat}
        onSelectChat={setActiveChatId}
        onSelectProject={handleSelectProject}
        onCreateSwarmOrChat={handleCreateSwarmOrChat}
      />
    </div>
  );
}
