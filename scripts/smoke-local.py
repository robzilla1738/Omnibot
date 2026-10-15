#!/usr/bin/env python3
"""Smoke-test the native app with an isolated store and local fake CLI bots.

Build first: pnpm build && cargo build --manifest-path src-tauri/Cargo.toml --locked
This opens a temporary native window. No provider inference is submitted.
"""
import base64
import argparse
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / "src-tauri/target/debug/Omnibot"
CLI_NAMES = ("claude", "codex", "opencode", "cursor-agent", "agent", "grok", "pi",
             "antigravity", "agy", "muse", "acp", "gemini", "aider", "ollama")


def request(base, path, body=None, token=None):
    data = None if body is None else json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(base + path, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=2) as response:
        return json.load(response)


def terminal_output(api, terminal_id):
    output = api("/api/terminal/output?id=" + terminal_id)
    return output, base64.b64decode(output["data"])


def stop(process):
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait()
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def wait_for_api(app, directory, primary_id):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if app.poll() is not None:
            raise RuntimeError("Native app exited before its API became available.")
        try:
            token = (directory / "api-token").read_text().strip()
            port = int((directory / "api-port").read_text().strip())
            if not token or not 1 <= port <= 65535:
                raise ValueError("Incomplete connection files")
            base = f"http://127.0.0.1:{port}"
            snapshot = request(base, "/api/snapshot", token=token)
            if any(bot["id"] == primary_id for bot in snapshot["bots"]):
                return base, token, snapshot
        except (FileNotFoundError, ValueError, urllib.error.URLError, TimeoutError, socket.timeout):
            pass
        time.sleep(0.1)
    raise RuntimeError("Native API did not start in time.")


