#!/usr/bin/env python3
"""Build a signed, notarized universal release candidate. Publication is separate."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
ACCOUNT = "com.robzilla1738.botfinity"
REPO = "robzilla1738/Omnibot"
FEED = f"https://raw.githubusercontent.com/{REPO}/main/updates/appcast.xml"
PUBLIC_KEY = "gVxSpK9LIK1HFk3Nf129RSmcKfVBnY76eG7a4gPv5QU="


def run(*args, capture=False):
    return subprocess.run([str(a) for a in args], cwd=ROOT, check=True,
                          text=True, capture_output=capture)


def sign_app(app, identity):
    # Tauri does not sign Sparkle's Updater.app and Autoupdate helper. Seal all
    # nested code explicitly, inside out, before signing the containing app.
    framework = app / "Contents/Frameworks/Sparkle.framework"
    base = framework / "Versions/B"
    for path in [base / "Autoupdate", base / "Updater.app",
                 base / "XPCServices/Downloader.xpc", base / "XPCServices/Installer.xpc",
                 framework, app]:
        if not path.exists():
            raise SystemExit(f"Missing required signing target: {path}")
        run("codesign", "--force", "--options", "runtime", "--timestamp", "--sign", identity, path)


def validate_app(app, version, team):
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    expected = {"CFBundleIdentifier": ACCOUNT, "CFBundleShortVersionString": version,
                "CFBundleVersion": version, "SUFeedURL": FEED,
                "SUPublicEDKey": PUBLIC_KEY, "SURequireSignedFeed": True,
                "SUVerifyUpdateBeforeExtraction": True}
    for key, value in expected.items():
        if info.get(key) != value:
            raise SystemExit(f"Unexpected {key}: {info.get(key)!r}")
    binary = app / "Contents/MacOS/Omnibot"
    if set(run("lipo", "-archs", binary, capture=True).stdout.split()) != {"arm64", "x86_64"}:
        raise SystemExit("Release must include Apple Silicon and Intel.")
    signature = run("codesign", "-dvv", app, capture=True).stderr
    if f"TeamIdentifier={team}" not in signature or "runtime" not in signature or "Timestamp=" not in signature:
        raise SystemExit("Release requires the expected Developer ID, hardened runtime, and timestamp.")
    if not (app / "Contents/Frameworks/Sparkle.framework").exists():
        raise SystemExit("Missing Sparkle framework.")
    validate_notices(app)
    rpaths = run("otool", "-l", binary, capture=True).stdout
    if any(str(ROOT) in line for line in rpaths.splitlines() if line.strip().startswith("path ")):
        raise SystemExit("Release contains a development framework search path.")
    run("codesign", "--verify", "--deep", "--strict", app)


def validate_notices(app):
    resources = app / "Contents/Resources"
    inventory = resources / "dependency-license-inventory.json"
    notices = resources / "THIRD-PARTY-LICENSES.txt"
    if not inventory.is_file() or not notices.is_file():
        raise SystemExit("Release is missing its dependency notice bundle or provenance inventory.")
    report = json.loads(inventory.read_text())
    if report["noticeBundle"]["sha256"] != hashlib.sha256(notices.read_bytes()).hexdigest():
        raise SystemExit("Bundled dependency notices do not match their provenance inventory.")
    if not report["packages"] or any(not package["noticeFiles"] for package in report["packages"]):
        raise SystemExit("Release dependency notice coverage is incomplete.")


def notarize(path, profile):
    result = run("xcrun", "notarytool", "submit", path, "--keychain-profile", profile,
                 "--wait", "--output-format", "json", capture=True)
    receipt = json.loads(result.stdout)
    print(f"Notarization: {receipt.get('status')} ({receipt.get('id')})", flush=True)
    if receipt.get("status") != "Accepted":
        raise SystemExit("Apple rejected this artifact; inspect its notarization log before continuing.")
    return receipt


def check_versions(version):
    config = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())
    cargo = re.search(r'(?m)^version = "([^"]+)"', (ROOT / "src-tauri/Cargo.toml").read_text())
    lock = re.search(r'name = "omnibot"\nversion = "([^"]+)"', (ROOT / "src-tauri/Cargo.lock").read_text())
    found = {"src-tauri/tauri.conf.json": config["version"],
             "src-tauri/Cargo.toml": cargo and cargo[1], "src-tauri/Cargo.lock": lock and lock[1]}
    mismatched = [f"{name}={value!r}" for name, value in found.items() if value != version]
    if mismatched:
        raise SystemExit(f"package.json is {version}, but: {', '.join(mismatched)}.")


def check_source():
    if run("git", "status", "--porcelain", capture=True).stdout.strip():
        raise SystemExit("Commit or stash local changes; releases must build the exact committed source.")
    origin = run("git", "remote", "get-url", "origin", capture=True).stdout.strip()
    if origin.removesuffix(".git") not in {f"https://github.com/{REPO}", f"git@github.com:{REPO}"}:
        raise SystemExit(f"origin must be the release repository {REPO}.")
    source = run("git", "rev-parse", "HEAD", capture=True).stdout.strip()
    run("git", "fetch", "--quiet", "origin", "main")
    run("git", "merge-base", "--is-ancestor", source, "FETCH_HEAD")
    response = json.loads(run("gh", "api", "--method", "GET",
        f"repos/{REPO}/actions/workflows/ci.yml/runs", "-f", f"head_sha={source}",
        "-f", "event=push", "-f", "branch=main", "-f", "per_page=100", capture=True).stdout)
    ci = verified_ci_run(response["workflow_runs"], source)
    tag = run("git", "ls-remote", "--tags", "origin", f"refs/tags/v{release_version()}", capture=True).stdout
    if tag.strip():
        raise SystemExit("This version already has a remote tag. Never replace a published version.")
    return source, ci


def verified_ci_run(runs, source):
    candidates = [item for item in runs if item["head_sha"] == source
                  and item["event"] == "push" and item["head_branch"] == "main"]
    if not candidates:
        raise SystemExit("No main-branch CI run exists for the exact source commit.")
    latest = max(candidates, key=lambda item: (item["run_number"], item["run_attempt"]))
    if latest["status"] != "completed" or latest["conclusion"] != "success":
        raise SystemExit("The latest CI run for this source commit must complete successfully.")
    return {key: latest[key] for key in ("id", "run_attempt", "html_url", "head_sha")}


def release_version():
    version = json.loads((ROOT / "package.json").read_text())["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise SystemExit("Public releases require a stable major.minor.patch version.")
    return version


def check_source_unchanged(source, version):
    if run("git", "rev-parse", "HEAD", capture=True).stdout.strip() != source:
        raise SystemExit("Source commit changed during the release build; discard this candidate.")
    if run("git", "status", "--porcelain", capture=True).stdout.strip():
        raise SystemExit("Source files changed during the release build; discard this candidate.")
    if release_version() != version:
        raise SystemExit("Release version changed during the build; discard this candidate.")
    check_versions(version)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--identity", required=True, help="Developer ID Application signing identity")
    parser.add_argument("--keychain-profile", required=True, help="Existing notarytool profile name (not a password)")
    args = parser.parse_args()
    if not args.identity.startswith("Developer ID Application:"):
        parser.error("Use a Developer ID Application identity.")
    team_match = re.search(r"\(([A-Z0-9]{10})\)$", args.identity)
    if not team_match:
        parser.error("Identity must include its 10-character Apple team ID.")
    version = release_version()
    check_versions(version)
    source, ci = check_source()
    # Validate credentials before spending time compiling. Never log account history.
    run("xcrun", "notarytool", "history", "--keychain-profile", args.keychain_profile,
        "--output-format", "json", capture=True)
    run("pnpm", "setup:sparkle")
    tools = ROOT / ".cache/sparkle/2.10.0/bin"
    if run(tools / "generate_keys", "--account", ACCOUNT, "-p", capture=True).stdout.strip() != PUBLIC_KEY:
        raise SystemExit("Sparkle Keychain key does not match the app's verification key.")
    os.environ["PATH"] = f"/opt/homebrew/opt/rustup/bin:{Path.home()}/.cargo/bin:" + os.environ["PATH"]
    run("rustup", "target", "add", "aarch64-apple-darwin", "x86_64-apple-darwin")
    run("pnpm", "tauri:build", "--target", "universal-apple-darwin", "--bundles", "app",
        "--config", json.dumps({"bundle": {"macOS": {"signingIdentity": args.identity}}}))
    check_source_unchanged(source, version)
    app = ROOT / "src-tauri/target/universal-apple-darwin/release/bundle/macos/Omnibot.app"
    out = ROOT / "release-artifacts" / version
    if out.exists():
        raise SystemExit(f"Candidate already exists at {out}; archive it before building a replacement.")
    out.mkdir(parents=True)
    run("python3", ROOT / "scripts/license-inventory.py", "--output", out / "license-inventory.json")
    shutil.copyfile(out / "THIRD-PARTY-LICENSES.txt", app / "Contents/Resources/THIRD-PARTY-LICENSES.txt")
    shutil.copyfile(out / "license-inventory.json", app / "Contents/Resources/dependency-license-inventory.json")
    sign_app(app, args.identity)
    validate_app(app, version, team_match[1])
    with tempfile.TemporaryDirectory(prefix="omnibot-notarize-") as temp:
        upload = Path(temp) / "Omnibot.zip"
        run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, upload)
        receipt = notarize(upload, args.keychain_profile)
    (out / "app-notarization.json").write_text(json.dumps(receipt, indent=2) + "\n")
    run("xcrun", "stapler", "staple", app)
    run("xcrun", "stapler", "validate", app)
    run("spctl", "--assess", "--type", "execute", "--verbose", app)
    archive_dir = out / "sparkle"
    archive_dir.mkdir()
    archive = archive_dir / f"Omnibot-{version}-universal.zip"
    run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, archive)
    # Validate what users actually receive, including preserved symlinks and ticket.
    with tempfile.TemporaryDirectory(prefix="omnibot-verify-") as temp:
        run("ditto", "-x", "-k", archive, temp)
        extracted = Path(temp) / "Omnibot.app"
        validate_app(extracted, version, team_match[1])
        run("xcrun", "stapler", "validate", extracted)
        run("spctl", "--assess", "--type", "execute", extracted)
    dmg = out / f"Omnibot-{version}-universal.dmg"
    with tempfile.TemporaryDirectory(prefix="omnibot-dmg-") as temp:
        run("ditto", app, Path(temp) / "Omnibot.app")
        (Path(temp) / "Applications").symlink_to("/Applications")
        run("hdiutil", "create", "-volname", "Omnibot", "-srcfolder", temp,
            "-format", "UDZO", dmg)
    run("codesign", "--force", "--timestamp", "--sign", args.identity, dmg)
    receipt = notarize(dmg, args.keychain_profile)
    (out / "dmg-notarization.json").write_text(json.dumps(receipt, indent=2) + "\n")
    run("xcrun", "stapler", "staple", dmg)
    run("codesign", "--verify", "--strict", dmg)
    run("xcrun", "stapler", "validate", dmg)
    run("spctl", "--assess", "--type", "open", "--context", "context:primary-signature", dmg)
    existing_feed = ROOT / "updates/appcast.xml"
    if existing_feed.exists():
        shutil.copyfile(existing_feed, archive_dir / "appcast.xml")
    run(tools / "generate_appcast", "--account", ACCOUNT, "--maximum-deltas", "0",
        "--download-url-prefix", f"https://github.com/{REPO}/releases/download/v{version}/", archive_dir)
    feed = archive_dir / "appcast.xml"
    run(tools / "sign_update", "--account", ACCOUNT, "--verify", feed)
    enclosure = next((e for e in ET.parse(feed).iter("enclosure") if e.attrib["url"].endswith(archive.name)), None)
    if enclosure is None or int(enclosure.attrib["length"]) != archive.stat().st_size:
        raise SystemExit("Generated feed does not match final archive.")
    signature = enclosure.attrib["{http://www.andymatuschak.org/xml-namespaces/sparkle}edSignature"]
    run(tools / "sign_update", "--account", ACCOUNT, "--verify", archive, signature)
    check_source_unchanged(source, version)
    manifest = {"version": version, "sourceCommit": source, "repository": REPO,
                "createdAt": datetime.now(timezone.utc).isoformat(), "ci": ci,
                "artifacts": {str(p.relative_to(out)): hashlib.sha256(p.read_bytes()).hexdigest()
                              for p in (archive, dmg, feed, out / "license-inventory.json", out / "THIRD-PARTY-LICENSES.txt")},
                "lockfiles": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                              for p in (ROOT / "pnpm-lock.yaml", ROOT / "src-tauri/Cargo.lock")}}
    (out / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (out / "SHA256SUMS.txt").write_text("".join(
        f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n"
        for p in [archive, dmg, out / "release-manifest.json", out / "license-inventory.json", out / "THIRD-PARTY-LICENSES.txt"]))
    print(f"Verified release candidate: {out}\nPublish the assets before publishing {feed}.")


if __name__ == "__main__":
    main()
