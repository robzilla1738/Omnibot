import type { ChatThread, OmniSnapshot } from "./types";

/** Field-by-field comparison; nested values are small (tool calls, ids, settings), so JSON is cheap enough. */
function sameFields(a: object, b: object, skip?: string): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(key => {
    if (key === skip) return true;
    const x = left[key], y = right[key];
    if (x === y) return true;
    return typeof x === "object" && typeof y === "object" && x !== null && y !== null && JSON.stringify(x) === JSON.stringify(y);
  });
}

const keepIfSame = <T extends object>(prev: T, next: T): T => (sameFields(prev, next) ? prev : next);

/** Merges items matched by `key`, and returns the previous array when every item was kept. */
function shareList<T>(prev: T[], next: T[], key: (item: T) => string, merge: (prev: T, next: T) => T): T[] {
  const byKey = new Map(prev.map(item => [key(item), item]));
  let changed = prev.length !== next.length;
  const merged = next.map((item, index) => {
    const old = byKey.get(key(item));
    const result = old === undefined ? item : merge(old, item);
    if (result !== prev[index]) changed = true;
    return result;
  });
  return changed ? merged : prev;
}

const byId = (item: { id: string }) => item.id;

function shareChat(prev: ChatThread, next: ChatThread): ChatThread {
  const messages = shareList(prev.messages, next.messages, byId, keepIfSame);
  return messages === prev.messages && sameFields(prev, next, "messages") ? prev : { ...next, messages };
}

/**
 * Keeps object identities for unchanged bots, chats, and messages so memoized
 * components skip re-rendering when a fresh snapshot arrives.
 */
export function shareSnapshot(prev: OmniSnapshot, next: OmniSnapshot): OmniSnapshot {
  const shared: OmniSnapshot = {
    ...next,
    preferences: keepIfSame(prev.preferences, next.preferences),
    gitStatus: keepIfSame(prev.gitStatus, next.gitStatus),
    bots: shareList(prev.bots, next.bots, byId, keepIfSame),
    chats: shareList(prev.chats, next.chats, byId, shareChat),
    workspaces: shareList(prev.workspaces, next.workspaces, byId, keepIfSame),
    routines: shareList(prev.routines, next.routines, byId, keepIfSame),
    harnesses: shareList(prev.harnesses, next.harnesses, byId, keepIfSame),
    skills: shareList(prev.skills, next.skills, byId, keepIfSame),
    mcpServers: shareList(prev.mcpServers, next.mcpServers, byId, keepIfSame),
    computerActivity: shareList(prev.computerActivity, next.computerActivity, byId, keepIfSame),
    activeRuns: shareList(prev.activeRuns, next.activeRuns, run => run.messageId, keepIfSame),
    activeWorkflowChatIds: shareList(prev.activeWorkflowChatIds, next.activeWorkflowChatIds, id => id, (a, b) => (a === b ? a : b)),
  };
  const keys = Object.keys(shared) as Array<keyof OmniSnapshot>;
  return keys.every(key => shared[key] === prev[key]) ? prev : shared;
}
