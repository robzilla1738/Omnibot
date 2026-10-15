# Bot lifecycle and coordination improvement plan

Date: October 15, 2026
Local branch: `plan/bot-lifecycle-and-coordination`
Status: implemented locally. See [implementation details and verification](bot-lifecycle-implementation.md). The baseline and findings below describe the pre-change review.

## Outcome

Make it easy to understand what a bot is, create a usable bot, choose who participates in a task, follow delegated work, and retain control of conversations and files. Prioritize predictable behavior and preservation of user work before adding features or restructuring large components.

This is an incremental improvement to the existing local Tauri/Rust/React application. Keep the current CLI adapters, local storage, explicit handoffs, and separation of personal and project memory. No cloud provisioning, provider installation, account creation, or automatic inference is needed for this work.

## Review baseline

Reviewed bot creation/import/edit/delete, setup, chat identity, dispatch and handoffs, native sessions, workspace/worktree ownership, driver configuration, routines, persistence, frontend creation flows, and existing regression coverage.

Existing strengths worth retaining:

- One active workflow per chat, with Stop spanning multiple bot turns.
- Explicit handoff parsing, failure suppression, bounded rounds, and loop protection.
- Sequential history propagation and a fixed transcript boundary for parallel peers.
- Atomic store replacement and transactional rollback in several creation/edit paths.
- Separate personal, project, and shared memory; deterministic fake CLI fixtures.

Verification run on the unmodified application during this review:

| Check | Result |
| --- | --- |
| `pnpm build` | Passed |
| `pnpm test:rust` | 58 passed |
| `pnpm test` | 26 passed |

The findings below come from source inspection. New failure cases have not yet been implemented as tests. Existing passing tests do not cover every lifecycle transition. No live provider inference or personal app data was used.

## Concrete findings to address

| Priority | Finding and consequence | Source |
| --- | --- | --- |
| P0 | Deleting a bot deletes every single-participant, non-group chat for that bot, including task history, and removes its routines. The library delete button calls this directly. | `server.rs::delete_bot_profile`; `OmniHubModal.tsx` bot actions |
| P0 | Chat clear/delete and bot/routine deletion mutate the live store before `persist()` without restoring it on failure. The UI can receive an error after in-memory data has already disappeared. Workflow completion also ignores persistence errors. | `server.rs` mutation functions; `drivers.rs::finish_active_run`; `orchestrator.rs::run_swarm_workflow` |
| P1 | `@all`, parallel mode, `/group`, and `/race` fall back from a single-participant room to project assignments or all non-primary bots. The UI says “Run All Room Bots,” but unrelated bots can run, and the current main bot can be excluded. | `orchestrator.rs::dispatch_turn`; `ChatWorkspace.tsx` speaker menu |
| P1 | Mentions and handoffs add participants to personal bot chats without changing their home marker. The sidebar then rejects these homes because it requires one participant and `!isGroup`, creating another personal conversation. A non-primary home can also receive a workspace through chat updates without losing its home marker. | `orchestrator.rs` participant expansion; `server.rs::update_chat_thread`; `DesktopShell.tsx::handleSelectBotDirectChat` |
| P1 | New-chat model selection writes each bot's global profile before creating the chat. A bad project path or later failure leaves earlier model changes saved, and successful creation changes unrelated chats' defaults. | `SearchAndNewChatModal.tsx::createChat` |
| P1 | A single parallel handoff sets `next_parallel` for the entire following wave, including sequential handoffs. Multiple distinct tasks from the same sender to the same recipient can be discarded as repeated edges. | `orchestrator.rs::run_swarm_workflow`, `filter_handoff_against_loops` |
| P1 | Handoffs resolve against all bots, even when the displayed project roster is narrower. Unknown/ambiguous recipients and loop-blocked work can disappear without a visible explanation. Mention order follows bot-store order rather than textual order. | `orchestrator.rs` roster construction, `parse_bot_handoffs`, `extract_mentioned_bots` |
| P1 | Imported bot slugs bypass the uniqueness allocator used for manually created bots. Names and slugs also use separate namespaces, so a name can match another bot's slug and create ambiguous routing. | `state.rs::import_cli_bots`; `server.rs::upsert_bot_profile`; handoff resolver |
| P1 | The editor exposes “Auto Edit” and “Plan Only” uniformly, but adapters map permissions differently; several do not translate plan mode. Saving a driver change in the library can retain an old custom command. | `OmniHubModal.tsx::handleSaveBot`; `drivers.rs::resolve_driver_binary` and driver argument branches |
| P1 | Changing project worktree defaults does not count as a context change, despite affecting the effective execution directory. Sessions can remain attached to the old directory. Worktree paths identify chat and bot but not repository, so moving a chat to another repository collides with its existing worktree. | `server.rs::upsert_workspace_entry`; `orchestrator.rs::run_single_bot_step`; `git_ops.rs::ensure_bot_worktree_in` |
| P1 | Deleting a chat leaves routines referencing its missing ID. Routine “last run” records dispatch acceptance, while subsequent CLI failure is not reflected in `last_error`. | `server.rs::delete_chat_thread`; `routines.rs::run` |
| P2 | The parallel limit is per workflow, not application-wide. Multiple rooms can launch concurrently into the same project checkout or the same bot home. Synchronous Git/worktree operations and full-store persistence run while holding shared state locks. | `orchestrator.rs`; `state.rs::snapshot`, `save_store_at` |
| P2 | Current UI Git helpers use chat-scoped HTTP, but registered native Git commands still use the globally selected folder. Those two interfaces have different ownership rules. The Inspector also lacks a first-class target for reviewing an individual bot's worktree. | `lib.rs::omni_git_*`; `omni-bridge.ts` Git helpers; `server.rs::git_root` |

