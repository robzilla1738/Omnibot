# Local review — October 14, 2026

This review covers the bot execution pipeline, group-chat coordination, CLI stream parsing, persistent state, Git operations, local API, and React client. Automated verification uses local fixtures and mocked APIs; no paid model calls are required.

## Fixes

| Area | Result |
| --- | --- |
| Workflow ownership | One active workflow per room, registered before dispatch returns. A second send cannot clear the first workflow's cancellation flag. Live chat edits/deletion wait for shutdown. |
| Stop and process lifecycle | Stop remains visible until execution finishes. Termination kills the CLI process group, including ordinary child tools. EOF on stderr cannot busy-loop, and closed output pipes cannot bypass the timeout/cancellation loop. |
| Handoff routing | Exact recipients, complete closing tags, multiple handoff blocks, preserved task instructions, no execution of fenced/quoted examples. Explicit handoffs are the default for new stores. Existing user preferences remain intact. |
| Group execution | Parallel limits batch all selected bots instead of dropping overflow. Sequential bots see prior replies; parallel peers see a fixed completed transcript. Incoming instructions from multiple senders are combined. |
| Sessions | Resume watermarks reflect the context actually provided, so parallel peers' results are not skipped. Changing a chat workspace or a bot's execution configuration invalidates incompatible sessions. |
| Workspace ownership | Changing the global project selection does not silently move an existing chat. Home stays project-free. New work chats explicitly select a project, and the Inspector displays that chat’s workspace. |
| Worktrees | Full encoded identifiers replace colliding timestamp prefixes. Existing branches are never forcibly reset. Failed isolation reports an error instead of silently running in the shared checkout. Handoff context includes worktree locations. |
| Driver results | Nonzero exits and provider error envelopes remain failures even when they include text. Failures cannot launch handoffs. Thinking-only deltas no longer suppress the final text. Unknown tool results do not complete unrelated tools, and explicit tool failures remain errors. |
| Driver configuration | Quoted custom command arguments work. Codex resume uses supported sandbox configuration flags; reasoning effort is forwarded. Pi resumes the actual session. Model overrides are limited to their selected bot. |
| Storage | Atomic replacement, owner-only state file permissions, startup recovery of interrupted message statuses, and a lock against concurrent writers. Invalid saved JSON is preserved and reported rather than overwritten with defaults. Rescans preserve customized bot roles/avatars. |
| Git | NUL-delimited status parsing handles spaces, renames, newlines, and Unicode. Diff truncation respects UTF-8 boundaries. File operations use literal pathspecs and reject traversal/external symlinks. Discard restores staged deletions and never deletes a tracked file merely because Git failed. |
| Local API and Markdown | The API rejects foreign origins and unexpected Host headers. Bot Markdown is sanitized before rendering. File previews read bounded amounts; version probes have a timeout. |
| UI synchronization | A serialized, coalesced snapshot refresh prevents races between snapshots and text deltas. Reconnects and missed events trigger resynchronization. Failed sends preserve drafts; active workflows block duplicate submissions between turns. |
| Routines | Readable manual/daily/weekday/weekly schedules, reusable prompt ideas, and per-routine bot/model choices. A local scheduler persists attempts before dispatch to prevent duplicate runs. Selected bots remain the first speaker even when prompts mention teammates. Existing cron entries stay manual. |

## Sidebar and first-run setup

- SF Pro throughout menus, model pickers, settings, and labels, with Lucide UI icons. SF Mono remains for code and tool output.
- The gauntlet is the default main-bot avatar. Setup, Bot library, and the Inspector share an avatar picker with character shapes/colors and local PNG/JPEG/WebP uploads. Name, role, description, and avatar edits preview in setup and persist with the profile.
- Setup uses consistent label spacing, animated disclosure sections, and subtle focus styling. The footer stays anchored across steps; the content fades out and enters with a short directional transition. Keyboard focus follows the new heading.
- Shared hover/press timing, smooth modal and settings transitions, and layout-stable selection borders keep controls consistent. The bot header expands by 26px to reveal its chevron on hover or keyboard focus, with constant height. Reduced-motion preferences are respected throughout.
- Main bot tile and selected bot rows use a clear dark highlight. Sidebar names are 16px with 14px conversation previews.
- Fresh installs start with no pinned bots. Selecting CLIs in onboarding adds their individual bots to the sidebar. Pin/unpin controls remain in Bot library and bot context menus; unpinning preserves conversations.
- Fresh stores contain one main bot, one empty conversation, no seeded group chat/routine, and no personal memory placeholders. Existing conversations are preserved.
- Local setup guides naming, CLI discovery and selective import, workspace selection, permissions, and a scripted handoff preview. No model calls occur during setup.
- Discovery opens the tools step immediately, runs concurrent bounded version checks off the UI thread and outside the state lock, and is reused when navigating Back. Progress and retry states keep onboarding responsive.
- Native select menus have consistent 50px field height; section divider lines are removed throughout the UI.
- Discovery does not import bots. Setup completion is persisted transactionally; invalid paths, missing CLIs, active workflows, and failed storage writes do not partially save setup.
- New chat defaults to one bot; group chats require explicit participant selection. Native model pickers in new chat, Bot library, and bot settings use live model catalogs from installed CLIs, preserve existing custom models, and offer CLI default. Creating a chat never submits a preset prompt.
- Setup can be reopened through the sidebar settings button; CLI diagnostics remain available through Bot library → Local tools.

