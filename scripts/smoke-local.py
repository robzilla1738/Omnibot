#!/usr/bin/env python3
"""Smoke-test the native app with an isolated store and local fake CLI bots.

Build first: pnpm build && cargo build --manifest-path src-tauri/Cargo.toml --locked
This opens a temporary native window. No provider inference is submitted.
"""
import base64
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
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def main():
    if not BINARY.exists():
        raise SystemExit("Build the native debug binary first; see this script's docstring.")
    with tempfile.TemporaryDirectory(prefix="omni-native-smoke-") as temporary:
        directory = Path(temporary)
        command = directory / "fixture.sh"
        command.write_text("#!/bin/sh\nprintf 'NATIVE_FIXTURE_OK\\n'\n")
        command.chmod(0o700)
        primary_id = "smoke-" + uuid.uuid4().hex
        bots = []
        for bot_id, name, primary in [(primary_id, "Smoke Lead", True), ("smoke-helper", "Smoke Helper", False)]:
            bots.append(dict(id=bot_id, name=name, slug=bot_id, roleTitle="Local fixture", description="No provider calls", shape="blob", color="cyan", isPrimary=primary, cliDriver="custom", model=None, reasoningEffort="low", permissionMode="auto", systemPrompt="", memories=[], autoCreatedForCli=False, customCommand=shlex.quote(str(command))))
        chat = dict(id="smoke-room", title="Native smoke test", subtitle="Local fixtures", isPrimary=True, isBotHome=True, ownerBotId=primary_id, isGroup=False, participantBotIds=[primary_id, "smoke-helper"], workspacePath=None, workspaceId=None, useWorktrees=False, maxSwarmTurns=4, messages=[], updatedAtMs=0)
        store = dict(homeLayoutVersion=4, bots=bots, chats=[chat], workspaces=[], routines=[], preferences=dict(onboardingCompleted=True, workspaceRoot=str(directory), defaultMaxSwarmTurns=4, approveAllTools=False, globalInstructions="", sharedMemories=[], pinnedBotIds=["smoke-helper"]))
        (directory / "store.json").write_text(json.dumps(store))
        processes = []
        with (directory / "process.log").open("w+") as log:
            try:
                # Vite's strict port avoids attaching the native test to another project.
                vite = subprocess.Popen(["pnpm", "dev", "--host", "127.0.0.1", "--strictPort"], cwd=ROOT, stdout=log, stderr=log, start_new_session=True)
                processes.append(vite)
                time.sleep(1)
                if vite.poll() is not None:
                    raise RuntimeError("Vite could not start. Stop the server on port 1420 before running this smoke test.")
                app = subprocess.Popen([str(BINARY)], cwd=ROOT, env={**os.environ, "OMNI_BOT_HOME": str(directory)}, stdout=log, stderr=log, start_new_session=True)
                processes.append(app)
                base = None
                token_file = directory / "api-token"
                deadline = time.monotonic() + 45
                while time.monotonic() < deadline and base is None:
                    if app.poll() is not None:
                        raise RuntimeError("Native app exited before its API became available.")
                    token = token_file.read_text().strip() if token_file.exists() else None
                    for port in range(4321, 4336):
                        candidate = f"http://127.0.0.1:{port}"
                        try:
                            snapshot = request(candidate, "/api/snapshot", token=token)
                        except (urllib.error.URLError, TimeoutError, socket.timeout):
                            continue
                        if any(bot["id"] == primary_id for bot in snapshot["bots"]):
                            base = candidate
                            break
                    time.sleep(0.1)
                if base is None:
                    raise RuntimeError("Native API did not start in time.")

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
                api("/api/bot/upsert", restored)
                saved = json.loads((directory / "store.json").read_text())
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
                print("Native smoke passed: startup, fake bot workflows, archive/restore, persistence, live output, interactive PTY input, resize, and exit cleanup.")
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
