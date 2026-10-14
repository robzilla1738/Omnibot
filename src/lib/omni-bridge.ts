import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  BotProfile,
  ChatThread,
  LocalFileEntry,
  OmniPreferences,
  OmniSnapshot,
  OmniStreamEvent,
  RoutineEntry,
  SystemOverview,
  WorkspaceEntry,
} from "./types";

let cachedServerBaseUrl = "http://127.0.0.1:4321";

function isTauriRuntime(): boolean {
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
  const snap = await httpJson<OmniSnapshot>("/api/snapshot");
  if (snap.serverBaseUrl) cachedServerBaseUrl = snap.serverBaseUrl;
  return snap;
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

export async function getGitFileDiff(filePath: string): Promise<string> {
  if (isTauriRuntime()) {
    return invoke<string>("omni_git_diff", { filePath });
  }
  const res = await httpJson<{ diff: string }>(
    `/api/git/diff?path=${encodeURIComponent(filePath)}`
  );
  return res.diff;
}

export function subscribeOmniEvents(
  onEvent: (event: OmniStreamEvent) => void
): () => void {
  let unlistenTauri: (() => void) | null = null;
  let sse: EventSource | null = null;

  if (isTauriRuntime()) {
    listen<OmniStreamEvent>("omni-stream-event", (ev) => {
      onEvent(ev.payload);
    })
      .then((unsub) => {
        unlistenTauri = unsub;
      })
      .catch(() => undefined);
  } else if (typeof EventSource !== "undefined") {
    sse = new EventSource(`${cachedServerBaseUrl}/api/events`);
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
    unlistenTauri?.();
    sse?.close();
  };
}
