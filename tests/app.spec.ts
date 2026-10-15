import { expect, test, type Page } from "@playwright/test";
import type { OmniSnapshot, ChatMessage } from "../src/lib/types";

function snapshot(): OmniSnapshot {
  return {
    profileId: "fixture-profile", instanceId: "fixture", revision: 1,
    serverPort: 4321, serverBaseUrl: "http://127.0.0.1:4321",
    preferences: {
      onboardingCompleted: true, pinnedBotIds: [], workspaceRoot: "/tmp/test-project", defaultMaxSwarmTurns: 4, approveAllTools: false, globalInstructions: "", sharedMemories: [],
      summarizeTeamResults: false, trustCursorBotHomes: false, workflowBudgetUsd: 3.75, maxContextMessages: 6, maxMessageChars: 1400, maxTurnBudgetUsd: 1.5,
      maxParallelBots: 3, turnTimeoutSecs: 300, preventHandoffLoops: true, onlyExplicitHandoffs: true,
    },
    bots: [{ id: "bot-a", name: "Test Bot", slug: "test-bot", roleTitle: "Tester", description: "Local fixture", shape: "blob", color: "cyan", isPrimary: true, cliDriver: "custom", model: null, reasoningEffort: "low", permissionMode: "plan", systemPrompt: "", memories: [], autoCreatedForCli: false, archived: false }],
    chats: [{ id: "room", title: "Test Room", subtitle: "Local fixture", isPrimary: true, isGroup: false, participantBotIds: ["bot-a"], workspacePath: "/tmp/test-project", workspaceId: null, ownerBotId: null, isBotHome: false, useWorktrees: false, maxSwarmTurns: 4, messages: [], nativeSessions: {}, modelOverrides: {}, tasks: [], lastSyncedMsgIndex: {}, updatedAtMs: 0 }],
    workspaces: [], routines: [], skills: [], harnesses: [], mcpServers: [], computerActivity: [], activeRuns: [], activeWorkflowChatIds: [],
    gitStatus: { isRepo: false, rootPath: "/tmp/test-project", branch: "", headShort: "", ahead: 0, behind: 0, changedFiles: [], diffStat: "", diffPreview: "", worktrees: [] },
  };
}

const unexpectedRequests = new WeakMap<Page, string[]>();

// Requests that reach the catch-all route have no fixture, so the UI would be exercising an error path by accident.
test.afterEach(async ({ page }) => {
  expect(unexpectedRequests.get(page) ?? [], "requests without a fixture").toEqual([]);
});

type FixtureEventsControl = { setDown(down: boolean): void; emit(): void };

/**
 * A fulfilled route can only return a finished SSE body, which makes the real EventSource drop and
 * reconnect constantly. This stand-in stays open, and `__fixtureEvents.setDown` simulates an outage.
 */
async function installFixtureEventSource(page: Page) {
  await page.addInitScript(() => {
    const win = window as unknown as { EventSource: unknown; __fixtureEvents?: FixtureEventsControl };
    let down = false;
    const live = new Set<FixtureEventSource>();
    class FixtureEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly url: string;
      readyState = 0;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(url: string | URL) {
        super();
        this.url = String(url);
        live.add(this);
        setTimeout(() => {
          if (this.readyState === 2) return;
          if (down) { this.fail(); return; }
          this.readyState = 1;
          this.dispatchEvent(new Event("open"));
          this.onopen?.(new Event("open"));
        }, 0);
      }
      fail() {
        this.close();
        this.dispatchEvent(new Event("error"));
        this.onerror?.(new Event("error"));
      }
      close() { this.readyState = 2; live.delete(this); }
    }
    // Leave an EventSource that a test installed itself in place.
    if (!/\[native code\]/.test(Function.prototype.toString.call(window.EventSource))) return;
    win.EventSource = FixtureEventSource;
    win.__fixtureEvents = { emit() { for (const source of live) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "state-updated", chatId: null }) })); }, setDown(next) { down = next; if (next) for (const source of [...live]) source.fail(); } };
  });
}

async function mockBackend(page: Page, state: OmniSnapshot, sendStatus = 200) {
  const sends: unknown[] = [];
  const unexpected: string[] = [];
  unexpectedRequests.set(page, unexpected);
  await installFixtureEventSource(page);
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/snapshot") return route.fulfill({ json: state });
    if (path === "/api/preferences") { Object.assign(state.preferences, route.request().postDataJSON()); return route.fulfill({ json: state }); }
    if (path === "/api/rescan") return route.fulfill({ json: state });
    if (path === "/api/setup") {
      const input = route.request().postDataJSON();
      state.preferences.onboardingCompleted = true;
      state.preferences.approveAllTools = input.approveAllTools;
      if (input.workspacePath) state.preferences.workspaceRoot = input.workspacePath;
      state.chats[0].workspacePath = null; state.chats[0].workspaceId = null;
      state.bots[0].name = input.primaryName;
      if (input.primaryDriver) { state.bots[0].cliDriver = input.primaryDriver; state.bots[0].model = null; }
      Object.assign(state.bots[0], input.primaryProfile ?? {});
      return route.fulfill({ json: state });
    }
    if (path === "/api/bot/upsert") {
      const bot = route.request().postDataJSON();
      Object.assign(state.bots.find(b => b.id === bot.id)!, bot);
      return route.fulfill({ json: state });
    }
    if (path === "/api/bot/pin") {
      const input = route.request().postDataJSON();
      state.preferences.pinnedBotIds = input.pinned ? [input.botId] : [];
      return route.fulfill({ json: state });
    }
    if (path === "/api/events") return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"state-updated","chatId":null}\n\n' });
    if (path === "/api/chat/preview") return route.fulfill({ json: { botIds: [], parallel: false, prompt: "" } });
    if (path === "/api/git/status") return route.fulfill({ json: state.gitStatus });
    if (path === "/api/chat/send") {
      sends.push(route.request().postDataJSON());
      if (sendStatus !== 200) return route.fulfill({ status: sendStatus, body: "Chat is still stopping" });
      state.activeWorkflowChatIds = ["room"];
      return route.fulfill({ json: { ok: true, messageId: "user1" } });
    }
    unexpected.push(`${route.request().method()} ${path}`);
    return route.fulfill({ status: 400, body: "Unexpected fixture request" });
  });
  await page.goto("/");
  if (state.preferences.onboardingCompleted) await expect(page.getByRole("button", { name: state.activeWorkflowChatIds?.length || state.activeRuns.length ? "Stop response" : "Send message", exact: true })).toBeVisible();
  else await expect(page.getByRole("button", { name: "Find my tools" })).toBeVisible();
  return sends;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function message(text: string): ChatMessage {
  return { id: "assistant1", role: "assistant", authorBotId: "bot-a", authorName: "Test Bot", text, thinking: "", toolCalls: [], handoffs: [], mentionedBotIds: [], status: "complete", createdAtMs: 0, usageReported: false, modelReported: false };
}

test("failed sends retain the draft and show a useful error", async ({ page }) => {
  const sends = await mockBackend(page, snapshot(), 400);
  const input = page.getByPlaceholder(/^Message /);
  await input.fill("Please review this change");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Chat is still stopping");
  await expect(input).toHaveValue("Please review this change");
  expect(sends).toHaveLength(1);
});

test("a running workflow blocks duplicate sends between bot turns", async ({ page }) => {
  const state = snapshot(); state.activeWorkflowChatIds = ["room"];
  const sends = await mockBackend(page, state);
  const input = page.getByPlaceholder(/^Message /);
  await input.fill("Must wait");
  await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeEnabled();
  await input.press("Enter");
  expect(sends).toHaveLength(0);
});