def wait_for_vite(process):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Vite could not start. Free port 1420 before running the debug smoke test.")
        try:
            with urllib.request.urlopen("http://127.0.0.1:1420", timeout=1) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, TimeoutError, socket.timeout):
            pass
        time.sleep(0.1)
    raise RuntimeError("Vite did not become ready in time.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=BINARY)
    parser.add_argument("--bundled", action="store_true", help="Packaged release binary with embedded frontend; do not start Vite")
    parser.add_argument("--arch", choices=("arm64", "x86_64"), help="Select a universal binary slice through /usr/bin/arch")
    args = parser.parse_args()
    binary = args.binary.resolve()
    if not binary.is_file():
        raise SystemExit("Build the native debug binary first; see this script's docstring.")
    with tempfile.TemporaryDirectory(prefix="omni-native-smoke-") as temporary:
        directory = Path(temporary)
        data_dir = directory / "profile"
        data_dir.mkdir(mode=0o700)
        home = directory / "home"
        probe_dir = home / ".local/bin"
        probe_dir.mkdir(parents=True, mode=0o700)
        # Home-local executables take precedence over installed CLI discovery paths.
        for name in CLI_NAMES:
            probe = probe_dir / name
            probe.write_text("#!/bin/sh\nexit 1\n")
            probe.chmod(0o700)
        environment = {"HOME": str(home), "OMNI_BOT_HOME": str(data_dir), "SHLVL": "1",
                       "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "SHELL": "/bin/sh",
                       "LANG": "en_US.UTF-8", "TMPDIR": str(directory)}
        launch = [str(binary)]
        if args.arch:
            launch = ["/usr/bin/arch", f"-{args.arch}", *launch]
        command = directory / "fixture.sh"
        command.write_text("#!/bin/sh\nprintf 'NATIVE_FIXTURE_OK\\n'\n")
        command.chmod(0o700)
        primary_id = "smoke-" + uuid.uuid4().hex
        bots = []
        for bot_id, name, primary in [(primary_id, "Smoke Lead", True), ("smoke-helper", "Smoke Helper", False)]:
            bots.append(dict(id=bot_id, name=name, slug=bot_id, roleTitle="Local fixture", description="No provider calls", shape="blob", color="cyan", isPrimary=primary, cliDriver="custom", model=None, reasoningEffort="low", permissionMode="auto", systemPrompt="", memories=[], autoCreatedForCli=False, customCommand=shlex.quote(str(command))))
        chat = dict(id="smoke-room", title="Native smoke test", subtitle="Local fixtures", isPrimary=True, isBotHome=True, ownerBotId=primary_id, isGroup=False, participantBotIds=[primary_id, "smoke-helper"], workspacePath=None, workspaceId=None, useWorktrees=False, maxSwarmTurns=4, messages=[], updatedAtMs=0)
        store = dict(homeLayoutVersion=4, bots=bots, chats=[chat], workspaces=[], routines=[], preferences=dict(onboardingCompleted=True, workspaceRoot=str(directory), defaultMaxSwarmTurns=4, approveAllTools=False, globalInstructions="", sharedMemories=[], pinnedBotIds=["smoke-helper"]))
        original_store = json.dumps(store).encode()
        (data_dir / "store.json").write_bytes(original_store)
        processes = []
        with (directory / "process.log").open("w+") as log:
            try:
                if not args.bundled:
                    with socket.socket() as port_check:
                        port_check.bind(("127.0.0.1", 1420))
                    vite = subprocess.Popen(["pnpm", "dev", "--host", "127.0.0.1", "--port", "1420", "--strictPort"], cwd=ROOT, stdout=log, stderr=log, start_new_session=True)
                    processes.append(vite)
                    wait_for_vite(vite)
                app = subprocess.Popen(launch, cwd=ROOT, env=environment, stdout=log, stderr=log, start_new_session=True)
                processes.append(app)
                base, token, snapshot = wait_for_api(app, data_dir, primary_id)
                # Exercise the packaged middleware without granting a mutation.
                for method, path, body in [("GET", "/api/snapshot", None), ("POST", "/api/bot/delete", {"id": "smoke-helper"})]:
                    payload = None if body is None else json.dumps(body).encode()
                    for origin in ["tauri://localhost", "http://localhost:1420"]:
                        denied = urllib.request.Request(base + path, data=payload, method=method,
                            headers={"Content-Type": "application/json", "Origin": origin})
                        try:
                            urllib.request.urlopen(denied, timeout=2)
                        except urllib.error.HTTPError as error:
                            assert error.code in (401, 403)
                        else:
                            raise AssertionError("Unauthenticated native API request succeeded")
                profile_id = snapshot["profileId"]
                instance_id = snapshot["instanceId"]
                migration_copies = list(data_dir.glob("store.pre-migration-*.json"))
                assert len(migration_copies) == 1 and migration_copies[0].read_bytes() == original_store
                assert all(Path(harness["binaryPath"]).parent == probe_dir
                           for harness in snapshot["harnesses"] if harness["installed"])

                def api(path, body=None):
                    return request(base, path, body, token)

                preview = api("/api/chat/preview", dict(chatId="smoke-room", text="@all Check the native workflow"))
                assert preview["botIds"] == [primary_id, "smoke-helper"]
                api("/api/chat/send", dict(chatId="smoke-room", text="@all Check the native workflow"))
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    snapshot = api("/api/snapshot")
                    if not snapshot["activeWorkflowChatIds"]:
                        break
                    time.sleep(0.1)
                else:
                    raise RuntimeError("Fake CLI workflow did not complete.")
                tasks = snapshot["chats"][0]["tasks"]
                assert len(tasks) == 2 and all(task["status"] == "complete" for task in tasks)
                assert sum(m["text"] == "NATIVE_FIXTURE_OK" for m in snapshot["chats"][0]["messages"]) == 2
                archived = api("/api/bot/delete", {"id": "smoke-helper"})
                assert len(archived["chats"][0]["messages"]) == 3
                restored = next(bot for bot in archived["bots"] if bot["id"] == "smoke-helper")
                assert restored["archived"]
                restored["archived"] = False
                restored["name"] = "Smoke Helper restored"
                restored["memories"] = ["NATIVE_RESTART_MEMORY"]
                api("/api/bot/upsert", restored)
                preferences = api("/api/snapshot")["preferences"]
                preferences["sharedMemories"] = ["NATIVE_SHARED_MEMORY"]
                preferences["maxParallelBots"] = 2
                api("/api/preferences", preferences)
                saved = json.loads((data_dir / "store.json").read_text())
                assert len(saved["chats"][0]["tasks"]) == 2
                assert not next(bot for bot in saved["bots"] if bot["id"] == "smoke-helper")["archived"]
                captured = api("/api/terminal/list?chatId=smoke-room")
                assert len(captured) == 2 and all(item["mode"] == "output" for item in captured)
                _, data = terminal_output(api, captured[0]["id"])
                assert b"NATIVE_FIXTURE_OK" in data
                command.write_text("#!/bin/sh\nprintf 'PTY_READY'\nread -r line\nprintf '<%s>\\n' \"$line\"\nstty size\n")
                terminal = api("/api/terminal/start", dict(chatId="smoke-room", botId="smoke-helper", cols=80, rows=24))
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    _, data = terminal_output(api, terminal["id"])
                    if b"PTY_READY" in data:
                        break
                    time.sleep(0.05)
                else:
                    raise RuntimeError("Interactive PTY did not start.")
                api("/api/terminal/resize", dict(id=terminal["id"], cols=99, rows=31))
                api("/api/terminal/write", dict(id=terminal["id"], data=base64.b64encode(b"native terminal input\r").decode()))
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    snapshot = api("/api/snapshot")
                    if not snapshot["activeWorkflowChatIds"]:
                        break
                    time.sleep(0.05)
                else:
                    raise RuntimeError("Interactive PTY did not release the workflow.")
                output, data = terminal_output(api, terminal["id"])
                assert b"<native terminal input>" in data
                assert b"31 99" in data
                assert output["status"] == "exited"
                saved = json.loads((data_dir / "store.json").read_text())
                old_token = token
                stop(app)
                app = subprocess.Popen(launch, cwd=ROOT, env=environment, stdout=log, stderr=log, start_new_session=True)
                processes.append(app)
                base, token, snapshot = wait_for_api(app, data_dir, primary_id)
                assert token != old_token
                assert snapshot["profileId"] == profile_id
                assert snapshot["instanceId"] != instance_id
                assert snapshot["preferences"] == saved["preferences"]
                assert next(chat for chat in snapshot["chats"] if chat["id"] == "smoke-room") == next(chat for chat in saved["chats"] if chat["id"] == "smoke-room")
                helper = next(bot for bot in snapshot["bots"] if bot["id"] == "smoke-helper")
                assert helper["name"] == "Smoke Helper restored" and helper["memories"] == ["NATIVE_RESTART_MEMORY"]
                assert not helper["archived"]
                assert list(data_dir.glob("store.pre-migration-*.json")) == migration_copies
                assert migration_copies[0].read_bytes() == original_store
                print("Native backend smoke passed: isolated startup/migration, fake workflows, archive/restore, PTY input/resize/exit, restart persistence, stable profile identity, rotating token, and preserved migration copy. Window appearance and updater installation were not verified.")
            except Exception:
                log.flush()
                log.seek(0)
                print(log.read()[-6000:])
                raise
            finally:
                for process in reversed(processes):
                    stop(process)


if __name__ == "__main__":
    main()
