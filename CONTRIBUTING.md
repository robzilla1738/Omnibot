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
pnpm build
pnpm test:rust
pnpm check:rust
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
pnpm exec playwright install chromium
pnpm test
git diff --check
```

For manual tests with an isolated profile, run `OMNI_BOT_HOME="$(mktemp -d)" pnpm tauri:dev`. This separates Omnibot's state, but installed CLIs still use their own accounts and configuration. Sending messages can incur provider charges.

## Reporting bugs

Include macOS/architecture, Omnibot commit or version, affected CLI/version, reproduction steps, and expected versus actual behavior. Remove tokens, private source, local usernames, conversation text, and other sensitive information from logs or screenshots.

Preserve custom names and existing conversations when changing storage formats. Use explicit, idempotent migrations. Never replace missing usage data with estimates or hardcode a provider's model catalog.

Contributions are accepted under this repository's MIT license. Include attribution and license notices when adding third-party code or assets. Provider names and logos remain their owners' trademarks.
