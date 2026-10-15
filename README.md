# Omnibot

A local macOS app for working with AI bots, projects, and group chats through your installed coding CLIs. Built with Tauri, Rust, React, and TypeScript.

[Download for macOS](https://github.com/robzilla1738/Omnibot/releases/latest) · [Changelog](CHANGELOG.md) · [Getting started](#getting-started) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)

## What you can do

- **Make your bots your own.** Choose names, profile pictures, roles, providers, and models. The main bot starts with the gauntlet avatar.
- **Keep bots, projects, and tasks separate.** Bots have ongoing conversations and personal memory. Projects provide workspace context. Chats are separate tasks, optionally linked to a project.
- **Choose your tools.** Discover installed CLIs, add individual bots, and select models from each supported CLI's available catalog. Custom model IDs and CLI defaults remain available.
- **Work together when you want.** Start a group chat, mention teammates, run sequential or parallel work, and use explicit handoffs. Optional Git worktrees isolate edits by bot.
- **Stay in control.** Stream replies and tool activity, stop running work, inspect Git changes, edit memories, and schedule routines while the app is open. Quitting Omnibot stops running bots.
- **Organize your sidebar.** Filter by Bots, Projects, or Chats; drag to reorder; collapse sections; rename or delete items using their context menus. Destructive actions ask for confirmation.

Omnibot stores its own conversations, preferences, and memories locally. When you send a message, the selected CLI uses its configured provider, authentication, permissions, and billing. Omnibot is an independent project and is not affiliated with the providers it integrates.

## Getting started

Download the signed, Apple-notarized universal app from [GitHub Releases](https://github.com/robzilla1738/Omnibot/releases/latest). Open the DMG, drag **Omnibot** to **Applications**, and launch it. The same download contains Apple Silicon and Intel binaries. See the [support matrix](docs/support-matrix.md) for tested platforms and limitations.

Existing users can use **Omnibot → Check for Updates…**. Finish running tasks before updating, and back up `~/.omni-bot/` when it contains important work. Keep the existing data directory; the update preserves the app identity and update key. See [backup and recovery](docs/recovery.md) before downgrading.

Omnibot is early-stage software. macOS is the supported platform; other platforms have not been validated.

### Build from source

For development, install:

- macOS with Xcode Command Line Tools (`xcode-select --install`).
- Node.js 22 or newer and pnpm 11.12.0 (the version pinned in `package.json`).
- A stable Rust toolchain with Cargo on your `PATH`.
- At least one supported CLI installed and authenticated when you want to run a bot. Setup and the automated tests do not require provider accounts.

```bash
git clone https://github.com/robzilla1738/Omnibot.git
cd Omnibot
pnpm install --frozen-lockfile
pnpm tauri:dev
```

In setup, customize your main bot, find installed tools, select bots to add to the sidebar, and review permissions. Adding a project is optional. Standard CLI permissions are the default. Discovery checks installation and model metadata; it does not prove that your provider account can complete a request.

Click **Bots** at the bottom of the sidebar to open the Bot library and add or pin bots later. Click a bot's name or avatar to edit its settings. Archive bots to preserve their history and memory; restore them from Bot library. Right-click empty sidebar space for view options. The settings button reopens setup.

### CLI support

Execution adapters are implemented for Claude Code, Codex, OpenCode, Cursor Agent, Grok Build, Pi, Muse (`muse exec`), Gemini CLI, Aider, and Ollama, plus custom commands. Antigravity and ACP adapters are experimental: they pass one prompt and show plain-text output. Streaming, model discovery, session resume, and usage reporting depend on each CLI's protocol. Unsupported metadata is shown as unavailable rather than guessed.

- Built-in structured adapters pass prompts on stdin or after `--`. Experimental ACP and custom commands receive one combined context-and-prompt argument; their command must accept that interface. Custom commands are trusted local code.
- When opened from Finder, Omnibot loads the `PATH` and variables exported by your login shell, so CLIs installed with Homebrew, npm, nvm, mise, and similar tools are found with their API keys.
- Ollama uses only models already installed (`ollama list`); it never downloads one. Aider runs with `--no-auto-commits` so you review and commit changes yourself.
- **Approve all tools** applies only to CLIs with an equivalent option; others run with their default permissions and the activity log says so.

Install and sign in to each CLI using its own documentation. Check **Bot library → Local tools** for local diagnostics. See [lifecycle and coordination changes](docs/bot-lifecycle-implementation.md) and [implementation notes and limitations](docs/local-review.md) for verified behavior; live inference has not been tested against every CLI/version combination.

## Bots, projects, and memory

Each bot has its own local home folder and personal notes. Project notes are included only in conversations attached to that project, and shared preferences are explicitly shared. Use **Memory** to inspect, edit, or forget notes. Memories are not automatically learned; exported `memory.md` files are readable copies of the app's stored notes.

A bot can carry out an explicit request involving a named folder within its CLI permissions. Its home folder is not an operating-system sandbox. A project is useful when you want a conversation to keep a workspace and Git context.

Newly discovered bots inherit their CLI’s configured model by default; discovery never selects the first catalog model or overwrites a saved choice. Chat creation saves model choices for that chat. Bot settings change global defaults, and composer selections override only the current request. Personal conversations keep a stable owner when helpers join.

`@all` and `/race` address current room participants. `/group` runs them sequentially; `/team` explicitly selects the bots assigned to a project. The composer previews recipients only when they differ from the single bot already shown in the chat header, or when multiple bots participate. **Bot library → Team Rules & Trust → Summarize team results** saves whether the first speaker adds a final summary turn. Bots sharing a checkout queue; use worktrees for parallel editing.

Repository-dependent starter actions select a project before running. In personal space, `/review` and recognized Git-review requests open the existing project picker, carrying the prompt and selected team into a new project conversation. The prompt remains in the composer for review before sending; the original personal conversation stays separate. General questions about Git do not require a project.

For deliberate delegation to a room participant or assigned project teammate, a bot can emit a complete handoff block:

```xml
<handoff to="Codex" mode="sequential">Review the changes in the named worktree and report regressions.</handoff>
```

Each reply can start at most 4 handoffs and each workflow at most 24 bot turns; skipped handoffs are explained in the chat.

Git worktrees start from committed HEAD, do not include uncommitted changes automatically, and are not merged automatically. Review their changes before merging. Deleting a chat removes its clean worktrees and merged `omni/` branches; anything with uncommitted or unmerged work is kept and listed in the Inspector activity.

## Routines and usage

Routines support manual, daily, weekday, and weekly schedules with a selected bot and model. Scheduled runs use local time while Omnibot is open. A run delayed by sleep or a busy chat still starts within 60 minutes (the routine shows waiting, then skipped if the window closes); runs missed while Omnibot was closed are not replayed. A routine created after today's time first runs at the next scheduled time. Older cron entries remain manual until configured through the schedule picker.

Token counts and cost come from CLI reports. Missing metrics remain unavailable, and reported cost may differ from your provider invoice. Dollar guardrails depend on when a CLI reports cost; they are not provider-side spending caps. A budget of 0 means no limit. When a CLI reports cost only with its final answer (as Claude Code does), Omnibot keeps the answer and adds a notice instead of stopping the turn. Duration is measured locally.

The turn timeout measures time without any output, so long runs that keep working are not cut off; every turn still stops after six times the timeout (at most three hours).

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Cmd+K` | Search bots, chats, projects, and skills |
| `Cmd+N` | New chat |
| `Cmd+I` | Toggle the Inspector |
| `Cmd+B` | Collapse or expand the sidebar |
| `Option+↑` / `Option+↓` | Reorder a focused sidebar row |
| `@` in the composer | Mention a bot or `@all` |
| `/` in the composer | Chat commands and local skills |

## Build and verify

```bash
pnpm build
pnpm setup:sparkle
pnpm test:rust
pnpm check:rust
pnpm exec playwright install chromium webkit
pnpm test
PLAYWRIGHT_BROWSER=webkit pnpm test
pnpm tauri:build
```

The native development build produces `Omnibot.app` and a `.dmg` under `src-tauri/target/release/bundle/` using ad-hoc signing. Public release builds use Developer ID signing, Apple notarization, and Sparkle updates. Download a signed universal build from [Releases](https://github.com/robzilla1738/Omnibot/releases). CI checks frontend compilation, Rust tests and Clippy, browser tests, and native app packaging. See [release instructions](docs/releasing.md) for the verified signing and publication process.

Tests use temporary repositories, fake CLI processes, and mocked API responses. They do not load your conversations or call model providers. Browser tests start Vite automatically; use `PLAYWRIGHT_PORT=1423 pnpm test` when the default development port is occupied; set `PLAYWRIGHT_CHANNEL=chrome` to use an installed Google Chrome instead of Playwright Chromium.

## Local data and compatibility

State lives in `~/.omni-bot/`; `OMNI_BOT_HOME` selects another data directory. Back up this folder before testing changes with important conversations. Keep one app instance per data directory.

The local API listens on loopback, normally `127.0.0.1:4321`; the development UI uses `localhost:1420`. Requests need the current startup's token in `~/.omni-bot/api-token` (sent as `Authorization: Bearer <token>`); the native app passes it to its own window automatically. For browser-only development, start the backend and Vite, then run `pnpm dev:connect` to open an authenticated browser session; rerun it after a full page reload. It is intended for your own machine, not remote hosting. See [the security policy](SECURITY.md) for the trust boundaries.

State changes use an explicit schema version. Before migrating an older layout/schema, Omnibot preserves a separate `store.pre-migration-*.json` copy. Missing or damaged state can recover from a valid `store.json.bak`; damaged bytes are preserved separately. Newer unsupported schemas fail startup without being overwritten. Older binaries may lack this protection: use the [backup and recovery procedure](docs/recovery.md) before downgrading or testing important data.

The application, Dock entry, executable, window, and bundle are named **Omnibot**. The original data directory, environment variable, and bundle identifier (`com.robzilla1738.botfinity`) are retained for compatibility. Legacy avatar paths and sidebar preferences migrate automatically. Your custom bot names are independent of the application name.

## Embedded terminal

Use the circular **Terminal** button beside Settings in the expanded sidebar (⌘`) to enter the interactive Claude Code or custom-command session directly. Existing sessions are reused; active chat automation is stopped before starting a new interactive session. Resize or expand the panel, search its output, and switch to **Run logs** for automated process output. Hiding the panel keeps the process running; **End control** stops it. See [terminal behavior and testing](docs/embedded-terminal.md).

## Interface and provider settings

Dropdowns use native platform menus and keyboard controls. Token usage, reported cost, duration, and the model badge sit beside the bot name and appear on card hover or keyboard focus (always available on touch devices). The chat area has no activity-history panel. The jump-to-latest control stays above the measured composer height, including terminal notices.

Cursor workspace trust is separate from tool approval. **Bot library → Team Rules & Trust → Trust bot homes in Cursor** permits Cursor to trust only Omnibot-managed bot home folders; project folders still need their own approval. This preference defaults off for new profiles. Provider errors are presented without duplicate JSON envelopes, while raw diagnostics remain in terminal run logs.

See the [implementation notes](docs/bot-lifecycle-implementation.md) and [embedded terminal guide](docs/embedded-terminal.md) for behavior, testing, and limitations.

The [support and verification matrix](docs/support-matrix.md) distinguishes implemented adapters from live-provider and native-platform validation. A passing fixture suite does not certify every CLI version or provider account.

## Contributing and license

Bug reports and focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes and [SECURITY.md](SECURITY.md) before reporting a vulnerability.

Omnibot's code is available under the [MIT license](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for borrowed code, icon attribution, and provider trademarks.