test("bot markdown keeps formatting and strips executable HTML", async ({ page }) => {
  const state = snapshot();
  state.chats[0].messages = [message('**Safe formatted text** <img src="x" onerror="window.__xss=1"><script>window.__xss=2</script><a href="javascript:window.__xss=3">Unsafe link</a>')];
  await mockBackend(page, state);
  await expect(page.locator("strong", { hasText: "Safe formatted text" })).toBeVisible();
  await expect(page.locator("[onerror], a[href^='javascript:']")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test("new chat and inspector shortcuts work without calling providers", async ({ page }) => {
  await mockBackend(page, snapshot());
  await page.keyboard.press("ControlOrMeta+i");
  await expect(page.getByTitle("Click to open Bot Settings, Group members, Project & Git (Cmd+I)")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByPlaceholder("Chat title (optional)…")).toBeVisible();
});

test("new chats default to one bot and save its selected CLI model without running it", async ({ page }) => {
  const state = snapshot();
  state.bots[0].cliDriver = "codex";
  state.harnesses = [{ id: "codex", kind: "codex", name: "Codex", binaryName: "codex", installed: true, models: ["fixture-small", "fixture-large"], description: "", installHint: "", authHint: "", supportsJsonStream: true, supportsSessionResume: true }];
  state.bots.push({ ...state.bots[0], id: "bot-b", name: "Teammate", isPrimary: false });
  const sends = await mockBackend(page, state);
  let created: Record<string, unknown> | undefined;
  await page.route("**/api/chat/create", async route => {
    created = route.request().postDataJSON();
    const chat = { ...state.chats[0], id: "new-chat", isPrimary: false, participantBotIds: created!.participantBotIds as string[] };
    state.chats.push(chat);
    await route.fulfill({ json: { chat, snapshot: state } });
  });
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("button", { name: "Individual bot", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Select Test Bot", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Select Teammate", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("combobox", { name: "Test Bot model", exact: true }).selectOption("fixture-small");
  await page.getByRole("button", { name: "Start chat", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New chat", exact: true })).toHaveCount(0);
  expect(state.bots[0].model).toBeNull();
  expect(created).toMatchObject({ modelOverrides: { "bot-a": "fixture-small" } });
  expect(created).toMatchObject({ participantBotIds: ["bot-a"], useWorktrees: false });
  expect(sends).toHaveLength(0);
});

test("group chats require explicit participants and preserve selection on create failure", async ({ page }) => {
  const state = snapshot();
  state.bots.push({ ...state.bots[0], id: "bot-b", name: "Teammate", isPrimary: false });
  const sends = await mockBackend(page, state);
  await page.route("**/api/chat/create", route => route.fulfill({ status: 400, body: "Unable to create chat" }));
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Group chat", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Create group chat/ })).toBeDisabled();
  await page.getByRole("button", { name: "Select Test Bot", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Create group chat/ })).toBeDisabled();
  await page.getByRole("button", { name: "Select Teammate", exact: true }).click();
  await page.getByRole("button", { name: "Create group chat (2 bots)", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Unable to create chat");
  await expect(page.getByRole("button", { name: "Select Teammate", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(sends).toHaveLength(0);
});


test("first-run setup stays local, starts uncluttered, and persists completion", async ({ page }) => {
  const state = snapshot(); state.preferences.onboardingCompleted = false;
  const sends = await mockBackend(page, state);
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar.getByRole("button", { name: "Open Test Bot", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(sidebar.getByText("Pinned", { exact: true })).toHaveCount(0);
  await page.getByLabel("What should we call your main bot?").fill("Omni");
  await page.getByRole("button", { name: "Find my tools" }).click();
  await expect(page.getByText("No supported CLIs found yet.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("radio", { name: /^Standard permissions/ })).toBeChecked();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Preview a handoff" }).click();
  await expect(page.getByRole("list", { name: "Scripted handoff preview" }).getByRole("listitem")).toHaveCount(3);
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
  expect(sends).toHaveLength(0);
  expect(state.preferences.pinnedBotIds).toEqual([]);
  await page.reload();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Find my tools" })).toHaveCount(0);
});

test("bots stay in the library until pinned and selected bots are highlighted", async ({ page }) => {
  const state = snapshot();
  state.bots.push({ ...state.bots[0], id: "bot-b", name: "Teammate", slug: "teammate", isPrimary: false });
  state.chats.push({ ...state.chats[0], id: "direct-b", isBotHome: true, isPrimary: false, workspacePath: null, participantBotIds: ["bot-b"] });
  await mockBackend(page, state);
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar.getByRole("button", { name: "Open Teammate", exact: true })).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Bot library", exact: true }).click();
  await page.getByRole("button", { name: "Pin Teammate to sidebar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unpin Teammate from sidebar", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Message @Teammate", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "Open Teammate", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(sidebar.getByRole("button", { name: "Open Test Bot", exact: true })).not.toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(sidebar.getByRole("button", { name: "Open Teammate", exact: true })).toBeVisible();
  await sidebar.getByRole("button", { name: "Bot library", exact: true }).click();
  await page.getByRole("button", { name: "Unpin Teammate from sidebar", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "Open Teammate", exact: true })).toHaveCount(0);
  expect(state.bots).toHaveLength(2);
});

test("setup preserves selections after a rejected save and submits permissions explicitly", async ({ page }) => {
  const state = snapshot(); state.preferences.onboardingCompleted = false;
  state.harnesses = [{ id: "codex", kind: "codex", name: "Codex", binaryName: "codex", installed: true, version: "fixture", description: "", installHint: "", authHint: "", models: [], supportsJsonStream: true, supportsSessionResume: true }];
  const sends = await mockBackend(page, state);
  let input: Record<string, unknown> | undefined;
  const reject = async (route: import("@playwright/test").Route) => {
    input = route.request().postDataJSON();
    return route.fulfill({ status: 400, body: "Choose an existing project folder using its full path." });
  };
  await page.route("**/api/setup", reject);
  await page.getByRole("button", { name: "Find my tools" }).click();
  await expect(page.getByRole("checkbox", { name: "Add Codex" })).not.toBeChecked();
  await page.getByRole("checkbox", { name: "Add Codex" }).check();
  await page.getByLabel("Power Test Bot with").selectOption("codex");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("radio", { name: /^Automatic tool approval/ }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("alert")).toContainText("Choose an existing project folder");
  expect(input).toMatchObject({ cliDrivers: ["codex"], primaryDriver: "codex", approveAllTools: true });
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("radio", { name: /^Automatic tool approval/ })).toBeChecked();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.unroute("**/api/setup", reject);
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
  expect(sends).toHaveLength(0);
});


test("setup previews and persists the main bot's name, avatar, and role", async ({ page }) => {
  const state = snapshot(); state.preferences.onboardingCompleted = false;
  const sends = await mockBackend(page, state);
  await page.getByLabel("What should we call your main bot?").fill("Infinity");
  await page.getByRole("button", { name: "Change profile picture", exact: true }).click();
  await page.getByRole("button", { name: "Color: Violet", exact: true }).click();
  await page.getByRole("button", { name: "Shape: Heart", exact: true }).click();
  await expect(page.getByRole("button", { name: "Shape: Heart", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Gauntlet", exact: true }).click();
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar.getByRole("button", { name: "Open Infinity", exact: true }).getByRole("img")).toHaveAttribute("src", "/omnibot-gauntlet.png");
  await page.getByText("Role & description", { exact: false }).click();
  await page.getByLabel("Role", { exact: true }).fill("Project coordinator");
  await page.getByRole("textbox", { name: "Description", exact: true }).fill("My local team lead");
  await page.getByRole("button", { name: "Find my tools" }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByLabel("What should we call your main bot?")).toHaveValue("Infinity");
  await page.getByRole("button", { name: "Find my tools" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
  expect(state.bots[0]).toMatchObject({ name: "Infinity", avatarImage: "/omnibot-gauntlet.png", shape: "heart", color: "violet", roleTitle: "Project coordinator", description: "My local team lead" });
  await page.reload();
  await expect(sidebar.getByRole("img", { name: "Infinity profile picture" })).toBeVisible();
  expect(sends).toHaveLength(0);
});

test("profile uploads validate files, persist locally, and can revert to a character", async ({ page }) => {
  const state = snapshot();
  const sends = await mockBackend(page, state);
  const openEditor = async () => {
    await page.getByRole("complementary", { name: "Sidebar" }).getByRole("button", { name: "Bot library", exact: true }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
  };
  await openEditor();
  const upload = page.getByRole("group", { name: "Profile picture", exact: true }).getByLabel("Upload profile picture", { exact: true });
  await upload.setInputFiles({ name: "invalid.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
  await expect(page.getByRole("alert")).toContainText("Choose a PNG, JPEG, or WebP");
  await upload.setInputFiles("public/omnibot-gauntlet.png");
  await expect(page.getByRole("button", { name: "Replace image", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save Bot", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save Bot", exact: true })).toHaveCount(0);
  expect(state.bots[0].avatarImage).toMatch(/^data:image\/png;base64,/);
  expect(state.bots[0].avatarImage!.length).toBeLessThan(800_000);
  await page.reload();
  await expect(page.getByRole("complementary", { name: "Sidebar" }).getByRole("img")).toHaveAttribute("src", state.bots[0].avatarImage!);
  await openEditor();
  await page.getByRole("button", { name: "Character", exact: true }).click();
  await page.getByRole("button", { name: "Save Bot", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save Bot", exact: true })).toHaveCount(0);
  expect(state.bots[0].avatarImage).toBeNull();
  expect(sends).toHaveLength(0);
});

test("setup navigation stays anchored across different step heights", async ({ page }) => {
  const state = snapshot(); state.preferences.onboardingCompleted = false;
  const sends = await mockBackend(page, state);
  const next = page.getByRole("button", { name: "Find my tools", exact: true });
  const original = await next.boundingBox();
  await page.getByRole("button", { name: /Role & description/ }).click();
  await page.getByRole("textbox", { name: "Description", exact: true }).fill("A longer profile that stays editable while the footer remains in place.");
  expect((await next.boundingBox())!.y).toBeCloseTo(original!.y, 0);
  await next.click();
  await expect(page.getByRole("heading", { name: "Meet your local tools." })).toBeVisible();
  const continueButton = page.getByRole("button", { name: "Continue", exact: true });
  expect((await continueButton.boundingBox())!.y).toBeCloseTo(original!.y, 0);
  expect((await continueButton.boundingBox())!.width).toBeCloseTo(original!.width, 0);
  await continueButton.click();
  await expect(page.getByRole("heading", { name: "Give your team a home." })).toBeVisible();
  expect((await continueButton.boundingBox())!.y).toBeCloseTo(original!.y, 0);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Meet your local tools." })).toBeVisible();
  expect(sends).toHaveLength(0);
});

test("slow discovery opens the tools screen immediately and is not repeated on Back", async ({ page }) => {
  const state = snapshot(); state.preferences.onboardingCompleted = false;
  const sends = await mockBackend(page, state);
  let finishScan!: () => void;
  const scanGate = new Promise<void>(resolve => { finishScan = resolve; });
  let scans = 0;
  await page.route("**/api/rescan", async route => {
    scans++;
    await scanGate;
    await route.fulfill({ json: state });
  });
  await page.getByRole("button", { name: "Find my tools" }).click();
  await expect(page.getByRole("heading", { name: "Meet your local tools." })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Checking installed tools…");
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await expect(page.getByText("No supported CLIs found yet.", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Find my tools" }).click();
  await expect(page.getByRole("heading", { name: "Meet your local tools." })).toBeVisible();
  expect(scans).toBe(1);
  finishScan();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
  await expect(page.getByRole("status")).toHaveText("0 tools found");
  expect(sends).toHaveLength(0);
});

test("failed tool discovery can be retried without leaving onboarding", async ({ page }) => {
  const state = snapshot(); state.preferences.onboardingCompleted = false;
  await mockBackend(page, state);
  let scans = 0;
  await page.route("**/api/rescan", route => ++scans === 1
    ? route.fulfill({ status: 500, body: "Discovery unavailable" })
    : route.fulfill({ json: state }));
  await page.getByRole("button", { name: "Find my tools" }).click();
  await expect(page.getByRole("alert")).toContainText("Couldn’t refresh your tools");
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Scan again" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("0 tools found");
  expect(scans).toBe(2);
});

test("bot header expands on hover without changing height and works with reduced motion", async ({ page }) => {
  await mockBackend(page, snapshot());
  const pill = page.getByTitle("Click to open Bot Settings, Group members, Project & Git (Cmd+I)");
  const original = await pill.boundingBox();
  await pill.hover();
  await expect.poll(async () => (await pill.boundingBox())!.width).toBeGreaterThan(original!.width + 24);
  expect((await pill.boundingBox())!.height).toBeCloseTo(original!.height, 0);
  await page.mouse.move(0, 0);
  await expect.poll(async () => Math.abs((await pill.boundingBox())!.width - original!.width)).toBeLessThan(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pill.focus();
  await expect.poll(async () => (await pill.boundingBox())!.width).toBeGreaterThan(original!.width + 24);
  await page.keyboard.press("Enter");
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTitle("Close inspector (Cmd+I)")).toBeVisible();
});

test("author hover reveals the provider logo and opens that bot's settings in place", async ({ page }) => {
  const state = snapshot();
  state.bots.push({ ...state.bots[0], id: "bot-b", name: "Teammate", cliDriver: "grok", isPrimary: false });
  state.chats[0].isGroup = true;
  state.chats[0].participantBotIds.push("bot-b");
  state.chats[0].messages = [{ ...message("Reply from teammate"), authorBotId: "bot-b", authorName: "Teammate" }];
  await mockBackend(page, state);
  const author = page.getByRole("button", { name: "Open Teammate settings", exact: true });
  const badge = page.locator("span.provider-hover-badge");
  const usage = page.locator("div.provider-hover-badge");
  await page.mouse.move(0, 0);
  await expect(badge).toHaveCSS("opacity", "0");
  await expect(usage).toHaveCSS("opacity", "0");
  await author.hover();
  await expect(badge).toHaveCSS("opacity", "1");
  await expect(usage).toHaveCSS("opacity", "1");
  await expect(badge.locator("svg")).toHaveCount(1);
  await author.click();
  await expect(page.getByText("Teammate · Character & CLI", { exact: true })).toBeVisible();
  await expect(page.getByText("Reply from teammate", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Teammate profile settings", exact: true })).toHaveCount(0);
});

test("routines keep drafts, save readable schedules and model choices, and run the saved configuration", async ({ page }) => {
  const state = snapshot();
  state.bots.push({ ...state.bots[0], id: "bot-b", name: "Teammate", cliDriver: "grok", isPrimary: false });
  state.harnesses = [{ id: "grok", kind: "grok", name: "Grok", binaryName: "grok", installed: true, models: ["fixture-current", "fixture-cheap"], modelLabels: { "fixture-cheap": "Fast option" }, modelsStatus: "ready", description: "", installHint: "", authHint: "", supportsJsonStream: true, supportsSessionResume: true }];
  const sends = await mockBackend(page, state);
  let runRequest: unknown;
  await page.route("**/api/routine/upsert", async route => {
    const routine = route.request().postDataJSON();
    state.routines = [{ ...routine, id: "saved-routine" }];
    await route.fulfill({ json: state });
  });
  await page.route("**/api/routine/run", async route => {
    runRequest = route.request().postDataJSON();
    await route.fulfill({ json: { messageId: "fixture-run" } });
  });
  await page.keyboard.press("ControlOrMeta+i");
  await page.getByRole("button", { name: "New routine", exact: true }).click();
  const form = page.getByRole("form", { name: "New routine" });
  await expect(form.getByRole("button", { name: "Save routine" })).toBeDisabled();
  await form.getByRole("button", { name: "Review changes", exact: true }).click();
  await form.getByRole("combobox", { name: "Routine bot", exact: true }).selectOption("bot-b");
  const model = form.getByRole("combobox", { name: "Routine model", exact: true });
  await expect(model.locator("option")).toHaveText(["CLI default", "fixture-current", "Fast option · fixture-cheap", "Custom model…"]);
  await model.selectOption("fixture-cheap");
  await page.getByRole("button", { name: "Close new routine", exact: true }).click();
  await page.getByRole("button", { name: "New routine", exact: true }).click();
  await expect(form.getByLabel("Name", { exact: true })).toHaveValue("Review changes");
  await form.getByRole("combobox", { name: "Routine schedule" }).selectOption("weekly");
  await form.getByRole("combobox", { name: "Routine day" }).selectOption("3");
  await form.getByLabel("Local time", { exact: true }).fill("10:30");
  await form.getByRole("button", { name: "Save routine" }).scrollIntoViewIfNeeded();
  await expect.poll(() => form.evaluate(element => {
    let parent = element.parentElement;
    while (parent && !parent.classList.contains("inspector-scroll-mask")) {
      if (parent.scrollTop !== 0) return false;
      parent = parent.parentElement;
    }
    return true;
  })).toBe(true);
  await form.getByRole("button", { name: "Save routine" }).click();
  await expect(page.getByRole("button", { name: "New routine", exact: true })).toBeVisible();
  expect(state.routines[0]).toMatchObject({ botId: "bot-b", model: "fixture-cheap", chatId: "room", schedule: { frequency: "weekly", time: "10:30", weekday: 3 } });
  await expect(page.getByText("Wednesday at 10:30", { exact: true })).toBeVisible();
  await page.getByTitle("Run routine with its saved bot and model").click();
  await expect.poll(() => runRequest).toEqual({ id: "saved-routine", chatId: "room" });
  expect(sends).toHaveLength(0);
});


test("thinking transitions into streamed text with one stop control and reduced motion", async ({ page }) => {
  await page.addInitScript(() => {
    class FixtureEvents {
      onmessage: ((event: MessageEvent) => void) | null = null;
      receive = () => this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "state-updated", chatId: "room" }) }));
      constructor() { window.addEventListener("fixture-stream-event", this.receive); }
      close() { window.removeEventListener("fixture-stream-event", this.receive); }
    }
    Object.defineProperty(window, "EventSource", { value: FixtureEvents });
  });
  const state = snapshot();
  state.activeWorkflowChatIds = ["room"];
  state.chats[0].messages = [{ ...message(""), status: "streaming", thinking: "Considering the request." }];
  await mockBackend(page, state);
  await expect(page.getByRole("status", { name: "Test Bot is thinking", exact: true })).toBeVisible();
  await expect(page.getByText("Waiting for CLI output...", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Live", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "View thinking", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('[aria-hidden="true"][inert]').filter({ has: page.getByText("Considering the request.", { exact: true }) })).toHaveCSS("opacity", "0");
  await page.screenshot({ path: test.info().outputPath("thinking.png") });
  await page.getByRole("button", { name: "View thinking", exact: true }).click();
  await expect(page.getByText("Considering the request.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Test Bot profile settings", exact: true })).toHaveCount(0);
  const dot = page.getByRole("status", { name: "Test Bot is thinking", exact: true }).locator(".thinking-dots i").first();
  await expect(dot).toHaveCSS("animation-name", "thinking-dot");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(dot).toHaveCSS("animation-name", "none");
  state.chats[0].messages[0].text = "Hello, I’m";
  await page.evaluate(() => window.dispatchEvent(new Event("fixture-stream-event")));
  await expect(page.locator(".omni-prose")).toHaveText("Hello, I’m");
  await expect(page.getByRole("status", { name: "Test Bot is thinking", exact: true })).toHaveCount(0);
  state.chats[0].messages[0].text += " your bot.";
  await page.evaluate(() => window.dispatchEvent(new Event("fixture-stream-event")));
  await expect(page.locator(".omni-prose")).toHaveText("Hello, I’m your bot.");
  let stops = 0;
  await page.route("**/api/chat/stop", async route => {
    stops++;
    state.activeWorkflowChatIds = [];
    state.chats[0].messages[0].status = "stopped";
    await route.fulfill({ json: state });
  });
  await page.getByRole("button", { name: "Stop response", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  expect(stops).toBe(1);
});


test("onboarding provider choice stays current in the ready screen and composer after reload", async ({ page }) => {
  const state = snapshot();
  state.preferences.onboardingCompleted = false;
  state.bots[0].cliDriver = "claude";
  state.bots[0].model = "old-claude-model";
  state.harnesses = ["claude", "grok"].map(kind => ({
    id: kind, kind: kind as "claude" | "grok", name: kind === "claude" ? "Claude" : "Grok", binaryName: kind,
    installed: true, models: [kind + "-fixture"], modelsStatus: "ready", description: "", installHint: "", authHint: "", supportsJsonStream: true, supportsSessionResume: true,
  }));
  const sends = await mockBackend(page, state);
  await page.getByRole("button", { name: "Find my tools" }).click();
  await page.getByRole("combobox", { name: /Power Test Bot with/ }).selectOption("grok");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Test Bot · Grok", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Finish setup", exact: true }).click();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await page.reload();
    await page.getByRole("button", { name: "Switch target Bot, CLI model, or parallel group mode" }).click();
    const picker = page.getByRole("combobox", { name: "Grok model", exact: true });
    await expect(picker).toBeVisible();
    await expect(picker).toHaveValue("");
    await expect(picker.locator("option")).toHaveText(["CLI default", "grok-fixture", "Custom model…"]);
  }
  expect(state.bots[0].cliDriver).toBe("grok");
  expect(state.bots[0].model).toBeNull();
  expect(sends).toHaveLength(0);
});

test("sidebar stays clean while views, ordering, collapsing and renaming persist", async ({ page }) => {
  const state = snapshot(); state.chats[0].workspacePath = null;
  state.bots[0].name = "Omni";
  state.bots.push({ ...state.bots[0], id: "b", name: "Grok", isPrimary: false, shape: "star", color: "silver", cliDriver: "grok" });
  state.bots.push({ ...state.bots[0], id: "c", name: "Codex", isPrimary: false, cliDriver: "codex" });
  state.preferences.pinnedBotIds = ["b", "c"];
  state.workspaces = [{ id: "project", name: "Website", path: "/tmp/website", description: "", instructions: "" }];
  state.chats.push({ ...state.chats[0], id: "work", isPrimary: false, title: "Homepage", workspacePath: "/tmp/website", participantBotIds: ["b"], messages: [message("The layout is ready for review.")] });
  await mockBackend(page, state);
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar.getByText("All views", { exact: true })).toHaveCount(0);
  await expect(sidebar.getByTitle("Customize sidebar", { exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("region", { name: "Bots", exact: true })).toBeVisible();
  const source = await sidebar.getByRole("button", { name: "Open Codex", exact: true }).boundingBox();
  const target = await sidebar.getByRole("button", { name: "Open Grok", exact: true }).boundingBox();
  await page.mouse.move(source!.x + 70, source!.y + source!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + 70, target!.y + 10, { steps: 12 });
  await page.mouse.up();
  await expect(sidebar.getByRole("button", { name: "Open Omni", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(sidebar.locator('[data-sidebar-section="bots"] button[aria-current], [data-sidebar-section="bots"] button[aria-label^="Open "]').first()).toHaveAttribute("aria-label", "Open Codex");
  await sidebar.getByRole("region", { name: "Bots", exact: true }).getByRole("button", { name: "Bots", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "Open Codex", exact: true })).not.toBeVisible();
  await sidebar.click({ button: "right", position: { x: 8, y: 240 } });
  await page.getByRole("combobox", { name: "Sidebar view" }).selectOption("projects");
  await sidebar.getByTitle("Close sidebar settings").click();
  await page.reload();
  await expect(sidebar.getByRole("region", { name: "Bots", exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: "Open Website", exact: true })).toBeVisible();
  await sidebar.click({ button: "right", position: { x: 8, y: 240 } });
  await page.getByRole("combobox", { name: "Sidebar view" }).selectOption("all");
  await sidebar.getByTitle("Close sidebar settings").click();
  await expect(sidebar.getByRole("region", { name: "Bots", exact: true }).getByRole("button", { name: "Bots", exact: true })).toHaveAttribute("aria-expanded", "false");
  await sidebar.getByRole("region", { name: "Bots", exact: true }).getByRole("button", { name: "Bots", exact: true }).click();
  await sidebar.getByTitle("Options for Codex").click();
  await sidebar.getByRole("menu", { name: "Options for Codex" }).getByRole("menuitem", { name: "Rename", exact: true }).click();
  await sidebar.getByRole("textbox", { name: "Rename Codex" }).fill("Builder");
  await sidebar.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "Open Builder", exact: true })).toBeVisible();
  await sidebar.getByTitle("Options for Homepage").click();
  await sidebar.getByRole("menuitem", { name: "Remove from sidebar", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "Open Homepage", exact: true })).toHaveCount(0);
  expect(state.chats.some(c => c.id === "work")).toBe(true);
  await sidebar.click({ button: "right", position: { x: 8, y: 240 } });
  await sidebar.getByRole("button", { name: "Reset view & restore hidden items" }).click();
  await sidebar.getByTitle("Close sidebar settings").click();
  await page.screenshot({ path: test.info().outputPath("sidebar-clean.png") });
  await sidebar.click({ button: "right", position: { x: 8, y: 240 } });
  await page.screenshot({ path: test.info().outputPath("sidebar-settings.png") });
});

test("home creates explicit project work without moving the personal chat", async ({ page }) => {
  const state = snapshot(); state.chats[0].workspacePath = null;
  state.workspaces = [{ id: "project", name: "Website", path: "/tmp/website", description: "", instructions: "" }];
  const sends = await mockBackend(page, state);
  await page.route("**/api/chat/create", async route => {
    const input = route.request().postDataJSON();
    const chat = { ...state.chats[0], id: "work", isPrimary: false, title: "Website work", workspacePath: input.workspacePath, workspaceId: "project" };
    state.chats.push(chat); await route.fulfill({ json: { chat, snapshot: state } });
  });
  await page.getByRole("button", { name: "Choose a project", exact: true }).click();
  const selector = page.getByRole("combobox", { name: "Chat project", exact: true });
  await expect(page.getByRole("button", { name: "Start chat", exact: true })).toBeDisabled();
  await selector.selectOption("/tmp/website");
  expect(await selector.evaluate(el => getComputedStyle(el).appearance)).not.toBe("none");
  await page.getByRole("button", { name: "Start chat", exact: true }).click();
  await expect(page.getByRole("main").getByRole("button", { name: "website", exact: true })).toBeVisible();
  expect(state.chats[0].workspacePath).toBeNull();
  await page.getByRole("complementary", { name: "Sidebar" }).getByRole("button", { name: "Open Test Bot", exact: true }).click();
  await expect(page.getByRole("button", { name: "Choose a project", exact: true })).toBeVisible();
  expect(sends).toHaveLength(0);
});

test("memory edits and forgetting stay in the selected bot or project", async ({ page }) => {
  const state = snapshot(); state.chats[0].workspacePath = null;
  state.workspaces = [{ id: "project", name: "Website", path: "/tmp/website", description: "", instructions: "", memories: [] }];
  const sends = await mockBackend(page, state);
  await page.route("**/api/workspace/upsert", async route => { Object.assign(state.workspaces[0], route.request().postDataJSON()); await route.fulfill({ json: state }); });
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  const manager = page.getByRole("region", { name: "Memory manager" });
  await manager.getByRole("textbox", { name: "New memory" }).fill("Prefer concise replies.");
  await manager.getByRole("button", { name: "Save memory", exact: true }).click();
  await expect(manager.getByText("Prefer concise replies.", { exact: true })).toBeVisible();
  await manager.getByRole("combobox", { name: "Memory scope" }).selectOption("project:project");
  await expect(manager.getByText("Prefer concise replies.", { exact: true })).toHaveCount(0);
  await manager.getByRole("textbox", { name: "New memory" }).fill("Website uses blue.");
  await manager.getByRole("button", { name: "Save memory", exact: true }).click();
  await manager.getByRole("button", { name: "Edit memory 1", exact: true }).click();
  await manager.getByRole("textbox", { name: "Edit memory", exact: true }).fill("Website uses teal.");
  await manager.getByRole("button", { name: "Save memory changes" }).click();
  await expect(manager.getByText("Website uses teal.", { exact: true })).toBeVisible();
  expect(state.bots[0].memories).toEqual(["Prefer concise replies."]);
  expect(state.workspaces[0].memories).toEqual(["Website uses teal."]);
  await manager.getByRole("button", { name: "Forget memory 1" }).click();
  await expect(manager.getByText("Website uses teal.", { exact: true })).toHaveCount(0);
  expect(state.workspaces[0].memories).toEqual([]);
  expect(sends).toHaveLength(0);
});

test("usage displays only reported totals and provider badge shows the resolved model", async ({ page }) => {
  const state = snapshot();
  state.chats[0].messages = [
    { ...message("Verified result"), id: "verified", cliDriver: "grok", model: "grok-fixture", modelReported: true, usageReported: true, inputTokens: 24000, outputTokens: 300, costUsd: 0.012345, durationMs: 7700 },
    { ...message("Old estimated result"), id: "old", inputTokens: 888, outputTokens: 111, costUsd: 0.5 },
  ];
  await mockBackend(page, state);
  const main = page.getByRole("main");
  await expect(main.getByText("≈24.3k tok", { exact: true })).toHaveAttribute("title", /24,300 tokens/);
  await expect(main.getByText("999 tok", { exact: true })).toHaveCount(0);
  await expect(main.getByText("Usage unavailable", { exact: true })).toBeVisible();
  await expect(main.getByText("7.7s", { exact: true })).toHaveAttribute("title", "Elapsed CLI execution time: 7,700 ms");
  await main.getByText("Verified result", { exact: true }).hover();
  await expect(main.getByText("grok-fixture", { exact: true })).toBeVisible();
  const badge = main.locator(".provider-hover-badge").first();
  await expect(badge).toHaveText("grok-fixture");
  await expect(badge.locator("svg, img")).not.toHaveCount(0);
});

test("Bots view opens a persistent bot conversation without taking over a one-off task", async ({ page }) => {
  const state = snapshot(); state.chats[0].workspacePath = null;
  state.bots.push({ ...state.bots[0], id: "helper", name: "Helper", isPrimary: false, roleTitle: "Research and everyday tasks" });
  state.chats.push({ ...state.chats[0], id: "task", isPrimary: false, title: "Plan a trip", participantBotIds: ["helper"] });
  const sends = await mockBackend(page, state);
  const requests: unknown[] = [];
  await page.route("**/api/chat/create", async route => {
    const input = route.request().postDataJSON(); requests.push(input);
    const chat = { ...state.chats[0], id: "helper-home", isPrimary: false, isBotHome: input.botHome, title: "Helper", participantBotIds: ["helper"] };
    state.chats.push(chat); await route.fulfill({ json: { chat, snapshot: state } });
  });
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const views = sidebar.getByRole("group", { name: "Sidebar views" });
  await expect(sidebar.getByRole("button", { name: "Open Helper", exact: true })).toHaveCount(0);
  await views.getByRole("button", { name: "Bots", exact: true }).click();
  await sidebar.getByRole("button", { name: "Open Helper", exact: true }).click();
  await expect.poll(() => requests).toEqual([expect.objectContaining({ botHome: true, participantBotIds: ["helper"] })]);
  await expect(sidebar.getByRole("button", { name: "Open Helper", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Ask Helper for help with anything you’re working on.")).toBeVisible();
  await views.getByRole("button", { name: "Chats", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "Open Plan a trip", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Open Helper", exact: true })).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Open Plan a trip", exact: true }).click();
  await views.getByRole("button", { name: "Bots", exact: true }).click();
  await sidebar.getByRole("button", { name: "Open Helper", exact: true }).click();
  expect(requests).toHaveLength(1);
  expect(state.preferences.pinnedBotIds).toEqual([]);
  expect(sends).toHaveLength(0);
});

test("sidebar views stay outside the fade, rows fit, and sections drag without collapsing", async ({ page }) => {
  const state = snapshot(); state.chats[0].workspacePath = null;
  state.bots.push({ ...state.bots[0], id: "helper", name: "Helper", isPrimary: false });
  state.preferences.pinnedBotIds = ["helper"];
  state.workspaces = [{ id: "website", name: "Website with a very long name", path: "/tmp/website", description: "", instructions: "" }];
  state.chats.push({ ...state.chats[0], id: "task", isPrimary: false, title: "A long task title for layout validation", messages: [message("A long response that must truncate rather than stretch the selected sidebar row.")] });
  await mockBackend(page, state);
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const views = sidebar.getByRole("group", { name: "Sidebar views" });
  expect(await views.evaluate(el => { for (let p: Element | null = el; p; p = p.parentElement) { if (getComputedStyle(p).maskImage !== "none") return false; } return true; })).toBe(true);
  const project = sidebar.getByRole("region", { name: "Projects", exact: true });
  const botSection = sidebar.getByRole("region", { name: "Bots", exact: true });
  const source = await project.getByRole("button", { name: "Projects", exact: true }).boundingBox();
  const target = await botSection.getByRole("button", { name: "Bots", exact: true }).boundingBox();
  await page.mouse.move(source!.x+20, source!.y+8); await page.mouse.down();
  await page.mouse.move(target!.x+20, target!.y+2, {steps:12}); await page.mouse.up();
  await expect(sidebar.locator("[data-sidebar-section]").first()).toHaveAttribute("data-sidebar-section", "projects");
  await expect(project.getByRole("button", { name: "Projects", exact: true })).toHaveAttribute("aria-expanded", "true");
  await sidebar.getByRole("button", { name: "Open A long task title for layout validation", exact: true }).click();
  const bounds = await sidebar.boundingBox();
  for (const row of await sidebar.locator("[data-sidebar-item]").all()) {
    const box = await row.boundingBox(); expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x+bounds!.width-8);
  }
  await sidebar.getByTitle("Options for Helper").click();
  const menu = sidebar.getByRole("menu", { name: "Options for Helper" });
  await expect(menu.getByRole("menuitem", { name: "Rename", exact: true })).toBeFocused();
  await expect(menu.locator(".lucide-arrow-up, .lucide-arrow-down")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(sidebar.getByTitle("Options for Helper")).toBeFocused();
  await page.reload();
  await expect(sidebar.locator("[data-sidebar-section]").first()).toHaveAttribute("data-sidebar-section", "projects");
  await page.screenshot({ path: test.info().outputPath("sidebar-restored.png") });
});

test("app updates explain availability in the browser without offering an unusable check", async ({ page }) => {
  await mockBackend(page, snapshot());
  await page.getByRole("complementary", { name: "Sidebar" }).getByRole("button", { name: "Bot library", exact: true }).click();
  await page.getByRole("button", { name: "App updates", exact: true }).click();
  await expect(page.getByText("Update checks are available in the installed macOS app.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Check for updates", exact: true })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Automatically check for updates" })).toHaveCount(0);
});

test("failed chat creation keeps model choices local and preserves the draft", async ({ page }) => {
  const state = snapshot(); state.bots[0].model = "original";
  state.harnesses = [{ id: "custom", kind: "custom", name: "Fixture", binaryName: "fixture", installed: true, models: ["original", "chat-only"], description: "", installHint: "", authHint: "", supportsJsonStream: false, supportsSessionResume: false }];
  await mockBackend(page, state);
  let profileWrites = 0;
  await page.route("**/api/bot/upsert", async route => { profileWrites++; await route.fulfill({ json: state }); });
  await page.route("**/api/chat/create", route => route.fulfill({ status: 400, body: "Project folder unavailable" }));
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("combobox", { name: "Test Bot model", exact: true }).selectOption("chat-only");
  await page.getByRole("button", { name: "Start chat", exact: true }).click();
  await expect(page.getByText("Project folder unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Test Bot model", exact: true })).toHaveValue("chat-only");
  expect(profileWrites).toBe(0); expect(state.bots[0].model).toBe("original");
});

test("archived bots can be restored without deleting their conversation", async ({ page }) => {
  const state = snapshot();
  state.bots.push({ ...state.bots[0], id: "helper", name: "Helper", slug: "helper", isPrimary: false });
  state.chats.push({ ...state.chats[0], id: "helper-home", isPrimary: false, isBotHome: true, ownerBotId: "helper", workspacePath: null, participantBotIds: ["helper"], messages: [message("Keep this history")] });
  await mockBackend(page, state);
  await page.route("**/api/bot/delete", async route => { state.bots[1].archived = true; await route.fulfill({ json: state }); });
  const library = page.getByRole("complementary", { name: "Sidebar" }).getByRole("button", { name: "Bot library", exact: true });
  await library.click();
  await page.getByRole("button", { name: "Archive Helper", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restore Helper", exact: true })).toBeVisible();
  expect(state.chats[1].messages[0].text).toBe("Keep this history");
  await page.getByRole("button", { name: "Restore Helper", exact: true }).click();
  await expect(page.getByRole("button", { name: "Archive Helper", exact: true })).toBeVisible();
  expect(state.bots[1].archived).toBe(false);
});

test("personal home with helpers reopens the same owner conversation", async ({ page }) => {
  const state = snapshot();
  state.bots.push({ ...state.bots[0], id: "helper", name: "Helper", isPrimary: false });
  state.chats.push({ ...state.chats[0], id: "helper-home", title: "Helper", isPrimary: false, isBotHome: true, ownerBotId: "helper", isGroup: false, workspacePath: null, participantBotIds: ["helper", "bot-a"], messages: [message("Existing delegated conversation")] });
  await mockBackend(page, state);
  let creates = 0;
  await page.route("**/api/chat/create", route => { creates++; return route.fulfill({ status: 500, body: "Must reuse existing home" }); });
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await sidebar.getByRole("group", { name: "Sidebar views" }).getByRole("button", { name: "Bots", exact: true }).click();
  await sidebar.getByRole("button", { name: "Open Helper", exact: true }).click();
  await expect(page.locator("p").filter({ hasText: /^Existing delegated conversation$/ })).toBeVisible(); expect(creates).toBe(0);
});

test("recipient preview hides the obvious bot and shows a different recipient", async ({ page }) => {
  const state = snapshot();
  state.chats[0].tasks = [{ id: "t", workflowId: "w", botId: "bot-a", instructions: "Review the change", mode: "sequential", status: "skipped", reason: "The previous sequential task failed." }];
  await mockBackend(page, state);
  await page.route("**/api/chat/preview", route => route.fulfill({ json: { botIds: ["bot-a"], parallel: false, prompt: "Review" } }));
  await page.getByPlaceholder(/^Message /).fill("Review");
  await expect(page.getByLabel("Recipient preview")).toHaveCount(0);
  await page.route("**/api/chat/preview", route => route.fulfill({ json: { botIds: ["other-bot"], parallel: false, prompt: "Review" } }));
  await page.getByPlaceholder(/^Message /).fill("Review with another bot");
  await expect(page.getByLabel("Recipient preview")).toHaveText("To: other-bot");
});

test("long conversations render recent messages first and retain access to earlier history", async ({ page }) => {
  const state = snapshot();
  state.chats[0].messages = Array.from({ length: 500 }, (_, index) => ({ ...message(`History entry ${index + 1}`), id: `history-${index}` }));
  await mockBackend(page, state);
  await expect(page.locator("p").filter({ hasText: /^History entry 500$/ })).toBeVisible();
  await expect(page.locator("p").filter({ hasText: /^History entry 1$/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Load earlier messages (300 remaining)", exact: true }).click();
  await page.getByRole("button", { name: "Load earlier messages (100 remaining)", exact: true }).click();
  await expect(page.locator("p").filter({ hasText: /^History entry 1$/ })).toHaveCount(1);
  expect(state.chats[0].messages).toHaveLength(500);
});

test("terminal panel follows output, expands, searches, and hides without stopping the process", async ({ page }) => {
  const state = snapshot(); state.bots[0].cliDriver = "codex";
  await mockBackend(page, state);
  let stopped = 0;
  const terminal = { id: "run-1", chatId: "room", botId: "bot-a", botName: "Test Bot", mode: "output", status: "running", cwd: "/tmp/project", startedAtMs: 1, exitCode: null, error: null, resumed: false };
  const bytes = new TextEncoder().encode("Starting local tools\r\n\x1b[32mREADY: live process output\x1b[0m\r\n");
  await page.route("**/api/terminal/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/list")) return route.fulfill({ json: [terminal] });
    if (url.pathname.endsWith("/output")) { const offset = Number(url.searchParams.get("offset")); return route.fulfill({ json: { data: toBase64(bytes.slice(offset)), offset: bytes.length, truncated: false, status: "running" } }); }
    if (url.pathname.endsWith("/stop")) { stopped++; return route.fulfill({ json: null }); }
    return route.fulfill({ status: 400, body: "Unexpected terminal mutation" });
  });
  await page.getByRole("button", { name: "Toggle terminal", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Bot terminal", exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Run logs", exact: true }).click();
  await expect(panel.getByRole("tab", { name: /Test Bot/ })).toBeVisible();
  await expect(panel.locator(".xterm-accessibility-tree")).toContainText("READY: live process output");
  await panel.getByRole("textbox", { name: "Search terminal output" }).fill("READY");
  await page.screenshot({ path: test.info().outputPath("terminal-split.png") });
  await panel.getByRole("button", { name: "Expand terminal", exact: true }).click();
  await expect(panel).toHaveClass(/terminal-expanded/);
  await page.screenshot({ path: test.info().outputPath("terminal-output.png") });
  await panel.getByRole("button", { name: "Hide terminal" }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "Toggle terminal", exact: true }).click();
  await panel.getByRole("button", { name: "Run logs", exact: true }).click();
  await expect(panel.locator(".xterm-accessibility-tree")).toContainText("READY: live process output");
  expect(stopped).toBe(0);
});

test("terminal opens the interactive CLI by default, stops automation, and reuses the session after hiding", async ({ page }) => {
  await page.clock.install();
  const state = snapshot(); state.bots[0].permissionMode = "auto"; state.activeWorkflowChatIds = ["room"];
  await mockBackend(page, state);
  const sessions: Record<string, unknown>[] = [];
  const writes: number[] = [];
  let stops = 0; let resizes = 0; let stoppedWorkflow = false;
  await page.route("**/api/chat/stop", route => { stoppedWorkflow = true; state.activeWorkflowChatIds = []; return route.fulfill({ json: state }); });
  await page.route("**/api/terminal/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/list")) return route.fulfill({ json: sessions });
    if (url.pathname.endsWith("/start")) {
      expect(stoppedWorkflow).toBe(true);
      const session = { id: "pty-1", chatId: "room", botId: "bot-a", botName: "Test Bot", mode: "interactive", status: "running", cwd: "/tmp/project", startedAtMs: 1, exitCode: null, error: null, resumed: false };
      sessions.push(session); return route.fulfill({ json: session });
    }
    if (url.pathname.endsWith("/output")) { const bytes = new TextEncoder().encode("Interactive fixture ready\r\n$ "); return route.fulfill({ json: { data: toBase64(bytes.slice(Number(url.searchParams.get("offset")))), offset: bytes.length, truncated: false, status: "running" } }); }
    if (url.pathname.endsWith("/resize")) { resizes++; return route.fulfill({ json: null }); }
    if (url.pathname.endsWith("/write")) { writes.push(...Buffer.from(route.request().postDataJSON().data, "base64")); return route.fulfill({ json: null }); }
    if (url.pathname.endsWith("/stop")) { stops++; sessions[0].status = "stopped"; return route.fulfill({ json: null }); }
    return route.fulfill({ status: 400, body: "Unexpected terminal request" });
  });
  await page.getByRole("button", { name: "Toggle terminal", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Bot terminal", exact: true });
  await expect(panel.getByText("Automation paused for this chat")).toBeVisible();
  await expect(panel.locator(".xterm-accessibility-tree")).toContainText("Interactive fixture ready");
  await panel.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("echo hello");
  await page.keyboard.press("Enter");
  await expect.poll(() => new TextDecoder().decode(new Uint8Array(writes))).toBe("echo hello\r");
  await expect.poll(() => resizes).toBeGreaterThan(0);
  await page.keyboard.press("Control+k");
  await expect.poll(() => writes.at(-1)).toBe(11);
  await expect(page.getByRole("dialog", { name: "Search" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Backquote");
  await expect(panel).toBeHidden();
  expect(stops).toBe(0);
  await page.keyboard.press("ControlOrMeta+Backquote");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "End control", exact: true }).click();
  await expect.poll(() => stops).toBe(1);
  await page.clock.runFor(5000);
  expect(sessions).toHaveLength(1);
});

test("unsupported terminal adapters explain live output without enabling takeover", async ({ page }) => {
  const state = snapshot(); state.bots[0].cliDriver = "codex";
  await mockBackend(page, state);
  await page.route("**/api/terminal/list?**", route => route.fulfill({ json: [] }));
  await page.getByRole("button", { name: "Toggle terminal", exact: true }).click();
  await expect(page.getByText(/This bot’s output is available in Run logs/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Open interactive CLI", exact: true })).toBeDisabled();
});

test("terminal startup errors stay visible without a retry loop", async ({ page }) => {
  await page.clock.install();
  const state = snapshot(); state.bots[0].permissionMode = "auto";
  await mockBackend(page, state);
  let starts = 0;
  await page.route("**/api/terminal/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/list")) return route.fulfill({ json: [] });
    if (path.endsWith("/start")) { starts++; return route.fulfill({ status: 400, body: "CLI command is unavailable" }); }
    return route.fulfill({ status: 400, body: "Unexpected request" });
  });
  await page.getByRole("button", { name: "Toggle terminal", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("CLI command is unavailable");
  await page.clock.runFor(5000);
  expect(starts).toBe(1);
  await page.getByRole("button", { name: "Retry connection", exact: true }).click();
  await expect.poll(() => starts).toBe(2);
});


test("saved team summary preference is applied after reloading the chat", async ({ page }) => {
  const state = snapshot();
  state.preferences.summarizeTeamResults = true;
  const sends = await mockBackend(page, state);
  await page.reload();
  await expect(page.getByText("Ask the first speaker to summarize team results (one extra turn)")).toHaveCount(0);
  await page.getByPlaceholder(/^Message /).fill("Review together");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => sends.length).toBe(1);
  expect(sends[0]).toMatchObject({ summarize: true });
});


test("team summary and Cursor home trust settings are remembered and can be turned off", async ({ page }) => {
  const state = snapshot();
  await mockBackend(page, state);
  const openSettings = async () => {
    await page.getByRole("complementary", { name: "Sidebar" }).getByRole("button", { name: "Bot library", exact: true }).click();
    await page.getByRole("button", { name: "Team Rules & Trust", exact: true }).click();
  };
  await openSettings();
  for (const name of ["Summarize team results", "Trust bot homes in Cursor"]) {
    const toggle = page.getByRole("switch", { name, exact: true });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  }
  await page.reload();
  await openSettings();
  for (const name of ["Summarize team results", "Trust bot homes in Cursor"]) {
    const toggle = page.getByRole("switch", { name, exact: true });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  }
});


test("repository reviews select a project and preserve the prompt before sending", async ({ page }) => {
  const state = snapshot(); state.chats[0].workspacePath = null;
  state.workspaces = [{ id: "project", name: "Website", path: "/tmp/website", description: "", instructions: "" }];
  const sends = await mockBackend(page, state);
  let created: Record<string, unknown> | undefined;
  await page.route("**/api/chat/create", async route => {
    created = route.request().postDataJSON();
    const chat = { ...state.chats[0], id: "work", isPrimary: false, title: "Website work", workspacePath: created!.workspacePath, workspaceId: "project" };
    state.chats.push(chat as typeof state.chats[0]);
    await route.fulfill({ json: { chat, snapshot: state } });
  });
  const prompt = "Inspect recent commits and uncommitted diffs in the active workspace.";
  await page.getByPlaceholder(/^Message /).fill(prompt);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New chat", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start chat", exact: true })).toBeDisabled();
  expect(sends).toHaveLength(0);
  await page.getByRole("combobox", { name: "Chat project", exact: true }).selectOption("/tmp/website");
  await page.getByRole("button", { name: "Start chat", exact: true }).click();
  await expect(page.getByPlaceholder(/^Message /)).toHaveValue(prompt);
  expect(created).toMatchObject({ workspacePath: "/tmp/website", participantBotIds: ["bot-a"] });
  expect(state.chats[0].workspacePath).toBeNull();
  expect(sends).toHaveLength(0);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => sends.length).toBe(1);
  expect(sends[0]).toMatchObject({ chatId: "work", text: prompt });
});

test("general Git questions in personal space do not require a project", async ({ page }) => {
  const state = snapshot(); state.chats[0].workspacePath = null;
  const sends = await mockBackend(page, state);
  await page.getByPlaceholder(/^Message /).fill("What does git status mean?");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => sends.length).toBe(1);
  await expect(page.getByRole("dialog", { name: "New chat", exact: true })).toBeHidden();
});

test("bot links open externally only for web and email URLs and remote images are not fetched", async ({ page }) => {
  await page.addInitScript(() => {
    const opened: string[] = [];
    (window as unknown as { __opened: string[] }).__opened = opened;
    window.open = ((url?: string | URL) => { opened.push(String(url)); return null; }) as typeof window.open;
  });
  const remoteRequests: string[] = [];
  page.on("request", request => { if (new URL(request.url()).hostname === "tracker.example") remoteRequests.push(request.url()); });
  const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const state = snapshot();
  state.chats[0].messages = [message(`[Docs](https://docs.example/guide) [Local file](file:///etc/hosts) ![Tracking pixel](https://tracker.example/pixel.png) ![Inline](${pixel})`)];
  await mockBackend(page, state);
  const prose = page.locator(".omni-prose");
  const docs = prose.getByRole("link", { name: "Docs", exact: true });
  await expect(docs).toHaveAttribute("rel", "noopener noreferrer");
  await expect(prose.locator("a", { hasText: "Local file" })).not.toHaveAttribute("href");
  await expect(prose.locator(".omni-blocked-image")).toHaveText("Tracking pixel");
  await expect(prose.getByRole("img", { name: "Inline" })).toHaveAttribute("src", pixel);
  await docs.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual(["https://docs.example/guide"]);
  expect(new URL(page.url()).pathname).toBe("/");
  expect(remoteRequests).toEqual([]);
});

test("deleting a chat asks for confirmation and keeps it when cancelled", async ({ page }) => {
  const state = snapshot();
  state.chats.push({ ...state.chats[0], id: "work", isPrimary: false, title: "Homepage", messages: [message("Draft is ready.")] });
  await mockBackend(page, state);
  const deletes: unknown[] = [];
  await page.route("**/api/chat/delete", async route => {
    deletes.push(route.request().postDataJSON());
    state.chats = state.chats.filter(chat => chat.id !== "work");
    await route.fulfill({ json: state });
  });
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const options = sidebar.getByTitle("Options for Homepage");
  await options.click();
  await page.getByRole("menuitem", { name: "Delete chat…", exact: true }).click();
  const confirmDialog = page.getByRole("alertdialog", { name: "Delete “Homepage”?" });
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmDialog).toHaveCount(0);
  expect(deletes).toEqual([]);
  await expect(sidebar.getByRole("button", { name: "Open Homepage", exact: true })).toBeVisible();
  await options.click();
  await page.getByRole("menuitem", { name: "Delete chat…", exact: true }).click();
  await confirmDialog.getByRole("button", { name: "Delete chat", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "Open Homepage", exact: true })).toHaveCount(0);
  expect(deletes).toEqual([{ id: "work" }]);
});

test("project deletion from the hub requires confirmation", async ({ page }) => {
  const state = snapshot();
  state.workspaces = [{ id: "project", name: "Website", path: "/tmp/website", description: "", instructions: "" }, { id: "docs", name: "Docs", path: "/tmp/docs", description: "", instructions: "" }];
  await mockBackend(page, state);
  let deletes = 0;
  await page.route("**/api/workspace/delete", async route => { deletes++; state.workspaces = state.workspaces.filter(ws => ws.id !== "project"); await route.fulfill({ json: state }); });
  await page.getByRole("complementary", { name: "Sidebar" }).getByRole("button", { name: "Bot library", exact: true }).click();
  const hub = page.getByRole("dialog", { name: "Omnibot Hub" });
  await hub.getByRole("navigation").getByRole("button", { name: /^Projects/ }).click();
  await hub.getByRole("button", { name: "Remove project Website", exact: true }).click();
  const confirmDialog = page.getByRole("alertdialog", { name: "Remove project “Website”?" });
  await expect(confirmDialog).toContainText("/tmp/website");
  await confirmDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(deletes).toBe(0);
  await expect(hub).toBeVisible();
  await hub.getByRole("button", { name: "Remove project Website", exact: true }).click();
  await confirmDialog.getByRole("button", { name: "Remove project", exact: true }).click();
  await expect.poll(() => deletes).toBe(1);
  await expect(hub.getByRole("button", { name: "Remove project Website", exact: true })).toHaveCount(0);
});

test("a failed local tool health check is shown as a failure", async ({ page }) => {
  const state = snapshot();
  state.harnesses = [{ id: "codex", kind: "codex", name: "Codex", binaryName: "codex", installed: true, models: [], description: "", installHint: "", authHint: "", supportsJsonStream: true, supportsSessionResume: true }];
  await mockBackend(page, state);
  await page.route("**/api/harness/test", route => route.fulfill({ json: { kind: "codex", ok: false, latencyMs: 12, message: "Not signed in" } }));
  await page.getByRole("complementary", { name: "Sidebar" }).getByRole("button", { name: "Bot library", exact: true }).click();
  await page.getByRole("button", { name: "Local tools", exact: true }).click();
  const tools = page.getByRole("dialog", { name: "Local Coding Tools" });
  await tools.getByRole("button", { name: "Test Codex", exact: true }).click();
  await expect(tools.getByText("✕ Health check failed · Not signed in")).toBeVisible();
});

test("search results support arrow-key selection and Enter", async ({ page }) => {
  const state = snapshot();
  state.chats.push({ ...state.chats[0], id: "alpha", isPrimary: false, title: "Alpha notes" }, { ...state.chats[0], id: "beta", isPrimary: false, title: "Alpha review" });
  await mockBackend(page, state);
  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByRole("combobox", { name: "Search" });
  await expect(search).toBeFocused();
  await search.fill("Alpha");
  const options = page.getByRole("listbox", { name: "Search results" }).getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await search.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(search).toHaveAttribute("aria-activedescendant", (await options.nth(1).getAttribute("id"))!);
  await search.press("Enter");
  await expect(page.getByRole("dialog", { name: "Search" })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Sidebar" }).getByRole("button", { name: "Open Alpha review", exact: true })).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("ControlOrMeta+k");
  await search.fill("zzz-nothing");
  await expect(page.getByText("No matches", { exact: true })).toBeVisible();
});

test("dialogs trap focus, close on Escape, and restore focus", async ({ page }) => {
  await mockBackend(page, snapshot());
  const composer = page.getByPlaceholder(/^Message /);
  await composer.focus();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Search" });
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog.getByRole("combobox", { name: "Search" })).toBeFocused();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(composer).toBeFocused();
});

test("shortcuts respect text fields and open modals", async ({ page }) => {
  await mockBackend(page, snapshot());
  const inspector = page.getByTitle("Click to open Bot Settings, Group members, Project & Git (Cmd+I)");
  await page.getByPlaceholder(/^Message /).focus();
  await page.keyboard.press("ControlOrMeta+i");
  await expect(inspector).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "New chat" })).toHaveCount(0);
});

test("failed sidebar actions report the error instead of failing silently", async ({ page }) => {
  const state = snapshot();
  state.bots.push({ ...state.bots[0], id: "bot-b", name: "Teammate", slug: "teammate", isPrimary: false });
  await mockBackend(page, state);
  await page.route("**/api/bot/pin", route => route.fulfill({ status: 500, body: "Disk is read-only" }));
  await page.getByRole("complementary", { name: "Sidebar" }).getByRole("button", { name: "Bot library", exact: true }).click();
  await page.getByRole("button", { name: "Pin Teammate to sidebar", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Disk is read-only" })).toContainText("Couldn’t pin Teammate");
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Disk is read-only" })).toHaveCount(0);
});

test("the offline screen can retry connecting to the backend", async ({ page }) => {
  const state = snapshot();
  let online = false;
  // Routes registered later take priority, so the offline gate goes last.
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/snapshot") return route.fulfill({ json: state });
    if (path === "/api/git/status") return route.fulfill({ json: state.gitStatus });
    return route.fulfill({ status: 400, body: "Unexpected fixture request" });
  });
  await installFixtureEventSource(page);
  await page.route("**/api/snapshot", route => online ? route.fallback() : route.fulfill({ status: 503, body: "Starting" }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Omnibot Local Daemon Offline" })).toBeVisible();
  await expect(page.getByText(/Start the backend, then run pnpm dev:connect/)).toBeVisible();
  online = true;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
});

test("a lost live-update connection shows a reconnecting notice", async ({ page }) => {
  await page.clock.install();
  const state = snapshot();
  await mockBackend(page, state);
  const setEventsDown = (down: boolean) => page.evaluate(next => (window as unknown as { __fixtureEvents: FixtureEventsControl }).__fixtureEvents.setDown(next), down);
  await page.clock.runFor(5000);
  await expect(page.getByText("Reconnecting…", { exact: true })).toHaveCount(0);
  await setEventsDown(true);
  await expect(page.getByText("Reconnecting…", { exact: true })).toBeVisible();
  await setEventsDown(false);
  await expect(page.getByText("Reconnecting…", { exact: true })).toHaveCount(0, { timeout: 10_000 });
});

test("workflow cost limit accepts 0 as no limit and rejects invalid input", async ({ page }) => {
  const state = snapshot();
  await mockBackend(page, state);
  await page.getByRole("complementary", { name: "Sidebar" }).getByRole("button", { name: "Bot library", exact: true }).click();
  await page.getByRole("button", { name: "Team Rules & Trust", exact: true }).click();
  const limit = page.getByRole("spinbutton", { name: "Workflow cost limit" });
  await expect(limit).toHaveValue("3.75");
  await limit.fill("-1");
  await expect(limit).toHaveAttribute("aria-invalid", "true");
  await limit.press("Enter");
  await expect(limit).toHaveValue("3.75");
  expect(state.preferences.workflowBudgetUsd).toBe(3.75);
  await limit.fill("0");
  await limit.press("Enter");
  await expect.poll(() => state.preferences.workflowBudgetUsd).toBe(0);
  await page.getByRole("button", { name: "No limit", exact: true }).click();
  await expect.poll(() => state.preferences.maxTurnBudgetUsd).toBe(0);
  await expect(page.getByRole("button", { name: "No limit", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("chat drafts and their selected skill survive navigation and reload", async ({ page }) => {
  const state = snapshot();
  state.skills = [{ id: "review", name: "Fixture skill", slug: "fixture-skill", description: "Review locally", path: "/tmp/fixture/SKILL.md", source: "fixture" }];
  state.chats.push({ ...state.chats[0], id: "other", title: "Other chat", isPrimary: false });
  await mockBackend(page, state);
  const composer = page.getByPlaceholder(/^Message /);
  await composer.fill("/fixture-skill");
  await page.getByRole("button", { name: /Fixture skill.*fixture-skill/ }).click();
  await composer.fill("Draft for the first chat");
  await page.getByRole("button", { name: "Open Other chat", exact: true }).click();
  await expect(composer).toHaveValue("");
  await composer.fill("Draft for the other chat");
  await page.reload();
  await expect(composer).toHaveValue("Draft for the first chat");
  await expect(page.getByRole("main").getByText("/fixture-skill", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open Other chat", exact: true }).click();
  await expect(composer).toHaveValue("Draft for the other chat");
});

test("a delayed failed send preserves a newer draft and a successful send clears only submitted text", async ({ page }) => {
  const state = snapshot();
  const sends = await mockBackend(page, state);
  let finishSend!: () => void;
  const gate = new Promise<void>(resolve => { finishSend = resolve; });
  let received = false;
  const reject = async (route: import("@playwright/test").Route) => {
    received = true;
    await gate;
    await route.fulfill({ status: 400, body: "Delayed rejection" });
  };
  await page.route("**/api/chat/send", reject);
  const composer = page.getByPlaceholder(/^Message /);
  await composer.fill("Original request");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => received).toBe(true);
  await composer.fill("Newer draft");
  finishSend();
  await expect(page.getByRole("alert")).toHaveText("Delayed rejection");
  await expect(composer).toHaveValue("Newer draft");
  await page.reload();
  await expect(composer).toHaveValue("Newer draft");
  await page.unroute("**/api/chat/send", reject);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => sends.length).toBe(1);
  await expect(composer).toHaveValue("");
  await page.reload();
  await expect(composer).toHaveValue("");
});

test("draft storage failures warn the user while preserving drafts across navigation", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("omnibot.chat-drafts.v1:")) throw new DOMException("Storage full", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  const state = snapshot();
  state.chats.push({ ...state.chats[0], id: "other", title: "Other chat", isPrimary: false });
  await mockBackend(page, state);
  await page.getByPlaceholder(/^Message /).fill("Keep this draft in memory");
  await expect(page.getByRole("alert")).toContainText("Draft changes could not be saved");
  await page.getByRole("button", { name: "Open Other chat", exact: true }).click();
  await page.getByRole("button", { name: "Open Test Bot", exact: true }).click();
  await expect(page.getByPlaceholder(/^Message /)).toHaveValue("Keep this draft in memory");
});

for (const effort of ["xhigh", "future-effort"]) {
  test(`sending inherits saved ${effort} effort until explicitly overridden`, async ({ page }) => {
    const state = snapshot();
    state.bots[0].reasoningEffort = effort;
    state.bots[0].cliDriver = "codex";
    state.harnesses = [{ id: "codex", kind: "codex", name: "Codex", binaryName: "codex", installed: true, models: [], supportsEffort: true, description: "", installHint: "", authHint: "", supportsJsonStream: true, supportsSessionResume: true }];
    await mockBackend(page, state);
    const sends: Record<string, unknown>[] = [];
    await page.route("**/api/chat/send", route => { sends.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true, messageId: "sent" } }); });
    const composer = page.getByPlaceholder(/^Message /);
    await composer.fill("Use the saved effort");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => sends.length).toBe(1);
    expect(sends[0].overrideEffort).toBeUndefined();
    await page.getByRole("button", { name: "Switch target Bot, CLI model, or parallel group mode" }).click();
    await expect(page.getByRole("button", { name: `Bot default (${effort})`, exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "low", exact: true }).click();
    await page.getByRole("main").click({ position: { x: 400, y: 150 } });
    await expect(page.getByRole("button", { name: "low", exact: true })).toBeHidden();
    await composer.fill("Use low this time");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => sends.length).toBe(2);
    expect(sends[1].overrideEffort).toBe("low");
  });
}

for (const source of ["library", "search"]) {
  test(`launching a skill from ${source} applies it to the next message`, async ({ page }) => {
    const state = snapshot();
    state.skills = [{ id: "review", name: "Fixture skill", slug: "fixture-skill", description: "Review locally", path: "/tmp/fixture/SKILL.md", source: "fixture" }];
    const sends = await mockBackend(page, state);
    await page.route("**/api/chat/create", async route => {
      const input = route.request().postDataJSON();
      const chat = { ...state.chats[0], id: "skill-chat", title: input.title, isPrimary: false };
      state.chats.push(chat);
      await route.fulfill({ json: { chat, snapshot: state } });
    });
    if (source === "library") {
      await page.getByRole("button", { name: "Bot library", exact: true }).click();
      await page.getByRole("button", { name: /^Agent Skills/ }).click();
      await page.getByRole("button", { name: "Launch", exact: true }).click();
    } else {
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByRole("combobox", { name: "Search", exact: true }).fill("Fixture skill");
      await page.getByRole("option", { name: /Fixture skill/ }).click();
    }
    await expect(page.getByRole("main").getByText("/fixture-skill", { exact: true })).toBeVisible();
    await page.getByPlaceholder(/^Message /).fill("Review this");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => sends.length).toBe(1);
    expect(sends[0]).toMatchObject({ chatId: "skill-chat", skillSlug: "fixture-skill", text: "Review this" });
  });
}

test("diff responses stay with the selected file, chat, and worktree", async ({ page }) => {
  const state = snapshot();
  state.gitStatus = { ...state.gitStatus, isRepo: true, branch: "main", changedFiles: ["first.txt", "second.txt"].map(path => ({ path, status: "modified", staged: false })) };
  state.chats[0].tasks = [{ id: "worktree", workflowId: "workflow", botId: "bot-a", instructions: "Review", mode: "sequential", status: "complete", workspacePath: "/tmp/worktree" }];
  state.chats.push({ ...state.chats[0], id: "other", title: "Other chat", isPrimary: false, workspacePath: "/tmp/other" });
  await mockBackend(page, state);
  let finishFirst!: () => void;
  const gate = new Promise<void>(resolve => { finishFirst = resolve; });
  let firstRequested = false;
  await page.route("**/api/git/diff?**", async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") === "first.txt") { firstRequested = true; await gate; return route.fulfill({ json: { diff: "STALE FIRST DIFF" } }); }
    await route.fulfill({ json: { diff: "CURRENT SECOND DIFF" } });
  });
  await page.keyboard.press("ControlOrMeta+i");
  await page.getByRole("button", { name: /^Project & Git/ }).click();
  await page.getByRole("button", { name: "first.txt", exact: true }).click();
  await expect.poll(() => firstRequested).toBe(true);
  await page.getByRole("button", { name: "second.txt", exact: true }).click();
  await expect(page.getByText("CURRENT SECOND DIFF", { exact: true })).toBeVisible();
  const firstResponse = page.waitForResponse(response => response.url().includes("/api/git/diff?") && new URL(response.url()).searchParams.get("path") === "first.txt");
  finishFirst();
  await firstResponse;
  await expect(page.getByText("STALE FIRST DIFF", { exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Git working folder" }).selectOption("worktree");
  await expect(page.getByText("CURRENT SECOND DIFF", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "second.txt", exact: true }).click();
  await expect(page.getByText("CURRENT SECOND DIFF", { exact: true })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+b");
  await page.getByRole("button", { name: "Open Other chat", exact: true }).click();
  await page.getByRole("button", { name: /^Project & Git/ }).click();
  await expect(page.getByText("CURRENT SECOND DIFF", { exact: true })).toHaveCount(0);
});

test("a delayed avatar decode cannot change a different bot editor", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      await original.call(this);
      await new Promise<void>(resolve => { (window as unknown as { finishAvatar: () => void }).finishAvatar = resolve; });
    };
  });
  const state = snapshot();
  state.bots.push({ ...state.bots[0], id: "other-bot", name: "Other Bot", isPrimary: false });
  await mockBackend(page, state);
  await page.getByRole("button", { name: "Bot library", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page.getByRole("group", { name: "Profile picture", exact: true }).filter({ visible: true }).getByLabel("Upload profile picture", { exact: true }).setInputFiles("public/omnibot-gauntlet.png");
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { finishAvatar?: () => void }).finishAvatar)).toBe("function");
  await page.getByRole("button", { name: "Edit", exact: true }).nth(1).click();
  await expect(page.getByPlaceholder("Bot Name (e.g. Architect, Reviewer, Sentinel)")).toHaveValue("Other Bot");
  await page.evaluate(() => (window as unknown as { finishAvatar: () => void }).finishAvatar());
  await page.getByRole("button", { name: "Save Bot", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save Bot", exact: true })).toBeHidden();
  expect(state.bots[1].avatarImage).toBeNull();
});

test("a previous bot save cannot close a newly opened editor", async ({ page }) => {
  const state = snapshot();
  state.bots.push({ ...state.bots[0], id: "other-bot", name: "Other Bot", isPrimary: false });
  await mockBackend(page, state);
  let finishSave!: () => void;
  const gate = new Promise<void>(resolve => { finishSave = resolve; });
  let requested = false;
  await page.route("**/api/bot/upsert", async route => {
    const bot = route.request().postDataJSON();
    requested = true;
    await gate;
    Object.assign(state.bots[0], bot);
    await route.fulfill({ json: state });
  });
  await page.getByRole("button", { name: "Bot library", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page.getByRole("button", { name: "Save Bot", exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  await page.getByRole("button", { name: "Edit", exact: true }).nth(1).click();
  const saved = page.waitForResponse("**/api/bot/upsert");
  finishSave();
  await saved;
  await expect(page.getByPlaceholder("Bot Name (e.g. Architect, Reviewer, Sentinel)")).toHaveValue("Other Bot");
  await expect(page.getByRole("button", { name: "Save Bot", exact: true })).toBeVisible();
});

test("an inspector avatar upload locks profile edits and keeps refreshed profile fields", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      await original.call(this);
      await new Promise<void>(resolve => { (window as unknown as { finishAvatar: () => void }).finishAvatar = resolve; });
    };
  });
  const state = snapshot();
  await mockBackend(page, state);
  await page.keyboard.press("ControlOrMeta+i");
  await page.getByRole("button", { name: "Edit Bot", exact: true }).click();
  await page.getByRole("group", { name: "Profile picture", exact: true }).filter({ visible: true }).getByLabel("Upload profile picture", { exact: true }).setInputFiles("public/omnibot-gauntlet.png");
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { finishAvatar?: () => void }).finishAvatar)).toBe("function");
  await expect(page.getByRole("textbox", { name: "Bot name", exact: true })).toBeDisabled();
  state.bots[0].name = "Updated name";
  await page.evaluate(() => (window as unknown as { __fixtureEvents: FixtureEventsControl }).__fixtureEvents.emit());
  await expect(page.getByText("Updated name · Character & CLI", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { finishAvatar: () => void }).finishAvatar());
  await expect.poll(() => state.bots[0].avatarImage).toMatch(/^data:image\/png;base64,/);
  expect(state.bots[0].name).toBe("Updated name");
});

test("drafts stay isolated between backend profiles with identical chat IDs", async ({ page }) => {
  const state = snapshot();
  await mockBackend(page, state);
  const composer = page.getByPlaceholder(/^Message /);
  await composer.fill("First profile private draft");
  state.profileId = "second-profile";
  await page.reload();
  await expect(composer).toHaveValue("");
  await composer.fill("Second profile draft");
  state.profileId = "fixture-profile";
  await page.reload();
  await expect(composer).toHaveValue("First profile private draft");
});

test("failed draft writes prevent unload until a later write succeeds", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    (window as unknown as { failDraftWrites: boolean }).failDraftWrites = true;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("omnibot.chat-drafts.v1:") && (window as unknown as { failDraftWrites: boolean }).failDraftWrites) throw new DOMException("Storage full", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await mockBackend(page, snapshot());
  const composer = page.getByPlaceholder(/^Message /);
  await composer.fill("Unsaved text");
  await expect(page.getByRole("alert")).toContainText("Draft changes could not be saved");
  const unloadPrevented = () => page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(await unloadPrevented()).toBe(true);
  await page.evaluate(() => { (window as unknown as { failDraftWrites: boolean }).failDraftWrites = false; });
  await composer.fill("Saved text");
  await expect.poll(unloadPrevented).toBe(false);
  await page.reload();
  await expect(composer).toHaveValue("Saved text");
});

test("long history remains responsive during concurrent bot event bursts", async ({ page }) => {
  const state = snapshot();
  state.bots.push(...["b", "c"].map(id => ({ ...state.bots[0], id: `bot-${id}`, name: `Bot ${id}`, isPrimary: false })));
  state.chats[0].isGroup = true;
  state.chats[0].participantBotIds = state.bots.map(bot => bot.id);
  state.chats[0].messages = Array.from({ length: 3000 }, (_, index) => ({ ...message(`History entry ${index + 1}: ${"A completed review result. ".repeat(20)}`), id: `history-${index}` }));
  const replies: ChatMessage[] = state.bots.map(bot => ({ ...message(`Concurrent reply from ${bot.name}`), id: `live-${bot.id}`, authorBotId: bot.id, authorName: bot.name, status: "streaming" as const }));
  state.chats[0].messages.push(...replies);
  state.activeWorkflowChatIds = ["room"];
  await mockBackend(page, state);
  const composer = page.getByPlaceholder(/^Message /);
  await expect(composer).toBeVisible();
  let snapshotRequests = 0;
  await page.route("**/api/snapshot", route => { snapshotRequests++; return route.fulfill({ json: state }); });
  await page.evaluate(() => {
    const win = window as unknown as { __fixtureEvents: FixtureEventsControl; stressFrames: number[]; stopStress: () => void };
    win.stressFrames = [];
    let previous = performance.now();
    let frame = 0;
    const sample = (now: number) => { win.stressFrames.push(now - previous); previous = now; frame = requestAnimationFrame(sample); };
    frame = requestAnimationFrame(sample);
    const burst = setInterval(() => { for (let i = 0; i < 50; i++) win.__fixtureEvents.emit(); }, 20);
    win.stopStress = () => { clearInterval(burst); cancelAnimationFrame(frame); };
  });
  const typingStart = Date.now();
  await composer.pressSequentially("Draft stays responsive while three bots stream", { delay: 15 });
  const typingMs = Date.now() - typingStart;
  await expect(composer).toHaveValue("Draft stays responsive while three bots stream");
  for (const reply of replies) { reply.text += " — final result"; reply.status = "complete"; }
  state.activeWorkflowChatIds = [];
  state.revision++;
  await page.evaluate(() => (window as unknown as { __fixtureEvents: FixtureEventsControl }).__fixtureEvents.emit());
  await expect(page.getByText("Concurrent reply from Bot c — final result", { exact: true })).toBeVisible();
  const frameGaps = await page.evaluate(() => { const win = window as unknown as { stopStress: () => void; stressFrames: number[] }; win.stopStress(); return win.stressFrames; });
  const maxFrameGapMs = Math.max(...frameGaps);
  const renderedHistoryMessages = await page.locator("p").filter({ hasText: /^History entry / }).count();
  const measurements = { historyMessages: 3000, concurrentBots: 3, eventsPerSecond: 2500, typingMs, maxFrameGapMs, snapshotRequests, renderedHistoryMessages };
  await test.info().attach("responsiveness.json", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
  console.log("Responsiveness fixture:", measurements);
  expect(typingMs).toBeLessThan(5000);
  expect(maxFrameGapMs).toBeLessThan(1000);
  expect(snapshotRequests).toBeLessThan(15);
  expect(renderedHistoryMessages).toBeLessThanOrEqual(200);
});

test("custom model entry does not carry into another bot editor", async ({ page }) => {
  const state = snapshot();
  state.bots.push({ ...state.bots[0], id: "other-bot", name: "Other Bot", isPrimary: false });
  await mockBackend(page, state);
  await page.getByRole("button", { name: "Bot library", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page.getByRole("combobox", { name: "Default model", exact: true }).selectOption("__custom__");
  await page.getByRole("textbox", { name: "Default model custom ID", exact: true }).fill("first-bot-only");
  await page.getByRole("button", { name: "Edit", exact: true }).nth(1).click();
  await expect(page.getByPlaceholder("Bot Name (e.g. Architect, Reviewer, Sentinel)")).toHaveValue("Other Bot");
  await expect(page.getByRole("textbox", { name: "Default model custom ID", exact: true })).toBeHidden();
  await expect(page.getByRole("combobox", { name: "Default model", exact: true })).toHaveValue("");
});

test("unreadable saved drafts are retained and prevent unloading new unsaved work", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("omnibot.chat-drafts.v1:fixture-profile", "unreadable saved data"));
  await mockBackend(page, snapshot());
  await expect(page.getByRole("alert")).toContainText("Saved drafts could not be loaded");
  await page.getByPlaceholder(/^Message /).fill("New work kept in memory");
  expect(await page.evaluate(() => localStorage.getItem("omnibot.chat-drafts.v1:fixture-profile"))).toBe("unreadable saved data");
  expect(await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);
});


test("sidebar menus restore focus to their trigger when pointer clicks do not focus buttons", async ({ page }) => {
  const state = snapshot();
  state.bots.push({ ...state.bots[0], id: "helper", name: "Helper", isPrimary: false });
  state.preferences.pinnedBotIds = ["helper"];
  await mockBackend(page, state);
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const trigger = sidebar.getByTitle("Options for Helper");
  await page.getByPlaceholder(/^Message /).focus();
  // Safari leaves focus on the previous element when a pointer opens a button menu.
  await trigger.evaluate(button => button.addEventListener("mousedown", event => event.preventDefault()));
  await trigger.click();
  await expect(sidebar.getByRole("menuitem", { name: "Rename", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  const row = sidebar.getByRole("button", { name: "Open Helper", exact: true });
  await row.click({ button: "right" });
  await expect(sidebar.getByRole("menuitem", { name: "Rename", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(row).toBeFocused();
});
