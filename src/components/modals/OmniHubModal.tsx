import {
  Bot,
  Brain,
  Check,
  Clock,
  Copy,
  FolderGit2,
  Play,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
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
  BOT_COLORS,
  BOT_SHAPES,
  BotCharacterAvatar,
  SkillBrandIcon,
} from "../icons/BotCharacterAvatar";

export type OmniHubSection =
  | "bots"
  | "projects"
  | "memories"
  | "skills"
  | "routines"
  | "instructions";

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
  onDeleteBot: (id: string) => Promise<void>;
  onUpdatePreferences: (prefs: OmniPreferences) => Promise<void>;
  onUpsertProject: (ws: WorkspaceEntry) => Promise<void>;
  onDeleteProject: (id: string) => Promise<void>;
  onUpsertRoutine: (routine: RoutineEntry) => Promise<void>;
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
    label: "Bots & Roster",
    subtitle: "Create and customize persistent CLI Bots, provider mascots, and roles",
  },
  {
    id: "projects",
    label: "Projects",
    subtitle: "Local git repositories and project-specific instructions",
  },
  {
    id: "memories",
    label: "Shared Memories",
    subtitle: "Persistent facts injected across every Bot and Swarm Room",
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
    label: "Swarm Rules & Trust",
    subtitle: "Global instructions, handoff limits, and CLI permission defaults",
  },
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
  onUpdatePreferences,
  onUpsertProject,
  onDeleteProject,
  onUpsertRoutine,
  onDeleteRoutine,
  onRunRoutineNow,
  onSelectBotDirectChat,
  onStartSidechatWithSkill,
}: OmniHubModalProps) {
  const [section, setSection] = useState<OmniHubSection>(initialSection);
  const [searchQuery, setSearchQuery] = useState("");

  // Bot Creator / Editor state
  const [showBotForm, setShowBotForm] = useState(false);
  const [editingBotId, setEditingBotId] = useState<string>("");
  const [botName, setBotName] = useState("");
  const [botRole, setBotRole] = useState("");
  const [botDesc, setBotDesc] = useState("");
  const [botShape, setBotShape] = useState<BotShape>("claude-spark");
  const [botColor, setBotColor] = useState<BotColor>("orange");
  const [botDriver, setBotDriver] = useState<CliDriverKind>("claude");
  const [botModel, setBotModel] = useState<string>("");
  const [botEffort, setBotEffort] = useState<string>("high");
  const [botPermission, setBotPermission] = useState<string>("auto");
  const [botPrompt, setBotPrompt] = useState("");

  // Memories state
  const [newMemoryText, setNewMemoryText] = useState("");

  // Projects state
  const [showNewProject, setShowNewProject] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string>("");
  const [projName, setProjName] = useState("");
  const [projPath, setProjPath] = useState(preferences.workspaceRoot);
  const [projDesc, setProjDesc] = useState("");
  const [projInstructions, setProjInstructions] = useState("");
  const [projAssignedBotIds, setProjAssignedBotIds] = useState<string[]>([]);
  const [projLeadBotId, setProjLeadBotId] = useState<string>("bot-omni");
  const [projUseWorktrees, setProjUseWorktrees] = useState(false);

  // Instructions state
  const [globalInstructionsDraft, setGlobalInstructionsDraft] = useState(
    preferences.globalInstructions
  );
  const [instructionsSaved, setInstructionsSaved] = useState(false);

  useEffect(() => {
    if (open && initialSection) {
      setSection(initialSection);
    }
  }, [open, initialSection]);

  useEffect(() => {
    setGlobalInstructionsDraft(preferences.globalInstructions);
  }, [preferences.globalInstructions]);

  const installedHarnesses = harnesses.filter((h) => h.installed);

  const openNewBotEditor = () => {
    setEditingBotId("");
    setBotName("");
    setBotRole("Specialized Coding Teammate");
    setBotDesc("");
    setBotShape("crystal");
    setBotColor("violet");
    const defaultDriver = installedHarnesses[0]?.kind ?? "claude";
    setBotDriver(defaultDriver);
    setBotModel(installedHarnesses[0]?.models[0] ?? "");
    setBotEffort("high");
    setBotPermission("auto");
    setBotPrompt("");
    setShowBotForm(true);
  };

  const openExistingBotEditor = (b: BotProfile) => {
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
    setBotPrompt(b.systemPrompt);
    setShowBotForm(true);
  };

  const handleDuplicateBot = async (b: BotProfile) => {
    const sameProviderCount = bots.filter(
      (x) => x.cliDriver === b.cliDriver
    ).length;
    await onUpsertBot({
      ...b,
      id: "",
      name: `${b.name} ${sameProviderCount + 1}`,
      slug: `${b.slug}-${sameProviderCount + 1}`,
      isPrimary: false,
      autoCreatedForCli: false,
    });
  };

  const handleSaveBot = async () => {
    if (!botName.trim()) return;
    const existing = bots.find((b) => b.id === editingBotId);
    await onUpsertBot({
      id: editingBotId,
      name: botName.trim(),
      slug:
        existing?.slug ||
        botName
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-"),
      roleTitle: botRole.trim() || "Coding Agent",
      description:
        botDesc.trim() || `Powered by ${botDriver} CLI inside Botfinity`,
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
      customCommand: existing?.customCommand ?? null,
      maxTurnBudgetUsd: existing?.maxTurnBudgetUsd ?? null,
    });
    setShowBotForm(false);
  };

  const handleAddMemory = async () => {
    const trimmed = newMemoryText.trim();
    if (!trimmed) return;
    setNewMemoryText("");
    await onUpdatePreferences({
      ...preferences,
      sharedMemories: [...preferences.sharedMemories, trimmed],
    });
  };

  const handleRemoveMemory = async (idx: number) => {
    await onUpdatePreferences({
      ...preferences,
      sharedMemories: preferences.sharedMemories.filter((_, i) => i !== idx),
    });
  };

  const openNewProjectForm = () => {
    setEditingProjectId("");
    setProjName("");
    setProjPath(preferences.workspaceRoot);
    setProjDesc("");
    setProjInstructions("");
    setProjAssignedBotIds([]);
    setProjLeadBotId("bot-omni");
    setProjUseWorktrees(false);
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
    setShowNewProject(true);
  };

  const handleSaveProject = async () => {
    if (!projName.trim() || !projPath.trim()) return;
    await onUpsertProject({
      id: editingProjectId,
      name: projName.trim(),
      path: projPath.trim(),
      description: projDesc.trim() || "Local git project",
      instructions: projInstructions.trim(),
      assignedBotIds: projAssignedBotIds,
      leadBotId: projLeadBotId || "bot-omni",
      useWorktreesDefault: projUseWorktrees,
    });
    setShowNewProject(false);
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
      case "instructions":
        return null;
    }
  };

  return (
    <div
      aria-hidden={!open}
      className={`fixed inset-0 z-50 flex items-center justify-center p-6 select-none transition-all duration-250 spring-transition ${
        open
          ? "bg-black/65 backdrop-blur-md opacity-100 pointer-events-auto"
          : "bg-black/0 backdrop-blur-none opacity-0 pointer-events-none"
      }`}
      onClick={onClose}
    >
      <div
        className={`w-full max-w-[920px] h-[80vh] max-h-[700px] rounded-[24px] bg-[#121212] border border-white/[0.08] shadow-[0_28px_90px_rgba(0,0,0,0.85)] flex overflow-hidden transition-all duration-250 spring-transition ${
          open
            ? "scale-100 opacity-100 translate-y-0"
            : "scale-[0.96] opacity-0 translate-y-2"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left Navigation Rail */}
        <div className="w-[244px] shrink-0 bg-[#0e0e0e] border-r border-white/[0.07] p-4 flex flex-col justify-between">
          <div className="space-y-4">
            <div className="px-2 pt-1 flex items-center gap-2.5">
              <img
                src="/botfinity-gauntlet.png"
                alt="Botfinity"
                className="w-8 h-8 object-contain shrink-0"
              />
              <div className="min-w-0">
                <div className="text-[15px] font-semibold text-white tracking-tight truncate">
                  Botfinity Hub
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
          <div className="px-7 pt-5 pb-4 border-b border-white/[0.07] flex items-center justify-between gap-4 shrink-0">
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
              onClick={onClose}
              className="w-8 h-8 rounded-full liquid-glass-chip flex items-center justify-center text-zinc-300 hover:text-white shrink-0 active:scale-95"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-7 space-y-5">
            {section === "bots" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">
                    {bots.length} persistent Bots configured on this Mac
                  </span>
                  <button
                    type="button"
                    onClick={openNewBotEditor}
                    className="px-3.5 py-1.5 rounded-full bg-white text-black text-xs font-semibold flex items-center gap-1.5 hover:bg-zinc-200 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Create New Bot</span>
                  </button>
                </div>

                {showBotForm && (
                  <div className="rounded-2xl liquid-glass-card p-5 space-y-4 border-cyan-400/30">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <BotCharacterAvatar
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
                              setBotModel(h.models[0] ?? "");
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

                    {/* Model, Effort & Permission Row */}
                    <div className="grid grid-cols-3 gap-3">
                      <div className="space-y-1">
                        <label className="block text-xs text-zinc-400">
                          Default Model
                        </label>
                        <input
                          type="text"
                          value={botModel}
                          onChange={(e) => setBotModel(e.target.value)}
                          placeholder="Default CLI model"
                          className="w-full rounded-xl bg-black/40 border border-white/10 px-2.5 py-1.5 text-xs font-mono text-white focus:outline-none"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="block text-xs text-zinc-400">
                          Reasoning Effort
                        </label>
                        <div className="grid grid-cols-3 gap-1">
                          {(["low", "medium", "high"] as const).map((lvl) => (
                            <button
                              key={lvl}
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
                              { id: "auto", label: "Auto Edit" },
                              { id: "plan", label: "Plan Only" },
                            ] as const
                          ).map((pm) => (
                            <button
                              key={pm.id}
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

                    {/* Color + Shape Pickers */}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="block text-xs text-zinc-400">
                          Character Color
                        </label>
                        <div className="flex flex-wrap gap-2">
                          {BOT_COLORS.map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => setBotColor(c.id)}
                              style={{ backgroundColor: c.swatch }}
                              className={`w-6 h-6 rounded-full ${
                                botColor === c.id ? "ring-2 ring-white scale-110" : "opacity-75"
                              }`}
                            />
                          ))}
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <label className="block text-xs text-zinc-400">
                          Character Mascot / Shape
                        </label>
                        <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                          {BOT_SHAPES.slice(0, 18).map((s) => (
                            <button
                              key={s.id}
                              type="button"
                              onClick={() => setBotShape(s.id)}
                              className={`px-2 py-1 rounded-lg text-[11px] ${
                                botShape === s.id
                                  ? "bg-white text-black font-semibold"
                                  : "bg-[#1f1f1f] text-zinc-300"
                              }`}
                            >
                              {s.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

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
                        className="px-4 py-2 rounded-full bg-white text-black text-xs font-semibold hover:bg-zinc-200"
                      >
                        Save Bot
                      </button>
                    </div>
                  </div>
                )}

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
                              <span className="text-[11px] font-mono px-1.5 py-0.2 rounded bg-white/[0.06] text-zinc-300">
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
                            onClick={() => onDeleteBot(b.id)}
                            className="text-zinc-500 hover:text-red-400 p-1"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>

                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => {
                            onSelectBotDirectChat(b);
                            onClose();
                          }}
                          className="flex-1 py-1.5 rounded-xl bg-white text-black text-xs font-semibold hover:bg-zinc-200"
                        >
                          Message @{b.name}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDuplicateBot(b)}
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

                {showNewProject && (
                  <div className="rounded-2xl liquid-glass-card p-5 space-y-4 border-cyan-400/30">
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
                        value={projName}
                        onChange={(e) => setProjName(e.target.value)}
                        placeholder="Project name (e.g. omni-bot)"
                        className="w-full rounded-xl bg-black/40 border border-white/10 px-3 py-2 text-[13px] text-white focus:outline-none"
                      />
                      <input
                        type="text"
                        value={projPath}
                        onChange={(e) => setProjPath(e.target.value)}
                        placeholder="/Users/rcourson/Tests/omni-bot"
                        className="w-full rounded-xl bg-black/40 border border-white/10 px-3 py-2 text-[13px] text-white font-mono focus:outline-none"
                      />
                    </div>

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
                            Isolate Swarm in Worktrees
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

                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={handleSaveProject}
                        className="px-4 py-1.5 rounded-full bg-white text-black text-xs font-semibold"
                      >
                        Save Project Configuration
                      </button>
                    </div>
                  </div>
                )}

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
                                  onClick={() => onDeleteProject(proj.id)}
                                  className="text-zinc-500 hover:text-red-400 p-1"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                          <div className="text-xs font-mono text-zinc-400 truncate">
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
                            onClick={() =>
                              onUpdatePreferences({
                                ...preferences,
                                workspaceRoot: proj.path,
                              })
                            }
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

            {section === "memories" && (
              <div className="space-y-4">
                <div className="flex items-center gap-2.5">
                  <input
                    type="text"
                    value={newMemoryText}
                    onChange={(e) => setNewMemoryText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddMemory();
                    }}
                    placeholder="Teach your Swarm a persistent fact (e.g. 'Always push personal repos to robzilla1738')..."
                    className="min-w-0 flex-1 rounded-xl bg-black/40 border border-white/12 px-3.5 py-2.5 text-[13.5px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleAddMemory}
                    className="px-4 py-2.5 rounded-xl bg-white text-black text-[13px] font-semibold hover:bg-zinc-200 shrink-0"
                  >
                    Add Memory
                  </button>
                </div>

                <div className="space-y-2">
                  {preferences.sharedMemories.map((entry, idx) => (
                    <div
                      key={idx}
                      className="group rounded-2xl liquid-glass-card px-4 py-3 flex items-start justify-between gap-3"
                    >
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <span className="text-xs font-mono text-zinc-500 pt-0.5 shrink-0">
                          #{idx + 1}
                        </span>
                        <p className="text-[13.5px] text-zinc-100 leading-relaxed break-words">
                          {entry}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveMemory(idx)}
                        className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-zinc-400 hover:text-red-400"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {section === "skills" && (
              <div className="space-y-4">
                <div className="h-10 rounded-full liquid-glass-chip px-4 flex items-center gap-2.5">
                  <Search className="w-4 h-4 text-zinc-400 shrink-0" />
                  <input
                    type="text"
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
                {routines.map((r) => (
                  <div
                    key={r.id}
                    className="rounded-2xl liquid-glass-card px-4 py-3.5 flex items-center justify-between gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-semibold text-zinc-100 truncate">
                        {r.name}
                      </div>
                      <div className="text-xs text-zinc-400 truncate mt-0.5">
                        {r.prompt}
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          onRunRoutineNow(r);
                          onClose();
                        }}
                        className="p-1.5 rounded-lg liquid-glass-chip text-zinc-300 hover:text-white"
                      >
                        <Play className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={r.enabled}
                        onClick={() =>
                          onUpsertRoutine({ ...r, enabled: !r.enabled })
                        }
                        className={`relative inline-flex h-6 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                          r.enabled ? "bg-[#3b82f6]" : "bg-white/[0.14]"
                        }`}
                      >
                        <span
                          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition ${
                            r.enabled ? "translate-x-4" : "translate-x-0"
                          }`}
                        />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteRoutine(r.id)}
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
                        Global Swarm Instructions
                      </div>
                      <p className="text-xs text-zinc-400">
                        Injected into the system context of every Bot turn
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await onUpdatePreferences({
                          ...preferences,
                          globalInstructions: globalInstructionsDraft.trim(),
                        });
                        setInstructionsSaved(true);
                        setTimeout(() => setInstructionsSaved(false), 1800);
                      }}
                      className="px-4 py-1.5 rounded-full bg-white text-black text-xs font-semibold hover:bg-zinc-200"
                    >
                      {instructionsSaved ? "Saved" : "Save Instructions"}
                    </button>
                  </div>
                  <textarea
                    rows={4}
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
                      Allow non-interactive CLI turns to read/edit project files and run shell checks without blocking
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={preferences.approveAllTools}
                    onClick={() =>
                      onUpdatePreferences({
                        ...preferences,
                        approveAllTools: !preferences.approveAllTools,
                      })
                    }
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

                {/* Token & Swarm Loop Guardrails */}
                <div className="rounded-2xl liquid-glass-card divide-y divide-white/[0.06] overflow-hidden">
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
                      aria-checked={preferences.preventHandoffLoops ?? true}
                      onClick={() =>
                        onUpdatePreferences({
                          ...preferences,
                          preventHandoffLoops: !(
                            preferences.preventHandoffLoops ?? true
                          ),
                        })
                      }
                      className={`relative inline-flex h-6 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                        (preferences.preventHandoffLoops ?? true)
                          ? "bg-[#3b82f6]"
                          : "bg-white/[0.14]"
                      }`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition ${
                          (preferences.preventHandoffLoops ?? true)
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
                      aria-checked={preferences.onlyExplicitHandoffs ?? false}
                      onClick={() =>
                        onUpdatePreferences({
                          ...preferences,
                          onlyExplicitHandoffs: !(
                            preferences.onlyExplicitHandoffs ?? false
                          ),
                        })
                      }
                      className={`relative inline-flex h-6 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                        (preferences.onlyExplicitHandoffs ?? false)
                          ? "bg-[#3b82f6]"
                          : "bg-white/[0.14]"
                      }`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition ${
                          (preferences.onlyExplicitHandoffs ?? false)
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
                          onClick={() =>
                            onUpdatePreferences({
                              ...preferences,
                              maxContextMessages: n,
                            })
                          }
                          className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${
                            (preferences.maxContextMessages ?? 6) === n
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
                        Max Turn Budget Cap (USD)
                      </div>
                      <p className="text-xs text-zinc-400">
                        Automatically stops a CLI turn if reported cost exceeds this threshold
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      {[0.5, 1.5, 3.0, 5.0].map((usd) => (
                        <button
                          key={usd}
                          type="button"
                          onClick={() =>
                            onUpdatePreferences({
                              ...preferences,
                              maxTurnBudgetUsd: usd,
                            })
                          }
                          className={`px-2.5 py-1 rounded-lg text-xs font-mono font-semibold ${
                            (preferences.maxTurnBudgetUsd ?? 1.5) === usd
                              ? "bg-white text-black"
                              : "bg-[#1f1f1f] text-zinc-400 hover:text-white"
                          }`}
                        >
                          ${usd.toFixed(2)}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="px-4 py-3 flex items-center justify-between gap-4">
                    <div>
                      <div className="text-[13.5px] font-semibold text-white">
                        Max Concurrent Parallel Bots (@all)
                      </div>
                      <p className="text-xs text-zinc-400">
                        Limits simultaneous CLI subprocesses in parallel swarm waves
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      {[2, 3, 4, 6].map((cnt) => (
                        <button
                          key={cnt}
                          type="button"
                          onClick={() =>
                            onUpdatePreferences({
                              ...preferences,
                              maxParallelBots: cnt,
                            })
                          }
                          className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${
                            (preferences.maxParallelBots ?? 3) === cnt
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
      </div>
    </div>
  );
}
