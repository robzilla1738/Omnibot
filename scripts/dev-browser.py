#!/usr/bin/env python3
"""Open the Vite UI using this user's private backend credentials."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import webbrowser


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def require_owned_listener(port):
    result = subprocess.run(["lsof", "-nP", "-a", f"-iTCP:{port}", "-sTCP:LISTEN", "-F", "u"], capture_output=True, text=True)
    owners = {line[1:] for line in result.stdout.splitlines() if line.startswith("u")}
    if result.returncode != 0 or owners != {str(os.getuid())}:
        raise RuntimeError(f"Port {port} must be listening under your own OS account. Start your backend and Vite before connecting.")


def verify_backend(base_url, token):
    request = Request(f"{base_url}/api/snapshot", headers={"Authorization": f"Bearer {token}"})
    # Credentials must never go through a proxy or follow a redirect off loopback.
    with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=5) as response:
        json.load(response)


def main():
    data_dir = Path(os.environ.get("OMNI_BOT_HOME", "").strip() or Path.home() / ".omni-bot")
    try:
        require_owned_listener(1420)
        token = (data_dir / "api-token").read_text().strip()
        port = int((data_dir / "api-port").read_text().strip())
        if not re.fullmatch(r"[a-f0-9]{64}", token) or not 1 <= port <= 65535:
            raise ValueError("Invalid local connection metadata; restart the backend.")
        base_url = f"http://127.0.0.1:{port}"
        require_owned_listener(port)
        verify_backend(base_url, token)
        fragment = urlencode({"omniToken": token, "omniServer": base_url})
        # Keep credentials out of process arguments and terminal output as well as HTTP logs.
        bootstrap = data_dir / "dev-connect.html"
        with os.fdopen(os.open(bootstrap, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as output:
            os.fchmod(output.fileno(), 0o600)
            target = json.dumps(f"http://localhost:1420/#{fragment}")
            output.write(f"<!doctype html><meta name=referrer content=no-referrer><script>location.replace({target})</script>")
        require_owned_listener(1420)
        if not webbrowser.open(bootstrap.resolve().as_uri()):
            raise RuntimeError("Could not open the default browser.")
    except (OSError, ValueError, URLError, RuntimeError) as error:
        sys.exit(f"Could not connect: {error}\nStart pnpm tauri:dev (or the backend and pnpm dev), then retry.")
    print("Opened the authenticated development UI. Credentials were not printed.")


if __name__ == "__main__":
    main()
