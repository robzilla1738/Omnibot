#!/usr/bin/env python3
"""Fail on dependency advisories except reviewed warnings absent from both macOS builds."""
from datetime import date
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TARGETS = ("aarch64-apple-darwin", "x86_64-apple-darwin")


def audit_json(command):
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
    if result.returncode not in (0, 1):
        raise SystemExit(f"{' '.join(command)} failed: {result.stderr.strip()}")
    try:
        report = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise SystemExit(f"{' '.join(command)} did not return an audit report: {error}") from error
    if "error" in report:
        raise SystemExit(f"{' '.join(command)} returned an audit error.")
    return report


def accepted_warning(warning, exceptions, today):
    advisory = warning.get("advisory", {})
    package = warning["package"]
    for exception in exceptions:
        if (advisory.get("id"), package["name"], package["version"], warning["kind"]) != (
                exception["advisory"], exception["package"], exception["version"], exception["kind"]):
            continue
        if date.fromisoformat(exception["expires"]) < today:
            raise SystemExit(f"Expired dependency exception: {exception['advisory']}")
        if exception["excludedTargets"] != list(TARGETS) or not exception["reason"].strip():
            raise SystemExit(f"Invalid dependency exception: {exception['advisory']}")
        return exception
    raise SystemExit(f"Unreviewed Rust warning: {advisory.get('id', warning['kind'])} "
                     f"({package['name']} {package['version']})")


def main():
    npm = audit_json(["pnpm", "audit", "--json"])
    counts = npm["metadata"]["vulnerabilities"]
    if any(counts.values()):
        raise SystemExit(f"JavaScript dependency vulnerabilities: {counts}")
    rust = audit_json(["cargo", "audit", "--json", "--deny", "warnings", "--file", "src-tauri/Cargo.lock"])
    settings = rust["settings"]
    if settings["ignore"] or settings["target_arch"] or settings["target_os"] or settings["severity"]:
        raise SystemExit("Remove cargo-audit ignores or filters; audit the complete lockfile here.")
    if set(settings["informational_warnings"]) != {"unmaintained", "unsound", "notice"}:
        raise SystemExit("Enable all cargo-audit informational warnings before reviewing exceptions.")
    if rust["vulnerabilities"]["count"]:
        ids = [item["advisory"]["id"] for item in rust["vulnerabilities"]["list"]]
        raise SystemExit(f"Rust dependency vulnerabilities: {', '.join(ids)}")
    exceptions = json.loads((ROOT / ".github/dependency-audit-exceptions.json").read_text())
    for warnings in rust["warnings"].values():
        for warning in warnings:
            exception = accepted_warning(warning, exceptions, date.today())
            package = f"{exception['package']}@{exception['version']}"
            for target in TARGETS:
                tree = subprocess.run(["cargo", "tree", "--locked", "--manifest-path", "src-tauri/Cargo.toml",
                    "--target", target, "--edges", "normal,build", "--invert", package],
                    cwd=ROOT, text=True, capture_output=True, check=True)
                if tree.stdout.strip():
                    raise SystemExit(f"{exception['advisory']} is present in {target}; exception no longer applies.")
            print(f"Accepted {exception['advisory']}: absent from both macOS dependency graphs; "
                  f"review by {exception['expires']}.")
    print("Dependency audit passed: no vulnerabilities and no unreviewed warnings.")


if __name__ == "__main__":
    main()
