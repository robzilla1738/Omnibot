# Security policy

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/robzilla1738/Omnibot/security/advisories/new). Do not post credentials, private conversations, or exploit details in a public issue. Include reproduction steps, the affected version/commit, and the impact you observed. There is no guaranteed response time.

Security fixes target the current `main` branch. Older commits and third-party CLI versions are not maintained by this project.

## Trust boundaries

Omnibot is a local desktop application. Its HTTP API binds to loopback, rejects foreign browser origins and unexpected Host headers, and requires a random token regenerated at each startup and stored in `<data directory>/api-token` (readable only by your user on supported macOS installations). Development browser sessions also authenticate; `pnpm dev:connect` passes the connection through a browser URL fragment, which is removed after import into memory. Credentials are not persisted in browser storage; reconnect after a full reload. The connector checks that both listeners belong to your OS account. Treat the browser tab, Vite server and its development code as trusted for the entire session; stop the backend when you stop Vite, especially on a shared machine. Packaged API authentication excludes unrelated web pages and other users' processes, but any process running as your user can read the token and is trusted. Do not expose the API through a public proxy or tunnel.

Bots run installed CLI tools with your user account, the environment from your login shell, and the permissions configured for those tools. Quitting Omnibot stops running bot processes. Standard permissions are the setup default. Automatic approval can allow tools to edit files and execute commands without a prompt. Bot home folders, project folders, and Git worktrees organize data; they are not operating-system sandboxes.

The app stores conversations, memories, workspace paths, and native session IDs locally. The selected CLI may transmit prompts, source code, files, and tool results to its configured provider and maintain its own logs. Omnibot does not replace the provider's privacy, authentication, or billing settings.

Only install CLIs, custom commands, skills, and MCP configurations you trust. A discovered executable is local code, and discovery may invoke its version or model-listing commands. CLI metadata probes do not intentionally submit inference prompts.

Markdown is sanitized, links in chats open in your default browser instead of the app window, avatars are validated local raster images, and state writes are atomic with a rolling backup. These measures do not make untrusted CLI tools or arbitrary generated commands safe. Review permissions and changes appropriate to the task.

File preview accepts absolute paths and paths relative to the selected workspace. Known credential paths and private application state are blocked; the workspace is not a filesystem sandbox. Browser run logs and provider errors can contain sensitive tool output. Share only redacted diagnostics. See [recovery](docs/recovery.md) for preserving state before upgrades or rollback.

Dependency checks fail on known vulnerabilities and unreviewed warnings. The two reviewed Rust lockfile warnings in [the exception file](.github/dependency-audit-exceptions.json) apply only while the exact affected packages are absent from both supported macOS build graphs, and expire on the recorded date. They do not authorize shipping affected Linux builds. See [contributor checks](CONTRIBUTING.md) for running the audit.

## Repository hygiene

Never commit API keys, `.env` files, signing certificates, exported conversations, or local state. Use fake CLIs and mocked data for automated tests. Published release builds are Developer ID signed and Apple-notarized; local development builds are ad-hoc signed.
