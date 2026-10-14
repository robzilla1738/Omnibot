import type React from "react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, Pencil, Folder, Loader2, Play, RefreshCw, ShieldCheck } from "lucide-react";
import type { BotProfile, CliDriverKind, OmniSnapshot } from "../../lib/types";
import type { SetupInput } from "../../lib/omni-bridge";
import { Collapse } from "../ui/Collapse";
import { NativeSelect } from "../ui/NativeSelect";
import { AvatarPicker, type BotAppearance } from "../bots/AvatarPicker";
import { BotCharacterAvatar } from "../icons/BotCharacterAvatar";

const steps = ["Welcome", "Your tools", "Permissions", "Ready"];
const button = "inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const field = "w-full rounded-xl border border-white/10 bg-[#1c1c1c] px-4 py-3 text-sm leading-6 transition-colors duration-200 focus:border-white/20";

export function SetupWorkspace({ snapshot, primaryBot, onRescan, onComplete, onCancel, onPreviewChange }: {
  snapshot: OmniSnapshot;
  primaryBot: BotProfile;
  onRescan: () => Promise<void>;
  onComplete: (input: SetupInput) => Promise<void>;
  onCancel?: () => void;
  onPreviewChange?: (bot: BotProfile) => void;
}) {
  const pictureId = useId();
  const detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [transitioning, setTransitioning] = useState(false);
  const [direction, setDirection] = useState(1);
  const paneRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const moving = useRef(false);
  const previousStep = useRef(step);
  const exitAnimation = useRef<Animation | null>(null);
  useEffect(() => () => exitAnimation.current?.cancel(), []);
  useLayoutEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "instant" });
    if (previousStep.current !== step) paneRef.current?.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
    previousStep.current = step;
  }, [step]);
  const moveToStep = async (target: number) => {
    if (moving.current || target === step) return;
    moving.current = true;
    setTransitioning(true);
    const pane = paneRef.current;
    const nextDirection = target > step ? 1 : -1;
    try {
      if (pane && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        exitAnimation.current = pane.animate([
          { opacity: 1, transform: "translateX(0)" },
          { opacity: 0, transform: `translateX(${-nextDirection * 6}px)` },
        ], { duration: 100, easing: "ease-in", fill: "forwards" });
        await exitAnimation.current.finished.catch(() => {});
      }
      if (!pane?.isConnected) return;
      setDirection(nextDirection);
      setStep(target);
      setError("");
    } finally {
      moving.current = false;
      if (pane?.isConnected) setTransitioning(false);
    }
  };
  const [name, setName] = useState(primaryBot.name);
  const [appearance, setAppearance] = useState<BotAppearance>({ shape: primaryBot.shape, color: primaryBot.color, avatarImage: primaryBot.avatarImage ?? null });
  const [roleTitle, setRoleTitle] = useState(primaryBot.roleTitle);
  const [description, setDescription] = useState(primaryBot.description);
  const [pictureOpen, setPictureOpen] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [drivers, setDrivers] = useState<CliDriverKind[]>([]);
  const [primaryDriver, setPrimaryDriver] = useState<CliDriverKind | undefined>(
    snapshot.harnesses.some(h => h.installed && h.kind === primaryBot.cliDriver) ? primaryBot.cliDriver : undefined,
  );
  const preview = useMemo(() => ({ ...primaryBot, ...appearance, cliDriver: primaryDriver ?? primaryBot.cliDriver, name: name.trim() || primaryBot.name, roleTitle, description }), [primaryBot, appearance, primaryDriver, name, roleTitle, description]);
  useEffect(() => { onPreviewChange?.(preview); }, [preview, onPreviewChange]);
  const [workspace, setWorkspace] = useState("");
  const [approveTools, setApproveTools] = useState(snapshot.preferences.onboardingCompleted ? snapshot.preferences.approveAllTools : false);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const scanStarted = useRef(false);
  const scanInFlight = useRef(false);
  const scanTools = async () => {
    if (scanInFlight.current) return;
    scanStarted.current = true;
    scanInFlight.current = true;
    setScanning(true);
    setScanError("");
    try { await onRescan(); }
    catch (e) { setScanError(e instanceof Error ? e.message : String(e)); }
    finally { scanInFlight.current = false; setScanning(false); }
  };
  const [error, setError] = useState("");
  const [demo, setDemo] = useState(false);
  const installed = snapshot.harnesses.filter(h => h.installed);
  const selected = installed.filter(h => drivers.includes(h.kind));
  const run = async (action: () => Promise<void>) => {
    setError(""); setBusy(true);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const next = () => {
    if (step === 0) {
      // Show the tools step immediately; discovery must never hold the welcome screen.
      void moveToStep(1);
      if (!scanStarted.current) void scanTools();
    }
    else if (step === 3) void run(() => onComplete({ cliDrivers: selected.map(h => h.kind), primaryDriver, primaryName: name.trim(), primaryProfile: { ...appearance, roleTitle, description }, workspacePath: workspace.trim(), approveAllTools: approveTools }));
    else void moveToStep(step + 1);
  };
  return (
    <main className="flex-1 min-w-0 min-h-0 overflow-hidden bg-[#121212]" aria-label="Workspace setup">
      <div className="mx-auto w-full max-w-[650px] px-8 py-8 md:py-10 h-full min-h-0 flex flex-col">
        <div className="flex items-center justify-between gap-3 mb-6 shrink-0">
          <ol className="flex items-center gap-3 text-xs text-zinc-500" aria-label="Setup progress">
            {steps.map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined} className={`flex items-center gap-1.5 transition-colors duration-200 ${step === index ? "text-white" : ""}`}><span className={`w-5 h-5 rounded-full flex items-center justify-center transition-colors duration-200 ${index < step ? "bg-white/15 text-white" : "bg-white/[0.05]"}`}>{index < step ? <Check size={12} /> : index + 1}</span><span className="hidden sm:inline">{label}</span></li>)}
          </ol>
          {onCancel && <button className="text-sm text-zinc-400 hover:text-white" onClick={onCancel} disabled={busy || avatarBusy || transitioning}>Close</button>}
        </div>

        <div ref={scrollRef} className="setup-scroll flex flex-col flex-1 min-h-0 overflow-y-auto overflow-x-hidden -mx-2 px-2">
        <div key={step} ref={paneRef} inert={transitioning} className="motion-view my-auto shrink-0 py-3" style={{ "--view-offset": `${direction * 8}px` } as React.CSSProperties}>
        {step === 0 && <section className="space-y-6">
          <div>
          <div className="flex items-center gap-4">
            <button type="button" aria-label="Change profile picture" aria-expanded={pictureOpen} aria-controls={pictureId} onClick={() => setPictureOpen(v => !v)} className="relative rounded-2xl p-2 hover:bg-white/[0.06] transition-colors">
              <BotCharacterAvatar bot={preview} size={78} showStarBadge={false} />
              <span className="absolute bottom-0 right-0 rounded-full bg-[#303030] border border-white/10 p-1.5"><Pencil size={13} /></span>
            </button>
            <div><span className="block text-sm text-zinc-200">Make it yours</span><button type="button" aria-expanded={pictureOpen} aria-controls={pictureId} onClick={() => setPictureOpen(v => !v)} className="text-xs text-zinc-400 hover:text-white mt-1">Change picture, shape, or color</button></div>
          </div>
          <Collapse open={pictureOpen} id={pictureId}><div className="pt-5"><div className="rounded-2xl border border-white/10 bg-[#181818] p-5"><AvatarPicker value={appearance} onChange={setAppearance} onBusyChange={setAvatarBusy} /></div></div></Collapse>
          </div>
          <div><h1 tabIndex={-1} className="text-[32px] font-medium leading-tight mb-3">A little setup.<br />A team of your own.</h1><p className="text-[15px] text-zinc-400 leading-relaxed max-w-lg">Start with your main bot. Find the coding tools on your Mac, and add teammates when you’re ready. Projects can come later.</p></div>
          <label className="flex flex-col gap-2.5 text-sm text-zinc-300"><span>What should we call your main bot?</span><input className={field} value={name} onChange={e => setName(e.target.value)} maxLength={40} autoComplete="off" /></label>
          <div className="rounded-2xl border border-white/[0.08] overflow-hidden">
            <button type="button" aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => setDetailsOpen(v => !v)} className="w-full flex items-center justify-between gap-4 px-5 py-4 text-sm text-zinc-300 hover:bg-white/[0.03] transition-colors text-left">
              <span>Role &amp; description <span className="text-zinc-500 ml-1.5">Optional</span></span>
              <ChevronDown size={16} className={`text-zinc-500 transition-transform duration-250 motion-reduce:transition-none ${detailsOpen ? "rotate-180" : ""}`} />
            </button>
            <Collapse open={detailsOpen} id={detailsId}>
              <div className="space-y-5 px-5 pb-5 pt-1">
                <label className="flex flex-col gap-2.5 text-sm text-zinc-400"><span>Role</span><input className={field} value={roleTitle} maxLength={100} onChange={e => setRoleTitle(e.target.value)} placeholder="Your project coordinator" /></label>
                <label className="flex flex-col gap-2.5 text-sm text-zinc-400"><span>Description</span><textarea className={`${field} resize-none`} rows={3} value={description} maxLength={500} onChange={e => setDescription(e.target.value)} placeholder="What should this bot help with?" /></label>
              </div>
            </Collapse>
          </div>
          <div className="rounded-2xl border border-white/[0.07] p-4 flex gap-3 text-sm text-zinc-400"><ShieldCheck className="shrink-0 text-zinc-300" size={20} /><p>Setup stays on your Mac. Discovery checks installed tools; the walkthrough uses a scripted demo. No AI requests or model charges.</p></div>
        </section>}

        {step === 1 && <section className="space-y-5">
          <div><h1 tabIndex={-1} className="text-[28px] font-medium mb-2">Meet your local tools.</h1><p className="text-sm text-zinc-400 leading-relaxed">Choose the CLIs you’d like to add as bots. Selected bots will appear individually in your sidebar.</p></div>
          <div className="flex items-center justify-between text-sm"><span role="status" className="text-zinc-400">{scanning ? "Checking installed tools…" : `${installed.length} ${installed.length === 1 ? "tool" : "tools"} found`}</span><button className="flex items-center gap-1.5 text-zinc-300 hover:text-white disabled:opacity-40" disabled={scanning || transitioning} onClick={() => void scanTools()}><RefreshCw size={14} className={scanning ? "animate-spin" : ""} />Scan again</button></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {installed.map(h => <label key={h.kind} className={`rounded-xl border p-3.5 flex items-center gap-3 cursor-pointer ${drivers.includes(h.kind) ? "border-white/30 bg-white/[0.07]" : "border-white/[0.08] bg-[#181818]"}`}>
              <input type="checkbox" aria-label={`Add ${h.name}`} checked={drivers.includes(h.kind)} onChange={e => setDrivers(e.target.checked ? [...drivers, h.kind] : drivers.filter(d => d !== h.kind))} className="accent-white w-4 h-4 shrink-0" />
              <span className="min-w-0"><span className="block text-sm font-medium">{h.name}</span><span className="block text-xs text-zinc-500 truncate" title={h.binaryPath ?? undefined}>Found locally{h.version ? ` · ${h.version}` : ""}</span></span>
            </label>)}
          </div>
          {!installed.length && scanning && <div className="rounded-xl bg-white/[0.04] p-5 text-sm text-zinc-400 flex items-center gap-3"><Loader2 size={16} className="animate-spin shrink-0" />Looking for coding tools on your Mac…</div>}
          {scanError && <p role="alert" className="rounded-xl bg-red-500/10 p-4 text-sm text-red-300">Couldn’t refresh your tools. {scanError} You can scan again or continue with the current list.</p>}
          {!installed.length && !scanning && !scanError && <div className="rounded-xl bg-white/[0.04] p-5 text-sm text-zinc-400">No supported CLIs found yet. You can finish setup now, install a CLI, and return here from Workspace setup.</div>}
          {!!installed.length && <label className="flex flex-col gap-2.5 text-sm"><span className="text-zinc-300">Power {name || "your main bot"} with</span><NativeSelect className={field} value={primaryDriver ?? ""} onChange={e => setPrimaryDriver(e.target.value as CliDriverKind || undefined)}><option value="">Choose later</option>{installed.map(h => <option key={h.kind} value={h.kind}>{h.name}</option>)}</NativeSelect></label>}
          <p className="text-xs text-zinc-500 leading-relaxed">Detection confirms installation, not sign-in. Each CLI uses its own account and billing when you send a real message. Your selected bots appear in the sidebar after setup.</p>
        </section>}

        {step === 2 && <section className="space-y-5">
          <div><h1 tabIndex={-1} className="text-[28px] font-medium mb-2">Give your team a home.</h1><p className="text-sm text-zinc-400">Every bot gets its own local home and memory. You can optionally add a project for future work.</p></div>
          <label className="flex flex-col gap-2.5 text-sm"><span className="flex items-center gap-2 text-zinc-300"><Folder size={16} />Project folder · optional</span><input className={field} value={workspace} onChange={e => setWorkspace(e.target.value)} placeholder="/Users/you/Projects/my-project" autoComplete="off" /><span className="block text-xs text-zinc-500">Leave this empty to start with your personal assistant. Adding a folder does not attach it to your home chat.</span></label>
          <fieldset className="space-y-2.5"><legend className="text-sm text-zinc-300 mb-2">Tool permissions</legend>
            {[{ value: false, title: "Standard permissions", text: "Use each CLI’s normal permission rules. Some tools may already be allowed by your CLI configuration." }, { value: true, title: "Automatic tool approval", text: "Allow tools without confirmation where supported. Bots can edit files and run commands in your workspace." }].map(option => <label key={option.title} className={`flex items-start gap-3 p-4 rounded-xl border cursor-pointer ${approveTools === option.value ? "border-white/30 bg-white/[0.06]" : "border-white/[0.08]"}`}><input type="radio" name="tool-permissions" checked={approveTools === option.value} onChange={() => setApproveTools(option.value)} className="accent-white mt-1" /><span><span className="block text-sm font-medium mb-1">{option.title}</span><span className="block text-xs text-zinc-400 leading-relaxed">{option.text}</span></span></label>)}
          </fieldset>
          <p className="text-xs text-zinc-500">No tools run during setup. You can change these preferences later.</p>
        </section>}

        {step === 3 && <section className="space-y-5">
          <div className="flex items-center gap-4"><BotCharacterAvatar bot={preview} size={56} showStarBadge={false} /><div><h1 tabIndex={-1} className="text-[28px] font-medium mb-2">Your space is ready.</h1><p className="text-sm text-zinc-400">{name} is your starting point. Your sidebar stays simple.</p></div></div>
          <div className="rounded-2xl border border-white/10 text-sm">
            <div className="flex justify-between gap-3 p-4"><span className="text-zinc-500">Main bot</span><span>{name} · {snapshot.harnesses.find(h => h.kind === preview.cliDriver)?.name ?? preview.cliDriver}</span></div>
            <div className="flex justify-between gap-3 p-4"><span className="text-zinc-500">Bot library</span><span>{selected.length ? `${selected.length} selected ${selected.length === 1 ? "CLI" : "CLIs"}` : "Just your main bot"}</span></div>
            <div className="flex justify-between gap-3 p-4"><span className="text-zinc-500">Workspace</span><span className="truncate" title={workspace}>{workspace.split("/").filter(Boolean).pop() || "Choose later"}</span></div>
            <div className="flex justify-between gap-3 p-4"><span className="text-zinc-500">Permissions</span><span>{approveTools ? "Automatic tool approval" : "Standard permissions"}</span></div>
          </div>
          <div className="rounded-2xl bg-[#1b1b1b] p-5 space-y-4">
            <div className="flex justify-between items-center gap-3"><span className="text-sm font-medium">See how a handoff works</span><span className="text-[11px] text-zinc-500">Local demo · no AI calls</span></div>
            {!demo ? <button className={`${button} bg-white/10 hover:bg-white/15 w-full`} onClick={() => setDemo(true)}><Play size={15} />Preview a handoff</button> : <ol className="space-y-3 text-sm" aria-label="Scripted handoff preview">{[[name, "I’ll ask a teammate to review this change."], [selected[0]?.name ?? "Example teammate", "Review complete. I found one suggestion."], [name, "Here’s the combined result. You stay in control."]].map(([who, text], index) => <li key={index} className="flex gap-3"><span className="w-5 h-5 shrink-0 rounded-full bg-white/10 text-zinc-400 text-xs flex items-center justify-center">{index + 1}</span><div><span className="font-medium">{who}</span><p className="text-zinc-400 text-xs mt-0.5">{text}</p></div></li>)}</ol>}
          </div>
          <p className="text-xs text-zinc-500 leading-relaxed">Your selected bots are ready in the sidebar. Create a group chat when you want bots to work together.</p>
        </section>}

        {error && <p role="alert" className="text-sm text-red-300 rounded-xl bg-red-500/10 p-3 mt-5">{error}</p>}
        </div>
        </div>
        <div className="pt-4 mt-2 shrink-0 flex items-center justify-between gap-3" aria-label="Setup navigation">
          <button className={`${button} text-zinc-400 hover:text-white ${step === 0 ? "invisible" : ""}`} disabled={busy || avatarBusy || transitioning} onClick={() => void moveToStep(step - 1)}><ArrowLeft size={16} />Back</button>
          <button className={`${button} motion-cta min-w-[160px] bg-white text-black hover:bg-[#f1f1f1]`} onClick={next} aria-busy={busy || (step === 1 && scanning)} disabled={busy || avatarBusy || transitioning || (step === 1 && scanning) || !name.trim() }><span>{step === 0 ? "Find my tools" : step === 3 ? "Finish setup" : "Continue"}</span><span className="w-4 h-4 shrink-0">{busy || (step === 1 && scanning) ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} className="cta-arrow" />}</span></button>
        </div>
      </div>
    </main>
  );
}
