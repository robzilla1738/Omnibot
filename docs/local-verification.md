# Local verification and handoff

Date: October 15, 2026
Branch: `plan/bot-lifecycle-and-coordination`
Scope: local Git commits only; nothing pushed, published, or released.

## Final checks

- Rust: **90 tests passed** (`pnpm test:rust`).
- Browser: **39 tests passed** (`PLAYWRIGHT_PORT=1423 pnpm test`).
- Production frontend build: passed (`pnpm build`).
- Clippy: passed with warnings denied (`pnpm check:rust`).
- Rust formatting and Git whitespace checks: passed.
- The frontend build retains a non-blocking bundle-size warning; the terminal is a separate lazy-loaded chunk.

The final browser suite covers project selection with preserved drafts, ordinary Git questions, CLI-default setup, saved summary and Cursor trust settings, recipient previews, hover-only provider/usage metadata, terminal interaction, persistence, and the existing application flows. Rust coverage includes nested/deduplicated provider errors, home-scoped Cursor trust, imported model defaults, scheduler ownership, persistence, and actual local PTYs.

Native HTTP/PTY smoke testing passed earlier during implementation with isolated profiles and fake commands. It was not rerun for this final commit because another local service owns its required port 1420. No unrelated service was stopped. Live provider account access, paid inference, Windows PTY behavior, packaging, signing, and deployment were not verified by these fixture-based checks.

## Run locally

Default development:

```sh
pnpm tauri:dev
```

Use the current alternate development port when 1420 is occupied:

```sh
pnpm setup:sparkle
PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH" pnpm tauri dev --config '{"build":{"devUrl":"http://localhost:1422","beforeDevCommand":"pnpm dev --port 1422"}}'
```

Run browser checks independently on an available port:

```sh
PLAYWRIGHT_PORT=1423 pnpm test
```

For isolated native smoke testing, first make port 1420 available, build the native binary with the default Tauri configuration, and run:

```sh
pnpm build
cargo build --manifest-path src-tauri/Cargo.toml --locked
python3 scripts/smoke-local.py
```

The smoke script uses a temporary `OMNI_BOT_HOME`, fake shell commands, and its own processes. Normal development uses the user's existing local profile. Model choices and Cursor trust stored there are not part of the Git commit.

## Related documentation

- [User guide](../README.md)
- [Lifecycle and coordination implementation](bot-lifecycle-implementation.md)
- [Embedded terminal](embedded-terminal.md)
- [Original plan and pre-change findings](bot-lifecycle-and-coordination-plan.md)
