export interface ChatDraft {
  text: string;
  skillSlug?: string;
  overrideBotId?: string;
  overrideModel?: string;
  overrideEffort?: string;
  parallelMode?: boolean;
}

export type ChatDrafts = Record<string, ChatDraft>;
const STORAGE_KEY = "omnibot.chat-drafts.v1";

export function readChatDrafts(profileId: string): ChatDrafts {
  const saved: unknown = JSON.parse(localStorage.getItem(`${STORAGE_KEY}:${profileId}`) ?? "{}");
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Saved chat drafts could not be read.");
  const drafts: ChatDrafts = {};
  for (const [id, value] of Object.entries(saved)) {
    if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string") throw new Error("Saved chat drafts could not be read.");
    const draft: ChatDraft = { text: value.text };
    for (const field of ["skillSlug", "overrideBotId", "overrideModel", "overrideEffort"] as const) {
      if (field in value && typeof value[field] === "string") draft[field] = value[field];
    }
    if ("parallelMode" in value && typeof value.parallelMode === "boolean") draft.parallelMode = value.parallelMode;
    Object.defineProperty(drafts, id, { value: draft, enumerable: true, configurable: true, writable: true });
  }
  return drafts;
}

export function writeChatDrafts(profileId: string, drafts: ChatDrafts): void {
  localStorage.setItem(`${STORAGE_KEY}:${profileId}`, JSON.stringify(drafts));
}
