import type { CliHarnessInfo } from "../../lib/types";
import { rescanOmniEnvironment } from "../../lib/omni-bridge";
import { NativeSelect } from "../ui/NativeSelect";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function BotModelSelect({ value, harness, onChange, label = "Model", defaultLabel = "CLI default", disabled = false }: {
  value: string | null;
  harness?: CliHarnessInfo;
  onChange: (model: string | null) => void | Promise<void>;
  label?: string;
  defaultLabel?: string;
  disabled?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState("");
  useEffect(() => { setCustom(false); setDraft(""); setError(""); }, [harness?.kind]);
  const models = harness?.models ?? [];
  const inFlight = useRef(false);
  const lastSubmitted = useRef<string | null>(null);
  const save = async (model: string | null) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true); setError("");
    try { await onChange(model); }
    catch (error) { lastSubmitted.current = null; setError(error instanceof Error ? error.message : String(error)); }
    finally { inFlight.current = false; setSaving(false); }
  };
  // Enter saves and then disabling the input blurs it; without this the same ID is saved twice.
  const submitCustom = () => {
    const next = draft.trim();
    if (!next || next === lastSubmitted.current) return;
    lastSubmitted.current = next;
    void save(next);
  };
  return <div className="space-y-2 text-xs text-zinc-400">
    <div className="flex items-center justify-between gap-2"><span>{label}</span>
      <button type="button" aria-label={`Refresh ${label.toLowerCase()} options`} disabled={disabled || refreshing || harness?.modelsStatus === "loading"} className="p-1 rounded-md hover:text-white disabled:opacity-40" onClick={async () => {
        setRefreshing(true); setError("");
        try { await rescanOmniEnvironment(); } catch { setError("Couldn't refresh model options. Try again."); }
        finally { setRefreshing(false); }
      }}><RefreshCw size={12} className={refreshing || harness?.modelsStatus === "loading" ? "animate-spin" : ""} /></button>
    </div>
    <NativeSelect aria-label={label} value={custom ? "__custom__" : value ?? ""} disabled={disabled || saving} onChange={event => {
      if (event.target.value === "__custom__") { setDraft(value ?? ""); setCustom(true); return; }
      setCustom(false); void save(event.target.value || null);
    }} className="w-full rounded-xl border border-white/10 bg-[#1c1c1c] px-3 text-sm text-zinc-200">
      <option value="">{defaultLabel}</option>
      {value && !models.includes(value) && <option value={value}>{value} (saved, not listed)</option>}
      {models.map(model => <option key={model} value={model}>{harness?.modelLabels?.[model] ? `${harness.modelLabels[model]} · ${model}` : model}</option>)}
      <option value="__custom__">Custom model…</option>
    </NativeSelect>
    {!value && !custom && defaultLabel === "CLI default" && <p>Uses the model configured in {harness?.name ?? "your CLI"}.</p>}
    {custom && <label className="block space-y-2"><span>Model ID from your CLI</span><input aria-label={`${label} custom ID`} value={draft} onChange={event => { setDraft(event.target.value); lastSubmitted.current = null; }} onBlur={submitCustom} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); submitCustom(); } }} disabled={disabled || saving} className="w-full rounded-xl border border-white/10 bg-[#1c1c1c] px-3 py-3 text-sm text-zinc-200" /></label>}
    {harness?.modelsStatus === "loading" && <p role="status">Checking models with your CLI…</p>}
    {harness?.modelsStatus === "unavailable" && <p>Model list unavailable. Use your CLI default or enter a model ID.</p>}
    {error && <p role="alert" className="text-red-300">{error}</p>}
  </div>;
}
