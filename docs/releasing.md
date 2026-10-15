# Signing, notarization, and updates

Omnibot uses Sparkle 2.10.0 for native macOS updates. `scripts/setup-sparkle.py` downloads the official distribution and verifies its pinned SHA-256 checksum before extraction. The framework is bundled with the app; its license is included in `licenses/Sparkle.txt`.

## Update behavior

Use **Omnibot → Check for Updates…** in the macOS menu or **Omnibot Hub → App updates**. Daily automatic checks are enabled by default and can be disabled in App updates. Installation requires user interaction; automatic installation and system profiling are disabled. The updater refuses manual checks and vetoes update installation/relaunch while CLI workflows are running. Finish tasks and save any unsent draft before installing an update.

The HTTPS feed is `https://raw.githubusercontent.com/robzilla1738/Omnibot/main/updates/appcast.xml`. Both the feed and update archive require Ed25519 signatures. The app verifies an archive before extracting it. The public verification key is in `src-tauri/Info.plist`; the private key stays in the maintainer's Keychain under account `com.robzilla1738.botfinity`. This legacy identifier is retained for compatibility with existing installations. Do not change the key or identifier for an established app.

An installation from before Sparkle was added needs one manual upgrade to a signed release. Later releases can arrive through Sparkle.

## Development builds

Install dependencies and run `pnpm setup:sparkle` before Rust tests or checks. `pnpm tauri:dev` and `pnpm tauri:build` run setup automatically. Development builds use ad-hoc signing. The manually dispatched GitHub package workflow produces a development artifact only; it cannot publish unsigned public releases. CI does not have access to the maintainer's local Keychain.

## Prepare a public release on macOS

You need a valid **Developer ID Application** certificate, a working `notarytool` Keychain profile, the existing Sparkle private key, and `gh` authenticated with read access to this repository's Actions runs. Never commit or print private credentials. See Apple's [notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow) and Sparkle's [publishing documentation](https://sparkle-project.org/documentation/publishing/).

