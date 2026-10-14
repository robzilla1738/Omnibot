# Security policy

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/robzilla1738/Omnibot/security/advisories/new). Do not post credentials, private conversations, or exploit details in a public issue. Include reproduction steps, the affected version/commit, and the impact you observed. There is no guaranteed response time.

Security fixes target the current `main` branch. Older commits and third-party CLI versions are not maintained by this project.

## Trust boundaries

Omnibot is a local desktop application. Its HTTP API binds to loopback, rejects foreign browser origins and unexpected Host headers, and has no remote authentication layer. Local processes and applications on the same machine are trusted. Do not expose the API through a public proxy or tunnel.

Bots run installed CLI tools with your user account and the permissions configured for those tools. Standard permissions are the setup default. Automatic approval can allow tools to edit files and execute commands without a prompt. Bot home folders, project folders, and Git worktrees organize data; they are not operating-system sandboxes.

The app stores conversations, memories, workspace paths, and native session IDs locally. The selected CLI may transmit prompts, source code, files, and tool results to its configured provider and maintain its own logs. Omnibot does not replace the provider's privacy, authentication, or billing settings.

Only install CLIs, custom commands, skills, and MCP configurations you trust. A discovered executable is local code, and discovery may invoke its version or model-listing commands. CLI metadata probes do not intentionally submit inference prompts.

Markdown is sanitized, avatars are validated local raster images, and state writes are atomic. These measures do not make untrusted CLI tools or arbitrary generated commands safe. Review permissions and changes appropriate to the task.

## Repository hygiene

Never commit API keys, `.env` files, signing certificates, exported conversations, or local state. Use fake CLIs and mocked data for automated tests. Release builds are currently ad-hoc signed, not Apple-notarized.
