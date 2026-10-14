#!/usr/bin/env python3
"""Fetch the pinned official Sparkle framework and tools; verify before extracting."""
import hashlib
import pathlib
import platform
import subprocess
import tempfile

VERSION = "2.10.0"
SHA256 = "c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c"
ROOT = pathlib.Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache" / "sparkle" / VERSION
FRAMEWORK = ROOT / "src-tauri" / "Sparkle.framework"


def main():
    if platform.system() != "Darwin":
        raise SystemExit("Sparkle builds require macOS.")
    marker = CACHE / ".verified-sha256"
    if not (marker.exists() and marker.read_text().strip() == SHA256 and (CACHE / "bin/generate_appcast").exists()):
        CACHE.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="omnibot-sparkle-") as folder:
            archive = pathlib.Path(folder) / "Sparkle.tar.xz"
            subprocess.run(["curl", "--fail", "--location", "--retry", "3", "--output", str(archive),
                            f"https://github.com/sparkle-project/Sparkle/releases/download/{VERSION}/Sparkle-{VERSION}.tar.xz"], check=True)
            if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
                raise SystemExit("Sparkle archive checksum mismatch; nothing was extracted.")
            subprocess.run(["tar", "-xf", str(archive), "-C", str(CACHE)], check=True)
            marker.write_text(SHA256 + "\n")
    # Refresh the framework from the verified, versioned distribution on every setup.
    subprocess.run(["ditto", str(CACHE / "Sparkle.framework"), str(FRAMEWORK)], check=True)
    print(f"Sparkle {VERSION} ready ({SHA256[:12]}…).")


if __name__ == "__main__":
    main()