P0 means address first because existing user work can be lost or state can diverge. P1 covers core correctness and misleading behavior. P2 follows after those contracts are stable.

## Intended behavior

1. **A bot is a saved identity and execution configuration.** It has a stable ID, unique routing handle, role, instructions, optional model default, and personal memory. A CLI is the execution tool; several bots may share it. Discovery finds tools; creating a bot creates local configuration.
2. **A personal conversation has a stable owner.** Delegated helpers may appear without changing which bot owns it or causing another home to be created. Personal conversations stay project-free. Project work is an explicit task chat.
3. **A task chat owns its participants and optional project.** Store chat-level model overrides with the chat. Resolution is message override → chat override → bot default → CLI default, subject to driver support.
4. **The composer explains who runs.** Default sends go to the selected speaker. Explicit mentions choose recipients in textual order. `@all` means current room participants. Running a project team is a separate explicit choice. Choosing recipients and choosing sequential/parallel execution are separate decisions.
5. **A handoff is trackable work.** Each accepted task records its sender, recipient, instructions, execution mode, source workspace, and outcome. Sequential work preserves order; independent parallel work does not change other tasks' ordering. Every rejected or skipped handoff has a reason.
6. **The execution location and supported permissions are visible.** Effective settings come from one resolver shared by dispatch and the UI. Unsupported permission modes are unavailable or clearly explained before sending.
7. **Removing a shortcut, archiving a bot, and deleting history are distinct actions.** Archive preserves messages, author identity, and memory. Dependent routines are disabled with a reason. Permanent history removal is a separate, explicit operation.

## Implementation sequence

### 1. Preserve data and establish lifecycle invariants

Scope: `state.rs`, `server.rs`, `homes.rs`, `setup.rs`, and lifecycle fixtures.

- Make every store mutation use a consistent validate → candidate state → persist → publish sequence, with rollback on failure and no success event before persistence.
- Surface failed workflow saves and retain recoverable in-memory results; do not silently claim durable completion.
- Introduce archive behavior before changing the library's removal action. Preserve existing transcripts and disable affected routines instead of silently deleting them.
- Introduce explicit home ownership independent of participant count, with a versioned migration from current flags. Derive group presentation consistently instead of allowing contradictory flags.
- Use one backend allocator for bot IDs/handles, imported bots, duplicates, and template creation. Reserve broadcast handles and reject ambiguous name/handle combinations.
- Validate participant IDs, project assignments, lead bot references, and routine targets at all mutation entry points. Reject missing targets rather than silently replacing them with `bot-omni`.
- Decide and implement chat deletion's routine policy: preserve the routine in a disabled state with a missing-target explanation.

