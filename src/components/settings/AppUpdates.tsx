import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-react";
import { isTauriRuntime } from "../../lib/omni-bridge";

type UpdateStatus = { version: string; available: boolean; automaticallyChecks: boolean };

export function AppUpdates() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    if (isTauriRuntime()) invoke<UpdateStatus>("omni_update_status")
      .then(value => { if (mounted) setStatus(value); })
      .catch(e => { if (mounted) setError(String(e)); });
    return () => { mounted = false; };
  }, []);
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-6">
    <div className="rounded-2xl bg-white/[0.04] p-5 space-y-4">
      <div className="flex items-center gap-4">
        <img src="/omnibot-gauntlet.png" alt="" className="w-12 h-12 object-contain" />
        <div><p className="text-base font-semibold text-white">Omnibot</p>
          <p className="text-sm text-zinc-400">{status ? `Version ${status.version}` : "Desktop updates"}</p></div>
      </div>
      <p className="text-sm text-zinc-400 leading-relaxed">{status?.available
        ? "Omnibot checks for updates daily. You choose when to install and restart. Finish running tasks before updating."
        : "Update checks are available in the installed macOS app."}</p>
      <button type="button" disabled={!status?.available || busy}
        onClick={() => void run(() => invoke("omni_check_for_updates"))}
        className="px-4 py-2.5 rounded-full bg-white text-black text-sm font-medium inline-flex items-center gap-2 hover:bg-zinc-200 disabled:opacity-40 disabled:cursor-default transition-colors">
        <RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} />Check for updates
      </button>
    </div>
    {status?.available && <label className="flex items-center justify-between gap-6 rounded-2xl bg-white/[0.04] p-5 cursor-pointer">
      <span className="text-sm text-zinc-200">Automatically check for updates</span>
      <input type="checkbox" checked={status.automaticallyChecks} disabled={busy}
        onChange={event => { const enabled = event.target.checked; void run(async () => {
          await invoke("omni_set_automatic_updates", { enabled });
          setStatus(current => current && { ...current, automaticallyChecks: enabled });
        }); }} className="w-4 h-4 accent-white" />
    </label>}
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
  </div>;
}
