# Signing, notarization, and updates

Omnibot uses Sparkle 2.10.0 for native macOS updates. `scripts/setup-sparkle.py` downloads the official distribution and verifies its pinned SHA-256 checksum before extraction. The framework is bundled with the app; its license is included in `licenses/Sparkle.txt`.

## Update behavior

Use **Omnibot → Check for Updates…** in the macOS menu or **Omnibot Hub → App updates**. Daily automatic checks are enabled by default and can be disabled in App updates. Installation requires user interaction; automatic installation and system profiling are disabled. The updater refuses manual checks and vetoes update installation/relaunch while CLI workflows are running. Finish tasks and save any unsent draft before installing an update.

The HTTPS feed is `https://raw.githubusercontent.com/robzilla1738/Omnibot/main/updates/appcast.xml`. Both the feed and update archive require Ed25519 signatures. The app verifies an archive before extracting it. The public verification key is in `src-tauri/Info.plist`; the private key stays in the maintainer's Keychain under account `com.robzilla1738.botfinity`. This legacy identifier is retained for compatibility with existing installations. Do not change the key or identifier for an established app.

An installation from before Sparkle was added needs one manual upgrade to a signed release. Later releases can arrive through Sparkle.

## Development builds

Install dependencies and run `pnpm setup:sparkle` before Rust tests or checks. `pnpm tauri:dev` and `pnpm tauri:build` run setup automatically. Development builds use ad-hoc signing. The manually dispatched GitHub package workflow produces a development artifact only; it cannot publish unsigned public releases. CI does not have access to the maintainer's local Keychain.

## Prepare a public release on macOS

You need a valid **Developer ID Application** certificate, a working `notarytool` Keychain profile, and the existing Sparkle private key. Never commit or print private credentials. See Apple's [notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow) and Sparkle's [publishing documentation](https://sparkle-project.org/documentation/publishing/).

1. Bump the version in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`. Never reuse a published version.
2. Run the CI checks locally: frontend build, Rust formatting/tests/Clippy, and browser tests. Commit the release source and push it; require successful CI before publication.
3. Build the universal candidate with the existing local credentials:

   ```sh
   python3 scripts/release-macos.py \
     --identity 'Developer ID Application: Your Name (TEAMID1234)' \
     --keychain-profile your-existing-profile
   ```

The script checks credential availability, builds Apple Silicon and Intel slices, signs the complete app, submits it to Apple, and requires `Accepted`. It staples and verifies the app, creates a ZIP preserving framework symlinks, and re-extracts the ZIP to verify its actual signature, notarization, architecture, version, and embedded update configuration. It also creates, signs, notarizes, and staples a DMG. Finally it generates and verifies the signed appcast and SHA-256 checksums. Outputs stay in ignored `release-artifacts/<version>/`; the live feed is unchanged.

If a candidate directory already exists, archive it before making a replacement. Do not replace a candidate after it has been published. Failed notarization submissions can be inspected with `xcrun notarytool log <submission-id> --keychain-profile <profile>`.

## Publish in this order

1. Create a draft GitHub Release `v<version>` pointing at the verified source commit. Upload the universal DMG, ZIP, and `SHA256SUMS.txt`. Use a release-notes file with `gh release create --notes-file`.
2. Publish the release. Download the public artifacts and verify their checksums and signatures.
3. Copy the generated `release-artifacts/<version>/sparkle/appcast.xml` to `updates/appcast.xml`, commit, and push. **Never publish a feed before its downloads exist.** Do not hand-edit or format signed XML.
4. Download the live feed and verify it with Sparkle's `sign_update --account com.robzilla1738.botfinity --verify <feed.xml>`. Check the native updater in the installed app.

GitHub-hosted signed releases would need separately provisioned certificate, notarization, and Sparkle credentials. Local Keychain access alone does not configure them. Forks must supply their own signing identity, bundle identifier, update key, and feed URL.

The universal binary contains both architectures. Runtime testing on an Apple Silicon development Mac does not establish Intel or older macOS compatibility; test those on corresponding hardware before claiming that coverage.
