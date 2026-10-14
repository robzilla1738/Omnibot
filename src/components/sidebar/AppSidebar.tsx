import { SidebarSections } from "./SidebarSections";
import {
  Blocks,
  Copy,
  Palette,
  Pin,
  PinOff,
  Settings2,
  Pencil,
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
  WorkspaceEntry,
} from "../../lib/types";
import { BotCharacterAvatar, CliProviderGlyph } from "../icons/BotCharacterAvatar";

const COLLAPSED_WIDTH = 92;
const DEFAULT_EXPANDED_WIDTH = 290;
const MIN_EXPANDED_WIDTH = 248;
const MAX_EXPANDED_WIDTH = 420;
const SNAP_THRESHOLD = 165;

export interface AppSidebarProps {
  workspaces: WorkspaceEntry[];
  onSelectProject: (path: string) => Promise<void>;
  onUpsertProject: (project: WorkspaceEntry) => Promise<void>;
  onNewProject: () => void;
  collapsed: boolean;
  setupMode?: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  primaryBot: BotProfile;
  bots: BotProfile[];
  harnesses: CliHarnessInfo[];
  pinnedBotIds: string[];
  onTogglePin: (bot: BotProfile) => Promise<void>;
  onOpenSetup: () => void;
  chats: ChatThread[];
  activeChatId: string;
  activeRuns: ActiveBotRun[];
  onSelectPrimary: () => void;
  onSelectBotDirectChat: (bot: BotProfile) => void;
  onSelectChat: (chatId: string) => void;
  onNewChatOrSwarm: () => void;
  onNewGroupChat: () => void;
  onNewBot: () => void;
  onOpenSearch: () => void;
  onDeleteChat: (chatId: string, e: React.MouseEvent) => void;
  onUpdateChat: (params: { chatId: string; title?: string }) => Promise<void>;
  onUpsertBot: (bot: BotProfile) => Promise<void>;
  onDeleteBot: (botId: string) => Promise<void>;
  onCustomizeBot: (bot: BotProfile) => void;
}

type ContextMenuState =
  | {
      kind: "bot";
      bot: BotProfile;
      x: number;
      y: number;
    }
  | null;