Acceptance: archiving a bot preserves its home and project tasks across restart; failed clear/delete leaves memory and disk unchanged; a delegated personal conversation reopens as the same home; repeated setup/import and duplicate requests do not create conflicting handles or homes; migrations preserve existing history and are idempotent.

### 2. Unify creation and make readiness understandable

Scope: setup, Bot library, templates, Inspector editor, `setup.rs`, backend bot service, and frontend types.

- Route setup imports, manual creation, templates, and duplication through the same provisioning rules. Backend owns defaults and uniqueness; each UI submits intent rather than assembling a slightly different full profile.
- Keep the initial form focused on name, role/instructions, execution tool, and model. Move custom commands and supported advanced settings behind a disclosure.
- Show separate tool detection, model configuration, and authentication-verification states. Never describe a detected executable as proof a request will succeed.
- Require an explicit model for Ollama before execution. Preserve custom model IDs for other adapters without claiming they have been verified.
- On provider change, clear incompatible model/custom-command/session settings through shared backend rules, not only selected UI handlers.
- Define duplication as copying configuration with a unique name/handle and fresh home/session. Keep personal memories empty by default; make copying them explicit.
- Save chat creation and chat-level execution overrides atomically. Retain drafts on failure and keep “make this the bot default” an explicit profile action.
- Handle duplicate/archive/template errors visibly and prevent repeated submission while pending.

Acceptance: every creation entry point yields the same valid bot shape; unavailable tools produce actionable readiness information; failed chat creation changes no global bot settings; two chats can use different models for the same bot; duplicating a bot does not inherit its sessions or personal memories.

### 3. Make routing and collaboration deterministic

Scope: `orchestrator.rs`, composer controls, handoff rendering, workflow tests.

- Extract a pure routing function that returns ordered recipients, mode, and validation errors before recording a user message. Use it for dispatch and recipient previews.
- Parse slash commands as commands and remove their control syntax from the task passed to CLIs. Define behavior for bare commands, whitespace, multiple mentions, quoted examples, and code blocks.
- Use stable bot IDs internally and a single routing-handle resolver at the text boundary. Define eligible handoff recipients from the visible room/project team; explicitly adding an outsider updates the visible team.
- Replace the next-wave boolean with a small typed task queue that preserves sequential groups and independent parallel groups. Keep this local and in-process; no general workflow framework is necessary.
- Assign task IDs, distinguish duplicate delivery from distinct work for the same bot, and retain bounded rounds/turns. Aggregate same-recipient instructions only when ordering and dependencies permit it.
- Record accepted, queued, running, complete, failed, stopped, and skipped outcomes, including missing recipient, loop limit, round limit, and budget limit reasons.
- Define dependency failure behavior: independent peers may finish, but work requiring a failed predecessor is skipped with a visible explanation.
- Keep ordinary group replies simple. Offer a coordinator summary only as an explicit workflow option; the setup demo must reflect actual behavior rather than promise an automatic return to the lead.

Acceptance: `@all` never selects an outsider; A-then-B remains ordered alongside independent parallel work; two distinct A→B tasks are not silently lost; overlapping handoffs execute once per accepted task; malformed/quoted examples never dispatch; all skipped work is visible; Stop prevents queued tasks from starting.

### 4. Resolve execution context once and enforce its ownership

Scope: orchestrator, driver adapters, project settings, sessions, Git/worktree service.

