import { previewOmniMessage } from "../../lib/omni-bridge";
import { Collapse } from "../ui/Collapse";
import { BotModelSelect } from "../bots/BotModelSelect";
import DOMPurify from "dompurify";
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  Loader2,
  Plus,
  Sparkles,
  Square,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { marked } from "marked";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  ActiveBotRun,
  BotProfile,
  ChatMessage,
  ChatThread,
  CliHarnessInfo,
  LocalSkillItem,
} from "../../lib/types";
import {
  BotCharacterAvatar,
  CliProviderGlyph,
  SkillBrandIcon,
} from "../icons/BotCharacterAvatar";

export interface ChatWorkspaceProps {
  chat: ChatThread;
  initialDraft?: string;
  onChooseProject: (prompt?: string) => void;
  onManageTeam: () => void;
  onOpenMemory: () => void;
  bots: BotProfile[];
  harnesses: CliHarnessInfo[];
  skills: LocalSkillItem[];
  activeRuns: ActiveBotRun[];
  workflowActive: boolean;
  terminalControlActive?: boolean;
  summarizeTeamResults?: boolean;
  onOpenTerminal?: () => void;
  defaultSpeakerId: string;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onOpenBotSettings: (bot: BotProfile) => void;
  onSendMessage: (params: {
    text: string;
    skillSlug?: string;
    overrideBotId?: string;
    overrideModel?: string;
    overrideEffort?: string;
    parallelMode?: boolean;
  summarize?: boolean;
  }) => Promise<void>;
  onStopChat: () => Promise<void>;
}

const SWARM_SLASH_COMMANDS = [
  {
    slug: "group",
    name: "Group Coordinate",
    description: "Have all Bots in this room collaborate sequentially on the task",
    prefix: "/group ",
  },
  {
    slug: "race",
    name: "Parallel Bot Arena",
    description: "Run all Bots in parallel and compare their solutions side-by-side",
    prefix: "/race ",
  },
  {
    slug: "team",
    name: "Project team",
    description: "Explicitly invite the bots assigned to this project",
    prefix: "/team ",
  },
  {
    slug: "review",
    name: "Cross-Bot Code Review",
    description: "Have @Claude and @Codex cross-review uncommitted git changes",
    prefix:
      "@Claude inspect our current git diff for bugs or architectural issues, then hand off to @Codex to verify and suggest concrete fixes: ",
  },
];

