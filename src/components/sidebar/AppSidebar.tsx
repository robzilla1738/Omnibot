import {
  Blocks,
  LayoutGrid,
  MessageSquare,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActiveBotRun,
  BotProfile,
  ChatThread,
  CliHarnessInfo,
} from "../../lib/types";
import { BotCharacterAvatar, CliProviderGlyph } from "../icons/BotCharacterAvatar";

const COLLAPSED_WIDTH = 92;
const DEFAULT_EXPANDED_WIDTH = 290;
const MIN_EXPANDED_WIDTH = 248;
const MAX_EXPANDED_WIDTH = 420;
const SNAP_THRESHOLD = 165;

export interface AppSidebarProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  primaryBot: BotProfile;
  bots: BotProfile[];
  chats: ChatThread[];
  activeChatId: string;
  activeRuns: ActiveBotRun[];
  harnesses: CliHarnessInfo[];
  onSelectPrimary: () => void;
  onSelectBotDirectChat: (bot: BotProfile) => void;
  onSelectChat: (chatId: string) => void;
  onNewChatOrSwarm: () => void;
  onNewBot: () => void;
  onOpenSearch: () => void;
  onDeleteChat: (chatId: string, e: React.MouseEvent) => void;
  onOpenCliHarnesses: () => void;
  onOpenOmniHub: () => void;
}

