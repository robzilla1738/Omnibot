import { useSidebarDrag, reorderAt } from "./useSidebarDrag";
import { createPortal } from "react-dom";
import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, Folder, MessageSquare, MoreHorizontal, Plus, X } from "lucide-react";
import type { AppSidebarProps } from "./AppSidebar";
import { BotCharacterAvatar } from "../icons/BotCharacterAvatar";
import { Collapse } from "../ui/Collapse";

type Section = "bots" | "projects" | "chats";
type Layout = { view: "all" | Section; sections: Section[]; hidden: string[]; collapsed: string[]; order: Record<string, string[]>; sort: "manual" | "name" | "recent" };
const labels = { bots: "Bots", projects: "Projects", chats: "Chats" };
const defaults = (): Layout => ({ view: "all", sections: ["bots", "projects", "chats"], hidden: [], collapsed: [], order: {}, sort: "manual" });
const storageKey = "omnibot.sidebar.v1";
function readLayout(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || localStorage.getItem("botfinity.sidebar.v1") || "null");
    if (!saved) return defaults();
    const base = defaults();
    return { ...base, view: ["all", ...base.sections].includes(saved.view) ? saved.view : "all", sections: [...new Set<Section>([...(Array.isArray(saved.sections) ? saved.sections.filter((s: Section) => Object.hasOwn(labels, s)) : []), ...base.sections])], hidden: Array.isArray(saved.hidden) ? saved.hidden.filter((s: unknown) => typeof s === "string") : [], collapsed: Array.isArray(saved.collapsed) ? saved.collapsed.filter((s: unknown) => typeof s === "string") : [], order: saved.order && typeof saved.order === "object" ? saved.order : {}, sort: ["manual", "name", "recent"].includes(saved.sort) ? saved.sort : "manual" };
  } catch { return defaults(); }
}
type Item = { id: string; name: string; detail: string; updated: number; active: boolean; icon: ReactNode; open: () => void; rename: (name: string) => Promise<void>; remove?: () => Promise<void> };
export function SidebarSections(props: AppSidebarProps & { customizationHost: HTMLElement | null; customizationOpen: boolean; onCloseCustomization: () => void }) {
  const [layout, setLayout] = useState(readLayout);
  const [menu, setMenu] = useState<string | null>(null);
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 });
  const [rename, setRename] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(layout)); } catch { setError("View changes couldn't be saved on this device."); } }, [layout]);
  useEffect(() => { const close = (e: KeyboardEvent) => { if (e.key === "Escape") { setMenu(null); setRename(null); props.onCloseCustomization(); } }; window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, []);
  useEffect(() => {
    if (!props.customizationOpen) return;
    const close = (event: PointerEvent) => { if (!(event.target as Element).closest('[data-sidebar-settings]')) props.onCloseCustomization(); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [props.customizationOpen, props.onCloseCustomization]);
  const toggle = (key: "collapsed" | "hidden", value: string) => setLayout(l => ({ ...l, [key]: l[key].includes(value) ? l[key].filter(v => v !== value) : [...l[key], value] }));
  const run = async (action: () => Promise<void>) => { setSaving(true); setError(""); try { await action(); setMenu(null); setRename(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setSaving(false); } };
  const projectChats = (path: string) => props.chats.filter(c => c.workspacePath === path);
  const chatIcon = (ids: string[]) => {
    const members = ids.map(id => props.bots.find(b => b.id === id)).filter(b => !!b);
    if (members.length === 1) return <BotCharacterAvatar bot={members[0]} size={40} />;
    if (members.length > 1) return <span className="flex items-center justify-center -space-x-3 w-10 h-10 rounded-xl bg-white/[0.04]">{members.slice(0,2).map(bot => <BotCharacterAvatar key={bot.id} bot={bot} size={25} showCliBadge={false} />)}</span>;
    return <MessageSquare size={24} className="text-zinc-500" />;
  };
  const items: Record<Section, Item[]> = {
    bots: (layout.view === "bots" ? props.bots.filter(b => !b.isPrimary).map(b => b.id) : props.pinnedBotIds).flatMap(id => {
      const bot = props.bots.find(b => b.id === id && !b.isPrimary); if (!bot) return [];
      const direct = props.chats.filter(c => !c.isPrimary && c.isBotHome && !c.isGroup && c.participantBotIds.length === 1 && c.participantBotIds[0] === id).sort((a,b) => b.updatedAtMs-a.updatedAtMs);
      const running = props.activeRuns.some(r => r.botId === id);
      return [{ id, name: bot.name, detail: running ? "Thinking…" : direct[0]?.messages.filter(m => m.text.trim()).at(-1)?.text.replace(/[#*_`]/g, "").replace(/\s+/g, " ") || bot.roleTitle || "Start a conversation", updated: direct[0]?.updatedAtMs ?? 0, active: direct.some(c => c.id === props.activeChatId), icon: <BotCharacterAvatar bot={bot} size={40} isStreaming={running} />, open: () => props.onSelectBotDirectChat(bot), rename: (name: string) => props.onUpsertBot({ ...bot, name }), remove: async () => { if (props.pinnedBotIds.includes(id)) await props.onTogglePin(bot); if (layout.view === "bots") toggle("hidden", `bots:${id}`); } }];
    }),
    projects: props.workspaces.map(project => ({ id: project.id, name: project.name, detail: project.path.split("/").filter(Boolean).slice(-2).join("/"), updated: Math.max(0,...projectChats(project.path).map(c => c.updatedAtMs)), active: props.chats.some(c => c.id === props.activeChatId && c.workspacePath === project.path), icon: <span className="w-10 h-10 rounded-xl bg-white/[0.04] flex items-center justify-center"><Folder size={22} className="text-zinc-400" /></span>, open: () => { void run(() => props.onSelectProject(project.path)); }, rename: name => props.onUpsertProject({ ...project, name }) })),
    chats: props.chats.filter(c => !c.isPrimary && !c.isBotHome).map(chat => ({ id: chat.id, name: chat.title, detail: chat.messages.filter(m => m.text.trim()).at(-1)?.text.replace(/[#*_`]/g, "").replace(/\s+/g, " ") || (chat.workspacePath ? chat.workspacePath.split("/").filter(Boolean).at(-1)! : chat.isGroup ? "Group chat" : "Personal chat"), updated: chat.updatedAtMs, active: chat.id === props.activeChatId, icon: chatIcon(chat.participantBotIds), open: () => props.onSelectChat(chat.id), rename: title => props.onUpdateChat({ chatId: chat.id, title }) })),
  };
  const sorted = (section: Section) => {
    const order = Array.isArray(layout.order[section]) ? layout.order[section] : [];
    return [...items[section]].sort((a,b) => layout.sort === "name" ? a.name.localeCompare(b.name) : layout.sort === "recent" ? b.updated-a.updated : (order.indexOf(a.id) < 0 ? 999999 : order.indexOf(a.id)) - (order.indexOf(b.id) < 0 ? 999999 : order.indexOf(b.id)));
  };
  const moveItem = (section: Section, id: string, direction: number) => {
    const ids = sorted(section).map(item => item.id);
    const index = ids.indexOf(id), next = index + direction;
    if (next < 0 || next >= ids.length) return;
    setLayout(l => ({ ...l, sort: "manual", order: { ...l.order, [section]: reorderAt(ids, id, ids[next], direction > 0) } }));
  };
  const openMenu = (key: string, x: number, y: number) => {
    setMenu(menu === key ? null : key); setRename(null);
    setMenuPoint({ x: Math.max(8, Math.min(x, window.innerWidth - 220)), y: Math.max(8, Math.min(y, window.innerHeight - 180)) });
  };
  const menuSection = menu?.split(":")[0] as Section | undefined;
  const menuItem = menuSection && items[menuSection]?.find(item => `${menuSection}:${item.id}` === menu);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element).closest('[data-sidebar-item-menu], [data-sidebar-options]')) { setMenu(null); setRename(null); }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);
  const drag = useSidebarDrag((source, target) => {
    if (source.kind === "section") {
      setLayout(l => ({ ...l, sections: reorderAt(l.sections, source.id, target.id, target.after) as Section[] }));
    } else {
      const section = source.section as Section;
      const ids = sorted(section).map(item => item.id);
      setLayout(l => ({ ...l, sort: "manual", order: { ...l.order, [section]: reorderAt(ids, source.id, target.id, target.after) } }));
    }
    setMenu(null);
  });
  return <div className="h-full min-h-0 min-w-0 flex flex-col gap-3">
    <div role="group" aria-label="Sidebar views" className="shrink-0 flex items-center gap-0.5 px-1">
      {(["all", "bots", "projects", "chats"] as const).map(view => <button key={view} type="button" aria-pressed={layout.view === view} onClick={() => { setLayout(l => ({ ...l, view, collapsed: view === "all" ? l.collapsed : l.collapsed.filter(s => s !== view) })); setMenu(null); }} className={`flex-1 min-w-0 rounded-full px-2 py-1.5 text-[12px] transition-colors ${layout.view === view ? "bg-[#252525] text-zinc-100" : "text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04]"}`}>{view === "all" ? "All" : labels[view]}</button>)}
    </div>
    {props.customizationOpen && props.customizationHost && createPortal(<div data-sidebar-settings role="dialog" aria-label="Customize sidebar" className="absolute top-16 left-3 right-3 z-40 rounded-2xl bg-[#202020] p-4 shadow-2xl space-y-4 text-xs">
      <div className="flex items-center justify-between text-sm text-zinc-200"><span>Sidebar</span><button title="Close sidebar settings" onClick={props.onCloseCustomization} className="rounded-lg p-1.5 hover:bg-white/5"><X size={14}/></button></div>
      <label className="flex items-center justify-between gap-3 text-zinc-400">Show<select aria-label="Sidebar view" value={layout.view} onChange={e => setLayout(l => ({ ...l, view: e.target.value as Layout["view"] }))} className="sidebar-native-menu"><option value="all">All sections</option>{Object.entries(labels).map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label className="flex items-center justify-between gap-3 text-zinc-400">Sort items<select aria-label="Sort sidebar items" className="sidebar-native-menu" value={layout.sort} onChange={e => setLayout(l => ({ ...l, sort: e.target.value as Layout["sort"] }))}><option value="manual">My order</option><option value="name">Name</option><option value="recent">Recent activity</option></select></label>
      {layout.sections.map(section => <label key={section} className="flex items-center gap-2"><input type="checkbox" checked={!layout.hidden.includes(section)} onChange={() => toggle("hidden",section)}/>{labels[section]}</label>)}
      <p className="text-zinc-500">Drag rows or section names to reorder. Use Option + ↑ / ↓ with a row focused.</p>
      <button onClick={() => { setLayout(defaults()); setMenu(null); }} className="text-zinc-400 hover:text-white">Reset view & restore hidden items</button>
    </div>, props.customizationHost)}
    {error && <p role="alert" className="text-xs text-red-300 px-2">{error}</p>}
    {menuItem && props.customizationHost && createPortal(<div data-sidebar-item-menu role="dialog" aria-label={`Options for ${menuItem.name}`} style={{ left: menuPoint.x, top: menuPoint.y }} className="motion-menu fixed z-50 w-[210px] rounded-2xl bg-[#242424] p-2 shadow-2xl text-[13px]">
      {rename === menu ? <form className="space-y-3 p-2" onSubmit={e => { e.preventDefault(); if (draft.trim()) void run(() => menuItem.rename(draft.trim())); }}>
        <input autoFocus aria-label={`Rename ${menuItem.name}`} maxLength={120} value={draft} onChange={e => setDraft(e.target.value)} className="w-full bg-white/5 rounded-lg px-2 py-2" />
        <div className="flex justify-end gap-2"><button type="button" onClick={() => setMenu(null)} className="px-2 py-1.5 text-zinc-400">Cancel</button><button disabled={saving || !draft.trim()} className="px-3 py-1.5 rounded-full bg-white text-black">Save</button></div>
      </form> : <>
        <button disabled={saving} onClick={() => { setRename(menu); setDraft(menuItem.name); }} className="w-full text-left px-3 py-2 rounded-xl hover:bg-white/5">Rename</button>
        {menuSection === "bots" && !props.pinnedBotIds.includes(menuItem.id) && <button onClick={() => void run(() => props.onTogglePin(props.bots.find(b => b.id === menuItem.id)!))} className="w-full text-left px-3 py-2 rounded-xl hover:bg-white/5">Pin to sidebar</button>}
        <button disabled={saving} title="Remove from sidebar; keep history and files" onClick={() => { if (menuItem.remove) void run(menuItem.remove); else { toggle("hidden",menu!); setMenu(null); } }} className="w-full text-left px-3 py-2 rounded-xl hover:bg-white/5 text-zinc-400">Remove</button>
      </>}
    </div>, props.customizationHost)}
    <div data-sidebar-scroll className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden sidebar-scroll-mask space-y-5 pt-4 pb-24">
    {layout.sections.filter(section => (layout.view === "all" ? !layout.hidden.includes(section) : layout.view === section)).map(section => {
      const rows = sorted(section).filter(item => !layout.hidden.includes(`${section}:${item.id}`)); const closed = layout.collapsed.includes(section);
      if (rows.length === 0 && layout.view === "all") return null;
      return <section key={section} aria-label={labels[section]} data-sidebar-section={section} className={`min-w-0 rounded-[13px] transition-colors ${drag.source?.kind === "section" && drag.over === section ? "bg-white/[0.06]" : ""}`}>
        <div className="group/section flex items-center justify-between px-2.5 mb-2">
          <button {...drag.bind({ kind: "section", section, id: section })} title={`Drag to reorder ${labels[section]}`} onClick={() => toggle("collapsed",section)} aria-expanded={!closed} aria-controls={`sidebar-${section}`} className="flex items-center gap-1.5 text-[13.5px] text-[#8e8d8a] hover:text-zinc-200">{labels[section]}<ChevronDown size={12} className={`transition-all duration-200 ${closed ? "-rotate-90 opacity-60" : "opacity-0 group-hover/section:opacity-60 group-focus-within/section:opacity-60"}`}/></button>
          <button title={section === "bots" ? "Manage bots" : section === "projects" ? "Add project" : "New chat"} onClick={section === "bots" ? props.onNewBot : section === "projects" ? props.onNewProject : props.onNewChatOrSwarm} className="p-1.5 text-zinc-400 hover:text-white rounded-lg hover:bg-white/5 opacity-0 group-hover/section:opacity-100 focus-visible:opacity-100 transition-opacity"><Plus size={15}/></button>
        </div>
        <Collapse open={!closed} id={`sidebar-${section}`}><div className="min-w-0 space-y-1">
          {rows.length === 0 && <p className="px-3 py-3 text-xs text-zinc-500">{section === "bots" ? "Add a bot from your library." : section === "projects" ? "Add a folder when you're ready." : "Your conversations will appear here."}</p>}
          {rows.map((item,index) => { const key = `${section}:${item.id}`; return <div key={key} data-sidebar-item={item.id} className={`min-w-0 rounded-[13px] transition-[background-color,opacity] ${drag.source?.id === item.id && drag.source.kind === "item" ? "opacity-40" : ""} ${drag.source?.kind === "item" && drag.over === item.id ? "bg-white/[0.09]" : item.active ? "bg-[#222]" : "hover:bg-[#171717]"}`}>
            <div className="flex min-w-0 items-center group relative">
              <button {...drag.bind({ kind: "item", section, id: item.id })} title={`Drag to reorder ${item.name}`} aria-label={`Open ${item.name}`} aria-current={item.active ? "page" : undefined} onClick={() => { setMenu(null); item.open(); }} onContextMenu={e => { e.preventDefault(); openMenu(key,e.clientX,e.clientY); }} onKeyDown={e => { if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); moveItem(section,item.id,e.key === "ArrowUp" ? -1 : 1); } }} className="flex flex-1 min-w-0 items-center w-full gap-3 px-2.5 py-2.5 text-left rounded-[13px]"><span className="w-10 h-10 shrink-0 flex items-center justify-center">{item.icon}</span><span className="min-w-0 flex-1"><span className="block truncate text-[16px] font-medium leading-[1.3] text-[#eee]">{item.name}</span><span className="block truncate text-[14px] leading-[1.35] mt-0.5 text-[#9b9b9b]">{item.detail}</span></span></button>
              <button data-sidebar-options title={`Options for ${item.name}`} aria-expanded={menu===key} onClick={e => { const rect = e.currentTarget.getBoundingClientRect(); openMenu(key,rect.right-210,rect.bottom+4); }} className="absolute right-1 top-2 p-2 rounded-lg bg-[#1c1c1c] text-zinc-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 hover:bg-white/5"><MoreHorizontal size={16}/></button>
            </div>
          </div>; })}
        </div></Collapse>
      </section>;
    })}
    </div>
  </div>;
}
