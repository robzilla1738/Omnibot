import { useRef, useState } from "react";
import { Check, ImagePlus, Loader2 } from "lucide-react";
import { BOT_COLORS, BOT_SHAPES, BotCharacterAvatar } from "../icons/BotCharacterAvatar";
import { GAUNTLET_AVATAR, readAvatar } from "../../lib/avatar";

export interface BotAppearance {
  shape: string;
  color: string;
  avatarImage?: string | null;
}

export function AvatarPicker({ value, onChange, onBusyChange }: {
  value: BotAppearance;
  onBusyChange?: (busy: boolean) => void;
  onChange: (next: BotAppearance) => void | Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const change = async (next: BotAppearance | (() => Promise<BotAppearance>)) => {
    setBusy(true); onBusyChange?.(true); setError("");
    try { await onChange(typeof next === "function" ? await next() : next); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); onBusyChange?.(false); }
  };
  const isPhoto = Boolean(value.avatarImage && value.avatarImage !== GAUNTLET_AVATAR);
  const card = "relative flex flex-col items-center justify-center gap-2 rounded-xl border px-2 py-3 text-xs transition-colors hover:bg-white/[0.06] disabled:opacity-50";
  const selected = "border-white/35 bg-white/[0.08] text-white";
  const idle = "border-white/10 text-zinc-400";
  return (
    <fieldset className="space-y-4 min-w-0" disabled={busy} aria-label="Profile picture">
      <legend className="text-sm text-zinc-300 mb-3">Profile picture</legend>
      <div className="grid grid-cols-3 gap-2">
        <button type="button" aria-pressed={!value.avatarImage} onClick={() => void change({ ...value, avatarImage: null })} className={`${card} ${!value.avatarImage ? selected : idle}`}>
          <BotCharacterAvatar shape={value.shape} color={value.color} size={40} />Character
        </button>
        <button type="button" aria-pressed={value.avatarImage === GAUNTLET_AVATAR} onClick={() => void change({ ...value, avatarImage: GAUNTLET_AVATAR })} className={`${card} ${value.avatarImage === GAUNTLET_AVATAR ? selected : idle}`}>
          <img src={GAUNTLET_AVATAR} alt="" className="w-10 h-10 object-contain" />Gauntlet
        </button>
        <button type="button" aria-label={isPhoto ? "Replace image" : "Upload image"} onClick={() => input.current?.click()} className={`${card} ${isPhoto ? selected : idle}`}>
          {busy ? <Loader2 className="w-10 h-10 p-2 animate-spin" /> : isPhoto ? <BotCharacterAvatar bot={value} size={40} /> : <ImagePlus className="w-10 h-10 p-2" />}
          {isPhoto ? "Replace image" : "Upload image"}
        </button>
      </div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Upload profile picture" className="sr-only" onChange={e => {
        const file = e.target.files?.[0]; e.target.value = "";
        if (file) void change(async () => ({ ...value, avatarImage: await readAvatar(file) }));
      }} />
      {!value.avatarImage ? <>
        <div className="flex flex-wrap gap-2.5 p-1" role="group" aria-label="Character color">
          {BOT_COLORS.map(c => <button type="button" key={c.id} title={c.label} aria-label={`Color: ${c.label}`} aria-pressed={value.color === c.id} onClick={() => void change({ ...value, color: c.id })} style={{ background: c.swatch }} className={`w-6 h-6 rounded-full inline-flex items-center justify-center ${value.color === c.id ? "ring-2 ring-white ring-offset-2 ring-offset-[#181818]" : ""}`}>{value.color === c.id && <Check size={13} className="text-black" />}</button>)}
        </div>
        <div className="grid grid-cols-6 gap-1.5 max-h-40 overflow-y-auto p-1" role="group" aria-label="Character shape">
          {BOT_SHAPES.map(shape => <button type="button" key={shape.id} title={shape.label} aria-label={`Shape: ${shape.label}`} aria-pressed={value.shape === shape.id} onClick={() => void change({ ...value, shape: shape.id })} className={`rounded-lg p-1.5 flex justify-center ${value.shape === shape.id ? "bg-white/10 ring-1 ring-white/30" : "hover:bg-white/[0.06]"}`}><BotCharacterAvatar shape={shape.id} color={value.color} size={28} /></button>)}
        </div>
      </> : <button type="button" onClick={() => void change({ ...value, avatarImage: null })} className="text-xs text-zinc-400 hover:text-white">Remove image · use character</button>}
      <p className="text-xs text-zinc-500">PNG, JPEG, or WebP · up to 10 MB. Saved on this Mac.</p>
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    </fieldset>
  );
}