1. Bump the version in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`. Never reuse a published version.
2. Run the CI checks locally, including release-script unit checks, dependency audit and license inventory. Review the inventory's upstream notice obligations and the [native upgrade validation](#native-upgrade-validation). Commit the release source, merge it to `main`, and wait for the latest `CI` push run for that exact commit to succeed. A passing PR run for a different merge SHA is insufficient.
3. Build the universal candidate with the existing local credentials:

   ```sh
   python3 scripts/release-macos.py \
     --identity 'Developer ID Application: Your Name (TEAMID1234)' \
     --keychain-profile your-existing-profile
   ```

The script first refuses to run unless all four version numbers match, the working tree is clean, `origin` is the intended GitHub repository, and `HEAD` belongs to remote `main`. It requires the latest push CI run for that exact SHA to have succeeded and rejects an existing remote version tag. It checks source/commit/version stability again after compilation and before accepting final artifacts; do not edit or switch the release checkout while it runs.

It then checks credential availability and builds Apple Silicon and Intel slices. It collects dependency license/notice texts and provenance, including reviewed immutable upstream sources when package archives omit their license files; missing or mismatched sources stop the release. The generated `THIRD-PARTY-LICENSES.txt` and inventory are copied into the app resources before signing. The script signs the complete app, submits it to Apple, and requires `Accepted`. It staples and verifies the app, creates a ZIP preserving framework symlinks, and re-extracts the ZIP to verify its actual signature, notarization, architecture, version, embedded update configuration and notice-bundle integrity. It also creates, signs, notarizes, and staples a DMG. Finally it generates and verifies the signed appcast and SHA-256 checksums. `release-manifest.json` binds the source SHA, successful CI run/attempt/URL, lockfile hashes and final artifact hashes. Outputs stay in ignored `release-artifacts/<version>/`; the live feed is unchanged.

If a candidate directory already exists, archive it before making a replacement. Do not replace a candidate after it has been published. Failed notarization submissions can be inspected with `xcrun notarytool log <submission-id> --keychain-profile <profile>`.

## Publish in this order

1. Read `sourceCommit` from the verified candidate's `release-manifest.json`; create a draft GitHub Release `v<version>` targeting that exact full SHA, not the current branch tip. Upload the universal DMG, ZIP, `release-manifest.json`, `license-inventory.json`, `THIRD-PARTY-LICENSES.txt`, and `SHA256SUMS.txt`. Use a release-notes file with `gh release create --notes-file`. Include upgrade/recovery instructions and any unverified platform/provider combinations.
2. Publish the release. Download the public artifacts into a fresh directory, run `shasum -a 256 -c SHA256SUMS.txt`, compare the manifest's commit with the release tag, and verify the extracted app's code signature, notarization ticket and version. Check the ZIP's Sparkle signature against its enclosure in the candidate feed. Preserve the results with the release evidence.
3. Copy the generated `release-artifacts/<version>/sparkle/appcast.xml` to `updates/appcast.xml`, commit, and push. **Never publish a feed before its downloads exist.** Do not hand-edit or format signed XML.
4. Download the live feed and verify it with Sparkle's `sign_update --account com.robzilla1738.botfinity --verify <feed.xml>`. Check the native updater in the installed app.

GitHub-hosted signed releases would need separately provisioned certificate, notarization, and Sparkle credentials. Local Keychain access alone does not configure them. Forks must supply their own signing identity, bundle identifier, update key, and feed URL.

The universal binary contains both architectures. Runtime testing on an Apple Silicon development Mac does not establish Intel or older macOS compatibility; test those on corresponding hardware before claiming that coverage.

## Native upgrade validation

Use disposable profiles and a disposable project with fake CLI tools for these checks. Keep the production data directory, provider accounts and published feed untouched. Record the old/new app versions, candidate source SHA and artifact hashes, macOS/CPU, actual commands and results. A source-built qualification app is useful evidence but is not a publishable candidate until the source/CI/signing/notarization gates above pass.

Use a dedicated macOS test account for GUI and updater-relaunch qualification. `HOME` and `OMNI_BOT_HOME` apply only to the explicitly launched process; Launch Services, UI automation and Sparkle relaunches can omit them and open the default profile. For environment-only subprocess checks, stop UI automation before quitting, relaunch explicitly with the isolated environment, and verify the profile identity before continuing. Do not inspect a closed test app with a tool that can reopen it.

1. **Before upgrade:** in the previous supported app, create/edit bot names, prompts, personal/project/shared memories, chat ownership, model choices, sidebar order and routines. Include an archived bot, a project chat, native session metadata, and clean/dirty worktrees. Quit; retain a private full-profile backup and separate repository backup. Do not use real secrets in fixtures.
2. **First upgraded launch:** run the candidate with `OMNI_BOT_HOME` pointing to a copy. Confirm migration-copy creation and exact preservation of original bytes, schema/layout versions, every saved setting, message provenance, ownership and project location. Confirm interrupted tasks are displayed honestly, and disabled routines remain disabled. Quit and reopen to check migration idempotence.
3. **New work:** send a fake CLI request, use/stop the interactive PTY, edit memory, change a model, archive/restore a bot, and verify saved changes after restarting. Test cancel/quit during queued and active work. Ensure dirty/unmerged worktrees survive deletion and Git error paths.
4. **Recovery:** on separate copies, remove the primary store, corrupt it, provide an unsupported future schema, and simulate an unwritable data directory. Verify the expected backup restoration or refusal, preserved source bytes, actionable UI notices and retry behavior. Never perform these mutations on a real profile.
5. **Rollback:** use the previous application with a pre-upgrade compatible copy in another directory, following [recovery](recovery.md). Verify history and settings. Do not interpret an old app opening newer data as safe downgrade support.
6. **Updater:** verify the candidate's embedded feed/key settings, signatures and notarization. Exercise native Check for Updates and automatic-check settings, then repeat while a fake workflow or terminal owns a chat to confirm the install/relaunch veto. Complete actual signed update installation/relaunch testing in a controlled staging setup before claiming end-to-end updater coverage; opening the settings panel or receiving a network error is insufficient. Do not publish a production feed solely to test an unreviewed candidate.
7. **Platforms:** repeat critical startup, migration, PTY and update checks on physical Intel and the oldest supported macOS version. Record unavailable hardware as unverified. Universal architecture inspection is only a packaging check.

Keep the signed candidate, manifest, checksums, CI URL and redacted test record together. A failure in migration, source binding, signing, notarization or artifact verification blocks publication. Hardware/provider gaps must be explicit in release claims and the [support matrix](support-matrix.md).
