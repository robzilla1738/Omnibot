import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse


spec = importlib.util.spec_from_file_location("dev_browser", Path(__file__).with_name("dev-browser.py"))
dev_browser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dev_browser)

# Synthetic fixture only; never read a real profile or launch a real browser.
TOKEN = "a" * 64


@contextlib.contextmanager
def local_server(status=200, location=None):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append((self.path, self.headers.get("Authorization")))
            self.send_response(status)
            if location is not None:
                self.send_header("Location", location)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class ListenerOwnership(unittest.TestCase):
    def test_only_current_user_listeners_are_accepted(self):
        cases = [
            (0, "p10\nu501\n", True),
            (0, "p10\nu501\np11\nu501\n", True),
            (0, "p10\nu502\n", False),
            (0, "p10\nu501\np11\nu502\n", False),
            (0, "p10\n", False),
            (0, "", False),
            (1, "p10\nu501\n", False),
        ]
        for code, output, accepted in cases:
            with self.subTest(code=code, output=output), \
                    patch.object(dev_browser.os, "getuid", return_value=501), \
                    patch.object(dev_browser.subprocess, "run", return_value=SimpleNamespace(returncode=code, stdout=output)) as command:
                if accepted:
                    dev_browser.require_owned_listener(1420)
                else:
                    with self.assertRaisesRegex(RuntimeError, "own OS account"):
                        dev_browser.require_owned_listener(1420)
                args = command.call_args.args[0]
                self.assertIn("-a", args)
                self.assertIn("-iTCP:1420", args)
                self.assertIn("-sTCP:LISTEN", args)


class BackendTransport(unittest.TestCase):
    def test_proxy_environment_never_receives_loopback_credentials(self):
        with local_server() as (backend, received), local_server() as (proxy, intercepted):
            environment = {"http_proxy": proxy, "HTTP_PROXY": proxy, "all_proxy": proxy,
                           "ALL_PROXY": proxy, "no_proxy": "", "NO_PROXY": ""}
            with patch.dict(os.environ, environment):
                dev_browser.verify_backend(backend, TOKEN)
            self.assertEqual(received, [("/api/snapshot", f"Bearer {TOKEN}")])
            self.assertEqual(intercepted, [])

    def test_redirects_never_forward_credentials_to_another_listener(self):
        with local_server() as (destination, intercepted):
            for status in (301, 302, 303, 307, 308):
                with self.subTest(status=status), local_server(status, f"{destination}/capture") as (backend, received):
                    with self.assertRaises(HTTPError) as error:
                        dev_browser.verify_backend(backend, TOKEN)
                    self.assertEqual(error.exception.code, status)
                    self.assertEqual(received, [("/api/snapshot", f"Bearer {TOKEN}")])
                    self.assertEqual(intercepted, [])


class BrowserBootstrap(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="omni-dev-browser-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.environment = patch.dict(os.environ, {"OMNI_BOT_HOME": str(self.directory)})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        (self.directory / "api-token").write_text(TOKEN)
        (self.directory / "api-port").write_text("4321")

    def test_browser_receives_only_a_private_file_url(self):
        bootstrap = self.directory / "dev-connect.html"
        bootstrap.write_text("old contents")
        bootstrap.chmod(0o644)
        output = io.StringIO()
        with patch.object(dev_browser, "require_owned_listener") as owned, \
                patch.object(dev_browser, "verify_backend") as verify, \
                patch.object(dev_browser.webbrowser, "open", return_value=True) as browser, \
                contextlib.redirect_stdout(output):
            dev_browser.main()
        self.assertEqual([call.args[0] for call in owned.call_args_list], [1420, 4321, 1420])
        verify.assert_called_once_with("http://127.0.0.1:4321", TOKEN)
        browser.assert_called_once_with(bootstrap.resolve().as_uri())
        self.assertNotIn(TOKEN, browser.call_args.args[0])
        self.assertNotIn(TOKEN, output.getvalue())
        self.assertEqual(stat.S_IMODE(bootstrap.stat().st_mode), 0o600)
        html = bootstrap.read_text()
        self.assertIn("name=referrer content=no-referrer", html)
        target = json.loads(html.split("location.replace(", 1)[1].split(")</script>", 1)[0])
        url = urlparse(target)
        self.assertEqual((url.scheme, url.netloc, url.path, url.query), ("http", "localhost:1420", "/", ""))
        self.assertEqual(parse_qs(url.fragment), {"omniToken": [TOKEN], "omniServer": ["http://127.0.0.1:4321"]})

    def test_unowned_frontend_is_rejected_before_reading_connection_metadata(self):
        (self.directory / "api-token").unlink()
        with patch.object(dev_browser, "require_owned_listener", side_effect=RuntimeError("unowned frontend")), \
                patch.object(dev_browser, "verify_backend") as verify, \
                patch.object(dev_browser.webbrowser, "open") as browser:
            with self.assertRaisesRegex(SystemExit, "unowned frontend"):
                dev_browser.main()
        verify.assert_not_called()
        browser.assert_not_called()
        self.assertFalse((self.directory / "dev-connect.html").exists())

    def test_unowned_backend_never_receives_credentials(self):
        with patch.object(dev_browser, "require_owned_listener", side_effect=[None, RuntimeError("unowned backend")]), \
                patch.object(dev_browser, "verify_backend") as verify, \
                patch.object(dev_browser.webbrowser, "open") as browser:
            with self.assertRaisesRegex(SystemExit, "unowned backend"):
                dev_browser.main()
        verify.assert_not_called()
        browser.assert_not_called()

    def test_listener_change_during_bootstrap_prevents_browser_launch(self):
        with patch.object(dev_browser, "require_owned_listener", side_effect=[None, None, RuntimeError("frontend changed")]), \
                patch.object(dev_browser, "verify_backend"), \
                patch.object(dev_browser.webbrowser, "open") as browser:
            with self.assertRaisesRegex(SystemExit, "frontend changed"):
                dev_browser.main()
        browser.assert_not_called()

    def test_missing_listener_inspection_tool_fails_closed(self):
        with patch.object(dev_browser.subprocess, "run", side_effect=FileNotFoundError("lsof unavailable")), \
                patch.object(dev_browser, "verify_backend") as verify, \
                patch.object(dev_browser.webbrowser, "open") as browser:
            with self.assertRaisesRegex(SystemExit, "lsof unavailable"):
                dev_browser.main()
        verify.assert_not_called()
        browser.assert_not_called()

    def test_invalid_metadata_is_not_sent_or_printed(self):
        for token, port in [("not-a-token", "4321"), (TOKEN, "0"), (TOKEN, "65536"), (TOKEN, "invalid")]:
            with self.subTest(port=port):
                (self.directory / "api-token").write_text(token)
                (self.directory / "api-port").write_text(port)
                with patch.object(dev_browser, "require_owned_listener"), \
                        patch.object(dev_browser, "verify_backend") as verify, \
                        patch.object(dev_browser.webbrowser, "open") as browser:
                    with self.assertRaises(SystemExit) as error:
                        dev_browser.main()
                self.assertNotIn(token, str(error.exception))
                verify.assert_not_called()
                browser.assert_not_called()


if __name__ == "__main__":
    unittest.main()
