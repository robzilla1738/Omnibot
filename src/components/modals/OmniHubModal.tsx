import { AppUpdates } from "../settings/AppUpdates";
import { MemoryManager } from "../memory/MemoryManager";
import { routineScheduleLabel } from "../routines/RoutineEditor";
import { BotModelSelect } from "../bots/BotModelSelect";
import { Collapse } from "../ui/Collapse";
import {
  Bot,
  Brain,
  Check,
  Clock,
  Copy,
  FolderGit2,
  Play,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { AvatarPicker } from "../bots/AvatarPicker";
import { useEffect, useId, useState } from "react";
import { duplicateBot } from "../../lib/bots";
import { Dialog, useConfirm } from "../ui/Dialog";
import { errorMessage } from "../ui/Notices";
import type {
  BotColor,
  BotProfile,
  BotShape,
  CliDriverKind,
  CliHarnessInfo,
  LocalSkillItem,
  OmniPreferences,
  RoutineEntry,
  WorkspaceEntry,
} from "../../lib/types";
import {
  BotCharacterAvatar,
  SkillBrandIcon,
} from "../icons/BotCharacterAvatar";

const TURN_BUDGET_OPTIONS = [0.5, 1.5, 3.0, 5.0, 0];
const formatUsdLimit = (usd: number) => (usd > 0 ? `$${usd.toFixed(2)}` : "No limit");

export type OmniHubSection =
  | "bots"
  | "projects"
  | "memories"
  | "skills"
  | "routines"
  | "instructions"
  | "updates";

export interface OmniHubModalProps {
  open: boolean;
  initialSection?: OmniHubSection;
  onClose: () => void;
  bots: BotProfile[];
  harnesses: CliHarnessInfo[];
  skills: LocalSkillItem[];
  projects: WorkspaceEntry[];
  routines: RoutineEntry[];
  preferences: OmniPreferences;
  onUpsertBot: (bot: BotProfile) => Promise<void>;
  onTogglePin: (bot: BotProfile) => Promise<void>;
  onOpenSetup: () => void;
  onOpenCliHarnesses: () => void;
  onDeleteBot: (id: string) => Promise<void>;
  onUpdatePreferences: (prefs: OmniPreferences) => Promise<void>;
  onUpsertProject: (ws: WorkspaceEntry) => Promise<void>;
  onDeleteProject: (id: string) => Promise<void>;
  onDeleteRoutine: (id: string) => Promise<void>;
  onRunRoutineNow: (routine: RoutineEntry) => Promise<void>;
  onSelectBotDirectChat: (bot: BotProfile) => void;
  onStartSidechatWithSkill: (skill: LocalSkillItem) => void;
}

const HUB_SECTIONS: Array<{
  id: OmniHubSection;
  label: string;
  subtitle: string;
}> = [
  {
    id: "bots",
    label: "Bot library",
    subtitle: "Your bots live here. Pin favorites to keep them in the sidebar.",
  },
  {
    id: "projects",
    label: "Projects",
    subtitle: "Local git repositories and project-specific instructions",
  },
  {
    id: "memories",
    label: "Memory",
    subtitle: "Personal notes, project knowledge, and explicitly shared preferences",
  },
  {
    id: "skills",
    label: "Agent Skills",
    subtitle: "Auto-discovered SKILL.md workflows across your local CLIs",
  },
  {
    id: "routines",
    label: "Routines",
    subtitle: "Scheduled prompts and automated multi-bot checks",
  },
  {
    id: "instructions",
    label: "Team Rules & Trust",
    subtitle: "Global instructions, handoff limits, and CLI permission defaults",
  },
  { id: "updates", label: "App updates", subtitle: "Keep Omnibot up to date" },
];

export function OmniHubModal({
  open,
  initialSection = "bots",
  onClose,
  bots,
  harnesses,
  skills,
  projects,
  routines,
  preferences,
  onUpsertBot,
  onDeleteBot,
  onTogglePin,
  onOpenSetup,
  onOpenCliHarnesses,
  onUpdatePreferences,
  onUpsertProject,
  onDeleteProject,
  onDeleteRoutine,
  onRunRoutineNow,
  onSelectBotDirectChat,
  onStartSidechatWithSkill,
}: OmniHubModalProps) {
  const disclosureId = useId();
  const [section, setSection] = useState<OmniHubSection>(initialSection);
  const [searchQuery, setSearchQuery] = useState("");

  // Bot Creator / Editor state
  const [showBotForm, setShowBotForm] = useState(false);
  const [editingBotId, setEditingBotId] = useState<string>("");
  const [botName, setBotName] = useState("");
  const [botRole, setBotRole] = useState("");
  const [botDesc, setBotDesc] = useState("");
  const [botShape, setBotShape] = useState<BotShape>("claude-spark");
  const [botAvatarImage, setBotAvatarImage] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [botSaveError, setBotSaveError] = useState("");
  const [botSaving, setBotSaving] = useState(false);
  const [hubActionPending, setHubActionPending] = useState(false);
  const [hubActionError, setHubActionError] = useState("");
  const { confirm, confirmElement } = useConfirm();
  /** Runs one hub action at a time and reports its failure inline; resolves to whether it succeeded. */
  const runHubAction = async (action: () => Promise<void>): Promise<boolean> => {
    if (hubActionPending) return false;
    setHubActionPending(true); setHubActionError("");
    try { await action(); return true; }
    catch (error) { setHubActionError(errorMessage(error)); return false; }
    finally { setHubActionPending(false); }
  };
  const savePreferences = (patch: Partial<OmniPreferences>) => runHubAction(() => onUpdatePreferences({ ...preferences, ...patch }));
  const [botColor, setBotColor] = useState<BotColor>("orange");
  const [botDriver, setBotDriver] = useState<CliDriverKind>("claude");
  const [botModel, setBotModel] = useState<string>("");
  const [botEffort, setBotEffort] = useState<string>("high");
  const [botPermission, setBotPermission] = useState<string>("auto");
  const [botCustomCommand, setBotCustomCommand] = useState("");
  const [botPrompt, setBotPrompt] = useState("");

  // Projects state
  const [showNewProject, setShowNewProject] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string>("");
  const [projName, setProjName] = useState("");
  const [projPath, setProjPath] = useState("");
  const [projDesc, setProjDesc] = useState("");
  const [projInstructions, setProjInstructions] = useState("");
  const [projAssignedBotIds, setProjAssignedBotIds] = useState<string[]>([]);
  const [projLeadBotId, setProjLeadBotId] = useState<string>("bot-omni");
  const [projUseWorktrees, setProjUseWorktrees] = useState(false);
  const [projAutoApprove, setProjAutoApprove] = useState(false);
  const [projSaving, setProjSaving] = useState(false);
  const [projSaveError, setProjSaveError] = useState("");

  // Instructions state
  const [globalInstructionsDraft, setGlobalInstructionsDraft] = useState(
    preferences.globalInstructions
  );
  const [instructionsSaved, setInstructionsSaved] = useState(false);
  useEffect(() => {
    if (!instructionsSaved) return;
    const timer = setTimeout(() => setInstructionsSaved(false), 1800);
    return () => clearTimeout(timer);
  }, [instructionsSaved]);
  const [workflowBudgetDraft, setWorkflowBudgetDraft] = useState(String(preferences.workflowBudgetUsd));
  useEffect(() => { setWorkflowBudgetDraft(String(preferences.workflowBudgetUsd)); }, [preferences.workflowBudgetUsd]);
  const workflowBudgetValue = Number(workflowBudgetDraft);
  const workflowBudgetValid = workflowBudgetDraft.trim() !== "" && Number.isFinite(workflowBudgetValue) && workflowBudgetValue >= 0;
  const commitWorkflowBudget = () => {
    if (!workflowBudgetValid) { setWorkflowBudgetDraft(String(preferences.workflowBudgetUsd)); return; }
    if (workflowBudgetValue !== preferences.workflowBudgetUsd) void savePreferences({ workflowBudgetUsd: workflowBudgetValue });
  };

  useEffect(() => {
    if (open && initialSection) {
      setSection(initialSection);
    }
  }, [open, initialSection]);
  useEffect(() => { setHubActionError(""); }, [section]);

  useEffect(() => {
    setGlobalInstructionsDraft(preferences.globalInstructions);
  }, [preferences.globalInstructions]);

  const installedHarnesses = harnesses.filter((h) => h.installed);

  const openNewBotEditor = () => {
    setBotAvatarImage(null);
    setBotSaveError("");
    setEditingBotId("");
    setBotCustomCommand("");
    setBotName("");
    setBotRole("Specialized Coding Teammate");
    setBotDesc("");
    setBotShape("crystal");
    setBotColor("violet");
    const defaultDriver = installedHarnesses[0]?.kind ?? "claude";
    setBotDriver(defaultDriver);
    setBotModel("");
    setBotEffort("high");
    setBotPermission("auto");
    setBotPrompt("");
    setShowBotForm(true);
  };

  const openExistingBotEditor = (b: BotProfile) => {
    setBotAvatarImage(b.avatarImage ?? null);
    setBotSaveError("");
    setEditingBotId(b.id);
    setBotName(b.name);
    setBotRole(b.roleTitle);
    setBotDesc(b.description);
    setBotShape((b.shape as BotShape) || "blob");
    setBotColor((b.color as BotColor) || "cyan");
    setBotDriver(b.cliDriver);
    setBotModel(b.model ?? "");
    setBotEffort(b.reasoningEffort || "high");
    setBotPermission(b.permissionMode || "auto");
    setBotCustomCommand(b.customCommand ?? "");
    setBotPrompt(b.systemPrompt);
    setShowBotForm(true);
  };


  const handleSaveBot = async () => {
    if (!botName.trim()) return;
    const existing = bots.find((b) => b.id === editingBotId);
    setBotSaving(true); setBotSaveError("");
    try { await onUpsertBot({
      id: editingBotId,
      archived: existing?.archived ?? false,
      name: botName.trim(),
      slug:
        existing?.slug ||
        botName
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-"),
      roleTitle: botRole.trim() || "Coding Agent",
      description:
        botDesc.trim() || `Powered by ${botDriver} CLI inside Omnibot`,
      avatarImage: botAvatarImage,
      shape: botShape,
      color: botColor,
      isPrimary: existing?.isPrimary ?? false,
      cliDriver: botDriver,
      model: botModel.trim() || null,
      reasoningEffort: botEffort || "high",
      permissionMode: botPermission || "auto",
      systemPrompt: botPrompt.trim(),
      memories: existing?.memories ?? [],
      autoCreatedForCli: existing?.autoCreatedForCli ?? false,
      customCommand: botCustomCommand.trim() || null,
      maxTurnBudgetUsd: existing?.maxTurnBudgetUsd ?? null,
    });
    setShowBotForm(false);
    } catch (e) { setBotSaveError(e instanceof Error ? e.message : String(e)); }
    finally { setBotSaving(false); }
  };

  const openNewProjectForm = () => {
    setEditingProjectId("");
    setProjName("");
    setProjPath("");
    setProjDesc("");
    setProjInstructions("");
    setProjAssignedBotIds([]);
    setProjLeadBotId("bot-omni");
    setProjUseWorktrees(false);
    setProjAutoApprove(preferences.approveAllTools);
    setProjSaveError("");
    setShowNewProject(true);
  };

  const openEditProjectForm = (p: WorkspaceEntry) => {
    setEditingProjectId(p.id);
    setProjName(p.name);
    setProjPath(p.path);
    setProjDesc(p.description);
    setProjInstructions(p.instructions);
    setProjAssignedBotIds(p.assignedBotIds ?? []);
    setProjLeadBotId(p.leadBotId || "bot-omni");
    setProjUseWorktrees(Boolean(p.useWorktreesDefault));
    setProjAutoApprove(Boolean(p.approveAllTools));
    setProjSaveError("");
    setShowNewProject(true);
  };

  const handleSaveProject = async () => {
    if (!projName.trim() || !projPath.trim() || projSaving) return;
    setProjSaving(true); setProjSaveError("");
    try {
    await onUpsertProject({
      id: editingProjectId,
      name: projName.trim(),
      path: projPath.trim(),
      description: projDesc.trim() || "Local git project",
      instructions: projInstructions.trim(),
      assignedBotIds: projAssignedBotIds,
      leadBotId: projLeadBotId || "bot-omni",
      useWorktreesDefault: projUseWorktrees,
      memories: projects.find(p => p.id === editingProjectId)?.memories ?? [],
      approveAllTools: projAutoApprove,
    });
    setShowNewProject(false);
    } catch (error) { setProjSaveError(errorMessage(error)); }
    finally { setProjSaving(false); }
  };

  const handleDeleteProject = async (project: WorkspaceEntry) => {
    const confirmed = await confirm({
      title: `Remove project “${project.name}”?`,
      message: <>Omnibot will forget this project and its settings. Files in <code className="text-zinc-100 break-all">{project.path}</code> are not deleted.</>,
      confirmLabel: "Remove project",
      destructive: true,
    });
    if (confirmed) await runHubAction(() => onDeleteProject(project.id));
  };

  const handleDeleteRoutine = async (routine: RoutineEntry) => {
    const confirmed = await confirm({
      title: `Delete routine “${routine.name}”?`,
      message: "Its schedule and saved instructions will be removed. Past conversation history is kept.",
      confirmLabel: "Delete routine",
      destructive: true,
    });
    if (confirmed) await runHubAction(() => onDeleteRoutine(routine.id));
  };

  const activeSectionMeta =
    HUB_SECTIONS.find((s) => s.id === section) ?? HUB_SECTIONS[0];

  const renderNavIcon = (id: OmniHubSection) => {
    switch (id) {
      case "bots":
        return <Bot className="w-4 h-4 shrink-0" />;
      case "projects":
        return <FolderGit2 className="w-4 h-4 shrink-0" />;
      case "memories":
        return <Brain className="w-4 h-4 shrink-0" />;
      case "skills":
        return <Sparkles className="w-4 h-4 shrink-0" />;
      case "routines":
        return <Clock className="w-4 h-4 shrink-0" />;
      case "updates":
      case "instructions":
        return <Settings className="w-4 h-4 shrink-0" />;
    }
  };

  const renderSectionBadge = (id: OmniHubSection) => {
    switch (id) {
      case "bots":
        return bots.length;
      case "projects":
        return projects.length;
      case "memories":
        return preferences.sharedMemories.length;
      case "skills":
        return skills.length;
      case "routines":
        return routines.length;
      case "updates":
      case "instructions":
        return null;
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="Omnibot Hub"
      className="w-full max-w-[920px] h-[80vh] max-h-[700px] rounded-[24px] bg-[#121212] border border-white/[0.08] shadow-[0_28px_90px_rgba(0,0,0,0.85)] flex overflow-hidden"
    >
        {/* Left Navigation Rail */}
        <div className="w-[244px] shrink-0 bg-[#0e0e0e] p-4 flex flex-col justify-between">
          <div className="space-y-4">
            <div className="px-2 pt-1 flex items-center gap-2.5">
              <img
                src="/omnibot-gauntlet.png"
                alt="Omnibot"
                className="w-8 h-8 object-contain shrink-0"
              />
              <div className="min-w-0">
                <div className="text-[15px] font-semibold text-white tracking-tight truncate">
                  Omnibot Hub
                </div>
                <div className="text-[11.5px] text-zinc-400 truncate">
                  Bots, Projects &amp; Memory
                </div>
              </div>
            </div>

            <nav className="space-y-1">
              {HUB_SECTIONS.map((item) => {
                const active = section === item.id;
                const count = renderSectionBadge(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => setSection(item.id)}
                    className={`w-full px-3 py-2.5 rounded-xl flex items-center justify-between gap-2 text-[13.5px] font-medium transition-all duration-200 spring-transition ${
                      active
                        ? "liquid-glass-active text-white"
                        : "text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.05]"
                    }`}
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      {renderNavIcon(item.id)}
                      <span className="truncate">{item.label}</span>
                    </span>
                    {count !== null && count > 0 && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-white/[0.08] text-zinc-300 tabular-nums shrink-0">
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="px-2.5 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[11px] text-zinc-400">
            100% Local · Stored in <code className="text-zinc-200">~/.omni-bot</code>
          </div>
        </div>

        {/* Right Content Area */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <div className="px-7 pt-5 pb-4 flex items-center justify-between gap-4 shrink-0">
            <div className="min-w-0">
              <h2 className="text-[19px] font-semibold text-white tracking-tight truncate">
                {activeSectionMeta.label}
              </h2>
              <p className="text-[12.5px] text-zinc-400 truncate mt-0.5">
                {activeSectionMeta.subtitle}
              </p>
            </div>

            <button
              type="button"
              aria-label="Close Omnibot Hub"
              onClick={onClose}
              className="w-8 h-8 rounded-full liquid-glass-chip flex items-center justify-center text-zinc-300 hover:text-white shrink-0 active:scale-95"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div key={section} className="motion-view stable-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-7 space-y-5">
            {hubActionError && <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-300 break-words">{hubActionError}</p>}
            {section === "updates" && <AppUpdates />}
            {section === "bots" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">
                    {bots.length} {bots.length === 1 ? "bot" : "bots"} in your library
                  </span>
                  <button
                    type="button"
                    onClick={openNewBotEditor}
                    className="px-3.5 py-1.5 rounded-full bg-white text-black text-xs font-semibold flex items-center gap-1.5 hover:bg-zinc-200 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Create New Bot</span>
                  </button>
                  <button type="button" onClick={onOpenSetup} className="px-3 py-1.5 rounded-full border border-white/10 text-xs text-zinc-300 hover:text-white">Add from CLIs</button>
                  <button type="button" onClick={onOpenCliHarnesses} className="text-xs text-zinc-400 hover:text-white">Local tools</button>
                </div>

                <Collapse open={showBotForm} id={disclosureId + '-showBotForm'}><div className="rounded-2xl liquid-glass-card p-5 space-y-4 border-cyan-400/30">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <BotCharacterAvatar
                          bot={{ avatarImage: botAvatarImage }}
                          shape={botShape}
                          color={botColor}
                          cliDriver={botDriver}
                          size={48}
                          showCliBadge
                        />
                        <div>
                          <div className="text-sm font-semibold text-white">
                            {editingBotId ? `Edit ${botName}` : "Create a New Bot"}
                          </div>
                          <div className="text-xs text-zinc-400">
                            Assign a provider-logo mascot or custom shape, role, and CLI
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowBotForm(false)}
                        className="text-xs text-zinc-400 hover:text-white"
                      >
                        Cancel
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <input
                        type="text"
                        value={botName}
                        onChange={(e) => setBotName(e.target.value)}
                        placeholder="Bot Name (e.g. Architect, Reviewer, Sentinel)"
                        className="rounded-xl bg-black/40 border border-white/10 px-3 py-2 text-[13px] text-white focus:outline-none"
                      />
                      <input
                        type="text"
                        value={botRole}
                        onChange={(e) => setBotRole(e.target.value)}
                        placeholder="Role Title (e.g. Security & Auth Specialist)"
                        className="rounded-xl bg-black/40 border border-white/10 px-3 py-2 text-[13px] text-white focus:outline-none"
                      />
                    </div>

                    {/* CLI Driver Picker */}
                    <div className="space-y-1.5">
                      <label className="block text-xs text-zinc-400">
                        Powered by Local CLI Harness (multiple Bots can share the same CLI)
                      </label>
                      <div className="flex flex-wrap gap-2">
                        {installedHarnesses.map((h) => (
                          <button
                            key={h.id}
                            type="button"
                            onClick={() => {
                              setBotDriver(h.kind);
                              setBotModel("");
                              setBotPermission("auto");
                              setBotCustomCommand("");
                            }}
                            className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
                              botDriver === h.kind
                                ? "bg-white text-black font-semibold"
                                : "bg-[#1f1f1f] text-zinc-300 hover:text-white"
                            }`}
                          >
                            {h.name} ({h.binaryName})
                          </button>
                        ))}
                      </div>
                    </div>

                    <p className="text-xs text-zinc-500">{installedHarnesses.some(h => h.kind === botDriver) ? "CLI detected" : "CLI not detected"} · Authentication not verified{botDriver === "ollama" && !botModel ? " · Choose an installed model before running" : ""}</p>
                    <details className="text-xs text-zinc-400"><summary className="cursor-pointer">Advanced command settings</summary><label className="block mt-2">Custom executable and arguments<input aria-label="Custom CLI command" value={botCustomCommand} onChange={e => setBotCustomCommand(e.target.value)} placeholder="Optional command override" className="block w-full mt-1 rounded bg-white/5 p-2" /></label><p className="mt-1">The selected adapter still controls command flags. Changing the adapter clears this override.</p></details>
                    {/* Model, Effort & Permission Row */}
                    <div className="grid grid-cols-3 gap-3">
                      <BotModelSelect label="Default model" value={botModel || null} harness={installedHarnesses.find(h => h.kind === botDriver)} onChange={model => setBotModel(model ?? "")} />
                      <div className="space-y-1">
                        <label className="block text-xs text-zinc-400">
                          Reasoning Effort
                        </label>
                        <div className="grid grid-cols-3 gap-1">
                          {(["low", "medium", "high"] as const).map((lvl) => (
                            <button
                              key={lvl}
                              disabled={!installedHarnesses.find(h => h.kind === botDriver)?.supportsEffort}
                              title="Reasoning effort is available only for adapters that support it"
                              type="button"
                              onClick={() => setBotEffort(lvl)}
                              className={`py-1.5 rounded-lg text-[11px] capitalize ${
                                botEffort === lvl
                                  ? "bg-white text-black font-semibold"
                                  : "bg-[#1f1f1f] text-zinc-300"
                              }`}
                            >
                              {lvl}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-1">
                        <label className="block text-xs text-zinc-400">
                          Permission Mode
                        </label>
                        <div className="grid grid-cols-2 gap-1">
                          {(
                            [
                              { id: "auto", label: "CLI permissions" },
                              { id: "plan", label: "Plan Only" },
                            ] as const
                          ).map((pm) => (
                            <button
                              key={pm.id}
                              disabled={pm.id === "plan" && !installedHarnesses.find(h => h.kind === botDriver)?.supportsPlan}
                              title={pm.id === "plan" ? "Available only when this adapter supports plan mode" : "Use this CLI's configured permissions"}
                              type="button"
                              onClick={() => setBotPermission(pm.id)}
                              className={`py-1.5 rounded-lg text-[11px] ${
                                botPermission === pm.id
                                  ? "bg-white text-black font-semibold"
                                  : "bg-[#1f1f1f] text-zinc-300"
                              }`}
                            >
                              {pm.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    <AvatarPicker value={{ shape: botShape, color: botColor, avatarImage: botAvatarImage }} onBusyChange={setAvatarBusy} onChange={next => {
                      setBotShape(next.shape as BotShape); setBotColor(next.color as BotColor); setBotAvatarImage(next.avatarImage ?? null);
                    }} />
                    {botSaveError && <p role="alert" className="text-sm text-red-300">{botSaveError}</p>}

                    <textarea
                      rows={3}
                      value={botPrompt}
                      onChange={(e) => setBotPrompt(e.target.value)}
                      placeholder="System persona & instructions for this Bot..."
                      className="w-full rounded-xl bg-black/40 border border-white/10 p-3 text-[13px] text-white focus:outline-none resize-none"
                    />

                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={handleSaveBot}
                        disabled={avatarBusy || botSaving || !botName.trim()}
                        className="px-4 py-2 rounded-full bg-white text-black text-xs font-semibold hover:bg-zinc-200"
                      >
                        Save Bot
                      </button>
                    </div>
                  </div></Collapse>

                <p className="text-xs text-zinc-500 mb-3">Archiving preserves conversations and memory. Duplicating copies settings with fresh memory. Tool detection does not verify authentication.</p>
                <div className="grid grid-cols-2 gap-3.5">
                  {bots.map((b) => (
                    <div
                      key={b.id}
                      className="rounded-2xl liquid-glass-card p-4 flex flex-col justify-between gap-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <BotCharacterAvatar
                            bot={b}
                            size={46}
                            showCliBadge={!b.isPrimary}
                            showStarBadge={b.isPrimary}
                            useHeroMascot={b.isPrimary}
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-[14.5px] font-semibold text-white truncate">
                                {b.name}
                              </span>
                              <span className="text-[11px]  px-1.5 py-0.2 rounded bg-white/[0.06] text-zinc-300">
                                {b.cliDriver}
                              </span>
                            </div>
                            <div className="text-xs text-zinc-400 truncate mt-0.5">
                              {b.roleTitle}
                            </div>
                          </div>
                        </div>
                        {!b.isPrimary && (
                          <button
                            type="button"
                            aria-label={b.archived ? `Restore ${b.name}` : `Archive ${b.name}`}
                            disabled={hubActionPending}
                            onClick={() => void runHubAction(() => b.archived ? onUpsertBot({ ...b, archived: false }) : onDeleteBot(b.id))}
                            className="text-zinc-500 hover:text-red-400 p-1"
                          >
                            {b.archived ? <span className="text-xs">Restore</span> : <Trash2 className="w-3.5 h-3.5" />}
                          </button>
                        )}
                      </div>

                      {!b.isPrimary && !b.archived && <button
                        type="button"
                        aria-label={`${preferences.pinnedBotIds.includes(b.id) ? "Unpin" : "Pin"} ${b.name} ${preferences.pinnedBotIds.includes(b.id) ? "from" : "to"} sidebar`}
                        aria-pressed={preferences.pinnedBotIds.includes(b.id)}
                        onClick={() => void onTogglePin(b)}
                        className="flex items-center gap-2 text-xs text-zinc-400 hover:text-white w-fit"
                      >{preferences.pinnedBotIds.includes(b.id) ? <PinOff size={13} /> : <Pin size={13} />}{preferences.pinnedBotIds.includes(b.id) ? "Unpin from sidebar" : "Pin to sidebar"}</button>}
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => {
                            onSelectBotDirectChat(b);
                            onClose();
                          }}
                          className="flex-1 py-1.5 rounded-xl bg-white text-black text-xs font-semibold hover:bg-zinc-200"
                        >
                          {b.archived ? "View preserved conversation" : `Message @${b.name}`}
                        </button>
                        <button
                          type="button"
                          disabled={hubActionPending}
                          onClick={() => void runHubAction(() => onUpsertBot(duplicateBot(b, bots)))}
                          title={`Clone @${b.name} into another Bot running on ${b.cliDriver}`}
                          className="px-2.5 py-1.5 rounded-xl liquid-glass-chip text-xs text-zinc-200 hover:text-white inline-flex items-center gap-1"
                        >
                          <Copy className="w-3 h-3" />
                          <span>Clone</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => openExistingBotEditor(b)}
                          className="px-3 py-1.5 rounded-xl liquid-glass-chip text-xs text-zinc-200 hover:text-white"
                        >
                          Edit
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {section === "projects" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">
                    Active project:{" "}
                    <code className="text-zinc-200">{preferences.workspaceRoot}</code>
                  </span>
                  <button
                    type="button"
                    onClick={openNewProjectForm}
                    className="px-3.5 py-1.5 rounded-full bg-white text-black text-xs font-semibold flex items-center gap-1.5 hover:bg-zinc-200"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Project</span>
                  </button>
                </div>

                <Collapse open={showNewProject} id={disclosureId + '-showNewProject'}><div className="rounded-2xl liquid-glass-card p-5 space-y-4 border-cyan-400/30">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-white">
                        {editingProjectId ? `Configure Project: ${projName}` : "Add Local Project"}
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowNewProject(false)}
                        className="text-xs text-zinc-400 hover:text-white"
                      >
                        Cancel
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <input
                        type="text"
                        aria-label="Project name"
                        value={projName}
                        onChange={(e) => setProjName(e.target.value)}
                        placeholder="Project name (e.g. My app)"
                        className="w-full rounded-xl bg-black/40 border border-white/10 px-3 py-2 text-[13px] text-white focus:outline-none"
                      />
                      <input
                        type="text"
                        aria-label="Project folder path"
                        value={projPath}
                        onChange={(e) => setProjPath(e.target.value)}
                        placeholder="/Users/you/Projects/my-app"
                        className="w-full rounded-xl bg-black/40 border border-white/10 px-3 py-2 text-[13px] text-white  focus:outline-none"
                      />
                    </div>

                    <label className="flex items-start gap-3 rounded-xl bg-white/[0.04] p-4 text-sm"><input type="checkbox" checked={projAutoApprove} onChange={event => setProjAutoApprove(event.target.checked)} className="mt-1 accent-white" /><span>Automatically approve tools in this project<span className="block text-xs text-zinc-500 mt-1">When off, each CLI uses its normal permission rules. Home conversations keep standard permissions.</span></span></label>
                    {/* Assigned Bots on this Project */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs text-zinc-400">
                        <span>
                          Bots Assigned to Project{" "}
                          {projAssignedBotIds.length === 0
                            ? "(All Bots enabled)"
                            : `(${projAssignedBotIds.length} selected)`}
                        </span>
                        {projAssignedBotIds.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setProjAssignedBotIds([])}
                            className="text-[11px] text-cyan-300 hover:text-white"
                          >
                            Allow All Bots
                          </button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {bots.map((b) => {
                          const assigned =
                            projAssignedBotIds.length === 0 ||
                            projAssignedBotIds.includes(b.id);
                          return (
                            <button
                              key={b.id}
                              type="button"
                              onClick={() =>
                                setProjAssignedBotIds((prev) => {
                                  if (prev.length === 0) {
                                    return bots
                                      .filter((x) => x.id !== b.id)
                                      .map((x) => x.id);
                                  }
                                  return prev.includes(b.id)
                                    ? prev.filter((id) => id !== b.id)
                                    : [...prev, b.id];
                                })
                              }
                              className={`px-2.5 py-1.5 rounded-full text-xs flex items-center gap-1.5 transition-colors ${
                                assigned
                                  ? "bg-white/[0.12] border border-white/25 text-white font-medium"
                                  : "bg-[#1a1a1d] border border-white/[0.05] text-zinc-500"
                              }`}
                            >
                              <BotCharacterAvatar bot={b} size={18} />
                              <span>@{b.name}</span>
                              {assigned && (
                                <Check className="w-3 h-3 text-[#8cf1fb]" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Default Lead Bot + Worktree Isolation */}
                    <div className="grid grid-cols-2 gap-3 items-center">
                      <div className="space-y-1">
                        <label className="block text-xs text-zinc-400">
                          Default Lead Coordinator Bot
                        </label>
                        <div className="flex flex-wrap gap-1.5">
                          {bots.slice(0, 5).map((b) => (
                            <button
                              key={b.id}
                              type="button"
                              onClick={() => setProjLeadBotId(b.id)}
                              className={`px-2.5 py-1 rounded-lg text-xs flex items-center gap-1.5 ${
                                projLeadBotId === b.id
                                  ? "bg-white text-black font-semibold"
                                  : "bg-[#1f1f1f] text-zinc-300"
                              }`}
                            >
                              <BotCharacterAvatar bot={b} size={16} />
                              <span>{b.name}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="flex items-center justify-between rounded-xl bg-black/30 border border-white/[0.07] px-3 py-2.5">
                        <div>
                          <div className="text-xs font-medium text-white">
                            Isolate Group in Worktrees
                          </div>
                          <div className="text-[11px] text-zinc-400">
                            Default for group chats on this project
                          </div>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={projUseWorktrees}
                          onClick={() => setProjUseWorktrees((v) => !v)}
                          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                            projUseWorktrees ? "bg-[#3b82f6]" : "bg-white/[0.14]"
                          }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-md transition ${
                              projUseWorktrees ? "translate-x-4" : "translate-x-0"
                            }`}
                          />
                        </button>
                      </div>
                    </div>

                    <textarea
                      rows={3}
                      value={projInstructions}
                      onChange={(e) => setProjInstructions(e.target.value)}
                      placeholder="Project-specific instructions injected into every Bot working on this codebase (architecture rules, test commands, style conventions)..."
                      className="w-full rounded-xl bg-black/40 border border-white/10 p-3 text-[13px] text-white focus:outline-none resize-none"
                    />

                    {projSaveError && <p role="alert" className="text-sm text-red-300 break-words">{projSaveError}</p>}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => void handleSaveProject()}
                        disabled={projSaving || !projName.trim() || !projPath.trim()}
                        className="px-4 py-1.5 rounded-full bg-white text-black text-xs font-semibold disabled:opacity-40"
                      >
                        {projSaving ? "Saving…" : "Save Project Configuration"}
                      </button>
                    </div>
                  </div></Collapse>

                <div className="grid grid-cols-2 gap-3.5">
                  {projects.map((proj) => {
                    const isActive = preferences.workspaceRoot === proj.path;
                    const assignedBots =
                      proj.assignedBotIds && proj.assignedBotIds.length > 0
                        ? bots.filter((b) => proj.assignedBotIds?.includes(b.id))
                        : bots;
                    return (
                      <div
                        key={proj.id}
                        className="rounded-2xl liquid-glass-card p-4 flex flex-col justify-between gap-3"
                      >
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[14px] font-semibold text-white truncate flex items-center gap-2">
                              <FolderGit2 className="w-4 h-4 text-[#8cf1fb]" />
                              <span>{proj.name}</span>
                            </span>
                            <div className="flex items-center gap-1">
                              {projects.length > 1 && (
                                <button
                                  type="button"
                                  aria-label={`Remove project ${proj.name}`}
                                  disabled={hubActionPending}
                                  onClick={() => void handleDeleteProject(proj)}
                                  className="text-zinc-500 hover:text-red-400 p-1"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                          <div className="text-xs  text-zinc-400 truncate">
                            {proj.path}
                          </div>
                          {proj.instructions && (
                            <p className="text-xs text-zinc-300 line-clamp-2">
                              {proj.instructions}
                            </p>
                          )}
                          <div className="flex items-center justify-between pt-1">
                            <div className="flex items-center -space-x-1.5">
                              {assignedBots.slice(0, 6).map((b) => (
                                <BotCharacterAvatar key={b.id} bot={b} size={22} />
                              ))}
                            </div>
                            <span className="text-[11px] text-zinc-400">
                              {proj.assignedBotIds && proj.assignedBotIds.length > 0
                                ? `${assignedBots.length} Bots assigned`
                                : "All Bots enabled"}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void savePreferences({ workspaceRoot: proj.path })}
                            className={`flex-1 py-1.5 rounded-xl text-xs font-medium ${
                              isActive
                                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-400/30"
                                : "liquid-glass-chip text-zinc-100 hover:text-white"
                            }`}
                          >
                            {isActive ? "Active Project" : "Switch to Project"}
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditProjectForm(proj)}
                            className="px-3 py-1.5 rounded-xl liquid-glass-chip text-xs text-zinc-200 hover:text-white"
                          >
                            Configure Bots
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {section === "memories" && <MemoryManager bots={bots} projects={projects} preferences={preferences} onBot={onUpsertBot} onProject={onUpsertProject} onPreferences={onUpdatePreferences} />}

            {section === "skills" && (
              <div className="space-y-4">
                <div className="h-10 rounded-full liquid-glass-chip px-4 flex items-center gap-2.5">
                  <Search className="w-4 h-4 text-zinc-400 shrink-0" />
                  <input
                    type="text"
                    aria-label="Filter skills"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter local agent skills..."
                    className="min-w-0 flex-1 bg-transparent text-[13.5px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3.5">
                  {skills
                    .filter(
                      (s) =>
                        !searchQuery.trim() ||
                        s.name
                          .toLowerCase()
                          .includes(searchQuery.trim().toLowerCase()) ||
                        s.slug
                          .toLowerCase()
                          .includes(searchQuery.trim().toLowerCase())
                    )
                    .map((skill) => (
                      <div
                        key={skill.id}
                        className="rounded-2xl liquid-glass-card p-3.5 flex items-center justify-between gap-3"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <SkillBrandIcon name={skill.name} size={40} />
                          <div className="min-w-0 flex-1">
                            <div className="text-[13.5px] font-semibold text-zinc-100 truncate">
                              {skill.name}
                            </div>
                            <div className="text-xs text-zinc-400 truncate mt-0.5">
                              /{skill.slug} · {skill.source}
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            onStartSidechatWithSkill(skill);
                            onClose();
                          }}
                          className="px-3.5 py-1.5 rounded-full liquid-glass-chip text-xs font-medium text-zinc-100 shrink-0"
                        >
                          Launch
                        </button>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {section === "routines" && (
              <div className="space-y-3">
                <p className="text-xs text-zinc-400">Run saved tasks manually or on their schedule while Omnibot is open. Create routines from a chat’s settings.</p>
                {routines.map((r) => (
                  <div
                    key={r.id}
                    className="rounded-2xl liquid-glass-card px-4 py-3.5 flex items-center justify-between gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-semibold text-zinc-100 truncate">
                        {r.name} {r.runStatus && <span className="text-xs text-zinc-400">· {r.runStatus}</span>}
                      </div>
                      <div className="text-xs text-zinc-400 truncate mt-0.5">
                        {r.prompt}
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5 shrink-0">
                      <button
                        type="button"
                        aria-label={`Run ${r.name} now`}
                        disabled={hubActionPending}
                        onClick={() => void runHubAction(async () => { await onRunRoutineNow(r); onClose(); })}
                        className="p-1.5 rounded-lg liquid-glass-chip text-zinc-300 hover:text-white"
                      >
                        <Play className="w-3.5 h-3.5" />
                      </button>
                      <span className="text-xs text-zinc-500">{routineScheduleLabel(r)}</span>
                      <button
                        type="button"
                        aria-label={`Delete routine ${r.name}`}
                        disabled={hubActionPending}
                        onClick={() => void handleDeleteRoutine(r)}
                        className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {section === "instructions" && (
              <div className="space-y-5">
                <div className="rounded-2xl liquid-glass-card p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[14px] font-semibold text-white">
                        Global Team Instructions
                      </div>
                      <p className="text-xs text-zinc-400">
                        Injected into the system context of every Bot turn
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={hubActionPending}
                      onClick={async () => {
                        if (await savePreferences({ globalInstructions: globalInstructionsDraft.trim() })) setInstructionsSaved(true);
                      }}
                      className="px-4 py-1.5 rounded-full bg-white text-black text-xs font-semibold hover:bg-zinc-200"
                    >
                      {instructionsSaved ? "Saved" : "Save Instructions"}
                    </button>
                  </div>
                  <textarea
                    rows={4}
                    aria-label="Global team instructions"
                    value={globalInstructionsDraft}
                    onChange={(e) => setGlobalInstructionsDraft(e.target.value)}
                    className="w-full rounded-xl bg-black/40 border border-white/10 p-3 text-[13.5px] text-zinc-100 focus:outline-none resize-none"
                  />
                </div>

                <div className="rounded-2xl liquid-glass-card p-4 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[14px] font-semibold text-white">
                      <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>Auto-Approve Local CLI Tool Execution</span>
                    </div>
                    <p className="text-xs text-zinc-400 mt-0.5">
                      Default tool approval for new projects. Existing projects have their own setting. Home conversations use standard permissions.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={preferences.approveAllTools}
                    aria-label="Auto-approve local CLI tool execution"
                    onClick={() => void savePreferences({ approveAllTools: !preferences.approveAllTools })}
                    className={`relative inline-flex h-6 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                      preferences.approveAllTools ? "bg-[#3b82f6]" : "bg-white/[0.14]"
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition ${
                        preferences.approveAllTools ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>

                <div className="rounded-2xl liquid-glass-card overflow-hidden">
                  {([
                    ["summarizeTeamResults", "Summarize team results", "Have the first bot combine the team’s results into one final response. Adds one bot turn."],
                    ["trustCursorBotHomes", "Trust bot homes in Cursor", "Let Cursor work in bot home folders created by Omnibot. Project folders still require their own trust approval. Tool permissions remain unchanged."],
                  ] as const).map(([key, label, description]) => <div key={key} className="px-4 py-3 flex items-center justify-between gap-4">
                    <div><div className="text-[13.5px] font-semibold text-white">{label}</div><p className="text-xs text-zinc-400">{description}</p></div>
                    <button type="button" role="switch" aria-label={label} aria-checked={preferences[key]} disabled={hubActionPending}
                      onClick={() => void savePreferences({ [key]: !preferences[key] })}
                      className={`relative inline-flex h-6 w-10 shrink-0 rounded-full border-2 border-transparent transition-colors ${preferences[key] ? "bg-zinc-200" : "bg-white/[0.14]"}`}>
                      <span className={`inline-block h-5 w-5 rounded-full shadow transition ${preferences[key] ? "translate-x-4 bg-zinc-800" : "translate-x-0 bg-white"}`} />
                    </button>
                  </div>)}
                </div>

                {/* Token & Swarm Loop Guardrails */}
                <div className="rounded-2xl liquid-glass-card overflow-hidden">
                  <div className="px-4 py-3 flex items-center justify-between gap-4">
                    <div>
                      <div className="text-[13.5px] font-semibold text-white">
                        Prevent Ping-Pong Handoff Loops
                      </div>
                      <p className="text-xs text-zinc-400">
                        Blocks duplicate Bot-to-Bot edges and caps per-Bot turns in a single autonomous chain
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-label="Prevent ping-pong handoff loops"
                      aria-checked={preferences.preventHandoffLoops}
                      onClick={() => void savePreferences({ preventHandoffLoops: !preferences.preventHandoffLoops })}
                      className={`relative inline-flex h-6 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                        preferences.preventHandoffLoops
                          ? "bg-[#3b82f6]"
                          : "bg-white/[0.14]"
                      }`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition ${
                          preferences.preventHandoffLoops
                            ? "translate-x-4"
                            : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  <div className="px-4 py-3 flex items-center justify-between gap-4">
                    <div>
                      <div className="text-[13.5px] font-semibold text-white">
                        Require Explicit &lt;handoff&gt; Tags Only
                      </div>
                      <p className="text-xs text-zinc-400">
                        Only trigger Bot-to-Bot handoffs when a Bot emits an explicit &lt;handoff&gt; block
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-label="Require explicit handoff tags only"
                      aria-checked={preferences.onlyExplicitHandoffs}
                      onClick={() => void savePreferences({ onlyExplicitHandoffs: !preferences.onlyExplicitHandoffs })}
                      className={`relative inline-flex h-6 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                        preferences.onlyExplicitHandoffs
                          ? "bg-[#3b82f6]"
                          : "bg-white/[0.14]"
                      }`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition ${
                          preferences.onlyExplicitHandoffs
                            ? "translate-x-4"
                            : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  <div className="px-4 py-3 flex items-center justify-between gap-4">
                    <div>
                      <div className="text-[13.5px] font-semibold text-white">
                        Context Window Guardrail (Messages)
                      </div>
                      <p className="text-xs text-zinc-400">
                        Resumed CLI sessions send delta-only updates; new turns cap context to N messages
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      {[4, 6, 10, 16].map((n) => (
                        <button
                          key={n}
                          type="button"
                          aria-pressed={preferences.maxContextMessages === n}
                          onClick={() => void savePreferences({ maxContextMessages: n })}
                          className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${
                            preferences.maxContextMessages === n
                              ? "bg-white text-black"
                              : "bg-[#1f1f1f] text-zinc-400 hover:text-white"
                          }`}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="px-4 py-3 flex items-center justify-between gap-4">
                    <div>
                      <div className="text-[13.5px] font-semibold text-white">
                        Reported cost limit per turn (USD)
                      </div>
                      <p className="text-xs text-zinc-400">
                        Automatically stops a CLI turn if reported cost exceeds this threshold
                      </p>
                    </div>
                    <div className="flex items-center gap-1" role="group" aria-label="Reported cost limit per turn">
                      {TURN_BUDGET_OPTIONS.map((usd) => (
                        <button
                          key={usd}
                          type="button"
                          aria-pressed={preferences.maxTurnBudgetUsd === usd}
                          onClick={() => void savePreferences({ maxTurnBudgetUsd: usd })}
                          className={`px-2.5 py-1 rounded-lg text-xs whitespace-nowrap font-semibold ${
                            preferences.maxTurnBudgetUsd === usd
                              ? "bg-white text-black"
                              : "bg-[#1f1f1f] text-zinc-400 hover:text-white"
                          }`}
                        >
                          {formatUsdLimit(usd)}
                        </button>
                      ))}
                    </div>
                  </div>

                  <label className="px-4 py-3 flex items-center justify-between gap-4 text-sm">
                    <span>Workflow reported-cost limit (USD)<span className="block text-xs text-zinc-400">Stops queued work after reported costs reach this amount; not a provider spending cap. Enter 0 for no limit.</span></span>
                    <input aria-label="Workflow cost limit" aria-invalid={!workflowBudgetValid} type="number" min="0" step="0.25" inputMode="decimal" className={`w-24 rounded bg-white/10 p-2 ${workflowBudgetValid ? "" : "ring-1 ring-red-400"}`} value={workflowBudgetDraft} onChange={e => setWorkflowBudgetDraft(e.target.value)} onBlur={commitWorkflowBudget} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); commitWorkflowBudget(); } }} />
                  </label>
                  <div className="px-4 py-3 flex items-center justify-between gap-4">
                    <div>
                      <div className="text-[13.5px] font-semibold text-white">
                        Max concurrent bots across all chats
                      </div>
                      <p className="text-xs text-zinc-400">
                        Tasks sharing a working folder queue automatically to avoid conflicting edits.
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      {[1, 2, 3, 4, 6].map((cnt) => (
                        <button
                          key={cnt}
                          type="button"
                          aria-pressed={preferences.maxParallelBots === cnt}
                          onClick={() => void savePreferences({ maxParallelBots: cnt })}
                          className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${
                            preferences.maxParallelBots === cnt
                              ? "bg-white text-black"
                              : "bg-[#1f1f1f] text-zinc-400 hover:text-white"
                          }`}
                        >
                          {cnt}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      {confirmElement}
    </Dialog>
  );
}
