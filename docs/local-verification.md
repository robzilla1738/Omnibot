# Local verification

This page distinguishes repeatable checks from historical results. Use the exact commit and environment in any new verification record. Uncommitted source changes are not a signed release candidate.

## Published 0.1.2 — October 15, 2026

[Release and downloads](https://github.com/robzilla1738/Omnibot/releases/tag/v0.1.2) were built from `0121fa16cfe3a26079e3261e1da585ee9e374952`, after [exact-source CI](https://github.com/robzilla1738/Omnibot/actions/runs/38804183870) passed. CI passed 154 Rust tests, 69 Chromium tests, 69 WebKit tests, 23 Python safeguards, formatting/Clippy, dependency auditing, notice collection, packaging and the isolated native backend smoke test.

The final universal app and DMG were Developer ID signed, Apple-notarized and stapled. Public downloads were retrieved into a fresh directory and all five entries in `SHA256SUMS.txt` passed. The release tag matched the manifest source commit; the extracted app and DMG passed code-signature, ticket and Gatekeeper checks. The app's version, both architecture slices, existing bundle identity, update key/feed and embedded notices were validated. The ZIP passed Sparkle signature verification. The generated signed feed was published only after these downloads were available and verified.

| Artifact | SHA-256 |
| --- | --- |
| Universal ZIP | `a9ff564b31541c7e094e0fa78824728e0d50cd70cceb319314f5926bad319599` |
| Universal DMG | `c63f7b451ecd1bedc6fb162b1202f634a6441558eac176b66f3ed1044ad3f110` |

The final signed binary passed isolated Apple Silicon startup, fake workflows, archive/restore, PTY input/resize/exit and restart persistence smoke tests. An additional upgrade check downloaded and verified the published 0.1.1 ZIP, used that binary to save a synthetic profile, then explicitly replaced its subprocess with 0.1.2. Custom prompts, model/effort choices, personal/project/shared memory, settings, project/history/session metadata and disabled routines were preserved. The pre-migration copy exactly matched the old store bytes; a second launch preserved the profile identity and did not create another migration copy.

This was explicit binary replacement, not a Sparkle installation. Physical Intel, macOS 11, actual signed update installation/relaunch and all live CLI/provider combinations remain unverified. Native UI evidence from the earlier qualification is retained below. The source/CI manifest, checksums and dependency notices are release assets; the historical local qualification archive below is not the published artifact.

## 0.1.2 local qualification — October 15, 2026

Environment: macOS 27.0.1, Apple Silicon, Rust 1.99.0, Playwright 1.64.0. Source is the uncommitted worktree based on `d75f7ea9f6af7a1a9e3cca553dfcdea9efa4e6d2`; nothing was committed, pushed or published. The pre-existing Dependabot edit was preserved.

| Check | Result |
| --- | --- |
| Rust tests | 154 passed |
| Rust formatting and Clippy | Passed; warnings denied |
| Python release/bootstrap safeguards | 23 passed |
| TypeScript and production frontend build | Passed |
| WebKit browser suite | 69 passed |
| Chromium browser suite | 69 passed |
| Signed universal release bundle | Both architectures verified; Apple Silicon native smoke passed |
| Exact CI debug package | Built with its debug-only hardened-runtime override; native smoke passed |
| Developer ID / notarization / Gatekeeper | Passed, including extracted archive verification |
| Native UI | Setup, draft persistence through navigation/restart, successful update check and active-task refusal observed |
| Intel runtime | Attempted through Rosetta; unavailable (`Bad CPU type in executable`) |
| Physical Intel / macOS 11 / signed previous-to-next installation | Not verified |
| Live provider accounts / paid inference | Not exercised; CLI fixtures used |

The 3,000-message/three-bot streaming fixture kept 197 recent history rows rendered and made five snapshot requests during the burst in each browser. Maximum frame gaps were 66.6 ms in Chromium and 71 ms in WebKit. Typing took 1,180 ms and 1,283 ms respectively, including a deliberate 15 ms per-key delay. This is synthetic browser evidence, not a universal latency guarantee.

Dependency notice collection covered 307 package/version records with 529 upstream notice/declaration files and 19 reviewed immutable-source fallbacks. Provenance contains package-relative paths and public URLs. Both files are bundled in app Resources before signing. Four fallbacks preserve upstream declarations and canonical terms where no separate upstream license/copyright file exists; those omissions are explicit rather than replaced with invented ownership.

The local qualification artifact is `release-artifacts/qualification-0.1.2/Omnibot-0.1.2-local-qualification.zip` (SHA-256 `015f917627973cc126efd955e37413195686b24f952abd358eef8817eac2a49b`). Its neighboring manifest records runtime-source/config hashes and its notarization receipt. The ignored artifact directory is local evidence, not a public release. Public release still requires committed source, successful exact-SHA main-branch CI, the release manifest/signature workflow and the remaining platform/upgrade checks.

During GUI qualification, inspecting the closed temporary app caused the automation tool to relaunch it without the isolated environment. The process was stopped. Its newly created pre-migration copy was used to restore the normal `store.json` byte-for-byte under the store lock, and equality was verified. The extra migration backup was retained; the temporary app was removed. Subsequent qualification instructions require a dedicated test account for GUI/relaunch tests and prohibit inspection-driven reopening of closed test apps.

## Historical baseline before release hardening

The following results were recorded on October 15, 2026, on `plan/bot-lifecycle-and-coordination`, before the current persistence, authentication and release-safeguard changes. They are retained as prior evidence, not results for later source changes. Nothing was pushed, published or released by that verification.

- Rust: **90 tests passed** (`pnpm test:rust`).
- Browser: **39 tests passed** (`CI=1 PLAYWRIGHT_PORT=1423 pnpm test`).
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

Run browser checks on an available port with no concurrent repository writes or other Vite servers. Tailwind/Vite watches documentation too; editing it can reload the app during a test. Use `CI=1` to require a fresh test server:

```sh
CI=1 PLAYWRIGHT_PORT=1423 pnpm test
```

For browser-only manual development, start Vite and the native backend with the intended isolated profile, then run `pnpm dev:connect` using the same `OMNI_BOT_HOME`. The connector writes a private mode-0600 local connection page and opens that page, keeping credentials out of process arguments. The UI imports the token from a URL fragment into memory and removes the fragment. Reconnect after a full page reload or backend restart. Stop the backend when stopping Vite; development code remains trusted throughout the session. Do not share the private connection file or browser session.

For isolated native smoke testing, first make port 1420 available, build the native binary with the default Tauri configuration, and run:

```sh
pnpm build
cargo build --manifest-path src-tauri/Cargo.toml --locked
python3 scripts/smoke-local.py
```

The smoke script gives the native child a temporary `HOME` and `OMNI_BOT_HOME`, a minimal environment with login-shell capture disabled, and local fake executables shadowing registered CLI discovery names. It reads the private `api-port` file, so ephemeral port fallback is supported. It tests API workflows and real PTYs, then restarts against the same profile to verify conversations, preferences, bot memory, stable profile identity, token rotation and the unchanged pre-migration copy. Normal development uses the user's existing local profile.

For a release bundle with its frontend embedded, use the actual bundled executable and skip Vite:

```sh
python3 scripts/smoke-local.py --bundled --binary src-tauri/target/universal-apple-darwin/release/bundle/macos/Omnibot.app/Contents/MacOS/Omnibot
python3 scripts/smoke-local.py --bundled --arch x86_64 --binary src-tauri/target/universal-apple-darwin/release/bundle/macos/Omnibot.app/Contents/MacOS/Omnibot
```

The second command requires an Intel Mac or available Rosetta translation on Apple Silicon. Rosetta evidence does not replace physical Intel verification. `--arch arm64` explicitly selects the native Apple Silicon slice. Debug bundles still need Vite; omit `--bundled` for them. These assertions exercise the running native backend and PTY implementation; they do not establish window appearance, keyboard interaction through the native GUI, signed update installation, or provider-account compatibility.

CI installs and runs Chromium and WebKit browser tests. Its ad-hoc-signed debug bundle explicitly disables hardened runtime so Sparkle can load without a Developer ID; production release validation still requires hardened runtime and Developer ID signing. After packaging, CI runs native smoke when the macOS runner has a GUI login session; otherwise the job summary explicitly records that native qualification was not run. GUI screenshots/interaction and release upgrade checks remain separate required evidence. Follow the [test-account and relaunch isolation precautions](releasing.md#native-upgrade-validation) before native UI automation.

## Release safeguard checks

```sh
python3 -m unittest discover -s scripts -p 'test_*.py'
cargo install cargo-audit --version 0.22.2 --locked
python3 scripts/dependency-audit.py
python3 scripts/license-inventory.py
```

These checks exercise exact-SHA CI selection, rejection of source drift, scoped/expiring dependency exceptions and dependency inventory traversal. The audit checks JavaScript and Rust advisory databases; its result is time-sensitive. The license inventory records declarations for release review, not legal approval. Native signing/notarization, actual upgrade installation, physical Intel and older-macOS behavior require separate evidence in the [release protocol](releasing.md#native-upgrade-validation).

Release-tooling evidence on October 15, 2026, from the worktree based on `d75f7ea9f6af7a1a9e3cca553dfcdea9efa4e6d2`: the safeguard unit suite passed, dependency audit reported no JavaScript or Rust vulnerabilities, and the two recorded Rust warnings were confirmed absent from both macOS target graphs. The initial license inventory produced 307 package/version records; the current qualification above also bundles their collected upstream notices. A redacted Gitleaks scan of all reachable Git history reported zero matches; this is a pattern scan of reachable history, not proof that no sensitive data exists anywhere. No release was signed or published by these checks.

## Related documentation

- [User guide](../README.md)
- [Lifecycle and coordination implementation](bot-lifecycle-implementation.md)
- [Embedded terminal](embedded-terminal.md)
- [Original plan and pre-change findings](bot-lifecycle-and-coordination-plan.md)
