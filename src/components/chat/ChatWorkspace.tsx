import { marked } from "marked";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActiveBotRun,
  BotProfile,
  ChatMessage,
  ChatThread,
  CliHarnessInfo,
  GitRepoStatus,
  LocalSkillItem,
} from "../../lib/types";
import {
  BotCharacterAvatar,
  CliProviderGlyph,
  SkillBrandIcon,
} from "../icons/BotCharacterAvatar";
import {
  ArrowLeftRight,
  ArrowUp,
  BrainIcon,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  FolderKanban,
  Loader2,
  Plus,
  Sparkles,
  StopCircle,
  TerminalIcon,
  Wrench,
  X,
} from "../icons/OmarchyIcons";

export interface ChatWorkspaceProps {
  chat: ChatThread;
  bots: BotProfile[];
  harnesses: CliHarnessInfo[];
  skills: LocalSkillItem[];
  gitStatus: GitRepoStatus;
  activeRuns: ActiveBotRun[];
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onOpenGitInspector: () => void;
  onSendMessage: (params: {
    text: string;
    skillSlug?: string;
    overrideBotId?: string;
    overrideModel?: string;
    overrideEffort?: string;
    parallelMode?: boolean;
  }) => Promise<void>;
  onStopChat: () => Promise<void>;
  onToggleBotInChat: (botId: string) => Promise<void>;
}

