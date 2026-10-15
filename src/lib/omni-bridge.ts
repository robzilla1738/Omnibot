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
let serverDiscovered = false;
let apiTokenPromise: Promise<string> | null = null;

const DEFAULT_TIMEOUT_MS = 15_000;
const LONG_TIMEOUT_MS = 120_000;

export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

/** The debug backend accepts the dev origin without a token, so browser mode never sends one. */
function apiToken(): Promise<string | null> {
  if (!isTauriRuntime()) return Promise.resolve(null);
  apiTokenPromise ??= invoke<string>("omni_api_token").catch(error => {
    apiTokenPromise = null;
    throw error;
  });
  return apiTokenPromise;
}

async function httpJson<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...requestInit } = init ?? {};
  const token = await apiToken();
  let res: Response;
  try {
    res = await fetch(`${cachedServerBaseUrl}${path}`, {
      ...requestInit,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...requestInit.headers,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("Omnibot didn’t respond in time. Try again.");
    }
    throw error;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "Request failed");
    throw new Error(txt || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

function rememberServer(snap: OmniSnapshot, fallbackBaseUrl = cachedServerBaseUrl): OmniSnapshot {
  cachedServerBaseUrl = snap.serverBaseUrl || fallbackBaseUrl;
  return snap;
}

/** The dev server may bind any of 15 ports; probe them together and keep the first that answers. */
async function discoverServer(): Promise<OmniSnapshot> {
  const winner = new AbortController();
  const probes = Array.from({ length: 15 }, async (_, index) => {
    const candidate = `http://127.0.0.1:${4321 + index}`;
    const res = await fetch(`${candidate}/api/snapshot`, {
      signal: AbortSignal.any([winner.signal, AbortSignal.timeout(2000)]),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return rememberServer((await res.json()) as OmniSnapshot, candidate);
  });
  try {
    return await Promise.any(probes);
  } catch {
    throw new Error("Could not reach the Omnibot local backend.");
  } finally {
    winner.abort();
  }
}

export async function getOmniSnapshot(): Promise<OmniSnapshot> {
  if (isTauriRuntime()) {
    return rememberServer(await invoke<OmniSnapshot>("omni_snapshot"));
  }
  if (!serverDiscovered) {
    const snap = await discoverServer();
    serverDiscovered = true;
    return snap;
  }
  try {
    return rememberServer(await httpJson<OmniSnapshot>("/api/snapshot"));
  } catch (error) {
    serverDiscovered = false;
    throw error;
  }
}

export async function retryOmniStorage(): Promise<OmniSnapshot> {
  return httpJson("/api/storage/retry", { method: "POST" });
}

export async function rescanOmniEnvironment(): Promise<OmniSnapshot> {
  if (isTauriRuntime()) {
    return invoke<OmniSnapshot>("omni_rescan");
  }
  return httpJson<OmniSnapshot>("/api/rescan", { method: "POST", timeoutMs: LONG_TIMEOUT_MS });
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
  return httpJson<OmniSnapshot>("/api/git/commit", { method: "POST", body: JSON.stringify({ message, chatId, taskId }), timeoutMs: LONG_TIMEOUT_MS });
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
    timeoutMs: LONG_TIMEOUT_MS,
  });
}

export type EventChannelStatus = "connecting" | "connected" | "disconnected";

export function subscribeOmniEvents(
  onEvent: (event: OmniStreamEvent) => void,
  onStatus: (status: EventChannelStatus) => void
): () => void {
  let disposed = false;
  let unlistenTauri: (() => void) | null = null;
  let sse: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelay = 1000;

  const connectSse = async () => {
    const token = await apiToken().catch(() => null);
    if (disposed) return;
    const url = `${cachedServerBaseUrl}/api/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const source = new EventSource(url);
    sse = source;
    source.onopen = () => {
      reconnectDelay = 1000;
      onStatus("connected");
      onEvent({ type: "state-updated", chatId: null });
    };
    source.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data) as OmniStreamEvent);
      } catch {
        // Ignore malformed SSE frame
      }
    };
    source.onerror = () => {
      onStatus("disconnected");
      // The browser retries transient drops itself but gives up after a rejected response.
      if (source.readyState !== EventSource.CLOSED || disposed) return;
      reconnectTimer = setTimeout(() => void connectSse(), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    };
  };

  onStatus("connecting");
  if (isTauriRuntime()) {
    listen<OmniStreamEvent>("omni-stream-event", (ev) => {
      onEvent(ev.payload);
    })
      .then((unsub) => {
        if (disposed) unsub();
        else {
          unlistenTauri = unsub;
          onStatus("connected");
        }
      })
      .catch(() => {
        if (!disposed) onStatus("disconnected");
      });
  } else if (typeof EventSource !== "undefined") {
    void connectSse();
  } else {
    onStatus("disconnected");
  }

  return () => {
    disposed = true;
    clearTimeout(reconnectTimer);
    unlistenTauri?.();
    sse?.close();
  };
}

/** Opens model-provided links outside the app webview; other schemes are refused. */
export async function openExternalUrl(url: string): Promise<void> {
  if (!isSafeExternalUrl(url)) throw new Error("Only web and email links can be opened.");
  if (isTauriRuntime()) {
    await invoke("omni_open_external_url", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function isSafeExternalUrl(url: string): boolean {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
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
  return httpJson<OmniSnapshot>("/api/setup", { method: "POST", body: JSON.stringify(input), timeoutMs: LONG_TIMEOUT_MS });
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
export async function readTerminal(id: string, offset: number): Promise<{ data: Uint8Array; offset: number; truncated: boolean; status: string }> {
  const result = await httpJson<{ data: string; offset: number; truncated: boolean; status: string }>(`/api/terminal/output?id=${encodeURIComponent(id)}&offset=${offset}`);
  return { ...result, data: base64ToBytes(result.data) };
}
export function startTerminal(chatId: string, botId: string): Promise<TerminalSessionInfo> {
  return httpJson("/api/terminal/start", { method: "POST", body: JSON.stringify({ chatId, botId, cols: 80, rows: 24 }), timeoutMs: LONG_TIMEOUT_MS });
}
export function writeTerminal(id: string, data: Uint8Array): Promise<void> {
  return httpJson("/api/terminal/write", { method: "POST", body: JSON.stringify({ id, data: bytesToBase64(data) }) });
}
export function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  return httpJson("/api/terminal/resize", { method: "POST", body: JSON.stringify({ id, cols, rows }) });
}
export function stopTerminal(id: string): Promise<void> {
  return httpJson("/api/terminal/stop", { method: "POST", body: JSON.stringify({ id }) });
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunk to stay under the engine's argument limit without quadratic string concatenation.
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  }
  return btoa(chunks.join(""));
}
