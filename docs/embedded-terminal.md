# Embedded bot terminal

Implemented locally on `plan/bot-lifecycle-and-coordination`. Nothing is published.

## Using it

Click the circular **Terminal** control beside Settings in the expanded sidebar, or press **⌘`** (Ctrl+` on other keyboards). The default view opens the interactive CLI automatically for Claude Code and custom commands and focuses its input. Opening it while chat automation is running stops that workflow and cancels pending handoffs first. An existing live interactive session is reused, including after hiding/reopening or a page reload. Startup errors offer an explicit retry; completed or stopped sessions are not automatically restarted while the panel remains open.

**Run logs** is a secondary view for troubleshooting. It contains actual stdout and stderr from automated runs, including output without a newline. Those processes use structured protocols with closed stdin, so their logs are read-only and may contain JSON. Unsupported interactive adapters show an explanation rather than automatically presenting raw logs.

Drag the panel's left edge to resize, expand it for more space, and search or copy selected output from the toolbar. Process tabs and the follow button apply within the selected view. Opening an interactive CLI starts a new PTY process; it does not attach a keyboard to an already-running headless process.

- **Claude Code:** launches the interactive CLI, resuming the saved conversation when the bot configuration and working folder still match. Otherwise starts a new session. Includes bot instructions, scoped memories, recent chat context, model, effort, and supported bot permissions. Home chats continue to prohibit the bot's bypass-permissions setting.
- **Custom commands:** launches the bot's saved command and arguments in a PTY. The command must itself support interaction. Unlike automated custom turns, this does not append a task prompt to its arguments.
- **Other adapters:** live output is available; their interactive controls are disabled with an explanation.

The terminal receives real keystrokes, paste, control characters, and window-size changes. Hiding the panel or switching chats does not stop it. **End control** or the chat's **Stop response** stops the process; normal application exit also cleans up interactive processes. Chat sends, routines, profile edits, and workspace changes cannot race with a terminal that owns that chat. Global execution slots and checkout locks also apply to terminals.

Terminal conversations remain in the terminal, not the app's parsed chat transcript. Their lifecycle is recorded as a workflow task. Ending control records exit/stopped/error status and invalidates automated session state so a subsequent chat turn rebuilds its context. Automatic handoffs, parsed usage totals, and automatic turn budgets do not apply inside user-controlled terminals. No automatic workflow resumes or inferred success summaries are generated.

## Implementation

- React uses lazily loaded xterm.js with Fit, Search, and Serialize addons; styling uses the app's neutral charcoal surfaces, circular controls, and pill buttons.
- Rust uses `portable-pty`. A process owner handles group/foreground cleanup; nonblocking Unix I/O keeps Stop responsive even when the child ignores input.
- Terminal HTTP endpoints use the existing loopback host/origin validation. Start takes a saved chat/bot identity, not an arbitrary command. Input and dimensions are validated; pending input is bounded.
- Terminal output has its own byte-offset API, separate from canonical snapshots. The visible panel polls at approximately 80 ms after each completed read, with backpressure from xterm parsing. Hidden panels stop reading. Session metadata refreshes separately.
- Output is held in memory, up to 2 MiB per process, with up to 32 retained sessions (active sessions are never evicted). The UI retains up to 5,000 scrollback lines and serializes screens when switching tabs. Expired output is identified visibly. Full terminal transcripts are not written to disk and do not survive an app restart; task records do.
- The native window and server-only mode both stop interactive sessions during normal shutdown. Crashes or forced OS termination cannot run application cleanup.

## Verification

Rust regression tests exercise real local PTYs: Unicode input, prompts without newlines, dimensions, nonzero exits, failed startup, queued cancellation, blocked input, ownership exclusion, read-only automated streams, bounded retention, and Claude's interactive resume arguments using a fake executable.

Browser tests cover opening/expanding/searching output, hiding and reopening without stopping, automatic interactive startup, safe workflow transition, session reuse, retry behavior, keyboard forwarding, resize requests, ending control, and unsupported adapters. The native smoke script uses an isolated temporary profile and fake commands to verify process output, PTY input, resizing, and exit cleanup through the production HTTP API.

See [local verification](local-verification.md) for the final suite results and scope. The existing non-blocking frontend bundle-size warning remains; the terminal is loaded in a separate chunk only when opened.

Run:

```sh
pnpm build
pnpm test:rust
pnpm check:rust
pnpm test
cargo build --manifest-path src-tauri/Cargo.toml --locked
python3 scripts/smoke-local.py
```

No paid provider inference is needed for these checks. Live Claude authentication, provider-side behavior, and Windows PTY behavior have not been exercised by the automated fixtures. Interactive development testing: `pnpm tauri:dev`.


## Terminal polish and provider recovery

The xterm mount uses outer margins instead of inner padding so fitting matches the actual PTY space. Terminal resize requests are ordered, font loading triggers a refit, and the xterm 6 scrollbar uses the neutral app palette. Ended sessions show a read-only transcript notice and a new-session action. The redundant status strip is removed; bot-tab tooltips provide status and exit details. The bot picker uses a native select. Workflow task records are retained internally, but there is no activity-history panel in the chat area.

In Bot library → Team Rules & Trust, **Summarize team results** is saved in the local store and applied to subsequent chat sends. **Trust bot homes in Cursor** is separately opt-in: it adds `--trust` only when the working directory is that bot’s Omnibot-managed home. It never adds tool auto-approval or trusts project directories.

Nested Codex error messages are unwrapped and deduplicated. Account/model rejection explains how to select CLI default or a supported model; raw process diagnostics remain available in Run logs. Provider access still depends on the installed CLI and signed-in account.