## CLI model catalogs and message settings

- Claude uses its initialization control response, Codex and Muse use `model/list`, Grok/Cursor/OpenCode use `models`, Pi uses its extension-free model listing, and Ollama uses its installed model list. These are metadata requests, with no user prompt or inference submission.
- Discovery is concurrent, bounded to eight seconds per process and 2 MiB of output, and kills process groups on completion or timeout. Results merge into current state; refresh never replaces saved bot settings.
- Shared native model pickers display CLI labels and model IDs, offer refresh and custom IDs, and mark saved models absent from the current list. Unsupported or unavailable catalogs show an honest fallback instead of guessed model names. Ollama requires an explicit model and no longer chooses an arbitrary download.
- The obsolete bundled welcome is removed from legacy stores, including its frozen provider badge and CLI count. Real conversation history keeps its original provider. Setup previews and the ready screen reflect the selected main provider; changing providers clears stale composer model overrides and custom model drafts. A regression verifies the choice survives setup completion and reload.
- Provider badges use bundled provider logos and fade in on message hover or keyboard focus. Replies omit the side avatar; clicking an author's name opens that bot's settings without navigating away from the conversation.
- Pending replies show a single thinking indicator with animated dots; received text renders without an artificial typewriter delay. Thinking details are expandable, Stop stays in the composer, and reduced-motion settings disable the animation.
- The Inspector fade is limited to 6px at the top and 18px at the bottom, with content padding. Animated disclosures clip without creating hidden scroll containers, so focusing fields during expansion cannot strand earlier inputs offscreen.

## Personal homes, projects, and memory

- Main and individual bot homes start without a project. Project-free execution uses each bot’s own local home folder. One-off tasks are separate chats, with an optional workspace. A project work chat selects a saved project or an existing folder; folder validation happens before creation, and new folders are registered as projects. Ongoing bot conversations have an explicit persisted identity, so opening a bot cannot take over a task chat. Bots can act on explicit requests and named folders within CLI permissions without requiring a saved project.
- Existing primary-chat work history is moved into a separate work chat with its original sessions and routine targets. Real messages are preserved. Empty legacy auto-created CLI threads become personal homes; obsolete bundled welcome messages are removed by exact IDs and content prefixes.
- Personal bot memories, project notes, and deliberately shared preferences are separate context sections. A bot does not receive another bot’s personal notes. Project notes only enter chats attached to that folder. The Memory UI supports adding, editing, and forgetting notes in each scope.
- The transactional store is canonical. Readable `memory.md` exports live under `~/.omni-bot/bots/<encoded-id>/` and `projects/<encoded-id>/`; each bot also has a `home/` folder. Edit memories in the app. The app does not automatically learn memories or claim that editing an exported Markdown file changes stored notes.
- Context changes invalidate affected native sessions and cannot race active workflows. Project permission changes are scoped to that project; home never inherits automatic project approval. CLI permission modes still govern actual tools—home folders are not an OS-level sandbox.
- Sidebar sections are Bots, Projects, and Chats, with avatar-led rows, no empty section clutter, and subtle hover controls. Visible All/Bots/Projects/Chats buttons switch views outside the list fade. The Bots view shows all available bots without automatically pinning them; All uses explicit pins. Drag rows or section headings to reorder; Option + arrow keys reorder focused rows. Right-click the sidebar background to configure section visibility and item sorting; the top toolbar keeps only search and new chat. Sections collapse; compact popovers rename or remove items without expanding the rows. Removing a project or chat from the sidebar preserves its files/history. Layout preferences are local to each browser/native client, while bot pins and names persist in the app store.
- The centered bot header places its project beneath the name. Project selects use actual native select menus and platform appearance.

## Reported usage