const SWARM_SLASH_COMMANDS = [
  {
    slug: "swarm",
    name: "Swarm Coordinate",
    description: "Have all Bots in this room collaborate sequentially on the task",
    prefix: "@all ",
  },
  {
    slug: "race",
    name: "Parallel Bot Arena",
    description: "Run all Bots in parallel and compare their solutions side-by-side",
    prefix: "/race ",
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
  bots,
  harnesses,
  skills,
  gitStatus,
  activeRuns,
  inspectorOpen,
  onToggleInspector,
  onOpenGitInspector,
  onSendMessage,
  onStopChat,
  onToggleBotInChat,
}: ChatWorkspaceProps) {
  const [input, setInput] = useState("");
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [addBotPopoverOpen, setAddBotPopoverOpen] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<LocalSkillItem | null>(null);
  const [overrideBotId, setOverrideBotId] = useState<string | undefined>(undefined);
  const [overrideModel, setOverrideModel] = useState<string | undefined>(undefined);
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "high">(
    "high"
  );
  const [parallelMode, setParallelMode] = useState(false);

  const [slashIndex, setSlashIndex] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);

  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  const chatParticipants = useMemo(() => {
    const list = chat.participantBotIds
      .map((id) => bots.find((b) => b.id === id))
      .filter((b): b is BotProfile => Boolean(b));
    return list.length > 0 ? list : [bots[0]].filter(Boolean);
  }, [chat.participantBotIds, bots]);

  const activeSpeakerBot = useMemo(() => {
    if (overrideBotId) {
      return bots.find((b) => b.id === overrideBotId) ?? chatParticipants[0];
    }
    return chatParticipants[0];
  }, [overrideBotId, bots, chatParticipants]);

  const chatActiveRuns = useMemo(
    () => activeRuns.filter((r) => r.chatId === chat.id),
    [activeRuns, chat.id]
  );
  const isStreaming = chatActiveRuns.length > 0;

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.messages.length, isStreaming]);

  // Detect `/` Slash Command or `@` Bot Mention token at end of input
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
    for (const b of bots) {
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
            .replace(/(?:^|\s)@[a-zA-Z0-9_-]*$/, ` @${entry.bot.name} `)
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
      if (!trimmed) return;

      if (!overridePrompt) {
        setInput("");
      }
      const skillSlug = selectedSkill?.slug;
      const isParallel = parallelMode;
      setSelectedSkill(null);
      setParallelMode(false);

      await onSendMessage({
        text: trimmed,
        skillSlug,
        overrideBotId: targetBotId ?? overrideBotId,
        overrideModel,
        overrideEffort: reasoningEffort,
        parallelMode: isParallel,
      });
    },
    [
      input,
      selectedSkill,
      parallelMode,
      onSendMessage,
      overrideBotId,
      overrideModel,
      reasoningEffort,
    ]
  );

  const activeSpeakerHarness = useMemo(
    () => harnesses.find((h) => h.kind === activeSpeakerBot?.cliDriver),
    [harnesses, activeSpeakerBot]
  );

  return (
    <main className="relative flex-1 h-full bg-[#121212] overflow-hidden">
      {/* Top Progressive Blur & Soft Vignette Feather */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-0 inset-x-0 h-24 chat-top-feather z-10"
      />

      {/* Top Drag Region + Floating Liquid Glass Bot / Swarm Header Pill */}
      <div
        data-tauri-drag-region
        className="absolute top-0 inset-x-0 h-16 px-6 flex items-center justify-between z-20 pointer-events-auto"
      >
        {/* Left: Git Branch & Changed Files Pill */}
        <div className="flex items-center gap-2">
          {gitStatus.isRepo && (
            <button
              type="button"
              onClick={onOpenGitInspector}
              title="Inspect Git branch, modified files & worktrees"
              className="h-8 px-3 rounded-full floating-header-pill flex items-center gap-2 text-xs text-zinc-200 hover:text-white active:scale-95"
            >
              <FolderKanban className="w-3.5 h-3.5 text-[#8cf1fb]" />
              <span className="font-mono font-medium truncate max-w-[140px]">
                {gitStatus.branch}
              </span>
              {gitStatus.changedFiles.length > 0 && (
                <span className="px-1.5 py-0.2 rounded-full bg-amber-500/20 text-amber-300 text-[10.5px] font-semibold">
                  {gitStatus.changedFiles.length}
                </span>
              )}
            </button>
          )}
        </div>

        {/* Center: Floating Bot / Swarm Header Pill */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleInspector}
            title="Toggle Bot Settings, Swarm Config, Git Diffs & Computer (Cmd+I)"
            className={`px-4 py-1.5 rounded-full flex items-center gap-2.5 active:scale-[0.97] ${
              inspectorOpen
                ? "liquid-glass-active text-white"
                : "floating-header-pill text-zinc-100"
            }`}
          >
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
                  size={24}
                  useHeroMascot={activeSpeakerBot.isPrimary}
                />
              )
            )}
            <span className="text-[14.5px] font-semibold tracking-tight max-w-[260px] truncate">
              {chat.isPrimary ? "Omni" : chat.title}
            </span>
            {chatParticipants.length === 1 && activeSpeakerBot && (
              <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-white/[0.07] text-zinc-300">
                {activeSpeakerBot.cliDriver}
              </span>
            )}
          </button>

          {/* Quick "+ Add Bot to Room" Popover Trigger */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setAddBotPopoverOpen((v) => !v)}
              title="Add or remove Bots in this conversation (Swarm Room)"
              className="h-8 px-2.5 rounded-full floating-header-pill flex items-center gap-1 text-xs text-zinc-300 hover:text-white active:scale-95"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Bots ({chatParticipants.length})</span>
            </button>

            {addBotPopoverOpen && (
              <>
                <div
                  className="fixed inset-0 z-20"
                  onClick={() => setAddBotPopoverOpen(false)}
                />
                <div className="absolute right-0 mt-2 w-64 rounded-2xl liquid-glass-modal p-2.5 z-30 space-y-1.5 shadow-2xl">
                  <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                    Bots in this conversation
                  </div>
                  {bots.map((b) => {
                    const inChat = chat.participantBotIds.includes(b.id);
                    return (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => onToggleBotInChat(b.id)}
                        className={`w-full px-2.5 py-2 rounded-xl flex items-center justify-between gap-2 text-left text-xs transition-colors ${
                          inChat
                            ? "liquid-glass-active text-white"
                            : "hover:bg-white/[0.06] text-zinc-300"
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <BotCharacterAvatar bot={b} size={26} showCliBadge />
                          <div className="min-w-0">
                            <div className="font-semibold truncate">{b.name}</div>
                            <div className="text-[11px] text-zinc-400 truncate">
                              {b.cliDriver} · {b.roleTitle}
                            </div>
                          </div>
                        </div>
                        {inChat && (
                          <Check className="w-4 h-4 text-[#8cf1fb] shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Right: Active Swarm Status or Empty Spacer */}
        <div className="flex items-center justify-end min-w-[90px]">
          {isStreaming && (
            <button
              type="button"
              onClick={onStopChat}
              className="h-8 px-3 rounded-full bg-red-500/20 hover:bg-red-500/30 border border-red-400/35 text-red-200 text-xs font-medium flex items-center gap-1.5 active:scale-95 transition-colors"
            >
              <StopCircle className="w-3.5 h-3.5 text-red-300" />
              <span>Stop ({chatActiveRuns.length})</span>
            </button>
          )}
        </div>
      </div>

      {/* Full-Height Scrollable Transcript Area */}
      <div className="h-full w-full overflow-y-auto overflow-x-hidden chat-scroll-mask px-6 pt-20 pb-40">
        <div className="max-w-[760px] mx-auto space-y-5">
          {chat.messages.length === 0 && (
            <EmptyChatHero
              chat={chat}
              participants={chatParticipants}
              allBots={bots}
              onSendStarter={(prompt) => handleSend(prompt)}
            />
          )}

          {chat.messages.map((msg) => (
            <MessageCard
              key={msg.id}
              message={msg}
              bots={bots}
              onQuickHandoff={(targetBot, sourceText) => {
                const snippet = sourceText.slice(0, 500);
                handleSend(
                  `@${targetBot.name} review @${msg.authorName || "Bot"}'s response above and follow up or improve on it:\n\n> ${snippet.replace(/\n/g, "\n> ")}`,
                  targetBot.id
                );
              }}
            />
          ))}

          {isStreaming && (
            <div className="flex flex-wrap items-center gap-2.5 text-xs text-zinc-300 pl-1 py-1">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[#8cf1fb]" />
              <span>
                {chatActiveRuns
                  .map(
                    (r) =>
                      `@${r.botName} (${r.cliDriver}) is ${
                        r.activity === "thinking"
                          ? "thinking"
                          : r.activity.startsWith("tool:")
                            ? `running ${r.activity.slice(5)}`
                            : "responding"
                      }`
                  )
                  .join(" · ")}
                ...
              </span>
              <button
                type="button"
                onClick={onStopChat}
                className="ml-1 px-2.5 py-0.5 rounded-full liquid-glass-chip text-zinc-200 hover:text-white text-[11px]"
              >
                Stop
              </button>
            </div>
          )}

          <div ref={transcriptEndRef} className="h-10 shrink-0" />
        </div>
      </div>

      {/* Bottom Progressive Blur & Soft Vignette Feather */}
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 inset-x-0 h-32 chat-bottom-feather z-10"
      />

      {/* Floating Bottom Composer Area with Liquid Glass */}
      <div className="absolute bottom-0 inset-x-0 px-5 pb-4 pt-2 z-20 pointer-events-none">
        <div className="max-w-[760px] mx-auto relative pointer-events-auto">
          {/* `/` Slash Command & Skill Autocomplete Popover */}
          {slashMatch && matchingSlashItems.length > 0 && (
            <div className="mb-2.5 rounded-2xl liquid-glass-modal p-2 shadow-2xl space-y-1 max-h-64 overflow-y-auto">
              <div className="px-2.5 py-1 flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-zinc-400">
                <span>Swarm Commands &amp; Local Skills</span>
                <span className="font-mono text-[10px] text-zinc-500">ESC</span>
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
                        <span className="text-[11px] font-mono text-zinc-400">
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
              <div className="px-2.5 py-1 flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-zinc-400">
                <span>Mention or Hand Off to a Bot</span>
                <span className="font-mono text-[10px] text-zinc-500">ESC</span>
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
                      <BotCharacterAvatar
                        bot={entry.bot}
                        size={32}
                        showCliBadge
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13.5px] font-semibold truncate">
                          {entry.kind === "all"
                            ? "@all — Full Swarm Broadcast"
                            : `@${entry.bot.name}`}
                        </span>
                        {entry.kind === "bot" && (
                          <span className="text-[11px] font-mono text-zinc-400">
                            {entry.bot.cliDriver}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-zinc-400 truncate">
                        {entry.kind === "all"
                          ? "Dispatch to every Bot in the Swarm Room in parallel"
                          : entry.bot.roleTitle}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Active Chips Row: Selected Skill, Parallel Mode, Speaker Override */}
          {(selectedSkill || parallelMode || overrideBotId || overrideModel) && (
            <div className="flex flex-wrap items-center gap-2 mb-2 px-1">
              {parallelMode && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full liquid-glass-chip border-emerald-400/35 text-emerald-200 text-xs font-medium">
                  <ArrowLeftRight className="w-3 h-3" />
                  <span>Parallel Swarm Mode</span>
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
                  <BotCharacterAvatar bot={activeSpeakerBot} size={15} />
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
            className={`absolute bottom-14 left-0 w-80 rounded-2xl liquid-glass-modal p-2.5 z-30 space-y-2.5 origin-bottom-left transition-all duration-220 spring-transition ${
              composerMenuOpen
                ? "scale-100 opacity-100 translate-y-0 pointer-events-auto"
                : "scale-[0.94] opacity-0 translate-y-2 pointer-events-none"
            }`}
          >
            {/* Target Bot Picker */}
            <div className="px-1">
              <div className="px-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">
                Route Turn to Bot
              </div>
              <div className="max-h-36 overflow-y-auto space-y-0.5 pr-0.5">
                {bots.map((b) => {
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
                        <span className="text-[10.5px] font-mono text-zinc-400">
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

            {/* Model Override for Active CLI Driver */}
            {activeSpeakerHarness && activeSpeakerHarness.models.length > 0 && (
              <div className="border-t border-white/[0.07] pt-2 px-1">
                <div className="px-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5 flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5" />
                  <span>{activeSpeakerHarness.name} Model</span>
                </div>
                <div className="max-h-32 overflow-y-auto space-y-0.5 pr-0.5">
                  <button
                    type="button"
                    onClick={() => setOverrideModel(undefined)}
                    className={`w-full px-2.5 py-1.5 rounded-xl flex items-center justify-between text-xs transition-colors ${
                      !overrideModel
                        ? "liquid-glass-active text-white font-semibold"
                        : "hover:bg-white/[0.06] text-zinc-300"
                    }`}
                  >
                    <span>
                      Default ({activeSpeakerBot?.model || activeSpeakerHarness.models[0]})
                    </span>
                    {!overrideModel && (
                      <Check className="w-3.5 h-3.5 text-cyan-400" />
                    )}
                  </button>
                  {activeSpeakerHarness.models.map((m) => {
                    const active = overrideModel === m;
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setOverrideModel(m)}
                        className={`w-full px-2.5 py-1.5 rounded-xl flex items-center justify-between text-xs font-mono transition-colors ${
                          active
                            ? "liquid-glass-active text-white font-semibold"
                            : "hover:bg-white/[0.06] text-zinc-300"
                        }`}
                      >
                        <span className="truncate">{m}</span>
                        {active && (
                          <Check className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Thinking Effort */}
            <div className="px-2 pb-1 border-t border-white/[0.07] pt-2">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">
                Reasoning Effort
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {(["low", "medium", "high"] as const).map((lvl) => (
                  <button
                    key={lvl}
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

          {/* Main Liquid Glass Pill Composer */}
          <div className="min-h-[48px] rounded-full liquid-glass-pill px-2.5 py-1.5 flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setComposerMenuOpen((v) => !v)}
              title="Switch target Bot, CLI model, or parallel swarm mode"
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
                  ? `Message Swarm (${chatParticipants.map((b) => `@${b.name}`).join(", ")}) — type @ to hand off, / for skills`
                  : `Message ${activeSpeakerBot?.name || "Omni"} (${activeSpeakerBot?.cliDriver || "cli"}) — type @ to summon another Bot, / for skills`
              }
              className="flex-1 bg-transparent text-[15px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
            />

            <button
              type="button"
              disabled={!input.trim()}
              onClick={() => handleSend()}
              title="Send message"
              className="w-8 h-8 rounded-full bg-white hover:bg-zinc-200 disabled:opacity-35 text-black flex items-center justify-center transition-transform active:scale-95 shadow-md shrink-0"
            >
              <ArrowUp className="w-4 h-4 stroke-[2.5]" />
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

function EmptyChatHero({
  chat,
  participants,
  allBots,
  onSendStarter,
}: {
  chat: ChatThread;
  participants: BotProfile[];
  allBots: BotProfile[];
  onSendStarter: (prompt: string) => void;
}) {
  const lead = participants[0];
  const second =
    participants[1] ??
    allBots.find((b) => !b.isPrimary && b.id !== lead?.id) ??
    lead;

  const starters = chat.isGroup
    ? [
        {
          title: "Architecture & Implementation Handoff",
          prompt: `@${lead?.name || "Claude"} design a clean implementation plan for our next feature, then hand off to @${second?.name || "Codex"} to review and verify edge cases.`,
        },
        {
          title: "Parallel Swarm Audit (@all)",
          prompt:
            "@all Inspect the current repository structure and report the top 2 improvements from your perspective.",
        },
      ]
    : [
        {
          title: `Analyze Workspace with ${lead?.name || "Bot"}`,
          prompt:
            "Summarize the architecture of this workspace and check `git status` for any pending changes.",
        },
        {
          title: `Collaborate with @${second?.name || "Codex"}`,
          prompt: `Review the codebase for any bugs or code smells, and hand off to @${second?.name || "Codex"} to double-check your findings.`,
        },
      ];

  return (
    <div className="pt-12 pb-6 flex flex-col items-center text-center space-y-4">
      {participants.length > 1 ? (
        <div className="flex items-center -space-x-3">
          {participants.map((b) => (
            <BotCharacterAvatar key={b.id} bot={b} size={58} showCliBadge />
          ))}
        </div>
      ) : (
        lead && (
          <BotCharacterAvatar
            bot={lead}
            size={68}
            showCliBadge={!lead.isPrimary}
            showStarBadge={lead.isPrimary}
            useHeroMascot={lead.isPrimary}
          />
        )
      )}

      <div className="space-y-1 max-w-md">
        <h2 className="text-lg font-semibold text-white">{chat.title}</h2>
        <p className="text-xs text-[#8e8d8a] leading-relaxed">
          {chat.isGroup
            ? `Multi-Bot Swarm Room with ${participants.map((b) => `@${b.name} (${b.cliDriver})`).join(", ")}. Bots can talk to each other and hand off work automatically.`
            : lead?.description}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 w-full max-w-[600px] pt-2">
        {starters.map((s) => (
          <button
            key={s.title}
            type="button"
            onClick={() => onSendStarter(s.prompt)}
            className="p-3.5 rounded-2xl liquid-glass-card hover:bg-[#222222] text-left space-y-1 transition-all active:scale-[0.99]"
          >
            <div className="text-[13.5px] font-semibold text-zinc-100">
              {s.title}
            </div>
            <div className="text-xs text-[#8e8d8a] line-clamp-2">{s.prompt}</div>
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
}: {
  message: ChatMessage;
  bots: BotProfile[];
  onQuickHandoff: (targetBot: BotProfile, sourceText: string) => void;
}) {
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  const authorBot = useMemo(
    () => bots.find((b) => b.id === message.authorBotId),
    [bots, message.authorBotId]
  );

  const renderedHtml = useMemo(() => {
    const cleanText = message.text
      .replace(/<handoff[\s\S]*?<\/handoff>/gi, "")
      .trim();
    if (!cleanText) return "";
    const rawHtml = marked.parse(cleanText, { async: false }) as string;
    return rawHtml.replace(
      /(^|\s)(@[a-zA-Z0-9_-]+)/g,
      '$1<span class="bot-mention-pill">$2</span>'
    );
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
    <div className="group flex items-start gap-3 min-w-0">
      <div className="pt-0.5 shrink-0">
        <BotCharacterAvatar
          bot={authorBot}
          shape={message.authorShape ?? authorBot?.shape ?? "blob"}
          color={message.authorColor ?? authorBot?.color ?? "cyan"}
          cliDriver={message.cliDriver ?? authorBot?.cliDriver}
          isPrimary={authorBot?.isPrimary}
          size={36}
          isStreaming={message.status === "streaming"}
          showCliBadge={!authorBot?.isPrimary}
          showStarBadge={authorBot?.isPrimary}
          useHeroMascot={authorBot?.isPrimary}
        />
      </div>

      <div className="flex-1 max-w-[640px] min-w-0 space-y-2">
        <div className="w-full overflow-hidden rounded-2xl liquid-glass-card px-5 py-4 text-[15px] text-zinc-100 space-y-3 break-words">
          {/* Bot Identity & CLI Harness Header Bar */}
          <div className="flex items-center justify-between gap-2 pb-1 border-b border-white/[0.05]">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[13.5px] font-semibold text-white truncate">
                {message.authorName || authorBot?.name || "Bot"}
              </span>
              {message.cliDriver && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/[0.06] text-[11px] font-mono text-zinc-300">
                  <CliProviderGlyph driver={message.cliDriver} size={11} />
                  <span>{message.cliDriver}</span>
                  {message.model && (
                    <span className="text-zinc-400">· {message.model}</span>
                  )}
                </span>
              )}
              {message.worktreePath && (
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 text-[10.5px] font-mono">
                  worktree
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 text-[11.5px] text-[#8e8d8a] shrink-0">
              {message.durationMs != null && message.durationMs > 0 && (
                <span>{(message.durationMs / 1000).toFixed(1)}s</span>
              )}
              {message.status === "streaming" && (
                <span className="text-[#8cf1fb] flex items-center gap-1 font-medium">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Live</span>
                </span>
              )}
            </div>
          </div>

          {/* Collapsible Thinking / Reasoning Block */}
          {message.thinking && (
            <div className="rounded-xl liquid-glass-chip px-3 py-2">
              <button
                type="button"
                onClick={() => setThinkingExpanded((v) => !v)}
                className="w-full flex items-center justify-between text-xs text-zinc-300 hover:text-white"
              >
                <span className="flex items-center gap-1.5 font-medium">
                  <BrainIcon className="w-3.5 h-3.5 text-purple-300" />
                  <span>Thought process</span>
                </span>
                {thinkingExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
              </button>
              {thinkingExpanded && (
                <p className="mt-2 pt-2 border-t border-white/[0.06] text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap font-mono">
                  {message.thinking}
                </p>
              )}
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
                <div className="mt-2 pt-2 border-t border-white/[0.06] space-y-2">
                  {message.toolCalls.map((tc) => (
                    <div
                      key={tc.id}
                      className="rounded-lg bg-black/35 px-2.5 py-1.5 space-y-1 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11.5px] text-zinc-200 flex items-center gap-1.5 truncate">
                          <TerminalIcon className="w-3 h-3 text-cyan-400 shrink-0" />
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
          {renderedHtml ? (
            <div
              className="omni-prose"
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          ) : (
            message.status === "streaming" && (
              <div className="text-xs text-zinc-500 italic">
                Waiting for CLI output...
              </div>
            )
          )}

          {/* Outgoing Bot-to-Bot Handoff Banners */}
          {message.handoffs.length > 0 && (
            <div className="pt-1 space-y-1.5">
              {message.handoffs.map((h, i) => (
                <div
                  key={i}
                  className="rounded-xl bg-[#8cf1fb]/10 border border-[#8cf1fb]/25 px-3 py-2 flex items-center justify-between gap-2 text-xs text-[#8cf1fb]"
                >
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
              ))}
            </div>
          )}
        </div>

        {/* Hover Action Row: One-Click Pass Baton / Cross-Review with Another CLI Bot */}
        {message.status === "complete" &&
          message.text.trim().length > 0 &&
          otherBots.length > 0 && (
            <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1.5 pl-1">
              <span className="text-[11px] text-zinc-500 mr-1">Hand off to:</span>
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
            </div>
          )}
      </div>
    </div>
  );
}
