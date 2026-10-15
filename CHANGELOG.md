# Changelog

## [0.1.2](https://github.com/robzilla1738/Omnibot/releases/tag/v0.1.2) — October 15, 2026

- Add embedded interactive terminals and run logs, stronger bot lifecycle handling, scoped project execution, bounded delegation, and scheduled-run grace periods.
- Preserve customized bot instructions during upgrades. Keep an immutable copy of older stores before migration, recover missing or damaged primary stores from their backup, and refuse data from a newer schema.
- Retain per-chat drafts and composer selections across navigation and restart. Preserve newer drafts when an earlier send completes or fails, and block update restarts when draft persistence fails.
- Resolve Git actions consistently from the repository root, including nested project folders and worktrees. Handle staged additions and renames safely, and bound large previews and command output.
- Preserve saved reasoning defaults, apply skills launched from the library, and prevent stale Git previews, avatar decoding and profile saves from overwriting newer choices.
- Restore sidebar menu focus reliably in WebKit, including pointer and keyboard navigation.
- Require authentication in development as well as packaged builds. Add an owner-checked `pnpm dev:connect` command; browser credentials stay in memory, so reconnect after a full reload.
- Stop leftover process-group helpers after a CLI turn and bound aggregate output and tool-call retention.
- Bind release artifacts to an exact source commit and successful CI run. Add dependency audit gates, a complete collected dependency notice bundle with provenance, browser coverage in Chromium and WebKit, and recovery/support documentation.

Existing bundle identity, update feed and signing key are preserved. Before returning to an older app version, quit Omnibot and follow [the recovery procedure](docs/recovery.md); an older binary cannot enforce the new schema guard. Drafts use local webview storage and should be copied separately before clearing application/browser data.
