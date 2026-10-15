# Contributing to Omnibot

Start with the prerequisites and setup steps in [README.md](README.md). Keep fixes focused and describe the problem, resulting behavior, and verification in your pull request. For large changes, open an issue first so the design can be discussed.

## Development

- `src/` contains the React interface and typed API bridge.
- `src-tauri/src/` contains persistence, local APIs, CLI adapters, coordination, and Git operations.
- `tests/app.spec.ts` contains browser tests with mocked APIs.
- Rust tests use temporary folders and fake CLI scripts; do not add tests that require personal data or paid provider calls.

Run these before submitting:

```bash
pnpm install --frozen-lockfile
pnpm setup:sparkle
pnpm build
pnpm test:rust
pnpm check:rust
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
pnpm exec playwright install chromium
pnpm test
python3 -m unittest discover -s scripts -p 'test_*.py'
cargo install cargo-audit --version 0.22.2 --locked
python3 scripts/dependency-audit.py
python3 scripts/license-inventory.py
git diff --check
```

For manual tests with an isolated profile, run `OMNI_BOT_HOME="$(mktemp -d)" pnpm tauri:dev`. This separates Omnibot's state, but installed CLIs still use their own accounts and configuration. Sending messages can incur provider charges.

For browser-only development with an already-running backend and Vite, use `pnpm dev:connect`; use the same `OMNI_BOT_HOME` as the backend. Reconnect after restarting the backend because its token rotates. The native Tauri window gets its connection through IPC.

Dependency audits include development JavaScript dependencies and the complete Rust lockfile. CI accepts only the exact, time-limited warnings in `.github/dependency-audit-exceptions.json`, after checking both macOS dependency graphs. Do not add blanket advisory ignores. Include the affected version, platform evidence, upstream resolution and review date with any proposed exception. License inventory is an ignored release artifact; review new licenses and notice obligations before shipping, including notices not represented by a package's declared license string.

## Reporting bugs

Include macOS/architecture, Omnibot commit or version, affected CLI/version, reproduction steps, and expected versus actual behavior. Remove tokens, private source, local usernames, conversation text, and other sensitive information from logs or screenshots.

Preserve custom names and existing conversations when changing storage formats. Use explicit, idempotent migrations. Never replace missing usage data with estimates or hardcode a provider's model catalog.

Follow [recovery](docs/recovery.md) and the [native upgrade protocol](docs/releasing.md#native-upgrade-validation) for persistence or updater changes. Record the exact source commit and test environment; mark unavailable provider accounts and hardware as unverified rather than inferring compatibility from mocks.

Contributions are accepted under this repository's MIT license. Include attribution and license notices when adding third-party code or assets. Provider names and logos remain their owners' trademarks.