export function AppSidebar({
  collapsed,
  onCollapsedChange,
  primaryBot,
  bots,
  chats,
  activeChatId,
  activeRuns,
  harnesses,
  onSelectPrimary,
  onSelectBotDirectChat,
  onSelectChat,
  onNewChatOrSwarm,
  onNewBot,
  onOpenSearch,
  onDeleteChat,
  onOpenCliHarnesses,
  onOpenOmniHub,
}: AppSidebarProps) {
  const [expandedWidth, setExpandedWidth] = useState(DEFAULT_EXPANDED_WIDTH);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{
    startX: number;
    startWidth: number;
    moved: boolean;
  } | null>(null);

  const currentWidth = collapsed ? COLLAPSED_WIDTH : expandedWidth;

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      dragStartRef.current = {
        startX: e.clientX,
        startWidth: collapsed ? COLLAPSED_WIDTH : expandedWidth,
        moved: false,
      };
      setIsDragging(true);
    },
    [collapsed, expandedWidth]
  );

  useEffect(() => {
    if (!isDragging) return;

    const handlePointerMove = (e: PointerEvent) => {
      const state = dragStartRef.current;
      if (!state) return;
      const delta = e.clientX - state.startX;
      if (Math.abs(delta) > 4) {
        state.moved = true;
      }
      if (!state.moved) return;

      const rawWidth = state.startWidth + delta;
      if (rawWidth < SNAP_THRESHOLD) {
        if (!collapsed) onCollapsedChange(true);
      } else {
        if (collapsed) onCollapsedChange(false);
        const clamped = Math.max(
          MIN_EXPANDED_WIDTH,
          Math.min(MAX_EXPANDED_WIDTH, rawWidth)
        );
        setExpandedWidth(clamped);
      }
    };

    const handlePointerUp = () => {
      const state = dragStartRef.current;
      dragStartRef.current = null;
      setIsDragging(false);
      if (state && !state.moved) {
        onCollapsedChange(!collapsed);
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    document.body.style.cursor = "col-resize";
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.style.cursor = "";
    };
  }, [isDragging, collapsed, onCollapsedChange]);

  const primaryChat = chats.find((c) => c.isPrimary);
  const isPrimarySelected = primaryChat ? activeChatId === primaryChat.id : false;
  const rosterBots = bots.filter((b) => !b.isPrimary);
  const installedHarnesses = harnesses.filter((h) => h.installed);

  // Only show Multi-Bot Swarm Rooms and custom Sidechats (never duplicate 1:1 Bot threads)
  const swarmAndSidechats = chats.filter(
    (c) => !c.isPrimary && !c.id.startsWith("chat-direct-")
  );

  const isPrimaryStreaming = activeRuns.some((r) => r.botId === primaryBot.id);

  return (
    <aside
      style={{ width: currentWidth }}
      className={`relative shrink-0 h-full bg-[#0e0e0e] border-r border-white/[0.06] flex flex-col justify-between select-none z-20 overflow-hidden ${
        isDragging ? "" : "transition-[width] duration-300 spring-transition"
      }`}
    >
      {/* Top Drag Bar + Primary Botfinity Hero Card */}
      <div>
        <div
          data-tauri-drag-region
          className="h-16 pt-2 px-4 flex items-center justify-end gap-2.5"
        >
          <div
            className={`flex items-center gap-2.5 transition-all duration-200 spring-transition ${
              collapsed
                ? "opacity-0 scale-90 pointer-events-none w-0 overflow-hidden"
                : "opacity-100 scale-100"
            }`}
          >
            <button
              type="button"
              onClick={onOpenSearch}
              title="Search Bots, Swarm Rooms, Projects & Skills (Cmd+K)"
              className="w-10 h-10 rounded-full bg-[#1f1f1f] hover:bg-[#282828] border border-white/[0.06] flex items-center justify-center text-zinc-200 hover:text-white active:scale-95 transition-colors"
            >
              <Search className="w-[17px] h-[17px]" />
            </button>
            <button
              type="button"
              onClick={onNewChatOrSwarm}
              title="New Swarm Room or Thread (Cmd+N)"
              className="w-10 h-10 rounded-full bg-[#1f1f1f] hover:bg-[#282828] border border-white/[0.06] flex items-center justify-center text-zinc-200 hover:text-white active:scale-95 transition-colors"
            >
              <Plus className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>

        {/* Featured Primary Coordinator Card */}
        <div
          className={`flex flex-col items-center transition-all duration-300 spring-transition ${
            collapsed ? "px-3 pt-1 pb-3" : "px-4 pt-1 pb-4"
          }`}
        >
          <button
            type="button"
            onClick={onSelectPrimary}
            title={`${primaryBot.name} (Primary Coordinator)`}
            className="group flex flex-col items-center justify-center transition-all duration-300 spring-transition active:scale-[0.97] bg-transparent"
          >
            <BotCharacterAvatar
              bot={primaryBot}
              size={collapsed ? 48 : 72}
              isStreaming={isPrimaryStreaming}
              showStarBadge
            />
            <span
              className={`text-[15px] font-medium tracking-tight transition-all duration-200 overflow-hidden ${
                isPrimarySelected
                  ? "text-white"
                  : "text-zinc-300 group-hover:text-white"
              } ${
                collapsed ? "max-h-0 opacity-0 mt-0" : "max-h-7 opacity-100 mt-2"
              }`}
            >
              {primaryBot.name}
            </span>
          </button>
        </div>
      </div>

      {/* Collapsed Rail: Quick Bot Avatars */}
      {collapsed && (
        <div className="flex-1 overflow-y-auto sidebar-scroll-mask py-2 flex flex-col items-center gap-3">
          {rosterBots.map((bot) => {
            const directId = `chat-direct-${bot.slug}`;
            const altDirectId = `chat-direct-${bot.id}`;
            const selected =
              activeChatId === directId || activeChatId === altDirectId;
            const running = activeRuns.some((r) => r.botId === bot.id);
            return (
              <button
                key={bot.id}
                type="button"
                onClick={() => onSelectBotDirectChat(bot)}
                title={`${bot.name} (${bot.cliDriver})`}
                className={`p-1.5 rounded-2xl transition-all active:scale-95 ${
                  selected
                    ? "bg-[#222225] ring-1 ring-white/15"
                    : "hover:bg-[#18181b]"
                }`}
              >
                <BotCharacterAvatar
                  bot={bot}
                  size={38}
                  isStreaming={running}
                />
              </button>
            );
          })}
        </div>
      )}

      {/* Expanded Middle: Local CLI Bots Roster + Swarm Rooms */}
      <div
        className={`flex-1 overflow-y-auto overflow-x-hidden sidebar-scroll-mask px-3 pt-1 pb-24 space-y-5 transition-all duration-250 spring-transition ${
          collapsed
            ? "opacity-0 pointer-events-none translate-x-[-8px] hidden"
            : "opacity-100 translate-x-0"
        }`}
      >
        {/* Local CLI & Custom Bots Roster */}
        <div className="space-y-1">
          <div className="px-2.5 pb-1.5 flex items-center justify-between">
            <span className="text-[13.5px] font-normal text-[#8e8d8a]">
              Bots
            </span>
            <button
              type="button"
              onClick={onNewBot}
              className="text-[12.5px] text-zinc-400 hover:text-white flex items-center gap-1 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New</span>
            </button>
          </div>

          {rosterBots.map((bot) => {
            const directId = `chat-direct-${bot.slug}`;
            const altDirectId = `chat-direct-${bot.id}`;
            const selected =
              activeChatId === directId || activeChatId === altDirectId;
            const run = activeRuns.find((r) => r.botId === bot.id);
            const showDriverPill =
              bot.name.toLowerCase() !== bot.cliDriver.toLowerCase();

            return (
              <button
                key={bot.id}
                type="button"
                onClick={() => onSelectBotDirectChat(bot)}
                className={`w-full group flex items-center gap-3 px-3 py-2 rounded-[16px] text-left transition-colors ${
                  selected
                    ? "bg-[#1b1b1b] text-white"
                    : "hover:bg-[#161616] text-zinc-300"
                }`}
              >
                <BotCharacterAvatar
                  bot={bot}
                  size={38}
                  isStreaming={Boolean(run)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-medium text-[#f4f4f5] truncate leading-[1.3]">
                      {bot.name}
                    </span>
                    {showDriverPill && (
                      <span className="text-[11px] font-mono px-1.5 py-0.2 rounded-md bg-white/[0.05] text-zinc-400 shrink-0">
                        {bot.cliDriver}
                      </span>
                    )}
                  </div>
                  <div className="text-[13px] text-[#8e8d8a] truncate mt-0.5 leading-[1.3]">
                    {run ? (
                      <span className="text-[#8cf1fb] font-medium">
                        {run.activity === "thinking"
                          ? "Thinking..."
                          : run.activity.startsWith("tool:")
                            ? `Running ${run.activity.slice(5)}...`
                            : "Writing..."}
                      </span>
                    ) : (
                      bot.roleTitle
                    )}
                  </div>
                </div>
                {run && (
                  <span className="w-2.5 h-2.5 rounded-full bg-[#8cf1fb] animate-ping shrink-0" />
                )}
              </button>
            );
          })}
        </div>

        {/* Swarm Rooms & Threads */}
        {swarmAndSidechats.length > 0 && (
          <div className="space-y-1">
            <div className="px-2.5 pb-1.5 flex items-center justify-between">
              <span className="text-[13.5px] font-normal text-[#8e8d8a]">
                Swarm Rooms
              </span>
              <button
                type="button"
                onClick={onNewChatOrSwarm}
                className="text-[12.5px] text-zinc-400 hover:text-white flex items-center gap-1 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New</span>
              </button>
            </div>

            {swarmAndSidechats.map((chat) => {
              const selected = chat.id === activeChatId;
              const chatBots = chat.participantBotIds
                .map((id) => bots.find((b) => b.id === id))
                .filter((b): b is BotProfile => Boolean(b));
              const isBusy = activeRuns.some((r) => r.chatId === chat.id);

              return (
                <div
                  key={chat.id}
                  onClick={() => onSelectChat(chat.id)}
                  className={`group relative flex items-center gap-3 px-3 py-2.5 rounded-[16px] cursor-pointer transition-colors ${
                    selected
                      ? "bg-[#1b1b1b] text-white"
                      : "hover:bg-[#161616] text-zinc-300"
                  }`}
                >
                  {chat.isGroup && chatBots.length >= 2 ? (
                    <div className="w-[38px] h-[38px] rounded-[11px] bg-[#19191c] border border-white/[0.07] flex items-center justify-center -space-x-2 shrink-0 px-1">
                      {chatBots.slice(0, 2).map((b) => (
                        <BotCharacterAvatar key={b.id} bot={b} size={22} />
                      ))}
                    </div>
                  ) : chatBots[0] ? (
                    <BotCharacterAvatar bot={chatBots[0]} size={38} />
                  ) : (
                    <div className="w-[38px] h-[38px] rounded-[11px] bg-[#1b1b1b] border border-white/[0.06] text-zinc-400 flex items-center justify-center shrink-0">
                      <MessageSquare className="w-[18px] h-[18px]" />
                    </div>
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-medium text-[#f4f4f5] truncate leading-[1.3]">
                      {chat.title}
                    </div>
                    <p className="text-[13px] text-[#8e8d8a] truncate mt-0.5 leading-[1.3]">
                      {chat.isGroup
                        ? chatBots.map((b) => `@${b.name}`).join(" · ")
                        : formatRelativeUpdated(chat.updatedAtMs)}
                    </p>
                  </div>

                  {isBusy && (
                    <span className="w-2.5 h-2.5 rounded-full bg-[#2f7cf6] animate-pulse shrink-0 group-hover:hidden" />
                  )}

                  <button
                    type="button"
                    onClick={(e) => onDeleteChat(chat.id, e)}
                    title="Delete thread"
                    className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-white/[0.06] transition-all shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom Progressive Blur & Soft Vignette Feather */}
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 inset-x-0 h-24 sidebar-bottom-feather z-10"
      />

      {/* Bottom Dock: Botfinity Hub + CLI Harnesses Pill */}
      {collapsed ? (
        <div className="relative z-20 flex flex-col items-center gap-3 pb-4 pt-2">
          <button
            type="button"
            onClick={onNewChatOrSwarm}
            title="Start a new Swarm Room or Sidechat (Cmd+N)"
            className="w-11 h-11 rounded-full bg-[#1f1f1f] hover:bg-[#282828] border border-white/[0.05] flex items-center justify-center text-zinc-300 hover:text-white active:scale-95 transition-colors"
          >
            <Plus className="w-[18px] h-[18px]" />
          </button>
          <button
            type="button"
            onClick={onOpenOmniHub}
            title="Botfinity Hub (Bots, Projects, Memories, Skills & Routines)"
            className="w-11 h-11 rounded-full bg-[#1f1f1f] hover:bg-[#282828] border border-white/[0.05] flex items-center justify-center text-zinc-300 hover:text-white active:scale-95 transition-colors"
          >
            <LayoutGrid className="w-[18px] h-[18px]" />
          </button>
          <button
            type="button"
            onClick={onOpenCliHarnesses}
            title="CLI Harnesses & Local MCPs"
            className="w-11 h-11 rounded-full bg-[#1f1f1f] hover:bg-[#282828] border border-white/[0.05] flex items-center justify-center text-zinc-300 hover:text-white active:scale-95 transition-colors"
          >
            <Blocks className="w-[18px] h-[18px]" />
          </button>
        </div>
      ) : (
        <div className="absolute bottom-0 inset-x-0 z-20 px-4 pb-4 pt-2 flex items-center gap-2.5 pointer-events-none">
          <button
            type="button"
            onClick={onOpenOmniHub}
            title="Botfinity Hub (Bots, Projects, Memories, Skills & Routines)"
            className="pointer-events-auto w-11 h-11 rounded-full bg-[#1f1f1f] hover:bg-[#282828] text-zinc-200 border border-white/[0.06] flex items-center justify-center shrink-0 transition-colors active:scale-95"
          >
            <LayoutGrid className="w-[18px] h-[18px]" />
          </button>

          <button
            type="button"
            onClick={onOpenCliHarnesses}
            className="pointer-events-auto h-11 flex-1 min-w-0 px-4 rounded-full bg-[#1f1f1f] hover:bg-[#272727] border border-white/[0.06] flex items-center justify-between gap-2.5 transition-colors active:scale-[0.98]"
          >
            <span className="text-[14.5px] font-medium text-zinc-100 truncate">
              {installedHarnesses.length} Local CLIs
            </span>
            <div className="flex items-center -space-x-1.5 shrink-0">
              {installedHarnesses.slice(0, 4).map((h) => (
                <span
                  key={h.id}
                  className="w-[22px] h-[22px] rounded-full bg-[#141416] flex items-center justify-center ring-1 ring-white/15 shadow-xs"
                >
                  <CliProviderGlyph driver={h.kind} size={12} />
                </span>
              ))}
            </div>
          </button>
        </div>
      )}

      {/* Interactive Click & Drag Resize Handle along the right edge */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Drag or click to resize or toggle sidebar"
        title="Drag to resize · Click to toggle sidebar (Cmd+B)"
        onPointerDown={handlePointerDown}
        className="group/resizer absolute top-0 right-0 bottom-0 w-2.5 cursor-col-resize z-30 flex items-center justify-center"
      >
        <div
          className={`w-[3px] rounded-full transition-all duration-200 ${
            isDragging
              ? "h-24 bg-cyan-400/70"
              : "h-12 bg-white/0 group-hover/resizer:bg-white/20"
          }`}
        />
      </div>
    </aside>
  );
}

function formatRelativeUpdated(ms: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return "Active just now";
  if (diffSec < 3600) return `Updated ${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `Updated ${Math.floor(diffSec / 3600)}h ago`;
  return `Updated ${new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;
}
