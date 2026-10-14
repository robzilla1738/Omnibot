import { useState } from "react";
import { Pencil, Trash2, Check, X } from "lucide-react";
import type { BotProfile, WorkspaceEntry, OmniPreferences } from "../../lib/types";
import { NativeSelect } from "../ui/NativeSelect";

export function MemoryManager({ bots, projects, preferences, onBot, onProject, onPreferences }: {
  bots: BotProfile[]; projects: WorkspaceEntry[]; preferences: OmniPreferences;
  onBot: (bot: BotProfile) => Promise<void>; onProject: (project: WorkspaceEntry) => Promise<void>;
  onPreferences: (preferences: OmniPreferences) => Promise<void>;
}) {
  const [scope, setScope] = useState(`bot:${bots.find(b => b.isPrimary)?.id ?? bots[0]?.id}`);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bot = bots.find(b => `bot:${b.id}` === scope);
  const project = projects.find(p => `project:${p.id}` === scope);
  const entries = bot?.memories ?? project?.memories ?? (scope === "shared" ? preferences.sharedMemories : []);
  const save = async (next: string[]) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      if (bot) await onBot({ ...bot, memories: next });
      else if (project) await onProject({ ...project, memories: next });
      else if (scope === "shared") await onPreferences({ ...preferences, sharedMemories: next });
      else throw new Error("Choose a bot or project.");
      setDraft(""); setEditing(null);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <section className="space-y-5" aria-label="Memory manager">
    <label className="block space-y-2 text-sm text-zinc-300"><span>Memory belongs to</span>
      <NativeSelect aria-label="Memory scope" className="w-full rounded-xl bg-[#202020] px-3" value={scope} disabled={busy} onChange={event => { setScope(event.target.value); setDraft(""); setEditing(null); setError(""); }}>
        <optgroup label="Bots">{bots.map(b => <option key={b.id} value={`bot:${b.id}`}>{b.name}</option>)}</optgroup>
        <optgroup label="Projects">{projects.map(p => <option key={p.id} value={`project:${p.id}`}>{p.name}</option>)}</optgroup>
        <option value="shared">Shared preferences · all bots</option>
      </NativeSelect>
    </label>
    <p className="text-sm leading-relaxed text-zinc-400">{bot ? `Only ${bot.name} uses these memories, across its chats. Keep project-specific facts in project memory.` : project ? `Available to bots working in ${project.name}. Other projects and home chats don't receive these notes.` : "Preferences you intentionally share with every bot, across all projects."}</p>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (draft.trim()) void save([...entries, draft.trim()]); }}>
      <textarea aria-label="New memory" rows={3} maxLength={4000} disabled={busy} value={draft} onChange={event => setDraft(event.target.value)} placeholder="What should be remembered?" className="w-full resize-y rounded-xl bg-[#202020] p-3 text-sm text-zinc-100" />
      <div className="flex items-center justify-between gap-4"><span className="text-xs text-zinc-500">Saved locally. You can edit or forget any note.</span><button disabled={busy || !draft.trim()} className="rounded-full bg-white text-black px-4 py-2 text-sm disabled:opacity-40">Save memory</button></div>
    </form>
    {error && <p role="alert" className="text-red-300 text-sm">{error}</p>}
    {!entries.length && <p className="py-6 text-center text-sm text-zinc-500">No saved memories here yet.</p>}
    <div className="space-y-3">{entries.map((entry, index) => <div key={index} className="rounded-2xl bg-white/[0.04] p-4 flex items-start gap-3">
      {editing === index ? <><textarea aria-label="Edit memory" className="min-w-0 flex-1 rounded-lg bg-[#202020] p-2 text-sm" value={editText} maxLength={4000} onChange={event => setEditText(event.target.value)} /><button aria-label="Save memory changes" disabled={busy || !editText.trim()} onClick={() => void save(entries.map((value, i) => i === index ? editText.trim() : value))}><Check size={16} /></button><button aria-label="Cancel memory edit" onClick={() => setEditing(null)}><X size={16} /></button></> : <><p className="min-w-0 flex-1 text-sm text-zinc-300 whitespace-pre-wrap break-words">{entry}</p><button aria-label={`Edit memory ${index + 1}`} disabled={busy} onClick={() => { setEditing(index); setEditText(entry); }} className="text-zinc-500 hover:text-white"><Pencil size={15} /></button><button aria-label={`Forget memory ${index + 1}`} disabled={busy} onClick={() => void save(entries.filter((_, i) => i !== index))} className="text-zinc-500 hover:text-red-300"><Trash2 size={15} /></button></>}
    </div>)}</div>
  </section>;
}
