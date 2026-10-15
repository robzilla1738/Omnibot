#!/usr/bin/env python3
"""Collect exact dependency notices and provenance for redistribution with the macOS app."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TARGETS = ("aarch64-apple-darwin", "x86_64-apple-darwin")
NOTICE_PREFIXES = ("LICENSE", "LICENCE", "COPYING", "NOTICE", "COPYRIGHT")


def read_json(*command):
    return json.loads(subprocess.run(command, cwd=ROOT, check=True, text=True,
                                     stdout=subprocess.PIPE).stdout)


def production_packages(metadata):
    nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
    pending = [metadata["resolve"]["root"]]
    selected = set()
    while pending:
        package = pending.pop()
        if package in selected:
            continue
        selected.add(package)
        pending.extend(dependency["pkg"] for dependency in nodes[package]["deps"]
                       if any(kind["kind"] != "dev" for kind in dependency["dep_kinds"]))
    return [package for package in metadata["packages"] if package["id"] in selected]


def notice_paths(root, license_file=None):
    paths = {path for path in root.rglob("*") if path.is_file()
             and path.name.upper().startswith(NOTICE_PREFIXES)}
    if license_file:
        paths.add(root / license_file)
    for path in paths:
        if not path.resolve().is_relative_to(root.resolve()):
            raise SystemExit(f"License path escapes its installed package: {path.name}")
    return sorted(paths)


def pinned_text(reference):
    cache = ROOT / ".cache/license-notices" / reference["sha256"]
    if cache.exists():
        content = cache.read_bytes()
    else:
        request = urllib.request.Request(reference["url"], headers={"User-Agent": "Omnibot-license-notices"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                content = response.read()
        except urllib.error.URLError as error:
            raise SystemExit(f"Cannot obtain pinned license source {reference['url']}: {error}") from error
    if hashlib.sha256(content).hexdigest() != reference["sha256"]:
        raise SystemExit(f"License source checksum mismatch: {reference['url']}")
    text = content.decode("utf-8")
    if not text.strip():
        raise SystemExit(f"Empty upstream license file: {reference['url']}")
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(content)
    return text


def package_notices(record, root, paths, overrides):
    files = []
    for path in paths:
        content = path.read_bytes()
        text = content.decode("utf-8-sig")
        if not text.strip():
            raise SystemExit(f"Empty license file: {record['name']} {path.name}")
        files.append(({"path": path.relative_to(root).as_posix(), "origin": "installed package",
                       "sha256": hashlib.sha256(content).hexdigest()}, text))
    if any(path.name.upper().startswith(("LICENSE", "LICENCE", "COPYING"))
           and path.suffix.lower() not in (".spdx", ".json") for path in paths):
        return files
    key = f"{record['name']}@{record['version']}"
    override = overrides.get(record["ecosystem"], {}).get(key)
    if not override:
        raise SystemExit(f"No upstream license text for {record['ecosystem']}:{key}; add a reviewed, pinned source.")
    commit = override["commit"]
    if record["ecosystem"] == "cargo":
        commit = json.loads((root / ".cargo_vcs_info.json").read_text())["git"]["sha1"]
    if commit != override["commit"] or record["license"] != override["declaredLicense"]:
        raise SystemExit(f"License override no longer matches the published source: {key}")
    record["noticeOverride"] = override["reason"]
    if override.get("registryMetadata"):
        record["registryMetadata"] = override["registryMetadata"]
    record["upstreamCommit"] = f"https://github.com/{override['repository']}/tree/{commit}"
    for reference in override.get("files", []):
        files.append((reference | {"origin": "immutable upstream workspace"}, pinned_text(reference)))
    for relative in override.get("declarations", []):
        path = root / relative
        content = path.read_bytes()
        files.append(({"path": relative, "origin": "published upstream license declaration",
                       "sha256": hashlib.sha256(content).hexdigest()}, content.decode("utf-8")))
    if "standardLicense" in override:
        reference = overrides["standardLicenses"][override["standardLicense"]]
        files.append((reference | {"origin": "canonical license terms; not an upstream copyright notice"},
                      pinned_text(reference)))
    if not files:
        raise SystemExit(f"Empty license override: {key}")
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "release-artifacts/license-inventory.json")
    parser.add_argument("--notices", type=Path, help="Default: THIRD-PARTY-LICENSES.txt beside the JSON inventory")
    args = parser.parse_args()
    notices_path = args.notices or args.output.with_name("THIRD-PARTY-LICENSES.txt")
    overrides = json.loads((ROOT / ".github/dependency-license-overrides.json").read_text())
    javascript = read_json("pnpm", "licenses", "list", "--prod", "--json")
    packages = []
    sources = {}
    for license_name, entries in javascript.items():
        for entry in entries:
            for directory in entry["paths"]:
                root = Path(directory)
                package = json.loads((root / "package.json").read_text())
                name, version = package["name"], package["version"]
                if name != entry["name"] or version not in entry["versions"]:
                    raise SystemExit("Installed npm package does not match the license report.")
                key = ("npm", name, version)
                if key in sources:
                    continue
                packages.append({"ecosystem": "npm", "name": name, "version": version,
                                 "license": license_name, "targets": ["frontend"],
                                 "sourceDownload": f"https://registry.npmjs.org/{name}/-/{name.split('/')[-1]}-{version}.tgz"})
                sources[key] = (root, notice_paths(root))
    rust = {}
    for target in TARGETS:
        metadata = read_json("cargo", "metadata", "--locked", "--format-version", "1",
                             "--manifest-path", "src-tauri/Cargo.toml", "--filter-platform", target)
        for package in production_packages(metadata):
            item = rust.setdefault(package["id"], {"ecosystem": "cargo", "name": package["name"],
                "version": package["version"], "license": package["license"],
                "authors": package["authors"], "targets": []})
            item["targets"].append(target)
            key = ("cargo", package["name"], package["version"])
            if key in sources:
                continue
            if package["id"] == metadata["resolve"]["root"]:
                sources[key] = (ROOT, [ROOT / "LICENSE"])
                continue
            root = Path(package["manifest_path"]).parent
            sources[key] = (root, notice_paths(root, package["license_file"]))
            item["sourceDownload"] = f"https://crates.io/api/v1/crates/{package['name']}/{package['version']}/download"
            checksum_file = root / ".cargo-checksum.json"
            if checksum_file.exists():
                item["sourceArchiveSha256"] = json.loads(checksum_file.read_text())["package"]
    packages.extend(rust.values())
    missing = [f"{item['ecosystem']}:{item['name']}@{item['version']}" for item in packages
               if item["license"] in (None, "", "UNKNOWN", "UNLICENSED")]
    if missing:
        raise SystemExit(f"Review missing license declarations: {', '.join(missing)}")
    packages.sort(key=lambda item: (item["ecosystem"], item["name"], item["version"]))
    sections = ["THIRD-PARTY DEPENDENCY LICENSES AND NOTICES\n\n"
                "Collected from exact installed package versions and reviewed immutable upstream sources. "
                "All located license, notice and copyright files are preserved, including alternative terms. "
                "Authors are reproduced as upstream metadata, not invented copyright statements. "
                "Dependencies are unmodified. Exact source-download links below provide source for MPL-covered "
                "components and other packages. This collection records upstream material; it is not a legal certification.\n"]
    for record in packages:
        root, paths = sources[(record["ecosystem"], record["name"], record["version"])]
        files = package_notices(record, root, paths, overrides)
        record["noticeFiles"] = [reference for reference, _ in files]
        section = [f"\n{'=' * 72}\n{record['ecosystem']}: {record['name']} {record['version']}",
                   f"Declared license: {record['license']}"]
        if record.get("authors"):
            section.append(f"Authors declared by upstream: {', '.join(record['authors'])}")
        if record.get("sourceDownload"):
            section.append(f"Exact source: {record['sourceDownload']}")
        if record.get("noticeOverride"):
            section.append(record["noticeOverride"])
            section.append(f"Upstream commit: {record['upstreamCommit']}")
        for reference, content in files:
            section.append(f"\n--- {reference['path']} ({reference['origin']}) ---")
            if reference.get("url"):
                section.append(f"Source: {reference['url']}")
            section.append(content)
        sections.append("\n".join(section))
    notice_bytes = ("\n".join(sections) + "\n").encode()
    report = {"scope": "Installed npm production dependencies and resolved Rust normal/build dependencies on both macOS targets; upstream texts and explicit reviewed fallbacks, not legal certification.",
              "noticeBundle": {"file": notices_path.name, "sha256": hashlib.sha256(notice_bytes).hexdigest()},
              "packages": packages}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    notices_path.parent.mkdir(parents=True, exist_ok=True)
    notices_path.write_bytes(notice_bytes)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Wrote {len(packages)} dependency license records and complete collected notices to {args.output.parent}.")


if __name__ == "__main__":
    main()
