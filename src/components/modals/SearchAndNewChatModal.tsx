import {
  Check,
  FolderGit2,
  MessageSquare,
  Plus,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BotProfile,
  ChatThread,
  LocalSkillItem,
  WorkspaceEntry,
} from "../../lib/types";
import { BotCharacterAvatar, SkillBrandIcon } from "../icons/BotCharacterAvatar";

export interface SearchAndNewChatModalProps {
  open: boolean;
  mode: "search" | "new-swarm";
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
    useWorktrees?: boolean;
    initialPrompt?: string;
    skillSlug?: string;
  }) => Promise<void>;
}

const SWARM_PRESETS = [
  {
    id: "preset-arch-build-review",
    title: "Plan → Build → Review Swarm",
    subtitle: "@Claude designs & implements, then hands off to @Codex & @Grok for review",
    prompt:
      "@Claude analyze our task and propose a clean implementation, then hand off to @Codex to verify edge cases.",
  },
  {
    id: "preset-parallel-race",
    title: "Parallel Multi-CLI Arena (@all)",
    subtitle: "Run selected CLI Bots in parallel (with optional Git worktrees)",
    prompt: "",
  },
];

export function SearchAndNewChatModal({
  open,
  mode,
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

  useEffect(() => {
    if (open) {
      const nonPrimary = bots.filter((b) => !b.isPrimary).slice(0, 3);
      setSelectedBotIds(nonPrimary.map((b) => b.id));
      setTimeout(() => inputRef.current?.focus(), 40);
    } else {
      setQuery("");
    }
  }, [open, bots]);

  const trimmedQuery = query.trim().toLowerCase();

  const toggleBotSelection = (id: string) => {
    setSelectedBotIds((prev) =>
      prev.includes(id)
        ? prev.length > 1
          ? prev.filter((x) => x !== id)
          : prev
        : [...prev, id]
    );
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
      className={`fixed inset-0 z-50 flex items-start justify-center pt-16 px-4 select-none transition-all duration-220 spring-transition ${
        open
          ? "bg-black/65 backdrop-blur-md opacity-100 pointer-events-auto"
          : "bg-black/0 backdrop-blur-none opacity-0 pointer-events-none"
      }`}
      onClick={onClose}
    >
      <div
        className={`w-full max-w-[560px] max-h-[80vh] rounded-[22px] bg-[#121212] border border-white/[0.08] shadow-[0_28px_90px_rgba(0,0,0,0.85)] flex flex-col overflow-hidden transition-all duration-240 spring-transition ${
          open
            ? "scale-100 opacity-100 translate-y-0"
            : "scale-[0.96] opacity-0 -translate-y-2"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Search / Input Bar */}
        <div className="shrink-0 px-4 py-3.5 border-b border-white/[0.06] flex items-center gap-3">
          <Search className="w-[18px] h-[18px] text-[#8e8d8a] shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              mode === "search"
                ? "Search Bots, Swarm Rooms, Projects, and Skills..."
                : "Swarm Room or Thread title (optional)..."
            }
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "Enter" && mode === "new-swarm") {
                onCreateSwarmOrChat({
                  title: query.trim() || undefined,
                  participantBotIds: selectedBotIds,
                  useWorktrees,
                });
                onClose();
              }
            }}
            className="w-full bg-transparent text-[15px] text-zinc-100 placeholder:text-[#8e8d8a] focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-[#1f1f1f] hover:bg-[#272727] border border-white/[0.06] flex items-center justify-center text-zinc-300 hover:text-white shrink-0 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 p-3.5 overflow-y-auto space-y-4">
          {mode === "new-swarm" ? (
            <>
              {/* Select Bots for Swarm Room */}
              <div className="space-y-2">
                <div className="px-1 flex items-center justify-between text-xs text-[#8e8d8a]">
                  <span>
                    Select 1 Bot for a Thread or 2+ Bots for a Swarm Room (
                    {selectedBotIds.length} selected)
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {bots.map((b) => {
                    const selected = selectedBotIds.includes(b.id);
                    return (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => toggleBotSelection(b.id)}
                        className={`p-2.5 rounded-2xl flex items-center justify-between gap-2.5 text-left transition-all ${
                          selected
                            ? "bg-[#222226] border border-white/15 text-white"
                            : "bg-[#171719] border border-white/[0.05] text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <BotCharacterAvatar
                            bot={b}
                            size={34}
                            showCliBadge={!b.isPrimary}
                            showStarBadge={b.isPrimary}
                            useHeroMascot={b.isPrimary}
                          />
                          <div className="min-w-0">
                            <div className="text-[13.5px] font-semibold truncate">
                              {b.name}
                            </div>
                            <div className="text-[11px] font-mono text-zinc-400 truncate">
                              {b.cliDriver}
                            </div>
                          </div>
                        </div>
                        {selected && (
                          <Check className="w-4 h-4 text-[#8cf1fb] shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Git Worktree Toggle */}
              <div className="px-3.5 py-2.5 rounded-2xl bg-[#18181b] border border-white/[0.06] flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <FolderGit2 className="w-4 h-4 text-[#8cf1fb]" />
                  <div>
                    <div className="text-[13.5px] font-medium text-zinc-100">
                      Isolate Bots in Git Worktrees
                    </div>
                    <div className="text-[11.5px] text-[#8e8d8a]">
                      Each Bot edits its own branch without stepping on teammates
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={useWorktrees}
                  onClick={() => setUseWorktrees((v) => !v)}
                  className={`relative inline-flex h-6 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                    useWorktrees ? "bg-[#3b82f6]" : "bg-white/[0.14]"
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition ${
                      useWorktrees ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {/* Start Button */}
              <button
                type="button"
                onClick={() => {
                  onCreateSwarmOrChat({
                    title: query.trim() || undefined,
                    participantBotIds: selectedBotIds,
                    useWorktrees,
                  });
                  onClose();
                }}
                className="w-full flex items-center justify-between gap-3.5 px-4 py-3 rounded-[16px] bg-white hover:bg-zinc-200 text-black text-left transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Plus className="w-5 h-5 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[14.5px] font-semibold truncate">
                      {selectedBotIds.length > 1
                        ? `Launch Swarm Room (${selectedBotIds.length} Bots)`
                        : "Start Focused 1:1 Thread"}
                    </div>
                  </div>
                </div>
                <span className="px-3 py-1 rounded-full bg-black text-white text-xs font-semibold shrink-0">
                  Start
                </span>
              </button>

              {/* Quick Swarm Presets */}
              <div className="space-y-1.5">
                <div className="px-1 text-xs text-[#8e8d8a]">Swarm Presets</div>
                {SWARM_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => {
                      onCreateSwarmOrChat({
                        title: preset.title,
                        participantBotIds: selectedBotIds,
                        useWorktrees:
                          preset.id === "preset-parallel-race" || useWorktrees,
                        initialPrompt: preset.prompt || undefined,
                      });
                      onClose();
                    }}
                    className="w-full px-3.5 py-2.5 rounded-2xl bg-[#19191c] hover:bg-[#222226] text-left transition-colors"
                  >
                    <div className="text-[13.5px] font-semibold text-zinc-100">
                      {preset.title}
                    </div>
                    <div className="text-xs text-[#8e8d8a] mt-0.5">
                      {preset.subtitle}
                    </div>
                  </button>
                ))}
              </div>
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
                        <span className="text-[11px] font-mono text-zinc-400">
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

              {/* Threads & Swarm Rooms */}
              {filteredChats.length > 0 && (
                <div className="space-y-1">
                  <div className="px-2 text-xs text-[#8e8d8a]">
                    Swarm Rooms &amp; Threads
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
                          <div className="text-[12px] font-mono text-[#8e8d8a] truncate">
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
      </div>
    </div>
  );
}