export function ChatWorkspace({
  chat,
  initialDraft = "",
  onChooseProject, onManageTeam, onOpenMemory,
  bots,
  harnesses,
  skills,
  activeRuns,
  workflowActive,
  terminalControlActive = false,
  summarizeTeamResults: summarize = false,
  onOpenTerminal,
  defaultSpeakerId,
  inspectorOpen,
  onToggleInspector,
  onOpenBotSettings,
  onSendMessage,
  onStopChat,
}: ChatWorkspaceProps) {
  const [input, setInput] = useState(initialDraft);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sendPending = useRef(false);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<LocalSkillItem | null>(null);
  const [overrideBotId, setOverrideBotId] = useState<string | undefined>(undefined);
  const [overrideModel, setOverrideModel] = useState<string | undefined>(undefined);
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "high">(
    "medium"
  );
  const [parallelMode, setParallelMode] = useState(false);

  const [slashIndex, setSlashIndex] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [isNearBottom, setIsNearBottom] = useState(true);

  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const composerAreaRef = useRef<HTMLDivElement | null>(null);
  const [composerHeight, setComposerHeight] = useState(120);
  const [visibleMessageCount, setVisibleMessageCount] = useState(200);
  useEffect(() => {
    const element = composerAreaRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setComposerHeight(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const chatParticipants = useMemo(() => {
    const list = chat.participantBotIds
      .map((id) => bots.find((b) => b.id === id))
      .filter((b): b is BotProfile => Boolean(b) && !b?.archived);
    return list;
  }, [chat.participantBotIds, bots]);

  const activeSpeakerBot = useMemo(() => {
    if (overrideBotId) {
      return bots.find((b) => b.id === overrideBotId && !b.archived) ?? chatParticipants[0];
    }
    return bots.find((b) => b.id === defaultSpeakerId && !b.archived) ?? chatParticipants[0];
  }, [overrideBotId, bots, chatParticipants, defaultSpeakerId]);

  useEffect(() => {
    setOverrideModel(undefined);
    const effort = activeSpeakerBot?.reasoningEffort;
    setReasoningEffort(effort === "low" || effort === "high" ? effort : "medium");
  }, [activeSpeakerBot?.id, activeSpeakerBot?.cliDriver, activeSpeakerBot?.model, activeSpeakerBot?.reasoningEffort]);

  const [routePreview, setRoutePreview] = useState("");
  useEffect(() => {
    let disposed = false;
    if (!input.trim()) { setRoutePreview(""); return; }
    const timer = setTimeout(() => {
      previewOmniMessage({ chatId: chat.id, text: input, overrideBotId: activeSpeakerBot?.id, overrideModel, parallelMode })
        .then(plan => {
          if (disposed) return;
          const isCurrentBot = chat.participantBotIds.length === 1 && plan.botIds.length === 1 && plan.botIds[0] === chat.participantBotIds[0];
          setRoutePreview(isCurrentBot ? "" : `To: ${plan.botIds.map(id => bots.find(b => b.id === id)?.name ?? id).join(", ")}${plan.botIds.length > 1 ? (plan.parallel ? " · Running together" : " · One after another") : ""}`);
        })
        .catch(error => { if (!disposed) setRoutePreview(error instanceof Error ? error.message : "Cannot preview recipients"); });
    }, 200);
    return () => { disposed = true; clearTimeout(timer); };
  }, [input, chat.id, chat.participantBotIds, activeSpeakerBot?.id, overrideModel, parallelMode, bots]);

  const chatActiveRuns = useMemo(
    () => activeRuns.filter((r) => r.chatId === chat.id),
    [activeRuns, chat.id]
  );
  const isStreaming = workflowActive || chatActiveRuns.length > 0;

  // Compute a lightweight signature of streaming text/thinking lengths so sticky scroll tracks live deltas
  const lastMsg = chat.messages[chat.messages.length - 1];
  const streamSignature = lastMsg
    ? `${chat.messages.length}:${lastMsg.text.length}:${lastMsg.thinking.length}:${lastMsg.toolCalls.length}`
    : "0";

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsNearBottom(distance < 150);
  }, []);

  useEffect(() => {
    if (!isNearBottom) return;
    const el = scrollContainerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [streamSignature, isNearBottom, isStreaming]);

  const slashMatch = useMemo(() => {
    const m = /(?:^|\s)\/([a-zA-Z0-9_-]*)$/.exec(input);
    return m ? { query: m[1].toLowerCase() } : null;
  }, [input]);

  const mentionMatch = useMemo(() => {
    const m = /(?:^|\s)@([a-zA-Z0-9_-]*)$/.exec(input);
    return m ? { query: m[1].toLowerCase() } : null;
  }, [input]);

  const matchingSlashItems = useMemo(() => {
    if (!slashMatch) return [];
    const q = slashMatch.query;
    const cmds = SWARM_SLASH_COMMANDS.filter(
      (c) =>
        !q ||
        c.slug.includes(q) ||
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q)
    ).map((c) => ({ kind: "command" as const, cmd: c }));

    const sks = skills
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          s.slug.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q)
      )
      .slice(0, 7)
      .map((s) => ({ kind: "skill" as const, skill: s }));

    return [...cmds, ...sks];
  }, [slashMatch, skills]);

  const matchingBotMentions = useMemo(() => {
    if (!mentionMatch) return [];
    const q = mentionMatch.query;
    const items: Array<
      | { kind: "all" }
      | { kind: "bot"; bot: BotProfile }
    > = [];
    if (!q || "all".includes(q) || "swarm".includes(q) || "everyone".includes(q)) {
      items.push({ kind: "all" });
    }
    for (const b of bots.filter(bot => !bot.archived)) {
      if (
        !q ||
        b.name.toLowerCase().includes(q) ||
        b.slug.toLowerCase().includes(q) ||
        b.cliDriver.toLowerCase().includes(q)
      ) {
        items.push({ kind: "bot", bot: b });
      }
    }
    return items;
  }, [mentionMatch, bots]);

  useEffect(() => {
    setSlashIndex(0);
  }, [slashMatch?.query]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionMatch?.query]);

  const applySlashSelection = useCallback(
    (
      item:
        | { kind: "command"; cmd: (typeof SWARM_SLASH_COMMANDS)[number] }
        | { kind: "skill"; skill: LocalSkillItem }
    ) => {
      if (item.kind === "skill") {
        setSelectedSkill(item.skill);
        setInput((prev) =>
          prev.replace(/(?:^|\s)\/[a-zA-Z0-9_-]*$/, "").trimStart()
        );
      } else {
        if (item.cmd.slug === "race") {
          setParallelMode(true);
        }
        setInput((prev) =>
          prev.replace(/(?:^|\s)\/[a-zA-Z0-9_-]*$/, ` ${item.cmd.prefix}`).trimStart()
        );
      }
      composerInputRef.current?.focus();
    },
    []
  );

  const applyMentionSelection = useCallback(
    (entry: { kind: "all" } | { kind: "bot"; bot: BotProfile }) => {
      if (entry.kind === "all") {
        setParallelMode(true);
        setInput((prev) =>
          prev.replace(/(?:^|\s)@[a-zA-Z0-9_-]*$/, " @all ").trimStart()
        );
      } else {
        setInput((prev) =>
          prev
            .replace(/(?:^|\s)@[a-zA-Z0-9_-]*$/, ` @${entry.bot.slug} `)
            .trimStart()
        );
      }
      composerInputRef.current?.focus();
    },
    []
  );

  const handleSend = useCallback(
    async (overridePrompt?: string, targetBotId?: string) => {
      const trimmed = (overridePrompt ?? input).trim();
      if (!trimmed || sendPending.current || isStreaming) return;
      if (!activeSpeakerBot && !targetBotId) { setSendError("Restore this bot in Bot library or choose an active participant."); return; }
      if (!chat.workspacePath && (/^\/review(?:\s|$)/i.test(trimmed) || (/^(?:please\s+)?(?:inspect|review|audit|check|summarize|examine)\b/i.test(trimmed) && /\b(git (?:diff|status|commits?|changes)|uncommitted (?:changes|diffs)|recent (?:git )?commits)\b/i.test(trimmed)))) {
        onChooseProject(trimmed);
        return;
      }
      sendPending.current = true;
      setSending(true);
      setSendError(null);

      if (!overridePrompt) {
        setInput("");
      }
      const skillSlug = selectedSkill?.slug;
      const isParallel = parallelMode;
      setSelectedSkill(null);
      setParallelMode(false);

      try {
      await onSendMessage({
        text: trimmed,
        skillSlug,
        overrideBotId: targetBotId ?? activeSpeakerBot?.id,
        overrideModel: targetBotId && targetBotId !== activeSpeakerBot?.id ? undefined : overrideModel,
        overrideEffort: reasoningEffort,
        parallelMode: isParallel,
        summarize,
      });
      } catch (error) {
        if (!overridePrompt) setInput(trimmed);
        setSelectedSkill(selectedSkill);
        setParallelMode(isParallel);
        setSendError(error instanceof Error ? error.message : "Could not send message.");
      } finally {
        sendPending.current = false;
        setSending(false);
      }
    },
    [
      chat.workspacePath, onChooseProject,
      input,
      isStreaming,
      selectedSkill,
      parallelMode,
      summarize,
      onSendMessage,
      activeSpeakerBot?.id,
      overrideModel,
      reasoningEffort,
    ]
  );

  const activeSpeakerHarness = useMemo(
    () => harnesses.find((h) => h.kind === activeSpeakerBot?.cliDriver),
    [harnesses, activeSpeakerBot]
  );

  const isEmpty = chat.messages.length === 0;

  return (
    <main className="motion-chat relative flex-1 min-w-0 h-full bg-[#121212] overflow-hidden">
      {/* Top Progressive Blur & Soft Vignette Feather */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-0 inset-x-0 h-24 chat-top-feather z-10"
      />

      {sendError && (
        <div role="alert" className="absolute bottom-28 inset-x-6 z-30 rounded-xl bg-red-950 p-3 text-sm text-red-200">
          {sendError}
        </div>
      )}
      {/* Minimal Top Drag Region — Single Centered Bot Name Pill */}
      <div
        data-tauri-drag-region
        className="absolute top-0 inset-x-0 min-h-16 pt-2 flex flex-col items-center justify-center gap-1 z-20 pointer-events-auto"
      >
        <button
          type="button"
          onClick={onToggleInspector}
          title="Click to open Bot Settings, Group members, Project & Git (Cmd+I)"
          aria-expanded={inspectorOpen}
          className="bot-header-pill text-zinc-100"
        >
          <span className="inline-flex items-center gap-2.5 min-w-0">
          {chatParticipants.length > 1 ? (
            <div className="flex items-center -space-x-1.5">
              {chatParticipants.slice(0, 4).map((b) => (
                <BotCharacterAvatar key={b.id} bot={b} size={22} />
              ))}
            </div>
          ) : (
            activeSpeakerBot && (
              <BotCharacterAvatar
                bot={activeSpeakerBot}
                size={26}
                showStarBadge={false}
                showCliBadge={false}
                isStreaming={isStreaming}
              />
            )
          )}
          <span className="text-[16px] font-medium max-w-[260px] truncate">
            {chat.isGroup ? chat.title : activeSpeakerBot?.name || chat.title}
          </span>
          </span>
          <span className="bot-header-chevron" aria-hidden="true"><ChevronRight size={18} /></span>
        </button>
        <button onClick={() => onChooseProject()} title={chat.workspacePath ?? "Start a project work chat"} className="max-w-[260px] truncate rounded-md px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04]">
          {chat.workspacePath ? chat.workspacePath.split("/").filter(Boolean).at(-1) : "Personal space"}
        </button>
      </div>

      {/* Full-Height Scrollable Transcript Area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        style={isEmpty ? undefined : { paddingBottom: composerHeight + 40 }}
        className={`h-full w-full overflow-y-auto overflow-x-hidden chat-scroll-mask px-6 ${
          isEmpty ? "flex flex-col items-center justify-center" : "pt-28 pb-40"
        }`}
      >
        {isEmpty ? (
          <EmptyChatHero
            chat={chat}
            participants={chatParticipants}
            allBots={bots}
            onChooseProject={onChooseProject}
            onManageTeam={onManageTeam}
            onOpenMemory={onOpenMemory}
            onSendStarter={(prompt) => handleSend(prompt)}
          />
        ) : (
          <div className="max-w-[740px] mx-auto space-y-5">
            {chat.messages.length > visibleMessageCount && <button type="button" className="text-xs text-zinc-400 hover:text-white" onClick={() => { setIsNearBottom(false); setVisibleMessageCount(count => count + 200); }}>Load earlier messages ({chat.messages.length - visibleMessageCount} remaining)</button>}
            {chat.messages.slice(-visibleMessageCount).map((msg) => (
              <MessageCard
                key={msg.id}
                message={msg}
                bots={bots}
                onOpenBotSettings={onOpenBotSettings}
                onQuickHandoff={(targetBot) => {
                  handleSend(
                    `@${targetBot.name} review @${msg.authorName || "Bot"}'s response above and follow up or improve on it.`,
                    targetBot.id
                  );
                }}
              />
            ))}

            {isStreaming && !terminalControlActive && !chat.messages.some(message => message.status === "streaming") && (
              <div role="status" className="pl-12 text-[13px] text-zinc-400 flex items-center gap-2">
                <ThinkingDots />
                <span>Preparing the next turn</span>
              </div>
            )}

            <div ref={transcriptEndRef} className="h-10 shrink-0" />
          </div>
        )}
      </div>

      {/* Bottom Progressive Blur & Soft Vignette Feather */}
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 inset-x-0 h-32 chat-bottom-feather z-10"
      />

      {/* Floating Jump-to-Latest Pill when scrolled up */}
      {!isEmpty && !isNearBottom && (
        <div className="absolute inset-x-0 flex justify-center z-20 pointer-events-none" style={{ bottom: composerHeight + 8 }}>
          <button
            type="button"
            onClick={() => {
              setIsNearBottom(true);
              transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
            }}
            className="pointer-events-auto px-3.5 py-1.5 rounded-full liquid-glass-pill text-xs font-medium text-zinc-100 hover:text-white flex items-center gap-1.5 shadow-xl active:scale-95"
          >
            <ArrowDown className="w-3.5 h-3.5 text-[#8cf1fb]" />
            <span>{isStreaming && !terminalControlActive ? "Streaming below" : "Jump to latest"}</span>
          </button>
        </div>
      )}

      {/* Floating Bottom Composer Area with Liquid Glass */}
      <div ref={composerAreaRef} className="absolute bottom-0 inset-x-0 px-5 pb-4 pt-2 z-20 pointer-events-none">
        <div className="max-w-[740px] mx-auto relative pointer-events-auto">
          {/* `/` Slash Command & Skill Autocomplete Popover */}
          {slashMatch && matchingSlashItems.length > 0 && (
            <div className="mb-2.5 rounded-2xl liquid-glass-modal p-2 shadow-2xl space-y-1 max-h-64 overflow-y-auto">
              <div className="px-2.5 py-1 flex items-center justify-between text-[11px] font-medium text-zinc-400">
                <span>Chat Commands &amp; Local Skills</span>
                <span className=" text-[10px] text-zinc-500">ESC</span>
              </div>
              {matchingSlashItems.map((item, idx) => {
                const active = idx === slashIndex;
                const key =
                  item.kind === "command"
                    ? `cmd:${item.cmd.slug}`
                    : `sk:${item.skill.id}`;
                return (
                  <button
                    key={key}
                    type="button"
                    onMouseEnter={() => setSlashIndex(idx)}
                    onClick={() => applySlashSelection(item)}
                    className={`w-full px-3 py-2 rounded-xl flex items-center gap-3 text-left transition-colors ${
                      active
                        ? "liquid-glass-active text-white"
                        : "hover:bg-white/[0.06] text-zinc-200"
                    }`}
                  >
                    {item.kind === "command" ? (
                      <div className="w-8 h-8 rounded-xl bg-[#8cf1fb]/15 border border-[#8cf1fb]/30 text-[#8cf1fb] flex items-center justify-center shrink-0">
                        <ArrowLeftRight className="w-4 h-4" />
                      </div>
                    ) : (
                      <SkillBrandIcon name={item.skill.name} size={32} />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13.5px] font-semibold truncate">
                          {item.kind === "command"
                            ? item.cmd.name
                            : item.skill.name}
                        </span>
                        <span className="text-[11px]  text-zinc-400">
                          /{item.kind === "command" ? item.cmd.slug : item.skill.slug}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-400 truncate">
                        {item.kind === "command"
                          ? item.cmd.description
                          : item.skill.description}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* `@` Bot Mention Autocomplete Popover */}
          {mentionMatch && matchingBotMentions.length > 0 && (
            <div className="mb-2.5 rounded-2xl liquid-glass-modal p-2 shadow-2xl space-y-1 max-h-64 overflow-y-auto">
              <div className="px-2.5 py-1 flex items-center justify-between text-[11px] font-medium text-zinc-400">
                <span>Mention or Hand Off to a Bot</span>
                <span className=" text-[10px] text-zinc-500">ESC</span>
              </div>
              {matchingBotMentions.map((entry, idx) => {
                const active = idx === mentionIndex;
                const key = entry.kind === "all" ? "all" : entry.bot.id;
                return (
                  <button
                    key={key}
                    type="button"
                    onMouseEnter={() => setMentionIndex(idx)}
                    onClick={() => applyMentionSelection(entry)}
                    className={`w-full px-3 py-2 rounded-xl flex items-center gap-3 text-left transition-colors ${
                      active
                        ? "liquid-glass-active text-white"
                        : "hover:bg-white/[0.06] text-zinc-200"
                    }`}
                  >
                    {entry.kind === "all" ? (
                      <div className="w-8 h-8 rounded-xl bg-cyan-500/15 border border-cyan-400/30 text-cyan-300 flex items-center justify-center shrink-0">
                        <Sparkles className="w-4 h-4" />
                      </div>
                    ) : (
                      <BotCharacterAvatar bot={entry.bot} size={32} />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13.5px] font-semibold truncate">
                          {entry.kind === "all"
                            ? "@all — Group Broadcast"
                            : `@${entry.bot.name}`}
                        </span>
                        {entry.kind === "bot" && (
                          <span className="text-[11px]  text-zinc-400">
                            {entry.bot.cliDriver}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-zinc-400 truncate">
                        {entry.kind === "all"
                          ? "Dispatch to every Bot in the Group chat in parallel"
                          : entry.bot.roleTitle}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Active Chips Row */}
          {routePreview && <p className="text-xs text-zinc-400 px-3 py-1" aria-label="Recipient preview">{routePreview}</p>}
          {(selectedSkill || parallelMode || overrideBotId || overrideModel) && (
            <div className="flex flex-wrap items-center gap-2 mb-2 px-1">
              {parallelMode && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full liquid-glass-chip border-emerald-400/35 text-emerald-200 text-xs font-medium">
                  <ArrowLeftRight className="w-3 h-3" />
                  <span>Parallel Group Mode</span>
                  <button
                    type="button"
                    onClick={() => setParallelMode(false)}
                    className="hover:text-white"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}
              {overrideBotId && activeSpeakerBot && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full liquid-glass-chip border-[#8cf1fb]/35 text-[#8cf1fb] text-xs font-medium">
                  <BotCharacterAvatar bot={activeSpeakerBot} size={16} />
                  <span>Target: @{activeSpeakerBot.name}</span>
                  <button
                    type="button"
                    onClick={() => setOverrideBotId(undefined)}
                    className="hover:text-white"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}
              {overrideModel && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full liquid-glass-chip border-purple-400/35 text-purple-200 text-xs font-medium">
                  <Cpu className="w-3 h-3" />
                  <span>{overrideModel}</span>
                  <button
                    type="button"
                    onClick={() => setOverrideModel(undefined)}
                    className="hover:text-white"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}
              {selectedSkill && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full liquid-glass-chip border-cyan-400/35 text-cyan-200 text-xs font-medium">
                  <Sparkles className="w-3 h-3" />
                  <span>/{selectedSkill.slug}</span>
                  <button
                    type="button"
                    onClick={() => setSelectedSkill(null)}
                    className="hover:text-white"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}
            </div>
          )}

          {/* Animated Liquid Glass Plus Menu Popover */}
          {composerMenuOpen && (
            <div
              className="fixed inset-0 z-20"
              onClick={() => setComposerMenuOpen(false)}
            />
          )}
          <div
            aria-hidden={!composerMenuOpen}
            inert={!composerMenuOpen}
            className={`absolute bottom-14 left-0 w-80 rounded-2xl liquid-glass-modal p-2.5 z-30 space-y-2.5 origin-bottom-left transition-[opacity,scale,translate] duration-200 spring-transition ${
              composerMenuOpen
                ? "scale-100 opacity-100 translate-y-0 pointer-events-auto"
                : "scale-[0.985] opacity-0 translate-y-1 pointer-events-none"
            }`}
          >
            {/* Target Bot Picker */}
            <div className="px-1">
              <div className="px-1.5 text-[10.5px] font-medium text-zinc-400 mb-1.5">
                Route Turn to Bot
              </div>
              <div className="max-h-36 overflow-y-auto space-y-0.5 pr-0.5">
                {bots.filter(b => !b.archived).map((b) => {
                  const active = activeSpeakerBot?.id === b.id && !parallelMode;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => {
                        setParallelMode(false);
                        setOverrideBotId(b.id);
                        setOverrideModel(undefined);
                      }}
                      className={`w-full px-2.5 py-1.5 rounded-xl flex items-center justify-between text-xs transition-colors ${
                        active
                          ? "liquid-glass-active text-white font-semibold"
                          : "hover:bg-white/[0.06] text-zinc-300"
                      }`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <BotCharacterAvatar bot={b} size={20} />
                        <span className="truncate">{b.name}</span>
                        <span className="text-[10.5px]  text-zinc-400">
                          ({b.cliDriver})
                        </span>
                      </span>
                      {active && (
                        <Check className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                      )}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => {
                    setParallelMode((v) => !v);
                    setComposerMenuOpen(false);
                  }}
                  className={`w-full px-2.5 py-1.5 rounded-xl flex items-center justify-between text-xs transition-colors ${
                    parallelMode
                      ? "liquid-glass-active text-emerald-300 font-semibold"
                      : "hover:bg-white/[0.06] text-zinc-300"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <ArrowLeftRight className="w-4 h-4 text-emerald-400" />
                    <span>Run All Room Bots in Parallel (@all)</span>
                  </span>
                  {parallelMode && (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  )}
                </button>
              </div>
            </div>

            {activeSpeakerHarness && <div className="px-2 pt-2">
              <BotModelSelect label={`${activeSpeakerHarness.name} model`} harness={activeSpeakerHarness} value={overrideModel ?? null} defaultLabel={activeSpeakerBot && chat.modelOverrides && activeSpeakerBot.id in chat.modelOverrides ? `Chat default (${chat.modelOverrides[activeSpeakerBot.id] ?? "CLI default"})` : activeSpeakerBot?.model ? `Bot default (${activeSpeakerBot.model})` : "CLI default"} onChange={model => setOverrideModel(model ?? undefined)} />
            </div>}

            <div className="px-2 pb-1 pt-2">
              <div className="text-[10.5px] font-medium text-zinc-400 mb-1.5">
                Reasoning Effort
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {(["low", "medium", "high"] as const).map((lvl) => (
                  <button
                    key={lvl}
                    disabled={!activeSpeakerHarness?.supportsEffort}
                    title="Available only for adapters that support reasoning effort"
                    type="button"
                    onClick={() => setReasoningEffort(lvl)}
                    className={`py-1.5 rounded-xl text-xs capitalize transition-all ${
                      reasoningEffort === lvl
                        ? "bg-white text-black font-semibold shadow-sm"
                        : "liquid-glass-chip text-zinc-300 hover:text-white"
                    }`}
                  >
                    {lvl}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {terminalControlActive && <div role="status" className="mb-3 flex items-center justify-center gap-2 text-[11px] text-zinc-400">
            <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" />Terminal control is active
            <button className="underline underline-offset-4 hover:text-white" onClick={onOpenTerminal}>Open terminal</button>
          </div>}
          {/* Main Liquid Glass Pill Composer */}
          <div className="min-h-[48px] rounded-full liquid-glass-pill px-2.5 py-1.5 flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setComposerMenuOpen((v) => !v)}
              title="Switch target Bot, CLI model, or parallel group mode"
              className="w-7 h-7 rounded-full liquid-glass-chip flex items-center justify-center text-zinc-200 hover:text-white shrink-0 active:scale-95"
            >
              <Plus
                className={`w-4 h-4 transition-transform duration-200 ${
                  composerMenuOpen ? "rotate-45" : ""
                }`}
              />
            </button>

            <input
              ref={composerInputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (slashMatch && matchingSlashItems.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlashIndex((i) => (i + 1) % matchingSlashItems.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashIndex(
                      (i) =>
                        (i - 1 + matchingSlashItems.length) %
                        matchingSlashItems.length
                    );
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    const picked = matchingSlashItems[slashIndex];
                    if (picked) applySlashSelection(picked);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setInput((prev) =>
                      prev.replace(/(?:^|\s)\/[a-zA-Z0-9_-]*$/, "")
                    );
                    return;
                  }
                }

                if (mentionMatch && matchingBotMentions.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setMentionIndex((i) => (i + 1) % matchingBotMentions.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setMentionIndex(
                      (i) =>
                        (i - 1 + matchingBotMentions.length) %
                        matchingBotMentions.length
                    );
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    const picked = matchingBotMentions[mentionIndex];
                    if (picked) applyMentionSelection(picked);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setInput((prev) =>
                      prev.replace(/(?:^|\s)@[a-zA-Z0-9_-]*$/, "")
                    );
                    return;
                  }
                }

                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={
                chat.isGroup
                  ? `Message Group (${chatParticipants.map((b) => `@${b.name}`).join(", ")}) — type @ to hand off, / for skills`
                  : !chat.workspacePath ? `Message ${activeSpeakerBot?.name || "Omnibot"}…` : `Message ${activeSpeakerBot?.name || "Omnibot"} — type @ to summon another Bot, / for skills`
              }
              className="flex-1 bg-transparent text-[15px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
            />

            <button
              type="button"
              disabled={!isStreaming && (!input.trim() || sending)}
              onClick={() => isStreaming ? onStopChat() : handleSend()}
              aria-label={isStreaming ? "Stop response" : "Send message"}
              title={isStreaming ? "Stop response" : "Send message"}
              className="w-8 h-8 rounded-full bg-white hover:bg-zinc-200 disabled:opacity-35 text-black flex items-center justify-center transition-transform active:scale-95 shadow-md shrink-0"
            >
              {isStreaming ? <Square className="w-3 h-3 fill-current" /> : <ArrowUp className="w-4 h-4 stroke-[2.5]" />}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * Vertically & horizontally centered minimal empty state hero.
 */
function EmptyChatHero({ chat, participants, allBots, onSendStarter, onChooseProject, onManageTeam, onOpenMemory }: {
  chat: ChatThread; participants: BotProfile[]; allBots: BotProfile[];
  onSendStarter: (prompt: string) => void;
  onChooseProject: (prompt?: string) => void; onManageTeam: () => void; onOpenMemory: () => void;
}) {
  const lead = participants[0];
  const second =
    participants[1] ??
    allBots.find((b) => !b.isPrimary && b.id !== lead?.id) ??
    lead;

  if (!chat.workspacePath && !chat.isGroup && (chat.isPrimary || chat.isBotHome)) return (
    <div className="flex flex-col items-center text-center max-w-lg mx-auto px-6 space-y-6">
      {lead && <BotCharacterAvatar bot={lead} size={84} showStarBadge={lead.isPrimary} showCliBadge={false} />}
      <div className="space-y-3"><h2 className="text-[28px] font-medium text-white">{lead?.name ?? chat.title}</h2><p className="text-[15px] text-zinc-400 leading-relaxed">{chat.isPrimary ? "A place for your ideas, plans, and everything you’re working toward." : `Ask ${lead?.name ?? "your bot"} for help with anything you’re working on.`}</p></div>
      <div className="flex flex-wrap justify-center gap-3">
        <button onClick={() => onChooseProject()} className="rounded-full bg-white text-black px-5 py-3 text-sm motion-cta">Choose a project</button>
        <button onClick={onManageTeam} className="rounded-full liquid-glass-pill px-5 py-3 text-sm">Manage my team</button>
        <button onClick={onOpenMemory} className="rounded-full liquid-glass-pill px-5 py-3 text-sm">Memory</button>
      </div>
      <p className="text-xs text-zinc-500">Your bot remembers your preferences. Add a project whenever it helps.</p>
    </div>
  );
  if (!chat.workspacePath && !chat.isGroup) return (
    <div className="flex flex-col items-center text-center max-w-lg mx-auto px-6 gap-5">
      {lead && <BotCharacterAvatar bot={lead} size={64} showCliBadge={false} />}
      <h2 className="text-[26px] font-medium text-white">{chat.title === lead?.name ? "What would you like to get done?" : chat.title}</h2>
      <p className="text-[15px] text-zinc-400">A fresh task with {lead?.name ?? "your bot"}. Ask for anything, and add a workspace if it helps.</p>
    </div>
  );
  const starters = chat.isGroup
    ? [
        {
          label: "Plan & cross-review",
          requiresProject: false,
          prompt: `@${lead?.name || "Claude"} propose a clean plan for our next task, then hand off to @${second?.name || "Codex"} to review edge cases.`,
        },
        {
          label: chat.workspacePath ? "Parallel Group audit (@all)" : "Brainstorm together",
          requiresProject: !!chat.workspacePath,
          prompt:
            chat.workspacePath ? "@all Inspect this project and share your top 2 improvements." : "@all Help me plan our next task and identify the questions we should answer first.",
        },
        {
          label: "Review git diff",
          requiresProject: true,
          prompt:
            "@all Review uncommitted git changes in this repository and flag any bugs.",
        },
      ]
    : [
        {
          label: "Summarize project & git status",
          requiresProject: true,
          prompt:
            "Summarize the architecture of this project and check `git status` for any pending changes.",
        },
        {
          label: `Pair with @${second?.name || "Codex"}`,
          requiresProject: true,
          prompt: `Audit the codebase for bugs or tech debt, then hand off to @${second?.name || "Codex"} to verify your findings.`,
        },
        {
          label: "Review recent changes",
          requiresProject: true,
          prompt: "Inspect recent git commits and diffs for any issues.",
        },
      ];

  return (
    <div className="flex flex-col items-center justify-center text-center max-w-lg mx-auto px-4 -mt-6 space-y-5">
      {participants.length > 1 ? (
        <div className="flex items-center -space-x-3">
          {participants.map((b) => (
            <BotCharacterAvatar key={b.id} bot={b} size={64} />
          ))}
        </div>
      ) : (
        lead && (
          <BotCharacterAvatar
            bot={lead}
            size={76}
            showStarBadge={lead.isPrimary}
          />
        )
      )}

      <div className="space-y-1">
        <h2 className="text-[20px] font-semibold text-white tracking-tight">
          {chat.title}
        </h2>
        <p className="text-[13.5px] text-[#8e8d8a]">
          {chat.isGroup
            ? participants.map((b) => `@${b.name}`).join(" · ")
            : lead?.roleTitle}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
        {starters.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => chat.workspacePath || !s.requiresProject ? onSendStarter(s.prompt) : onChooseProject(s.prompt)}
            className="px-4 py-2 rounded-full liquid-glass-pill text-[13px] font-medium text-zinc-200 hover:text-white active:scale-95"
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageCard({
  message,
  bots,
  onQuickHandoff,
  onOpenBotSettings,
}: {
  message: ChatMessage;
  bots: BotProfile[];
  onQuickHandoff: (targetBot: BotProfile, sourceText: string) => void;
  onOpenBotSettings: (bot: BotProfile) => void;
}) {
  const thinkingId = useId();
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const authorBot = useMemo(
    () => bots.find((b) => b.id === message.authorBotId),
    [bots, message.authorBotId]
  );

  const isActivelyThinking =
    message.status === "streaming" &&
    Boolean(message.thinking) &&
    !message.text.trim();

  const showThinkingBody = thinkingExpanded;

  const totalTokens =
    message.usageReported && message.inputTokens != null && message.outputTokens != null ? message.inputTokens + message.outputTokens : null;

  const renderedHtml = useMemo(() => {
    const cleanText = message.text
      .replace(/<handoff[\s\S]*?<\/handoff>/gi, "")
      .replace(/<handoff[\s\S]*$/gi, "")
      .trim();
    if (!cleanText) return "";
    const rawHtml = marked.parse(cleanText, { async: false }) as string;
    return DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["form", "input", "button", "style", "iframe"],
      FORBID_ATTR: ["style"],
    });
  }, [message.text]);

  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {message.skillSlug && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full liquid-glass-chip text-xs font-medium text-cyan-200">
            <Sparkles className="w-3 h-3" />
            <span>/{message.skillSlug}</span>
          </span>
        )}
        <div className="max-w-[78%] rounded-2xl liquid-glass-pill px-4 py-2.5 text-[15px] text-zinc-100 leading-relaxed whitespace-pre-wrap">
          {message.text}
        </div>
      </div>
    );
  }

  const runningTool = message.toolCalls.find((t) => t.status === "running");
  const otherBots = bots.filter(
    (b) => !b.isPrimary && b.id !== message.authorBotId
  );

  return (
    <div className="group group/message min-w-0">
      <div className="w-full max-w-[620px] min-w-0 space-y-2">
        <div className="w-full overflow-hidden rounded-2xl liquid-glass-card px-5 py-4 min-h-[100px] text-[15px] text-zinc-100 space-y-3 break-words">
          {/* Bot Identity & CLI Harness Header Bar */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-1">
            <div className="flex items-center gap-2 min-w-0">
              <button type="button" disabled={!authorBot} aria-label={`Open ${message.authorName || authorBot?.name || "bot"} settings`} onClick={() => authorBot && onOpenBotSettings(authorBot)} className="text-[13.5px] font-semibold text-white truncate rounded-md hover:text-zinc-300">
                {message.authorName || authorBot?.name || "Bot"}
              </button>
              {(message.cliDriver ?? authorBot?.cliDriver) && (
                <span className="provider-hover-badge inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/[0.05] text-[11px] text-zinc-400">
                  <CliProviderGlyph driver={message.cliDriver ?? authorBot?.cliDriver ?? "custom"} size={11} />
                  <span title={message.modelReported ? "Model reported by the CLI" : "Requested model; the CLI has not confirmed the resolved model"}>{message.model && message.model !== "default" ? message.model : "CLI default"}</span>
                </span>
              )}
              {message.worktreePath && (
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 text-[10.5px]">
                  worktree
                </span>
              )}
            </div>

            <div className="provider-hover-badge inline-flex flex-wrap items-center gap-2 text-[11px] text-[#8e8d8a]">
              {totalTokens != null && (
                <span title={`CLI reported: ${totalTokens!.toLocaleString()} tokens · Input (including cache): ${message.inputTokens?.toLocaleString()} · Output: ${message.outputTokens?.toLocaleString()}`}>
                  {totalTokens >= 1000
                    ? `≈${(totalTokens / 1000).toFixed(1)}k tok`
                    : `${totalTokens} tok`}
                </span>
              )}
              {message.usageReported && message.costUsd != null && message.costUsd >= 0 && (
                <span title={`CLI reported cost: $${message.costUsd}. This may differ from your provider invoice or subscription billing.`} className="text-emerald-300/90">
                  {message.costUsd === 0 ? "$0" : message.costUsd < 0.000001 ? "<$0.000001" : `${Number(message.costUsd.toPrecision(6)) !== message.costUsd ? "≈" : ""}$${Number(message.costUsd.toPrecision(6))}`}
                </span>
              )}
              {message.status !== "streaming" && totalTokens == null && (!message.usageReported || message.costUsd == null) && (
                <span title="No verified turn totals are available. Older estimated counts are hidden; some CLIs do not report usage.">Usage unavailable</span>
              )}
              {message.durationMs != null && message.durationMs > 0 && (
                <span title={`Elapsed CLI execution time: ${message.durationMs.toLocaleString()} ms`}>{(message.durationMs / 1000).toFixed(1)}s</span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              {message.status === "streaming" && renderedHtml && !runningTool && (
                <span role="status" className="inline-flex items-center gap-1.5 text-zinc-400">
                  <span aria-hidden="true" className="h-1 w-1 rounded-full bg-zinc-400" />
                  Writing
                </span>
              )}
              {message.status === "stopped" && (
                <span className="text-amber-300 font-sans">Stopped</span>
              )}
            </div>
          </div>

          {message.status === "streaming" && !renderedHtml && !runningTool && (
            <div role="status" aria-label={`${message.authorName || "Bot"} is thinking`} className="thinking-state flex items-center gap-2.5 py-1 text-[14px] text-zinc-400">
              <span>Thinking</span><ThinkingDots />
            </div>
          )}

          {/* Collapsible Thinking / Reasoning Block */}
          {message.thinking && (
            <div className="rounded-xl liquid-glass-chip px-3 py-2">
              <button
                type="button"
                aria-expanded={showThinkingBody}
                aria-controls={thinkingId}
                onClick={() => setThinkingExpanded((v) => !v)}
                className="w-full flex items-center justify-between text-xs text-zinc-300 hover:text-white"
              >
                <span className="flex items-center gap-1.5 font-medium">
                  <Brain className="w-3.5 h-3.5 text-purple-300" />
                  <span>
                    {isActivelyThinking ? "View thinking" : "Thought process"}
                  </span>
                </span>
                {showThinkingBody ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
              </button>
              <Collapse open={showThinkingBody} id={thinkingId}>
                <p className="mt-2 pt-2 text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap max-h-60 overflow-y-auto">
                  {message.thinking}
                </p>
              </Collapse>
            </div>
          )}

          {/* Collapsible Tool Execution Timeline */}
          {message.toolCalls.length > 0 && (
            <div className="rounded-xl liquid-glass-chip px-3 py-2">
              <button
                type="button"
                onClick={() => setToolsExpanded((v) => !v)}
                className="w-full flex items-center justify-between text-xs text-zinc-300 hover:text-white"
              >
                <span className="flex items-center gap-1.5 font-medium min-w-0">
                  {runningTool ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400 shrink-0" />
                  ) : (
                    <Wrench className="w-3.5 h-3.5 text-zinc-300 shrink-0" />
                  )}
                  <span className="truncate">
                    {runningTool
                      ? `Running ${runningTool.name}: ${runningTool.inputSummary}...`
                      : `Executed ${message.toolCalls.length} ${
                          message.toolCalls.length === 1 ? "tool" : "tools"
                        }`}
                  </span>
                </span>
                {toolsExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                )}
              </button>

              {toolsExpanded && (
                <div className="mt-2 pt-2 space-y-2">
                  {message.toolCalls.map((tc) => (
                    <div
                      key={tc.id}
                      className="rounded-lg bg-black/35 px-2.5 py-1.5 space-y-1 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11.5px] text-zinc-200 flex items-center gap-1.5 truncate">
                          <Terminal className="w-3 h-3 text-cyan-400 shrink-0" />
                          <span className="truncate">{tc.name}</span>
                        </span>
                        <span
                          className={`text-[10.5px] shrink-0 ${
                            tc.status === "completed"
                              ? "text-emerald-400"
                              : "text-cyan-300"
                          }`}
                        >
                          {tc.status}
                        </span>
                      </div>
                      {tc.inputSummary && (
                        <div className="text-[11px] text-zinc-400 font-mono truncate">
                          {tc.inputSummary}
                        </div>
                      )}
                      {tc.outputSummary && (
                        <div className="text-[11px] text-zinc-500 truncate">
                          → {tc.outputSummary}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Main Markdown Prose */}
          {renderedHtml && (
            <div
              className="omni-prose"
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          )}

          {/* Outgoing Bot-to-Bot Handoff Banners */}
          {message.handoffs.length > 0 && (
            <div className="pt-1 space-y-1.5">
              {message.handoffs.map((h, i) => (
                <div
                  key={i}
                  className="rounded-xl bg-[#8cf1fb]/10 border border-[#8cf1fb]/25 px-3 py-2 space-y-1 text-xs text-[#8cf1fb]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <ArrowLeftRight className="w-3.5 h-3.5 shrink-0" />
                      <span className="font-semibold truncate">
                        @{h.fromBotName} handed off to{" "}
                        {h.toBotNames.map((n) => `@${n}`).join(", ")}
                      </span>
                    </div>
                    <span className="text-[10.5px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-black/30 text-cyan-200 shrink-0">
                      {h.mode}
                    </span>
                  </div>
                  {h.note && !h.note.startsWith("Handed off to ") && (
                    <p className="text-[11.5px] text-cyan-100/80 pl-5 line-clamp-2">
                      {h.note}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Hover Action Row: Copy & One-Click Pass Baton / Cross-Review with Another CLI Bot */}
        {message.status !== "streaming" && message.text.trim().length > 0 && (
          <div className="opacity-0 group-hover:opacity-100 transition-opacity flex flex-wrap items-center gap-1.5 pl-1">
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(message.text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="px-2.5 py-1 rounded-full liquid-glass-chip text-[11px] text-zinc-300 hover:text-white flex items-center gap-1 active:scale-95"
            >
              {copied ? (
                <>
                  <Check className="w-3 h-3 text-emerald-400" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  <span>Copy</span>
                </>
              )}
            </button>
            {otherBots.length > 0 && (
              <>
                <span className="text-[11px] text-zinc-500 ml-1 mr-0.5">
                  Hand off to:
                </span>
                {otherBots.slice(0, 4).map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => onQuickHandoff(b, message.text)}
                    className="px-2.5 py-1 rounded-full liquid-glass-chip text-[11px] text-zinc-300 hover:text-white flex items-center gap-1.5 active:scale-95"
                  >
                    <BotCharacterAvatar bot={b} size={14} />
                    <span>@{b.name}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingDots() {
  return <span aria-hidden="true" className="thinking-dots inline-flex items-center gap-1"><i /><i /><i /></span>;
}
