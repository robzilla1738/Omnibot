import { useId, useState } from "react";
import type { BotProfile, ChatThread, CliHarnessInfo, RoutineEntry } from "../../lib/types";
import { BotModelSelect } from "../bots/BotModelSelect";
import { Collapse } from "../ui/Collapse";
import { NativeSelect } from "../ui/NativeSelect";

const field = "w-full min-h-[50px] rounded-xl border border-white/10 bg-[#1f1f1f] px-3 py-3 text-sm text-zinc-100";
export function routineScheduleLabel(routine: RoutineEntry): string {
  const schedule = routine.schedule;
  if (!schedule || schedule.frequency === "manual") return "Run manually";
  const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][schedule.weekday];
  return `${schedule.frequency === "daily" ? "Every day" : schedule.frequency === "weekdays" ? "Weekdays" : day} at ${schedule.time}`;
}

export function RoutineEditor({ bots, harnesses, chat, initialBotId, onSave }: {
  bots: BotProfile[]; harnesses: CliHarnessInfo[]; chat: ChatThread; initialBotId: string;
  onSave: (routine: RoutineEntry) => Promise<void>;
}) {
  const scheduleId = useId();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [botId, setBotId] = useState(initialBotId);
  const [model, setModel] = useState<string | null>(null);
  const [frequency, setFrequency] = useState<NonNullable<RoutineEntry["schedule"]>["frequency"]>("manual");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const bot = bots.find(bot => bot.id === botId);
  return <form aria-label="New routine" className="liquid-glass-card rounded-2xl p-4 space-y-5" onSubmit={async event => {
    event.preventDefault(); if (saving) return;
    setSaving(true); setError("");
    try { await onSave({ id: "", name: name.trim(), prompt: prompt.trim(), botId, model, chatId: chat.id, schedule: { frequency, time, weekday }, enabled: true }); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }}>
    <div className="space-y-2"><span className="text-xs text-zinc-400">Start with an idea</span><div className="flex flex-wrap gap-2">
      {[
        ["Review changes", "Review the current changes for bugs and missing edge cases. Summarize findings before making edits."],
        ["Project recap", "Summarize the current project status, recent changes, and any open issues. Do not change files."],
        ["Plan next steps", "Review the project and propose the next three useful tasks. Explain each briefly without changing files."],
      ].map(([title, text]) => <button key={title} type="button" disabled={saving} onClick={() => { setName(title); setPrompt(text); }} className="rounded-full bg-white/[0.06] px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/10">{title}</button>)}
    </div></div>
    <label className="block space-y-2 text-xs text-zinc-400"><span>Name</span><input required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="Give this routine a name" disabled={saving} className={field} /></label>
    <label className="block space-y-2 text-xs text-zinc-400"><span>Bot</span><NativeSelect aria-label="Routine bot" value={botId} disabled={saving} onChange={event => { setBotId(event.target.value); setModel(null); }} className={field}>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</NativeSelect></label>
    <BotModelSelect key={botId} label="Routine model" value={model} harness={harnesses.find(h => h.kind === bot?.cliDriver)} defaultLabel={bot?.model ? `Bot default (${bot.model})` : "CLI default"} onChange={setModel} disabled={saving} />
    <label className="block space-y-2 text-xs text-zinc-400"><span>Instructions</span><textarea required maxLength={50000} rows={4} value={prompt} disabled={saving} onChange={event => setPrompt(event.target.value)} placeholder="What should the bot do?" className={`${field} resize-y min-h-24`} /></label>
    <label className="block space-y-2 text-xs text-zinc-400"><span>When to run</span><NativeSelect aria-label="Routine schedule" value={frequency} disabled={saving} onChange={event => setFrequency(event.target.value as typeof frequency)} className={field}><option value="manual">Only when I run it</option><option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option></NativeSelect></label>
    <Collapse open={frequency !== "manual"} id={scheduleId}><div className="grid grid-cols-2 gap-3">
      <label className="block space-y-2 text-xs text-zinc-400"><span>Local time</span><input type="time" required={frequency !== "manual"} value={time} disabled={saving} onChange={event => setTime(event.target.value)} className={field} /></label>
      {frequency === "weekly" && <label className="block space-y-2 text-xs text-zinc-400"><span>Day</span><NativeSelect aria-label="Routine day" value={weekday} disabled={saving} onChange={event => setWeekday(Number(event.target.value))} className={field}>{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, index) => <option key={day} value={index}>{day}</option>)}</NativeSelect></label>}
    </div></Collapse>
    <p className="text-xs leading-relaxed text-zinc-500">Runs in {chat.title}.{frequency !== "manual" && " Scheduled runs use your CLI account while Omnibot is open. Missed times aren’t replayed."}</p>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    <button type="submit" disabled={saving || !name.trim() || !prompt.trim() || !bot} className="motion-cta w-full rounded-full bg-white py-3 text-sm font-medium text-black disabled:opacity-40">{saving ? "Saving…" : "Save routine"}</button>
  </form>;
}
