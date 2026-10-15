import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  BotProfile,
  GitRepoStatus,
  ChatThread,
  CliDriverKind,
  CliHarnessTestResult,
  LocalFileEntry,
  OmniPreferences,
  OmniSnapshot,
  OmniStreamEvent,
  RoutineEntry,
  SystemOverview,
  WorkspaceEntry,
} from "./types";

let cachedServerBaseUrl = "http://127.0.0.1:4321";

export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

async function httpJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${cachedServerBaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "Request failed");
    throw new Error(txt || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function getOmniSnapshot(): Promise<OmniSnapshot> {
  if (isTauriRuntime()) {
    const snap = await invoke<OmniSnapshot>("omni_snapshot");
    if (snap.serverBaseUrl) cachedServerBaseUrl = snap.serverBaseUrl;
    return snap;
  }
  for (const port of Array.from({ length: 15 }, (_, index) => 4321 + index)) {
    try {
      const candidate = `http://127.0.0.1:${port}`;
      const res = await fetch(`${candidate}/api/snapshot`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const snap = (await res.json()) as OmniSnapshot;
        cachedServerBaseUrl = snap.serverBaseUrl || candidate;
        return snap;
      }
    } catch {
      // Try next candidate port
    }
  }
  const snap = await httpJson<OmniSnapshot>("/api/snapshot");
  if (snap.serverBaseUrl) cachedServerBaseUrl = snap.serverBaseUrl;
  return snap;
}

export async function retryOmniStorage(): Promise<OmniSnapshot> {
  return httpJson("/api/storage/retry", { method: "POST" });
}

export async function rescanOmniEnvironment(): Promise<OmniSnapshot> {
  if (isTauriRuntime()) {
    return invoke<OmniSnapshot>("omni_rescan");
  }
  return httpJson<OmniSnapshot>("/api/rescan", { method: "POST" });
}

export interface SendMessageParams {
  chatId: string;
  text: string;
  skillSlug?: string;
  overrideBotId?: string;
  overrideModel?: string;
  overrideEffort?: string;
  parallelMode?: boolean;
  summarize?: boolean;
}

export async function previewOmniMessage(params: SendMessageParams): Promise<{ botIds: string[]; parallel: boolean; prompt: string }> {
  return httpJson("/api/chat/preview", { method: "POST", body: JSON.stringify(params) });
}

export async function sendOmniMessage(params: SendMessageParams): Promise<string> {
  if (isTauriRuntime()) {
    return invoke<string>("omni_send_message", { input: params });
  }
  const res = await httpJson<{ ok: boolean; messageId: string }>("/api/chat/send", {
    method: "POST",
    body: JSON.stringify(params),
  });
  return res.messageId;
}

export async function stopOmniChat(chatId: string): Promise<OmniSnapshot> {
  if (isTauriRuntime()) {
    return invoke<OmniSnapshot>("omni_stop_chat", { chatId });
  }
  return httpJson<OmniSnapshot>("/api/chat/stop", {
    method: "POST",
    body: JSON.stringify({ chatId }),
  });
}

export interface CreateChatParams {
  modelOverrides?: Record<string, string | null>;
  botHome?: boolean;
  title?: string;
  subtitle?: string;
  participantBotIds: string[];
  workspaceId?: string;
  workspacePath?: string;
  useWorktrees?: boolean;
}

export async function createOmniChat(
  params: CreateChatParams
): Promise<{ chat: ChatThread; snapshot: OmniSnapshot }> {
  if (isTauriRuntime()) {
    const [chat, snapshot] = await invoke<[ChatThread, OmniSnapshot]>(
      "omni_create_chat",
      { input: params }
    );
    return { chat, snapshot };
  }
  return httpJson<{ chat: ChatThread; snapshot: OmniSnapshot }>("/api/chat/create", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export interface UpdateChatParams {
  chatId: string;
  title?: string;
  participantBotIds?: string[];
  workspacePath?: string;
  useWorktrees?: boolean;
  maxSwarmTurns?: number;
}

export async function updateOmniChat(
  params: UpdateChatParams
): Promise<OmniSnapshot> {
  if (isTauriRuntime()) {
    return invoke<OmniSnapshot>("omni_update_chat", { input: params });
  }
  return httpJson<OmniSnapshot>("/api/chat/update", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function resetOmniSessions(id: string): Promise<OmniSnapshot> {
  return httpJson("/api/chat/reset-sessions", { method: "POST", body: JSON.stringify({ id }) });
}

export async function clearOmniChat(id: string): Promise<OmniSnapshot> {
  if (isTauriRuntime()) {
    return invoke<OmniSnapshot>("omni_clear_chat", { id });
  }
  return httpJson<OmniSnapshot>("/api/chat/clear", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export async function deleteOmniChat(id: string): Promise<OmniSnapshot> {
  if (isTauriRuntime()) {
    return invoke<OmniSnapshot>("omni_delete_chat", { id });
  }
  return httpJson<OmniSnapshot>("/api/chat/delete", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export async function upsertOmniBot(bot: BotProfile): Promise<OmniSnapshot> {
  if (isTauriRuntime()) {
    return invoke<OmniSnapshot>("omni_upsert_bot", { bot });
  }
  return httpJson<OmniSnapshot>("/api/bot/upsert", {
    method: "POST",
    body: JSON.stringify(bot),
  });
}

export async function deleteOmniBot(id: string): Promise<OmniSnapshot> {
  if (isTauriRuntime()) {
    return invoke<OmniSnapshot>("omni_delete_bot", { id });
  }
  return httpJson<OmniSnapshot>("/api/bot/delete", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export async function saveOmniPreferences(
  preferences: OmniPreferences
): Promise<OmniSnapshot> {
  if (isTauriRuntime()) {
    return invoke<OmniSnapshot>("omni_update_preferences", { preferences });
  }
  return httpJson<OmniSnapshot>("/api/preferences", {
    method: "POST",
    body: JSON.stringify(preferences),
  });
}

export async function upsertOmniWorkspace(
  workspace: WorkspaceEntry
): Promise<OmniSnapshot> {
  if (isTauriRuntime()) {
    return invoke<OmniSnapshot>("omni_upsert_workspace", { workspace });
  }
  return httpJson<OmniSnapshot>("/api/workspace/upsert", {
    method: "POST",
    body: JSON.stringify(workspace),
  });
}

export async function deleteOmniWorkspace(id: string): Promise<OmniSnapshot> {
  if (isTauriRuntime()) {
    return invoke<OmniSnapshot>("omni_delete_workspace", { id });
  }
  return httpJson<OmniSnapshot>("/api/workspace/delete", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export async function upsertOmniRoutine(
  routine: RoutineEntry
): Promise<OmniSnapshot> {
  if (isTauriRuntime()) {
    return invoke<OmniSnapshot>("omni_upsert_routine", { routine });
  }
  return httpJson<OmniSnapshot>("/api/routine/upsert", {
    method: "POST",
    body: JSON.stringify(routine),
  });
}

export async function deleteOmniRoutine(id: string): Promise<OmniSnapshot> {
  if (isTauriRuntime()) {
    return invoke<OmniSnapshot>("omni_delete_routine", { id });
  }
  return httpJson<OmniSnapshot>("/api/routine/delete", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export async function getComputerOverview(): Promise<SystemOverview> {
  if (isTauriRuntime()) {
    return invoke<SystemOverview>("omni_computer_overview");
  }
  return httpJson<SystemOverview>("/api/computer/overview");
}

export async function listLocalFiles(
  relativePath = "."
): Promise<LocalFileEntry[]> {
  if (isTauriRuntime()) {
    return invoke<LocalFileEntry[]>("omni_list_local_files", { relativePath });
  }
  return httpJson<LocalFileEntry[]>(
    `/api/computer/files?path=${encodeURIComponent(relativePath)}`
  );
}

export async function readLocalFile(path: string): Promise<string> {
  if (isTauriRuntime()) {
    return invoke<string>("omni_read_local_file", { path });
  }
  const res = await httpJson<{ content: string }>(
    `/api/computer/read?path=${encodeURIComponent(path)}`
  );
  return res.content;
}

export async function openLocalItem(
  target: string,
  options?: { appName?: string; revealInFinder?: boolean }
): Promise<string> {
  if (isTauriRuntime()) {
    return invoke<string>("omni_open_local_item", {
      target,
      appName: options?.appName,
      revealInFinder: options?.revealInFinder ?? false,
    });
  }
  const res = await httpJson<{ message: string }>("/api/computer/open", {
    method: "POST",
    body: JSON.stringify({
      target,
      appName: options?.appName,
      revealInFinder: options?.revealInFinder ?? false,
    }),
  });
  return res.message;
}

export async function getChatGitStatus(chatId: string, taskId?: string): Promise<GitRepoStatus> {
  return httpJson<GitRepoStatus>(`/api/git/status?chatId=${encodeURIComponent(chatId)}${taskId ? `&taskId=${encodeURIComponent(taskId)}` : ""}`);
}
export async function getGitFileDiff(filePath: string, chatId: string, taskId?: string): Promise<string> {
  const res = await httpJson<{ diff: string }>(`/api/git/diff?path=${encodeURIComponent(filePath)}&chatId=${encodeURIComponent(chatId)}${taskId ? `&taskId=${encodeURIComponent(taskId)}` : ""}`);
  return res.diff;
}
export async function commitGitChanges(message: string, chatId: string, taskId?: string): Promise<OmniSnapshot> {
  return httpJson<OmniSnapshot>("/api/git/commit", { method: "POST", body: JSON.stringify({ message, chatId, taskId }) });
}
export async function discardGitFile(filePath: string, chatId: string, taskId?: string): Promise<OmniSnapshot> {
  return httpJson<OmniSnapshot>("/api/git/discard", { method: "POST", body: JSON.stringify({ filePath, chatId, taskId }) });
}

export async function testCliHarness(
  kind: CliDriverKind
): Promise<CliHarnessTestResult> {
  if (isTauriRuntime()) {
    return invoke<CliHarnessTestResult>("omni_test_harness", { kind });
  }
  return httpJson<CliHarnessTestResult>("/api/harness/test", {
    method: "POST",
    body: JSON.stringify({ kind }),
  });
}

export function subscribeOmniEvents(
  onEvent: (event: OmniStreamEvent) => void
): () => void {
  let disposed = false;
  let unlistenTauri: (() => void) | null = null;
  let sse: EventSource | null = null;

  if (isTauriRuntime()) {
    listen<OmniStreamEvent>("omni-stream-event", (ev) => {
      onEvent(ev.payload);
    })
      .then((unsub) => {
        if (disposed) unsub();
        else unlistenTauri = unsub;
      })
      .catch(() => undefined);
  } else if (typeof EventSource !== "undefined") {
    sse = new EventSource(`${cachedServerBaseUrl}/api/events`);
    sse.onopen = () => onEvent({ type: "state-updated", chatId: null });
    sse.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as OmniStreamEvent;
        onEvent(parsed);
      } catch {
        // Ignore malformed SSE frame
      }
    };
  }

  return () => {
    disposed = true;
    unlistenTauri?.();
    sse?.close();
  };
}

export interface SetupInput {
  cliDrivers: CliDriverKind[];
  primaryDriver?: CliDriverKind;
  primaryName: string;
  primaryProfile?: Pick<BotProfile, "shape" | "color" | "avatarImage" | "roleTitle" | "description">;
  workspacePath: string;
  approveAllTools: boolean;
}

export async function completeOmniSetup(input: SetupInput): Promise<OmniSnapshot> {
  if (isTauriRuntime()) return invoke<OmniSnapshot>("omni_complete_setup", { input });
  return httpJson<OmniSnapshot>("/api/setup", { method: "POST", body: JSON.stringify(input) });
}

export async function pinOmniBot(botId: string, pinned: boolean): Promise<OmniSnapshot> {
  const input = { botId, pinned };
  if (isTauriRuntime()) return invoke<OmniSnapshot>("omni_pin_bot", { input });
  return httpJson<OmniSnapshot>("/api/bot/pin", { method: "POST", body: JSON.stringify(input) });
}

export async function runOmniRoutine(id: string, chatId: string): Promise<void> {
  await httpJson("/api/routine/run", { method: "POST", body: JSON.stringify({ id, chatId }) });
}

export interface TerminalSessionInfo {
  id: string;
  chatId: string;
  botId: string;
  botName: string;
  mode: "output" | "interactive";
  status: "queued" | "running" | "complete" | "exited" | "stopped" | "error";
  cwd: string;
  startedAtMs: number;
  exitCode: number | null;
  error: string | null;
  resumed: boolean;
}
export function listTerminals(chatId: string): Promise<TerminalSessionInfo[]> {
  return httpJson(`/api/terminal/list?chatId=${encodeURIComponent(chatId)}`);
}
export function readTerminal(id: string, offset: number): Promise<{ data: number[]; offset: number; truncated: boolean; status: string }> {
  return httpJson(`/api/terminal/output?id=${encodeURIComponent(id)}&offset=${offset}`);
}
export function startTerminal(chatId: string, botId: string): Promise<TerminalSessionInfo> {
  return httpJson("/api/terminal/start", { method: "POST", body: JSON.stringify({ chatId, botId, cols: 80, rows: 24 }) });
}
export function writeTerminal(id: string, data: number[]): Promise<void> {
  return httpJson("/api/terminal/write", { method: "POST", body: JSON.stringify({ id, data }) });
}
export function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  return httpJson("/api/terminal/resize", { method: "POST", body: JSON.stringify({ id, cols, rows }) });
}
export function stopTerminal(id: string): Promise<void> {
  return httpJson("/api/terminal/stop", { method: "POST", body: JSON.stringify({ id }) });
}
