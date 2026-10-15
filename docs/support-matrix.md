# Support and verification matrix

Omnibot currently targets macOS. A build target or implemented adapter is not a claim that every operating-system release, CLI release or provider account has been tested. Record versioned live evidence when expanding the matrix.

| Surface | Implemented scope | Verification boundary |
| --- | --- | --- |
| macOS Apple Silicon | Native app, local API, process execution and PTYs | Rust/browser fixtures, signed/notarized local bundle, isolated native API/PTY/restart smoke and selected native UI checks; actual signed update installation remains unverified |
| macOS Intel | Universal release binary includes x86_64 | Both slices inspected in the signed artifact. Rosetta execution was unavailable on the qualification host; physical Intel runtime remains unverified |
| Minimum macOS | Bundle declares macOS 11.0 | Test the release candidate on that OS before advertising verified compatibility |
| Linux / Windows | Some upstream libraries have platform implementations | Unsupported by this project; packaging, permissions, subprocesses and PTYs are not validated |
| Claude Code, Codex, OpenCode, Cursor Agent, Grok Build, Pi, Muse, Gemini CLI, Aider, Ollama | Execution adapters and adapter-specific stream/session/usage handling | Fake executable and protocol fixtures; real CLI/provider versions require explicit manual checks |
| ACP / Antigravity | Experimental one-shot plain-text adapters | No guarantee of streaming metadata, resume or compatibility with every implementation |
| Custom command | Trusted executable plus configured arguments; automated context/prompt argument or interactive PTY | Command defines its own protocol and permissions; no provider compatibility claim |
| Embedded interactive terminal | Claude Code and custom commands | Local PTY fixture coverage; live account/session behavior remains CLI-specific |
| Scheduled routines | While application/backend runs | No background launch agent and no replay of runs missed while the app was closed |
| Updates | Sparkle signatures, Developer ID/notarized release pipeline | Signing and update delivery must be verified against actual release artifacts |

For a live adapter check, record Omnibot commit, exact CLI version, macOS/CPU, authentication method, selected model, permission mode, working directory type, and which of send/stream/stop/resume/usage/interactive behaviors passed. Use a disposable project and the narrowest permissions needed. Obtain explicit authorization before paid inference or changing provider account settings. Never include credential values or private task content in the record.

See [local verification](local-verification.md) for commands and evidence scope, [release validation](releasing.md#native-upgrade-validation) for native upgrade checks, and [recovery](recovery.md) before testing existing data.
