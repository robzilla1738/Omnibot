export type CliDriverKind =
  | "claude"
  | "codex"
  | "opencode"
  | "cursor"
  | "grok"
  | "pi"
  | "antigravity"
  | "muse"
  | "acp"
  | "gemini"
  | "aider"
  | "ollama"
  | "custom";

export type BotShape =
  | "omni-prism"
  | "claude-spark"
  | "codex-bloom"
  | "grok-orbit"
  | "cursor-cube"
  | "opencode-terminal"
  | "pi-crest"
  | "gemini-star"
  | "ollama-llama"
  | "aider-git"
  | "blob"
  | "pebble"
  | "bean"
  | "egg"
  | "squircle"
  | "tablet"
  | "capsule"
  | "cylinder"
  | "hex"
  | "gem"
  | "crystal"
  | "wedge"
  | "shield"
  | "dome"
  | "arch"
  | "cloud"
  | "teardrop"
  | "leaf"
  | "square"
  | "sparkle"
  | "clover"
  | "flower"
  | "heart"
  | "house"
  | "star";

export type BotColor =
  | "cyan"
  | "orange"
  | "green"
  | "blue"
  | "violet"
  | "magenta"
  | "yellow"
  | "red"
  | "brown"
  | "gray"
  | "black";

export interface BotProfile {
  id: string;
  name: string;
  slug: string;
  roleTitle: string;
  description: string;
  shape: BotShape | string;
  color: BotColor | string;
  isPrimary: boolean;
  cliDriver: CliDriverKind;
  model?: string | null;
  reasoningEffort: "low" | "medium" | "high" | string;
  permissionMode: "auto" | "acceptEdits" | "plan" | "bypassPermissions" | string;
  systemPrompt: string;
  memories: string[];
  autoCreatedForCli: boolean;
  customCommand?: string | null;
  maxTurnBudgetUsd?: number | null;
}

export interface ToolInvocation {
  id: string;
  name: string;
  inputSummary: string;
  command?: string | null;
  outputSummary?: string | null;
  status: "running" | "completed" | "error" | string;
}

export interface HandoffEvent {
  fromBotId: string;
  fromBotName: string;
  toBotIds: string[];
  toBotNames: string[];
  mode: "sequential" | "parallel" | string;
  note: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  authorBotId?: string | null;
  authorName?: string | null;
  authorShape?: string | null;
  authorColor?: string | null;
  cliDriver?: CliDriverKind | null;
  model?: string | null;
  text: string;
  thinking: string;
  toolCalls: ToolInvocation[];
  handoffs: HandoffEvent[];
  skillSlug?: string | null;
  mentionedBotIds: string[];
  worktreePath?: string | null;
  durationMs?: number | null;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  status: "streaming" | "complete" | "error" | "stopped" | string;
  createdAtMs: number;
}

export interface ChatThread {
  id: string;
  title: string;
  subtitle: string;
  isPrimary: boolean;
  isGroup: boolean;
  participantBotIds: string[];
  workspaceId?: string | null;
  workspacePath?: string | null;
  useWorktrees: boolean;
  maxSwarmTurns: number;
  messages: ChatMessage[];
  nativeSessions: Record<string, string>;
  lastSyncedMsgIndex?: Record<string, number>;
  updatedAtMs: number;
}

export interface WorkspaceEntry {
  id: string;
  name: string;
  path: string;
  description: string;
  instructions: string;
  assignedBotIds?: string[];
  leadBotId?: string | null;
  useWorktreesDefault?: boolean;
}

export interface RoutineEntry {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  botId: string;
  enabled: boolean;
  lastRunMs?: number | null;
}

export interface CliHarnessInfo {
  id: string;
  kind: CliDriverKind;
  name: string;
  binaryName: string;
  binaryPath?: string | null;
  version?: string | null;
  installed: boolean;
  description: string;
  installHint: string;
  authHint: string;
  models: string[];
  supportsJsonStream: boolean;
  supportsSessionResume: boolean;
}

export interface CliHarnessTestResult {
  kind: CliDriverKind;
  ok: boolean;
  binaryPath?: string | null;
  version?: string | null;
  latencyMs: number;
  message: string;
}

export interface LocalSkillItem {
  id: string;
  name: string;
  slug: string;
  description: string;
  path: string;
  source: string;
}

export interface LocalMcpServer {
  id: string;
  name: string;
  commandOrUrl: string;
  source: string;
  transport: string;
}

export interface GitChangedFile {
  path: string;
  status: string;
  staged: boolean;
}

export interface GitWorktreeEntry {
  path: string;
  branch: string;
  head: string;
}

export interface GitRepoStatus {
  isRepo: boolean;
  rootPath: string;
  branch: string;
  headShort: string;
  ahead: number;
  behind: number;
  changedFiles: GitChangedFile[];
  diffStat: string;
  diffPreview: string;
  worktrees: GitWorktreeEntry[];
}

export interface ComputerActivityEntry {
  id: string;
  toolName: string;
  summary: string;
  status: string;
  durationMs: number;
  timestampMs: number;
}

export interface ActiveBotRun {
  chatId: string;
  messageId: string;
  botId: string;
  botName: string;
  cliDriver: CliDriverKind;
  activity: string;
  startedAtMs: number;
}

export interface OmniPreferences {
  workspaceRoot: string;
  defaultMaxSwarmTurns: number;
  approveAllTools: boolean;
  globalInstructions: string;
  sharedMemories: string[];
  maxContextMessages?: number;
  maxMessageChars?: number;
  maxTurnBudgetUsd?: number;
  maxParallelBots?: number;
  turnTimeoutSecs?: number;
  preventHandoffLoops?: boolean;
  onlyExplicitHandoffs?: boolean;
}

export interface OmniSnapshot {
  serverPort: number;
  serverBaseUrl: string;
  preferences: OmniPreferences;
  harnesses: CliHarnessInfo[];
  bots: BotProfile[];
  chats: ChatThread[];
  workspaces: WorkspaceEntry[];
  routines: RoutineEntry[];
  skills: LocalSkillItem[];
  mcpServers: LocalMcpServer[];
  gitStatus: GitRepoStatus;
  computerActivity: ComputerActivityEntry[];
  activeRuns: ActiveBotRun[];
}

export interface LocalFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  sizeBytes: number;
  modifiedMs?: number | null;
}

export interface SystemOverview {
  os: string;
  arch: string;
  hostname: string;
  workspaceRoot: string;
  workspaceExists: boolean;
  homeDir: string;
  desktopDir: string;
  documentsDir: string;
  downloadsDir: string;
  frontmostApp?: string | null;
}

export type OmniStreamEvent =
  | {
      type: "turn-started";
      chatId: string;
      messageId: string;
      botId: string;
      botName: string;
      cliDriver: CliDriverKind;
      model?: string | null;
    }
  | {
      type: "thinking-delta";
      chatId: string;
      messageId: string;
      botId: string;
      delta: string;
    }
  | {
      type: "text-delta";
      chatId: string;
      messageId: string;
      botId: string;
      delta: string;
    }
  | {
      type: "tool-call";
      chatId: string;
      messageId: string;
      botId: string;
      tool: ToolInvocation;
    }
  | {
      type: "handoff";
      chatId: string;
      messageId: string;
      handoff: HandoffEvent;
    }
  | {
      type: "turn-finished";
      chatId: string;
      messageId: string;
      botId: string;
      status: string;
      durationMs: number;
    }
  | {
      type: "state-updated";
      chatId?: string | null;
    };