- Build an immutable effective run configuration containing bot identity, driver, model, supported permissions, instructions, memory scope, cwd, worktree identity, and limits.
- Associate native sessions with a compatibility fingerprint. Reuse only when driver/account configuration, workspace, relevant settings, and context remain compatible; preserve the existing transcript-watermark guarantees.
- Treat worktree-policy and eligible-roster changes as execution-context changes. Defer or reject incompatible changes while affected work runs.
- Key worktree allocation by repository, chat, and bot; preserve old dirty worktrees when a chat moves. Use the runtime state's data directory consistently.
- Make checkout sharing explicit. Default concurrent project writers to isolation or queue them when isolation is unavailable. Define same-bot home-directory concurrency too.
- Add an application-wide execution limit with visible queued work, while retaining per-chat duplicate-send protection and per-workflow limits.
- Make workflow budgets explicit instead of deriving them from an undocumented `2.5 ×` turn budget. Continue to label costs as reported values, with unavailable reporting represented honestly.
- Add a driver capability table for model selection, effort, permissions, resume, tools, and usage. Verify adapter contracts with fixtures and installed-version help where needed during implementation; do not infer identical behavior across CLIs.
- Route HTTP and native Git commands through the same explicit chat/worktree target resolver. Provide a clear result/worktree selector before commit/discard actions.

Acceptance: switching repository or worktree mode cannot resume in the old directory; Stop cancels queued and active processes; global limits hold across rooms; project defaults cannot silently alter a live run; the same Git action targets the same checkout through either API; unsupported plan mode cannot be presented as enforced.

### 5. Complete reliability and user feedback

Scope: runtime events, routines, storage errors, UI synchronization, focused module extraction.

- Link each routine attempt to a workflow ID and record dispatch, completion, failure, cancellation, and skipped/busy outcomes separately. Preserve current local scheduling and missed-run semantics.
- Keep active-workflow cleanup reliable on every exit path, including task failures. On restart, show interrupted work as interrupted and require a deliberate retry.
- Move slow Git/worktree operations outside the state lock. Revalidate state before committing their results; bound operations so a stalled subprocess cannot freeze Stop or snapshots.
- Add snapshot revisions or equivalent ordering so late mutation responses cannot overwrite newer streamed state. Use targeted updates where justified by measured transcript growth.
- Extract cohesive bot lifecycle, routing, execution-context, and workflow modules while fixing behavior. Share bot form validation and draft handling; avoid a broad cosmetic rewrite.
- Update help text and setup demonstrations to match permissions, handoffs, homes, model scope, and archive behavior.

Acceptance: routines report actual execution failures; a slow Git operation does not block Stop; reconnect/reload restores an accurate workflow view; out-of-order responses do not revert newer state; large local histories remain responsive under a measured fixture workload.

## Verification plan and completion criteria

Implement each slice with the smallest meaningful failing regression first, then run the affected Rust/Playwright tests. Retain existing fake-CLI and temporary-repository isolation.

Required additional scenarios:

- Fresh install with no CLI, one CLI, multiple bots on one CLI, repeat import, reserved/ambiguous handles, unavailable model, and provider switching with custom command history.
- Create, duplicate, rename, archive, reopen, and restore bots; personal delegation; chat creation failure after model selection; routine targets after archive/delete.
- Sequential, parallel, mixed handoffs, same-recipient tasks, recipient outside the eligible team, partial failure, unknown usage, budget exhaustion, Stop between batches, and concurrent rooms.
- Failed persistence at each destructive mutation; restart with interrupted runs; unchanged canonical history after a failed operation.
- Dirty worktrees, repository changes, workspace-default changes, same-directory concurrency, and native/HTTP Git target parity.

Add a small real-backend integration path using temporary `OMNI_BOT_HOME` and fake CLIs. Current browser mocks are useful for UI behavior but cannot establish backend lifecycle correctness. Exercise both browser HTTP and native command contracts where they differ.

Final local gate: `pnpm build`, `pnpm test:rust`, `pnpm check:rust`, `pnpm test`, `git diff --check`, and a native smoke test using isolated fixtures. Document any remaining adapter/version limits. Optional live provider validation is a separate explicitly selected check.

Done means every finding above is fixed or explicitly resolved with a documented contract, the acceptance cases pass, migrations retain user work, and a user can explain who will run, where they will work, which settings apply, and why a workflow stopped. No claim of universal bug absence is required to make these guarantees testable.

## Local working agreement

Implementation was subsequently authorized and completed on this local branch. Changes remain uncommitted; no pushes, pull requests, releases, or deployments were made. See the implementation report for resulting behavior, verification, and local test instructions.
