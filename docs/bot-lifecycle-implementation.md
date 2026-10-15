# Local bot lifecycle and coordination implementation

Branch: `plan/bot-lifecycle-and-coordination`. Work is retained in local Git history; no push, pull request, or release is part of this task.

## What changed

- **Preservation:** bot removal now archives the profile. History and memory remain; the Bot library offers Restore. Archiving unpins the bot, removes active project assignments, and disables dependent routines. Deleting a chat disables its routines instead of leaving an invalid target. Destructive store mutations roll back on failed persistence. Runtime save failures are visible with a Retry save action.
- **Identity:** personal conversations have a stable owner even when helpers join. Migration preserves prior history and turns duplicate legacy homes into ordinary conversations. Homes cannot be attached to projects. Creation and imports share name/handle validation, including reserved broadcast handles and cross-name/handle collisions. Duplication starts with empty personal memory and fresh sessions.
- **Models and readiness:** new-chat model selection is saved atomically with the chat and does not change the bot's global default. Message overrides take precedence over chat settings, then profile defaults, then CLI defaults. Missing commands and missing Ollama models fail before dispatch. UI distinguishes tool detection from authentication verification. Unsupported plan/effort controls are disabled; backend validation prevents silently ignoring unsupported permission requests.
- **Routing:** the recipient preview uses the same backend resolver as Send. `@all` and `/race` address active room participants; `/group` runs them sequentially; `/team` explicitly recruits the assigned project team. Commands are removed from the execution prompt. Mention selection uses stable handles and textual order; quoted/code examples do not recruit bots.
- **Workflows:** typed task groups preserve each handoff's mode. Distinct tasks for the same recipient remain distinct; exact duplicate tasks and bounded loops are reported. Task records expose queued/running/completed/failed/stopped/skipped outcomes and working folders. Failed sequential predecessors skip dependent peers; independent parallel peers may finish. The saved team-summary preference in Team Rules & Trust adds one final turn and cannot schedule further handoffs.
- **Execution ownership:** one global concurrency limit applies across chats. Runs sharing a checkout or overlapping folders queue; isolated worktrees can execute independently. Stop cancels queued tasks as well as active CLI process groups. Workflow cleanup releases ownership on all normal/error/unwind paths. Workflow cost has its own explicit setting instead of an undocumented multiplier.
- **Sessions and Git:** compatibility fingerprints cover bot settings, model overrides, effective cwd, project context, shared instructions/memory, roster, and detected CLI identity. A Reset CLI sessions action preserves chat history. Worktrees include repository identity; legacy dirty worktrees are reused, and moving a chat never destroys the old worktree. Git subprocesses are bounded and run outside the state lock. Native and HTTP Git mutations share the same target resolver; the Inspector can select a task's working folder.
- **Routines and UI:** routine outcomes follow actual workflow completion. Scheduled busy/failed attempts have visible reasons. Interrupted tasks/routines are marked on restart. Snapshot revisions plus server instance IDs prevent late responses from reverting newer state. Long conversations initially render the latest 200 messages, with earlier history available on demand; task records remain in the store for scheduling and Git inspection, but the chat activity-history panel has been removed. Transcript padding follows the composer's actual height.

## Resolved design decisions

- Bots sharing a working folder are serialized. Worktrees provide actual parallel editing; the app never silently falls back to a shared checkout when isolation fails.
- Sequential recipient lists have dependencies in listed order. Parallel recipient lists share a fixed conversation boundary. Separate handoff groups retain their declared order; a parallel group cannot make unrelated sequential work parallel.
- A task is accepted when recorded as queued. Failed and skipped tasks remain in the conversation's task history. Unknown/ambiguous/out-of-team handoffs are visible instead of launching hidden bots.
- Archiving is reversible. Restoring a bot does not silently re-enable routines or restore project assignments. Permanent chat history removal remains a separate action.
- External account/configuration changes inside a CLI are not observable reliably. Use Reset CLI sessions after those changes; authentication is never inferred from installation.
- Canonical store writes remain serialized with mutations to retain transactional correctness. Slow Git/worktree work has moved outside that lock, snapshots no longer invoke Git, and the UI bounds transcript rendering. This remains a local JSON store, not a database rewrite.
- Provider permission modes are adapter capabilities, not an OS sandbox. The reported-cost limit can only react to costs a CLI supplies; unknown cost remains unknown.

## Verification and local testing

The regression suites use temporary repositories, isolated stores, fake CLI processes, and mocked browser APIs. A real HTTP integration test exercises the production router, fake execution, archival, and persisted history. Added cases cover rollback, home migration, scoped models, routing, mixed handoffs, skipped tasks, summaries, global slots, routine failures, and worktree preservation.

Final verification results are recorded in [local verification](local-verification.md). The production frontend build, native debug build, Clippy with warnings denied, Rust formatting, and Git whitespace checks passed. The frontend build reports a non-blocking bundle-size warning (approximately 517 kB before gzip).

Run the full local checks:

```bash
pnpm build
pnpm test:rust
pnpm check:rust
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
pnpm test
git diff --check
```

For a native process smoke check with fake bots and a temporary data directory, close any development server on port 1420, then run:

```bash
cargo build --manifest-path src-tauri/Cargo.toml --locked
python3 scripts/smoke-local.py
```

The native smoke check passed earlier during implementation; see the final verification note for its current rerun limitation. The script starts Vite and the native app, verifies preview/dispatch, two fake bot runs, archive/restore, and disk persistence, then closes its processes and removes its temporary files. Startup can discover installed CLI metadata, but the smoke tasks use only local shell fixtures and submit no provider inference.

For interactive testing with your normal app data, run `pnpm tauri:dev`. To try a fresh isolated profile, set `OMNI_BOT_HOME` to a separate directory first. Suggested checks: create two bots, start a group chat with different chat models, compare `/group` and `/race`, toggle saved team summaries, stop a run while queued, archive/restore a bot, and select a bot worktree in the Inspector.

Live provider inference and all installed CLI/version combinations are outside the automated verification. Native packaging, signing, release, and deployment are unchanged by this local task.


## Final interface behavior

- Project-dependent shortcuts and recognized personal-space review requests use the existing project picker. The prompt and participants carry into a new project chat as a draft; no bot runs until Send. Ordinary Git questions stay in personal space.
- Newly imported bots use CLI defaults, and existing explicit model choices survive discovery. Setup and model settings explain inheritance.
- Terminal uses a circular sidebar button beside Settings. Its redundant running/resumed status strip is removed; status and exit details remain in tab tooltips. Native dropdowns retain platform controls.
- The removed Recent activity component is not replaced by another chat panel. Transcript metadata is grouped beside the bot name and revealed on hover/focus. The jump button follows the actual composer height to avoid terminal-notice overlap.
- Cursor home trust is an independently saved, opt-in preference scoped to the bot’s generated home folder. It does not approve project folders or tools. Codex account/model errors are unwrapped, deduplicated, and accompanied by model-selection guidance.