export function AppSidebar(props: AppSidebarProps) {
  const {
    collapsed,
    setupMode = false,
    onCollapsedChange,
    primaryBot,
    bots,
    harnesses,
    pinnedBotIds,
    onTogglePin,
    onOpenSetup,
    chats,
    activeChatId,
    activeRuns,
    onSelectPrimary,
    onSelectBotDirectChat,
    onNewChatOrSwarm,
    onNewBot,
    onOpenSearch,
    onUpsertBot,
    onDeleteBot,
    onCustomizeBot,
  } = props;
  const sidebarRef = useRef<HTMLElement>(null);
  const [sidebarCustomization, setSidebarCustomization] = useState(false);
  const [expandedWidth, setExpandedWidth] = useState(DEFAULT_EXPANDED_WIDTH);
  const installedHarnesses = harnesses.filter(harness => harness.installed);
  const dockHarnesses = installedHarnesses.slice(0, expandedWidth < 280 ? 2 : expandedWidth < 360 ? 3 : 4);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{
    startX: number;
    startWidth: number;
    moved: boolean;
  } | null>(null);

  // Right-click Context Menu State
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);

  const currentWidth = collapsed ? COLLAPSED_WIDTH : expandedWidth;

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = () => setContextMenu(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  const openBotContextMenu = (e: React.MouseEvent, bot: BotProfile) => {
    e.preventDefault();
    e.stopPropagation();
    if (setupMode) return;
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 220);
    setContextMenu({ kind: "bot", bot, x, y });
  };

  const handleDuplicateBot = async (bot: BotProfile) => {
    setContextMenu(null);
    const count = bots.filter((b) => b.cliDriver === bot.cliDriver).length;
    await onUpsertBot({
      ...bot,
      id: "",
      name: `${bot.name} ${count + 1}`,
      slug: `${bot.slug}-${count + 1}`,
      isPrimary: false,
      autoCreatedForCli: false,
    });
  };

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
  const activeChatObj = chats.find((c) => c.id === activeChatId);
  const isPrimarySelected = primaryChat ? activeChatId === primaryChat.id : false;
  const rosterBots = pinnedBotIds.map((id) => bots.find((b) => b.id === id && !b.isPrimary)).filter((b): b is BotProfile => Boolean(b));

  const isBotDirectSelected = (bot: BotProfile) => {
    if (!activeChatObj || activeChatObj.isPrimary || activeChatObj.isGroup || !activeChatObj.isBotHome) {
      return false;
    }
    return (
      activeChatObj.participantBotIds.length === 1 &&
      activeChatObj.participantBotIds[0] === bot.id
    );
  };

  const isPrimaryStreaming = activeRuns.some((r) => r.botId === primaryBot.id);

  return (
    <aside
      ref={sidebarRef}
      aria-label="Sidebar"
      aria-description="Right-click the sidebar background to customize its views."
      tabIndex={0}
      onContextMenu={event => {
        if (setupMode || event.defaultPrevented || (event.target as Element).closest("button, input, select, textarea, [role=dialog]")) return;
        event.preventDefault();
        setContextMenu(null);
        if (collapsed) onCollapsedChange(false);
        setSidebarCustomization(true);
      }}
      onKeyDown={event => {
        if (setupMode || event.target !== event.currentTarget) return;
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          if (collapsed) onCollapsedChange(false);
          setSidebarCustomization(true);
        }
      }}
      style={{ width: currentWidth }}
      className={`bot-sidebar relative shrink-0 h-full bg-[#0e0e0e] flex flex-col justify-between select-none z-20 overflow-hidden ${
        isDragging ? "" : "transition-[width] duration-300 spring-transition"
      }`}
    >
      {/* Top Drag Bar + Primary Omnibot Hero Card */}
      <div>
        <div
          data-tauri-drag-region
          className="h-16 pt-2 px-4 flex items-center justify-end gap-2.5"
        >
          <div
            className={`flex items-center gap-2.5 transition-all duration-200 spring-transition ${
              collapsed || setupMode
                ? "opacity-0 scale-90 pointer-events-none w-0 overflow-hidden"
                : "opacity-100 scale-100"
            }`}
          >
            <button
              type="button"
              onClick={onOpenSearch}
              title="Search Bots, Group chats, Projects & Skills (Cmd+K)"
              className="w-10 h-10 rounded-full bg-[#1f1f1f] hover:bg-[#282828] border border-white/[0.06] flex items-center justify-center text-zinc-200 hover:text-white active:scale-95 transition-colors"
            >
              <Search className="w-[17px] h-[17px]" />
            </button>
            <button
              type="button"
              onClick={onNewChatOrSwarm}
              title="New chat (Cmd+N)"
              className="w-10 h-10 rounded-full bg-[#1f1f1f] hover:bg-[#282828] border border-white/[0.06] flex items-center justify-center text-zinc-200 hover:text-white active:scale-95 transition-colors"
            >
              <Plus className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>

        {/* Featured Primary Coordinator Card */}
        <div
          className={`flex flex-col items-center transition-all duration-300 spring-transition ${
            collapsed ? "px-3 pt-1 pb-3" : "px-4 pt-[14px] pb-[22px]"
          }`}
        >
            <button
              type="button"
              onClick={onSelectPrimary}
              onContextMenu={(e) => openBotContextMenu(e, primaryBot)}
              title={setupMode ? primaryBot.name : `${primaryBot.name} (Right-click to rename or customize)`}
              aria-label={`Open ${primaryBot.name}`}
              aria-current={isPrimarySelected ? "page" : undefined}
              className={`group flex flex-col items-center justify-center rounded-[13px] transition-colors active:scale-[0.97] ${collapsed ? "p-2" : "w-[104px] min-h-[102px] py-1"} ${isPrimarySelected ? "bg-[#222222]" : "hover:bg-[#1a1a1a]"}`}
            >
              <BotCharacterAvatar
                bot={primaryBot}
                size={collapsed ? 48 : 64}
                isStreaming={isPrimaryStreaming}
                showStarBadge
              />
              <span
                className={`text-[14px] font-normal transition-all duration-200 overflow-hidden truncate max-w-[96px] ${
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
            const selected = isBotDirectSelected(bot);
            const running = activeRuns.some((r) => r.botId === bot.id);
            return (
              <button
                key={bot.id}
                type="button"
                onClick={() => onSelectBotDirectChat(bot)}
                onContextMenu={(e) => openBotContextMenu(e, bot)}
                title={`${bot.name} (${bot.cliDriver}) · Right-click for options`}
                aria-label={`Open ${bot.name}`}
                aria-current={selected ? "page" : undefined}
                className={`p-1.5 rounded-2xl transition-all active:scale-95 ${
                  selected
                    ? "bg-[#222225] ring-1 ring-white/15"
                    : "hover:bg-[#18181b]"
                }`}
              >
                <BotCharacterAvatar
                  bot={bot}
                  size={38}
                  showCliBadge={false}
                  isStreaming={running}
                />
              </button>
            );
          })}
        </div>
      )}

      {/* Expanded Middle: Local CLI Bots Roster + Group chats */}
      <div
        className={`flex-1 min-h-0 min-w-0 overflow-hidden px-3 pt-1 transition-all duration-250 spring-transition ${
          collapsed
            ? "opacity-0 pointer-events-none translate-x-[-8px] hidden"
            : "opacity-100 translate-x-0"
        }`}
      >
        {!setupMode && <SidebarSections {...props} customizationHost={sidebarRef.current} customizationOpen={sidebarCustomization} onCloseCustomization={() => setSidebarCustomization(false)} />}
      </div>

      {/* Bottom Progressive Blur & Soft Vignette Feather */}
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 inset-x-0 h-24 sidebar-bottom-feather z-10"
      />

      {/* Bottom Dock: Omnibot Hub + CLI Harnesses Pill */}
      {setupMode ? null : collapsed ? (
        <div className="relative z-20 flex flex-col items-center gap-3 pb-4 pt-2">
          <button
            type="button"
            onClick={onNewChatOrSwarm}
            title="Start a new chat (Cmd+N)"
            className="w-11 h-11 rounded-full bg-[#1f1f1f] hover:bg-[#282828] border border-white/[0.05] flex items-center justify-center text-zinc-300 hover:text-white active:scale-95 transition-colors"
          >
            <Plus className="w-[18px] h-[18px]" />
          </button>
          <button
            type="button"
            onClick={onOpenSetup}
            title="Workspace setup"
            className="w-11 h-11 rounded-full bg-[#1f1f1f] hover:bg-[#282828] border border-white/[0.05] flex items-center justify-center text-zinc-300 hover:text-white active:scale-95 transition-colors"
          >
            <Settings2 className="w-[18px] h-[18px]" />
          </button>
          <button
            type="button"
            onClick={onNewBot}
            title="Bot library"
            className="w-11 h-11 rounded-full bg-[#1f1f1f] hover:bg-[#282828] border border-white/[0.05] flex items-center justify-center text-zinc-300 hover:text-white active:scale-95 transition-colors"
          >
            <Blocks className="w-[18px] h-[18px]" />
          </button>
        </div>
      ) : (
        <div className="absolute bottom-0 inset-x-0 z-20 px-4 pb-4 pt-2 flex items-center gap-2.5 pointer-events-none">
          <button
            type="button"
            onClick={onOpenSetup}
            title="Workspace setup"
            className="pointer-events-auto w-11 h-11 rounded-full bg-[#1f1f1f] hover:bg-[#282828] text-zinc-200 border border-white/[0.06] flex items-center justify-center shrink-0 transition-colors active:scale-95"
          >
            <Settings2 className="w-[18px] h-[18px]" />
          </button>

          <button
            type="button"
            onClick={onNewBot}
            aria-label="Bot library"
            title={installedHarnesses.length ? `Bot library · ${installedHarnesses.map(h => h.name).join(", ")}` : "Bot library"}
            className="pointer-events-auto h-11 flex-1 min-w-0 px-4 rounded-full bg-[#1f1f1f] hover:bg-[#272727] border border-white/[0.06] flex items-center justify-between gap-2.5 transition-colors active:scale-[0.98]"
          >
            <span className="text-[14.5px] font-medium text-zinc-100 truncate">
              Bot library
            </span>
            {dockHarnesses.length ? <span aria-hidden="true" className="flex items-center -space-x-1.5 shrink-0">
              {dockHarnesses.map(harness => <span key={harness.kind} className="w-6 h-6 rounded-full bg-[#1f1f1f] border border-white/15 flex items-center justify-center">
                <CliProviderGlyph driver={harness.kind} size={15} />
              </span>)}
            </span> : <Plus className="w-[17px] h-[17px] text-zinc-400" />}
          </button>
        </div>
      )}

      {/* Right-Click Context Menu Popover */}
      {contextMenu && (
        <div
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          className="motion-menu fixed z-50 w-52 rounded-2xl liquid-glass-modal p-1.5 shadow-[0_18px_50px_rgba(0,0,0,0.85)] border border-white/[0.1] space-y-0.5"
        >
          <>
              <div className="px-2.5 py-1.5 flex items-center gap-2 mb-1">
                <BotCharacterAvatar bot={contextMenu.bot} size={22} />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-white truncate">
                    {contextMenu.bot.name}
                  </div>
                  <div className="text-[10.5px]  text-zinc-400 truncate">
                    {contextMenu.bot.cliDriver}
                  </div>
                </div>
              </div>
              {!contextMenu.bot.isPrimary && <button type="button" onClick={() => { onTogglePin(contextMenu.bot); setContextMenu(null); }}
                className="w-full px-2.5 py-2 rounded-xl flex items-center gap-2.5 text-[13px] text-zinc-200 hover:bg-white/[0.08]">
                {pinnedBotIds.includes(contextMenu.bot.id) ? <PinOff size={14} /> : <Pin size={14} />}
                {pinnedBotIds.includes(contextMenu.bot.id) ? "Unpin from sidebar" : "Pin to sidebar"}
              </button>}
              <button
                type="button"
                onClick={() => { onCustomizeBot(contextMenu.bot); setContextMenu(null); }}
                className="w-full px-2.5 py-1.5 rounded-xl flex items-center gap-2.5 text-xs text-zinc-200 hover:text-white hover:bg-white/[0.08] transition-colors"
              >
                <Pencil className="w-3.5 h-3.5 text-zinc-400" />
                <span>Rename &amp; Edit Role</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = contextMenu.bot;
                  setContextMenu(null);
                  onCustomizeBot(target);
                }}
                className="w-full px-2.5 py-1.5 rounded-xl flex items-center gap-2.5 text-xs text-zinc-200 hover:text-white hover:bg-white/[0.08] transition-colors"
              >
                <Palette className="w-3.5 h-3.5 text-cyan-400" />
                <span>Customize Shape &amp; CLI</span>
              </button>
              <button
                type="button"
                onClick={() => handleDuplicateBot(contextMenu.bot)}
                className="w-full px-2.5 py-1.5 rounded-xl flex items-center gap-2.5 text-xs text-zinc-200 hover:text-white hover:bg-white/[0.08] transition-colors"
              >
                <Copy className="w-3.5 h-3.5 text-zinc-400" />
                <span>Duplicate Bot ({contextMenu.bot.cliDriver})</span>
              </button>
              {!contextMenu.bot.isPrimary && (
                <>
                  <div className="my-1 " />
                  <button
                    type="button"
                    onClick={async () => {
                      const id = contextMenu.bot.id;
                      setContextMenu(null);
                      await onDeleteBot(id);
                    }}
                    className="w-full px-2.5 py-1.5 rounded-xl flex items-center gap-2.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/15 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete Bot</span>
                  </button>
                </>
              )}
            </>

        </div>
      )}

      {/* Interactive Click & Drag Resize Handle along the right edge */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Drag or click to resize or toggle sidebar"
        title="Drag to resize · Click to toggle sidebar (Cmd+B)"
        onPointerDown={handlePointerDown}
        className="absolute top-0 right-0 bottom-0 w-2.5 cursor-col-resize z-30"
      />
    </aside>
  );
}