- Removed character-count token estimation. Older messages without verified usage provenance no longer display guessed counts/costs.
- Terminal result envelopes supply totals; stream snapshots are ignored. OpenCode/Pi step usage accumulates, known event IDs deduplicate, separate cache reads/writes count once, and missing step metrics remain unavailable.
- Cost is the CLI-reported value, not a claim about the final provider invoice or subscription charge. Abbreviated/rounded values are marked and tooltips expose reported precision. Duration is locally measured elapsed CLI time. Stopped/failed runs may only have partial provider-reported usage.
- Hover badges show a provider logo and the resolved model when reported. If only a configured model/default is known, the tooltip identifies it as requested rather than confirmed. No provider inference was used to verify these paths; regressions use protocol fixtures.

## Verification

- `pnpm build`: TypeScript (including test code) and production Vite build.
- `pnpm test:rust`: 58 passing tests, including fake CLI workflows and temporary Git repositories.
- `pnpm test`: 25 Chromium/Playwright regression tests for retained drafts, duplicate-send prevention, HTML sanitization, navigation shortcuts, first-run completion, pin persistence, setup error recovery, profile customization, local image upload/removal, anchored setup navigation, header hover/reduced-motion behavior, delayed discovery, discovery retry, individual-chat defaults/model persistence, group-chat error recovery, message-author settings/hover logos, routine drafts/schedules/model selection/run requests, thinking-to-text transitions/Stop/reduced motion, sidebar view persistence/reordering/renaming, home/project separation, scoped memory edits, and honest usage/model display.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: clean.
- `git diff --check`: clean.
- Live local API: snapshot access, foreign-origin/Host rejection, temporary chat creation and deletion.
- Live browser: interface loaded with no JavaScript exceptions; composer visible.
- Installed CLI metadata checked without inference: Claude, Codex, OpenCode, Cursor, Grok, Pi, Muse, and Ollama catalogs all loaded. Zero active provider runs at completion.

All automated bot execution uses temporary shell-script fixtures. Tests do not discover or invoke provider CLIs, load personal conversations, or spend provider tokens.

## Practical limits

Live provider inference, authentication, and every installed CLI/version combination were not exercised. Provider APIs, available models, and CLI protocols can change independently of this app. A clean test suite is not proof of the absence of every bug.

Dollar guardrails depend on a CLI reporting cost, sometimes only after a request finishes; they are not guaranteed provider-side spending caps. A parallel batch can already be in flight when its first reported cost arrives. Timeouts, round limits, and loop guards remain independent controls.

Worktrees start from committed HEAD and do not automatically include uncommitted edits from the source checkout. Results are not automatically merged between bots; the handoff includes source worktree paths for explicit review or transfer. Git status, diffs, commits, and discard use the current chat’s project; Git is unavailable in home conversations. The Computer browser retains its separate global browsing directory, displayed in that panel.

Routine schedules run in local time while the app is open; missed times are not replayed. Execution uses the selected CLI account. Broad computer use and other Grok Bot cloud services are outside this app's implemented feature set.

## Try it locally

Run `pnpm tauri:dev`. The native Omnibot window and browser interface at `http://localhost:1420` use the same local backend (normally `http://127.0.0.1:4321`). Keep one instance per data directory. State lives in `~/.omni-bot`; `OMNI_BOT_HOME` selects a separate local data directory.

A useful manual check is a two-bot room: send `/group` for sequential work or `/race` for parallel work, then use Stop. To test explicit delegation, ask the first bot to finish with a standalone block such as:

```xml
<handoff to="Codex" mode="sequential">Review the changes in the named worktree and report any regressions.</handoff>
```

Choose your desired low-cost model in each bot's settings before making live requests. The review itself made zero paid model calls.

## Open-source release checks

The release pass added an MIT license, third-party notices (also bundled in the native app), contributor and security guidance, pinned GitHub Actions, and CI for browser tests, Rust checks, and macOS packaging. Personal machine fallback paths were removed. Claude's standard permission mode now preserves CLI configuration instead of forcing `acceptEdits`. The local API's CORS allowlist includes the packaged Tauri origin as well as the development UI, with a real HTTP preflight regression; foreign origins remain rejected.

The JavaScript dependency audit reported no known vulnerabilities. The Rust audit reported no vulnerability-class advisories and two informational advisories for transitive Linux GTK dependencies: `proc-macro-error` (RUSTSEC-2024-0370, unmaintained) and `glib` (RUSTSEC-2024-0429, unsound). Those crates are not used by the supported macOS target; Linux support remains unvalidated. These warnings are not suppressed.
