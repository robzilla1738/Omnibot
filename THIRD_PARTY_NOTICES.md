# Third-party notices

Omnibot's MIT license applies to its own code. Dependencies retain their respective licenses; installing dependencies includes their upstream notices.

Run `python3 scripts/license-inventory.py` after a frozen pnpm install to produce `release-artifacts/license-inventory.json` and `release-artifacts/THIRD-PARTY-LICENSES.txt`. The text preserves available upstream LICENSE, COPYING, NOTICE and COPYRIGHT files for installed frontend production packages and resolved Rust normal/build dependencies on Apple Silicon and Intel. Exact source-download links are included, including for MPL-covered components. The JSON records package versions, source checksums where available, package-relative notice paths and content hashes; it contains no local installation paths.

CI archives both files. The public release script copies them into the app's `Contents/Resources` before signing, verifies their integrity after archive extraction, and includes them as release assets/checksum entries. Development packaging does not by itself create this complete dependency notice resource; use the public release pipeline for redistribution.

Some published crates omit their workspace-root license files. [Reviewed overrides](.github/dependency-license-overrides.json) identify exact upstream commits, paths and SHA-256 checksums. Four crates also omit separate license files in their upstream repositories: `dispatch 0.2.0`, `selectors 0.38.0`, `sparkle-updater 0.1.0` and `tauri-plugin-sparkle-updater 0.3.0`. Their overrides preserve the actual published license declarations (and the MPL header for `selectors`), author metadata and pinned canonical license terms. They explicitly distinguish authors from copyright notices; no copyright holder or year is invented. Unknown missing texts, changed source commits and checksum mismatches stop generation. Maintainers must review changed license obligations before updating these mappings. This is a collection of upstream material, not legal certification.

The separately bundled notices below cover explicitly incorporated components and assets. Dependency security audits also include development-only dependencies even though their licenses are outside the redistribution inventory.

## T3 Code provider icon components

Provider SVG components in `src/components/icons/OmarchyIcons.tsx` were adapted from [T3 Code](https://github.com/pingdotgg/t3code). T3 Code is copyright 2026 T3 Tools Inc., distributed under the MIT license. The required notice is included in [licenses/T3-Code-MIT.txt](licenses/T3-Code-MIT.txt).

## Lucide

Interface icons use [Lucide](https://lucide.dev/), distributed under the ISC license. Its notice is included in [licenses/Lucide-ISC.txt](licenses/Lucide-ISC.txt).

## Provider names, logos, and fonts

Provider names and logos identify integrations and remain the property of their respective owners. The project license does not grant trademark rights or imply provider endorsement. Omnibot is an independent project.

The interface uses system fonts, including SF Pro on macOS. No Apple font files are redistributed in this repository.

## Sparkle

macOS updates use [Sparkle](https://sparkle-project.org/), distributed under its BSD-style license and included third-party notices. The full distribution notice is in [licenses/Sparkle.txt](licenses/Sparkle.txt) and bundled with the app. The Rust integration uses the MIT-licensed [tauri-plugin-sparkle-updater](https://github.com/ahonn/tauri-plugin-sparkle-updater) and `sparkle-updater` crates.

## Embedded terminal

The terminal uses [xterm.js](https://github.com/xtermjs/xterm.js) and its Fit, Search, and Serialize addons under the MIT license. The notice is included in [licenses/xterm-MIT.txt](licenses/xterm-MIT.txt). PTY processes use [portable-pty](https://github.com/wezterm/wezterm/tree/main/pty), copyright Wez Furlong, under the MIT license; see [licenses/portable-pty-MIT.txt](licenses/portable-pty-MIT.txt). Both notices are bundled with the app.
