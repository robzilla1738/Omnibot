# Omnibot

A local macOS app for working with AI bots, projects, and group chats through your installed coding CLIs. Built with Tauri, Rust, React, and TypeScript.

[Getting started](#getting-started) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)

## What you can do

- **Make your bots your own.** Choose names, profile pictures, roles, providers, and models. The main bot starts with the gauntlet avatar.
- **Keep bots, projects, and tasks separate.** Bots have ongoing conversations and personal memory. Projects provide workspace context. Chats are separate tasks, optionally linked to a project.
- **Choose your tools.** Discover installed CLIs, add individual bots, and select models from each supported CLI's available catalog. Custom model IDs and CLI defaults remain available.
- **Work together when you want.** Start a group chat, mention teammates, run sequential or parallel work, and use explicit handoffs. Optional Git worktrees isolate edits by bot.
- **Stay in control.** Stream replies and tool activity, stop running work, inspect Git changes, edit memories, and schedule routines while the app is open.
- **Organize your sidebar.** Filter by Bots, Projects, or Chats; drag to reorder; collapse sections; rename or remove items using their context menus.

Omnibot stores its own conversations, preferences, and memories locally. When you send a message, the selected CLI uses its configured provider, authentication, permissions, and billing. Omnibot is an independent project and is not affiliated with the providers it integrates.

## Getting started

Omnibot is early-stage software. macOS is the supported platform; other platforms have not been validated. Build from source using:

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

Open **Bot library** to add or pin bots later. Click a bot's name or avatar to edit its settings. Right-click empty sidebar space for view options. The settings button reopens setup.

### CLI support

Execution adapters are implemented for Claude Code, Codex, OpenCode, Cursor Agent, Grok Build, Pi, Muse, Gemini CLI, Aider, and Ollama, plus custom commands. Streaming, model discovery, session resume, and usage reporting depend on each CLI's protocol. Unsupported metadata is shown as unavailable rather than guessed. Ollama requires an explicit installed model.

Install and sign in to each CLI using its own documentation. Check **Bot library → Local tools** for local diagnostics. See [implementation notes and limitations](docs/local-review.md) for verified behavior; live inference has not been tested against every CLI/version combination.

## Bots, projects, and memory

Each bot has its own local home folder and personal notes. Project notes are included only in conversations attached to that project, and shared preferences are explicitly shared. Use **Memory** to inspect, edit, or forget notes. Memories are not automatically learned; exported `memory.md` files are readable copies of the app's stored notes.

A bot can carry out an explicit request involving a named folder within its CLI permissions. Its home folder is not an operating-system sandbox. A project is useful when you want a conversation to keep a workspace and Git context.

For deliberate delegation, a bot can emit a complete handoff block:

```xml
<handoff to="Codex" mode="sequential">Review the changes in the named worktree and report regressions.</handoff>
```

Git worktrees start from committed HEAD, do not include uncommitted changes automatically, and are not merged automatically. Review their changes before merging.

## Routines and usage

Routines support manual, daily, weekday, and weekly schedules with a selected bot and model. Scheduled runs use local time while Omnibot is open; missed runs are not replayed. Older cron entries remain manual until configured through the schedule picker.

Token counts and cost come from CLI reports. Missing metrics remain unavailable, and reported cost may differ from your provider invoice. Dollar guardrails depend on when a CLI reports cost; they are not provider-side spending caps. Duration is measured locally.

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
pnpm exec playwright install chromium
pnpm test
pnpm tauri:build
```

The native development build produces `Omnibot.app` and a `.dmg` under `src-tauri/target/release/bundle/` using ad-hoc signing. Public release builds use Developer ID signing, Apple notarization, and Sparkle updates. Download a signed universal build from [Releases](https://github.com/robzilla1738/Omnibot/releases). CI checks frontend compilation, Rust tests and Clippy, browser tests, and native app packaging. See [release instructions](docs/releasing.md) for the verified signing and publication process.

Tests use temporary repositories, fake CLI processes, and mocked API responses. They do not load your conversations or call model providers. Browser tests start Vite automatically; set `PLAYWRIGHT_CHANNEL=chrome` to use an installed Google Chrome instead of Playwright Chromium.

## Local data and compatibility

State lives in `~/.omni-bot/`; `OMNI_BOT_HOME` selects another data directory. Back up this folder before testing changes with important conversations. Keep one app instance per data directory.

The local API listens on loopback, normally `127.0.0.1:4321`; the development UI uses `localhost:1420`. It is intended for your own machine, not remote hosting. See [the security policy](SECURITY.md) for the trust boundaries.

The application, Dock entry, executable, window, and bundle are named **Omnibot**. The original data directory, environment variable, and bundle identifier (`com.robzilla1738.botfinity`) are retained for compatibility. Legacy avatar paths and sidebar preferences migrate automatically. Your custom bot names are independent of the application name.

## Contributing and license

Bug reports and focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes and [SECURITY.md](SECURITY.md) before reporting a vulnerability.

Omnibot's code is available under the [MIT license](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for borrowed code, icon attribution, and provider trademarks.
