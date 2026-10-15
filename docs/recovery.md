# Backups, upgrades, and recovery

Quit Omnibot before copying or repairing its data. The default directory is `~/.omni-bot`; `OMNI_BOT_HOME` overrides it. Use one running app per directory. A copy of Omnibot's data does not back up external project repositories, provider configuration, credentials, or CLI-owned conversation history.

Before upgrading important data, copy the entire data directory to a private backup location and record the installed application version. Keep a separate backup of project repositories, including uncommitted work. Git worktrees refer to their original repository metadata: copying their directories alone does not create independent, portable repositories.

For the default profile, this makes a dated backup without replacing an earlier one:

```sh
backup="$HOME/Omnibot-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
chmod 700 "$HOME/Omnibot-backups" "$backup"
ditto "$HOME/.omni-bot" "$backup/data"
```

Use the actual custom data directory if `OMNI_BOT_HOME` is set. Keep backups private: they contain conversations, memories, workspace paths and session identifiers. The API token in a backup expires when that profile's backend next starts.

## What startup preserves

The current schema is version 1; stores without `schemaVersion` are legacy version 0. Before a schema or home-layout migration, the original bytes are preserved as a unique `store.pre-migration-schema-<version>-home-<version>-<id>.json`. These copies are not rotated by ordinary saves. Keep them until you have verified the upgraded profile.

`store.json.bak` is the rolling previous save, not a permanent pre-upgrade backup. If the primary store is missing or corrupt and this backup is valid, startup restores it. Damaged primary bytes are preserved as `store.corrupt-<id>.json`. A recovery can lose the most recent save; check the visible conversations and settings before continuing. Unsupported future schemas or home layouts are refused without overwriting them.

If recovery fails, preserve the whole folder and the startup error before attempting repairs. Do not delete the original or repeatedly replace files in the active profile. A persistence failure shown by the UI needs attention before further work; retries cannot guarantee recovery of changes that never reached disk.

## Restore or roll back safely

1. Quit every app using the profile. Preserve the current data folder, even if it appears damaged.
2. Create a separate private recovery directory. Copy your known-good pre-upgrade backup into it, or copy a compatible `store.pre-migration-*.json` into that directory as `store.json`. A store-only restore does not restore bot-home files or external projects.
3. Launch the intended application explicitly with `OMNI_BOT_HOME` pointing to the recovery directory. For example, with `recovery` set to the directory you prepared: `OMNI_BOT_HOME="$recovery" /Applications/Omnibot.app/Contents/MacOS/Omnibot`.
4. Check bot names, memories, chats, ownership, model choices, project locations and routines before sending messages. Disable scheduled routines while evaluating restored data. Restored paths may still point to live projects, and CLIs still use their normal provider accounts.
5. Keep the original profile and backup until the recovered copy has survived a clean quit/restart and you have verified any project work separately.

Do not launch an old binary against the only copy of an upgraded profile. Older releases may not understand schema guards and can drop newer fields even when they appear to open successfully. Roll back using both the older app and its compatible pre-upgrade data copy. Without a compatible copy, preserve the data and report the problem privately instead of trying successive older binaries.

For a bug report, include the app version/commit, macOS and CPU architecture, the error, and whether a backup or migration copy exists. Do not attach the store, API token, native sessions, or unredacted logs to a public issue. Use [private vulnerability reporting](../SECURITY.md) for security-sensitive failures.
