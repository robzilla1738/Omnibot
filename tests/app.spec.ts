import { expect, test, type Page } from "@playwright/test";
import type { OmniSnapshot, ChatMessage } from "../src/lib/types";

function snapshot(): OmniSnapshot {
  return {
    serverPort: 4321, serverBaseUrl: "http://127.0.0.1:4321",
    preferences: { onboardingCompleted: true, pinnedBotIds: [], workspaceRoot: "/tmp/test-project", defaultMaxSwarmTurns: 4, approveAllTools: false, globalInstructions: "", sharedMemories: [] },
    bots: [{ id: "bot-a", name: "Test Bot", slug: "test-bot", roleTitle: "Tester", description: "Local fixture", shape: "blob", color: "cyan", isPrimary: true, cliDriver: "custom", model: null, reasoningEffort: "low", permissionMode: "plan", systemPrompt: "", memories: [], autoCreatedForCli: false }],
    chats: [{ id: "room", title: "Test Room", subtitle: "Local fixture", isPrimary: true, isGroup: false, participantBotIds: ["bot-a"], workspacePath: "/tmp/test-project", useWorktrees: false, maxSwarmTurns: 4, messages: [], nativeSessions: {}, updatedAtMs: 0 }],
    workspaces: [], routines: [], skills: [], harnesses: [], mcpServers: [], computerActivity: [], activeRuns: [], activeWorkflowChatIds: [],
    gitStatus: { isRepo: false, rootPath: "/tmp/test-project", branch: "", headShort: "", ahead: 0, behind: 0, changedFiles: [], diffStat: "", diffPreview: "", worktrees: [] },
  };
}

async function mockBackend(page: Page, state: OmniSnapshot, sendStatus = 200) {
  const sends: unknown[] = [];
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/snapshot") return route.fulfill({ json: state });
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
    if (path === "/api/chat/send") {
      sends.push(route.request().postDataJSON());
      if (sendStatus !== 200) return route.fulfill({ status: sendStatus, body: "Chat is still stopping" });
      state.activeWorkflowChatIds = ["room"];
      return route.fulfill({ json: { ok: true, messageId: "user1" } });
    }
    return route.fulfill({ status: 400, body: "Unexpected fixture request" });
  });
  await page.goto("/");
  if (state.preferences.onboardingCompleted) await expect(page.getByRole("button", { name: state.activeWorkflowChatIds?.length || state.activeRuns.length ? "Stop response" : "Send message", exact: true })).toBeVisible();
  else await expect(page.getByRole("button", { name: "Find my tools" })).toBeVisible();
  return sends;
}

function message(text: string): ChatMessage {
  return { id: "assistant1", role: "assistant", authorBotId: "bot-a", authorName: "Test Bot", text, thinking: "", toolCalls: [], handoffs: [], mentionedBotIds: [], status: "complete", createdAtMs: 0 };
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
  await page.keyboard.press("Control+i");
  await expect(page.getByTitle("Click to open Bot Settings, Group members, Project & Git (Cmd+I)")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Control+n");
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
  await page.keyboard.press("Control+n");
  await expect(page.getByRole("button", { name: "Individual bot", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Select Test Bot", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Select Teammate", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("combobox", { name: "Test Bot model", exact: true }).selectOption("fixture-small");
  await page.getByRole("button", { name: "Start chat", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New chat", exact: true })).toHaveCount(0);
  expect(state.bots[0].model).toBe("fixture-small");
  expect(created).toMatchObject({ participantBotIds: ["bot-a"], useWorktrees: false });
  expect(sends).toHaveLength(0);
});

test("group chats require explicit participants and preserve selection on create failure", async ({ page }) => {
  const state = snapshot();
  state.bots.push({ ...state.bots[0], id: "bot-b", name: "Teammate", isPrimary: false });
  const sends = await mockBackend(page, state);
  await page.route("**/api/chat/create", route => route.fulfill({ status: 400, body: "Unable to create chat" }));
  await page.keyboard.press("Control+n");
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
  await expect(page.getByRole("heading", { name: "Meet your local tools." })).toBeVisible({ timeout: 1500 });
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
  const badge = page.locator(".provider-hover-badge");
  await page.mouse.move(0, 0);
  await expect(badge).toHaveCSS("opacity", "0");
  await author.hover();
  await expect(badge).toHaveCSS("opacity", "1");
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
  await page.keyboard.press("Control+i");
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
  await sidebar.getByRole("button", { name: "Rename", exact: true }).click();
  await sidebar.getByRole("textbox", { name: "Rename Codex" }).fill("Builder");
  await sidebar.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "Open Builder", exact: true })).toBeVisible();
  await sidebar.getByTitle("Options for Homepage").click();
  await sidebar.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "Open Homepage", exact: true })).toHaveCount(0);
  expect(state.chats.some(c => c.id === "work")).toBe(true);
  await sidebar.click({ button: "right", position: { x: 8, y: 240 } });
  await sidebar.getByRole("button", { name: "Reset view & restore hidden items" }).click();
  await sidebar.getByTitle("Close sidebar settings").click();
  await page.screenshot({ path: "test-results/sidebar-clean.png" });
  await sidebar.click({ button: "right", position: { x: 8, y: 240 } });
  await page.screenshot({ path: "test-results/sidebar-settings.png" });
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
  expect(requests).toEqual([expect.objectContaining({ botHome: true, participantBotIds: ["helper"] })]);
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
  const menu = sidebar.getByRole("dialog", { name: "Options for Helper" });
  await expect(menu.getByRole("button", { name: "Rename", exact: true })).toBeVisible();
  await expect(menu.locator(".lucide-arrow-up, .lucide-arrow-down")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(sidebar.locator("[data-sidebar-section]").first()).toHaveAttribute("data-sidebar-section", "projects");
  await page.screenshot({ path: "test-results/sidebar-restored.png" });
});

test("app updates explain availability in the browser without offering an unusable check", async ({ page }) => {
  await mockBackend(page, snapshot());
  await page.getByRole("complementary", { name: "Sidebar" }).getByRole("button", { name: "Bot library", exact: true }).click();
  await page.getByRole("button", { name: "App updates", exact: true }).click();
  await expect(page.getByText("Update checks are available in the installed macOS app.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Check for updates", exact: true })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Automatically check for updates" })).toHaveCount(0);
});
