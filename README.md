# Omni Bot

Local multi-agent coding swarm & **Grok Bot** alternative for macOS, built with **Tauri v2 (Rust)** + **React 19** + **Tailwind CSS v4**.

Omni Bot auto-detects the coding agent CLIs installed on your Mac (**Claude Code**, **OpenAI Codex**, **OpenCode**, **Cursor Agent**, **Grok Build**, **Pi**, **Gemini**, **Aider**, **Ollama**), turns each one into a persistent, customizable **Bot** with Grok Bot's 25 procedural character shapes and 11 color palettes, and lets your Bots collaborate, debate architecture, and hand off work to each other in **Swarm Rooms** or isolated **Git Worktrees**.

---

## Highlights

- **T3 Code-Style Local CLI Auto-Discovery (`src-tauri/src/scanner.rs`)**:
  - Automatically detects installed coding CLIs on your `PATH`, `/opt/homebrew/bin`, `~/.local/bin`, `~/.grok/bin`, and `~/.cargo/bin`.
  - Probes versions, discovers local `SKILL.md` skills across `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, and `~/.cursor/skills`, and discovers configured MCP servers (`~/.claude.json`, `~/.cursor/mcp.json`, `~/.config/opencode/opencode.json`).
- **Real-Time Streaming JSONL Drivers (`src-tauri/src/drivers.rs`)**:
  - Normalized non-interactive streaming execution for `claude`, `codex`, `opencode`, `agent` (Cursor), `grok`, and `pi` with live thinking blocks, tool execution timelines, and per-Bot native session resume (`--resume` / `--session`).
- **True Multi-Bot Swarm & `@Bot` Handoffs (`src-tauri/src/orchestrator.rs`)**:
  - **Primary `Omni` Coordinator** + auto-spawned CLI Bots + custom Role Bots (*Architect*, *Reviewer*, *Designer*, *Scout*).
  - Mention `@Claude`, `@Codex`, `@Grok`, `@OpenCode`, `@Cursor`, `@Pi`, or `@all` in any thread.
  - Bots can autonomously hand off work to teammates via `@BotName` mentions or `<handoff to="BotName" mode="sequential|parallel">` blocks, with configurable loop guards (`maxSwarmTurns`) and instant **Stop** controls.
- **Git Diffs & Isolated Worktree Arena (`src-tauri/src/git_ops.rs`)**:
  - Inspect live repository status and per-file unified diffs in the right-hand Inspector Drawer (`Cmd+I`).
  - Toggle **Isolate Bots in Git Worktrees** on any Swarm Room so parallel Bots work in `~/.omni-bot/worktrees/<chat>/<bot>` without stepping on each other.
- **100% Local Storage & Dual Runtime**:
  - All state (`store.json`, bots, threads, memories, routines, worktrees) lives locally in `~/.omni-bot/`.
  - Runs as a native macOS app (`Omni Bot.app`) **and** exposes a local HTTP + SSE server on `http://127.0.0.1:4321`.

---

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Cmd + K` | Spotlight Search across Bots, Swarm Rooms, Threads, and Local Skills |
| `Cmd + N` | Launch a new **Multi-Bot Swarm Room** or 1:1 Sidechat |
| `Cmd + I` | Toggle Right Inspector Drawer (`Details`, `Git & Diffs`, `Computer`) |
| `Cmd + B` | Collapse / Expand Left Bot Roster Sidebar |
| `@` in composer | Mention or hand off to `@all`, `@Omni`, `@Claude`, `@Codex`, `@Grok`, `@OpenCode`, `@Cursor`, `@Pi` |
| `/` in composer | Invoke Swarm commands (`/swarm`, `/race`, `/review`) or local `SKILL.md` skills |

---

## Local Development

```bash
pnpm install
pnpm tauri:dev
```

### Build Native macOS `.app` & `.dmg`

```bash
pnpm tauri:build
```
