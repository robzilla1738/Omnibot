import {
  Activity,
  ArrowUpRight,
  Check,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { testCliHarness } from "../../lib/omni-bridge";
import type {
  BotColor,
  BotProfile,
  BotShape,
  CliDriverKind,
  CliHarnessInfo,
  CliHarnessTestResult,
  LocalMcpServer,
  LocalSkillItem,
} from "../../lib/types";
import {
  BotCharacterAvatar,
  CliBrandBadge,
  SkillBrandIcon,
} from "../icons/BotCharacterAvatar";

export interface CliHarnessesModalProps {
  open: boolean;
  onClose: () => void;
  harnesses: CliHarnessInfo[];
  bots: BotProfile[];
  skills: LocalSkillItem[];
  mcpServers: LocalMcpServer[];
  onRescan: () => Promise<void>;
  onSelectBotDirectChat: (bot: BotProfile) => void;
  onCreateBotFromTemplate: (template: {
    name: string;
    roleTitle: string;
    description: string;
    shape: BotShape;
    color: BotColor;
    cliDriver: CliDriverKind;
    systemPrompt: string;
  }) => Promise<void>;
  onStartChatWithSkill: (skill: LocalSkillItem) => void;
}

type CategoryFilter =
  | "All"
  | "Installed CLIs"
  | "Bot Templates"
  | "Local MCPs"
  | "Agent Skills";

const CATEGORIES: CategoryFilter[] = [
  "All",
  "Installed CLIs",
  "Bot Templates",
  "Local MCPs",
  "Agent Skills",
];

const BOT_TEMPLATES: Array<{
  id: string;
  name: string;
  roleTitle: string;
  description: string;
  shape: BotShape;
  color: BotColor;
  preferredDriver: CliDriverKind;
  systemPrompt: string;
}> = [
  {
    id: "tpl-architect",
    name: "Architect",
    roleTitle: "Principal Systems Architect",
    description: "Designs modular systems, APIs, data models, and coordinates @Codex/@Claude implementation",
    shape: "crystal",
    color: "violet",
    preferredDriver: "claude",
    systemPrompt:
      "You are @Architect, a Principal Systems Architect. Focus on clean boundaries, minimal surface area, data structures, and trade-offs. Hand off implementation steps to @Codex or @Claude when ready.",
  },
  {
    id: "tpl-reviewer",
    name: "Reviewer",
    roleTitle: "Adversarial Code & Bug Reviewer",
    description: "Hunts race conditions, edge cases, regressions, and tech debt in diffs",
    shape: "shield",
    color: "red",
    preferredDriver: "codex",
    systemPrompt:
      "You are @Reviewer, an adversarial staff code reviewer. Inspect git diffs and code changes for bugs, security flaws, race conditions, and unnecessary complexity.",
  },
  {
    id: "tpl-ui-polish",
    name: "Designer",
    roleTitle: "Design Engineer & UI Specialist",
    description: "Crafts liquid-glass dark interfaces, animations, and responsive React components",
    shape: "sparkle",
    color: "magenta",
    preferredDriver: "claude",
    systemPrompt:
      "You are @Designer, a Staff Design Engineer. Focus on crisp typography, layout hierarchy, micro-interactions, and clean Tailwind CSS.",
  },
  {
    id: "tpl-scout",
    name: "Scout",
    roleTitle: "Fast Codebase Explorer & Researcher",
    description: "Rapidly maps unfamiliar repositories, traces call graphs, and summarizes context for other Bots",
    shape: "cloud",
    color: "yellow",
    preferredDriver: "grok",
    systemPrompt:
      "You are @Scout, a fast codebase recon specialist. Quickly locate relevant files, trace data flow, and hand off a concise map to the implementing Bot.",
  },
];

export function CliHarnessesModal({
  open,
  onClose,
  harnesses,
  bots,
  skills,
  mcpServers,
  onRescan,
  onSelectBotDirectChat,
  onCreateBotFromTemplate,
  onStartChatWithSkill,
}: CliHarnessesModalProps) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("All");
  const [rescanning, setRescanning] = useState(false);
  const [testResults, setTestResults] = useState<
    Record<string, CliHarnessTestResult>
  >({});

  const installedList = useMemo(
    () => harnesses.filter((h) => h.installed),
    [harnesses]
  );

  const filteredHarnesses = useMemo(() => {
    if (category !== "All" && category !== "Installed CLIs") {
      return [];
    }
    const q = search.trim().toLowerCase();
    return harnesses.filter((h) => {
      if (category === "Installed CLIs" && !h.installed) return false;
      if (!q) return true;
      return (
        h.name.toLowerCase().includes(q) ||
        h.binaryName.toLowerCase().includes(q) ||
        h.description.toLowerCase().includes(q)
      );
    });
  }, [harnesses, search, category]);

  const filteredTemplates = useMemo(() => {
    if (category !== "All" && category !== "Bot Templates") return [];
    const q = search.trim().toLowerCase();
    return BOT_TEMPLATES.filter(
      (t) =>
        !q ||
        t.name.toLowerCase().includes(q) ||
        t.roleTitle.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q)
    );
  }, [search, category]);

  const filteredMcps = useMemo(() => {
    if (category !== "All" && category !== "Local MCPs") return [];
    const q = search.trim().toLowerCase();
    return mcpServers.filter(
      (m) =>
        !q ||
        m.name.toLowerCase().includes(q) ||
        m.commandOrUrl.toLowerCase().includes(q)
    );
  }, [mcpServers, search, category]);

  const filteredSkills = useMemo(() => {
    if (category !== "All" && category !== "Agent Skills") return [];
    const q = search.trim().toLowerCase();
    return skills.filter(
      (s) =>
        !q ||
        s.name.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
    );
  }, [skills, search, category]);

  const handleRescan = async () => {
    setRescanning(true);
    try {
      await onRescan();
    } finally {
      setRescanning(false);
    }
  };

  const handleTestHarness = async (kind: CliDriverKind) => {
    const res = await testCliHarness(kind);
    setTestResults((prev) => ({ ...prev, [kind]: res }));
  };

  return (
    <div
      aria-hidden={!open}
      className={`fixed inset-0 z-50 flex items-center justify-center p-6 select-none transition-all duration-250 spring-transition ${
        open
          ? "bg-black/65 backdrop-blur-sm opacity-100 pointer-events-auto"
          : "bg-black/0 backdrop-blur-none opacity-0 pointer-events-none"
      }`}
      onClick={onClose}
    >
      <div
        className={`w-full max-w-[860px] h-[78vh] max-h-[680px] rounded-[24px] bg-[#121212] border border-white/[0.08] shadow-[0_28px_90px_rgba(0,0,0,0.85)] flex flex-col overflow-hidden transition-all duration-250 spring-transition ${
          open
            ? "scale-100 opacity-100 translate-y-0"
            : "scale-[0.96] opacity-0 translate-y-2"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header Row */}
        <div className="shrink-0 px-7 pt-5 pb-3.5 flex items-center justify-between">
          <div>
            <h2 className="text-[20px] font-semibold text-white tracking-tight">
              Local Coding Harnesses &amp; Swarm Tools
            </h2>
            <p className="text-xs text-[#8e8d8a] mt-0.5">
              Auto-detected CLI agents, role templates, MCP servers, and local skills
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleRescan}
              className="h-8 px-3 rounded-full bg-[#1f1f1f] hover:bg-[#272727] border border-white/[0.06] flex items-center gap-2 text-xs text-zinc-200 hover:text-white transition-colors"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${rescanning ? "animate-spin text-cyan-400" : ""}`}
              />
              <span>{installedList.length} CLIs detected</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="w-8 h-8 rounded-full bg-[#1f1f1f] hover:bg-[#272727] border border-white/[0.06] flex items-center justify-center text-zinc-300 hover:text-white active:scale-95 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Search Input + Bot Templates Pill */}
        <div className="shrink-0 px-7 pb-3.5 flex items-center gap-2.5">
          <div className="flex-1 h-10 rounded-full bg-[#1f1f1f] border border-white/[0.06] px-4 flex items-center gap-2.5 focus-within:border-white/15 transition-colors">
            <Search className="w-4 h-4 text-zinc-400 shrink-0" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search local CLIs, role templates, MCP servers, and skills..."
              className="w-full bg-transparent text-[13.5px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
            />
          </div>

          <button
            type="button"
            onClick={() => setCategory("Bot Templates")}
            className="h-10 px-4 rounded-full bg-[#1f1f1f] hover:bg-[#272727] border border-white/[0.07] flex items-center gap-2 text-[13px] font-medium text-zinc-100 shrink-0 active:scale-95 transition-colors"
          >
            <BotCharacterAvatar shape="crystal" color="violet" size={20} />
            <span>Bot templates</span>
            <ArrowUpRight className="w-3.5 h-3.5 text-zinc-400" />
          </button>
        </div>

        {/* Filter Pills Row */}
        <div className="shrink-0 px-7 pt-0.5 pb-4 flex flex-wrap items-center gap-2">
          {CATEGORIES.map((cat) => {
            const active = category === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                className={`h-8 px-3.5 rounded-full text-[13px] font-medium inline-flex items-center justify-center transition-colors shrink-0 ${
                  active
                    ? "bg-white text-black font-semibold"
                    : "bg-[#1f1f1f] hover:bg-[#272727] text-zinc-300 hover:text-white border border-white/[0.05]"
                }`}
              >
                {cat}
              </button>
            );
          })}
        </div>

        {/* Scrollable 2-Column Catalog Body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-7 pb-7 space-y-6">
          {/* 1. Local Coding CLIs */}
          {filteredHarnesses.length > 0 && (
            <section className="space-y-3.5">
              <div className="flex items-center justify-between">
                <h3 className="text-[13.5px] font-semibold text-zinc-200">
                  Local Coding Agent CLIs
                </h3>
                <span className="text-xs text-zinc-500">
                  Auto-detected on your Mac
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-8 gap-y-4">
                {filteredHarnesses.map((h) => {
                  const matchingBot = bots.find(
                    (b) => !b.isPrimary && b.cliDriver === h.kind
                  );
                  const testRes = testResults[h.kind];
                  return (
                    <div
                      key={h.id}
                      className="flex items-center justify-between gap-3.5 py-1"
                    >
                      <div className="flex items-center gap-3.5 min-w-0 flex-1">
                        {matchingBot ? (
                          <BotCharacterAvatar
                            bot={matchingBot}
                            size={44}
                            showCliBadge
                          />
                        ) : (
                          <CliBrandBadge driver={h.kind} size={44} />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[14px] font-semibold text-zinc-100 truncate">
                              {h.name}
                            </span>
                            {h.version && (
                              <span className="text-[11px] font-mono text-zinc-400 truncate max-w-[110px]">
                                {h.version.split(" ")[0]}
                              </span>
                            )}
                          </div>
                          <div
                            title={testRes?.message || h.binaryPath || h.installHint}
                            className="text-[12px] font-mono text-zinc-400 truncate mt-0.5"
                          >
                            {testRes ? (
                              <span className="text-emerald-300">
                                ✓ {testRes.latencyMs}ms · {h.binaryPath}
                              </span>
                            ) : h.installed ? (
                              h.binaryPath
                            ) : (
                              `Not found · ${h.installHint}`
                            )}
                          </div>
                        </div>
                      </div>

                      {h.installed && matchingBot ? (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleTestHarness(h.kind)}
                            title="Run live CLI health check"
                            className="p-2 rounded-full bg-[#1f1f1f] hover:bg-[#272727] border border-white/[0.06] text-zinc-300 hover:text-white active:scale-95 transition-colors"
                          >
                            <Activity className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              onSelectBotDirectChat(matchingBot);
                              onClose();
                            }}
                            className="px-3.5 py-1.5 rounded-full bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/30 text-xs font-medium text-emerald-300 active:scale-95 transition-colors flex items-center gap-1.5"
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>Chat</span>
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-zinc-500 shrink-0">
                          Not installed
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* 2. Role Bot Templates */}
          {filteredTemplates.length > 0 && (
            <section className="space-y-3.5">
              <div className="flex items-center justify-between">
                <h3 className="text-[13.5px] font-semibold text-zinc-200">
                  Specialized Swarm Bot Templates
                </h3>
                <span className="text-xs text-zinc-500">
                  Add role teammates to your roster
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-8 gap-y-4">
                {filteredTemplates.map((tpl) => {
                  const alreadyInRoster = bots.some(
                    (b) => b.name.toLowerCase() === tpl.name.toLowerCase()
                  );
                  return (
                    <div
                      key={tpl.id}
                      className="flex items-center justify-between gap-3.5 py-1"
                    >
                      <div className="flex items-center gap-3.5 min-w-0 flex-1">
                        <BotCharacterAvatar
                          shape={tpl.shape}
                          color={tpl.color}
                          cliDriver={tpl.preferredDriver}
                          size={44}
                          showCliBadge
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[14px] font-semibold text-zinc-100 truncate">
                              {tpl.name}
                            </span>
                            <span className="text-[11px] font-mono text-zinc-400">
                              {tpl.preferredDriver}
                            </span>
                          </div>
                          <div
                            title={tpl.description}
                            className="text-[12.5px] text-zinc-400 truncate mt-0.5"
                          >
                            {tpl.description}
                          </div>
                        </div>
                      </div>

                      {alreadyInRoster ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400 shrink-0">
                          <Check className="w-3.5 h-3.5" />
                          <span>Added</span>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            onCreateBotFromTemplate({
                              name: tpl.name,
                              roleTitle: tpl.roleTitle,
                              description: tpl.description,
                              shape: tpl.shape,
                              color: tpl.color,
                              cliDriver: tpl.preferredDriver,
                              systemPrompt: tpl.systemPrompt,
                            })
                          }
                          className="px-3.5 py-1.5 rounded-full bg-[#1f1f1f] hover:bg-[#272727] border border-white/[0.06] text-xs font-medium text-zinc-100 shrink-0 active:scale-95 transition-colors"
                        >
                          Spawn Bot
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* 3. Discovered Local MCP Servers */}
          {filteredMcps.length > 0 && (
            <section className="space-y-3.5">
              <div className="flex items-center justify-between">
                <h3 className="text-[13.5px] font-semibold text-zinc-200">
                  Discovered Local MCP Servers ({filteredMcps.length})
                </h3>
              </div>
              <div className="grid grid-cols-2 gap-x-8 gap-y-4">
                {filteredMcps.map((mcp) => (
                  <div
                    key={mcp.id}
                    className="flex items-center justify-between gap-3.5 py-1"
                  >
                    <div className="flex items-center gap-3.5 min-w-0 flex-1">
                      <CliBrandBadge driver="acp" size={40} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-semibold text-zinc-100 truncate">
                          {mcp.name}
                        </div>
                        <div className="text-[12px] text-zinc-400 font-mono truncate mt-0.5">
                          {mcp.source} · {mcp.commandOrUrl}
                        </div>
                      </div>
                    </div>
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400 shrink-0">
                      <Check className="w-3.5 h-3.5" />
                      <span>Active</span>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 4. Local Agent Skills */}
          {filteredSkills.length > 0 && (
            <section className="space-y-3.5">
              <div className="flex items-center justify-between">
                <h3 className="text-[13.5px] font-semibold text-zinc-200">
                  Local Agent Skills ({filteredSkills.length})
                </h3>
              </div>
              <div className="grid grid-cols-2 gap-x-8 gap-y-4">
                {filteredSkills.slice(0, 24).map((skill) => (
                  <div
                    key={skill.id}
                    className="flex items-center justify-between gap-3.5 py-1"
                  >
                    <div className="flex items-center gap-3.5 min-w-0 flex-1">
                      <SkillBrandIcon name={skill.name} size={40} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-semibold text-zinc-100 truncate">
                          {skill.name}
                        </div>
                        <div
                          title={skill.description}
                          className="text-[12px] text-zinc-400 truncate mt-0.5"
                        >
                          /{skill.slug} · {skill.description}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        onStartChatWithSkill(skill);
                        onClose();
                      }}
                      className="px-3.5 py-1.5 rounded-full bg-[#1f1f1f] hover:bg-[#272727] border border-white/[0.06] text-xs font-medium text-zinc-100 shrink-0 active:scale-95 transition-colors"
                    >
                      Use
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
