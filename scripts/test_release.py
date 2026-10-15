import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


def load_script(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load_script("release-macos")
audit = load_script("dependency-audit")
licenses = load_script("license-inventory")
smoke = load_script("smoke-local")


class ReleaseChecks(unittest.TestCase):
    def test_ci_must_match_exact_source_and_branch(self):
        run = {"head_sha": "expected", "event": "push", "head_branch": "main",
               "run_number": 10, "run_attempt": 1, "status": "completed",
               "conclusion": "success", "id": 99, "html_url": "https://example.test/run/99"}
        self.assertEqual(release.verified_ci_run([run], "expected")["id"], 99)
        for changed in ({"head_sha": "other"}, {"head_branch": "feature"}, {"event": "pull_request"}):
            with self.subTest(changed=changed), self.assertRaises(SystemExit):
                release.verified_ci_run([run | changed], "expected")

    def test_newer_failing_or_pending_ci_invalidates_older_success(self):
        run = {"head_sha": "expected", "event": "push", "head_branch": "main",
               "run_number": 10, "run_attempt": 1, "status": "completed",
               "conclusion": "success", "id": 99, "html_url": "https://example.test/run/99"}
        for changed in ({"conclusion": "failure"}, {"status": "in_progress", "conclusion": None}):
            with self.subTest(changed=changed), self.assertRaises(SystemExit):
                release.verified_ci_run([run, run | {"run_attempt": 2} | changed], "expected")

    def test_commit_drift_aborts_before_artifacts_are_accepted(self):
        with patch.object(release, "run") as command:
            command.return_value.stdout = "different\n"
            with self.assertRaisesRegex(SystemExit, "Source commit changed"):
                release.check_source_unchanged("expected", "0.1.1")

    def test_uncommitted_changes_abort_even_when_commit_is_unchanged(self):
        from types import SimpleNamespace
        with patch.object(release, "run", side_effect=[SimpleNamespace(stdout="expected\n"),
                                                      SimpleNamespace(stdout=" M src/main.tsx\n")]):
            with self.assertRaisesRegex(SystemExit, "Source files changed"):
                release.check_source_unchanged("expected", "0.1.1")

    def test_version_drift_aborts_even_when_git_state_appears_clean(self):
        from types import SimpleNamespace
        with patch.object(release, "run", side_effect=[SimpleNamespace(stdout="expected\n"),
                                                      SimpleNamespace(stdout="")]), \
                patch.object(release, "release_version", return_value="0.1.2"):
            with self.assertRaisesRegex(SystemExit, "Release version changed"):
                release.check_source_unchanged("expected", "0.1.1")


class AuditExceptions(unittest.TestCase):
    def test_exception_requires_exact_package_version_kind_and_review_date(self):
        from datetime import date
        exception = {"advisory": "RUSTSEC-2024-0429", "package": "glib", "version": "0.18.5",
                     "kind": "unsound", "expires": "2027-01-15", "excludedTargets": list(audit.TARGETS),
                     "reason": "Absent from supported targets."}
        warning = {"advisory": {"id": exception["advisory"]},
                   "package": {"name": "glib", "version": "0.18.5"}, "kind": "unsound"}
        self.assertEqual(audit.accepted_warning(warning, [exception], date(2026, 10, 15)), exception)
        with self.assertRaisesRegex(SystemExit, "Expired"):
            audit.accepted_warning(warning, [exception], date(2027, 1, 16))
        with self.assertRaisesRegex(SystemExit, "Unreviewed"):
            audit.accepted_warning(warning | {"package": {"name": "glib", "version": "0.18.6"}},
                                   [exception], date(2026, 10, 15))
        with self.assertRaisesRegex(SystemExit, "Unreviewed"):
            audit.accepted_warning(warning | {"kind": "vulnerability"}, [exception], date(2026, 10, 15))


class LicenseInventory(unittest.TestCase):
    def test_only_reachable_production_and_build_dependencies_are_included(self):
        metadata = {"resolve": {"root": "app", "nodes": [
            {"id": "app", "deps": [
                {"pkg": "runtime", "dep_kinds": [{"kind": None}]},
                {"pkg": "build", "dep_kinds": [{"kind": "build"}]},
                {"pkg": "test", "dep_kinds": [{"kind": "dev"}]}]},
            {"id": "runtime", "deps": []}, {"id": "build", "deps": []},
            {"id": "test", "deps": []}]},
            "packages": [{"id": name} for name in ["app", "runtime", "build", "test", "unreachable"]]}
        self.assertEqual([package["id"] for package in licenses.production_packages(metadata)],
                         ["app", "runtime", "build"])

    def test_unknown_missing_license_and_notice_only_package_fail_closed(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            record = {"ecosystem": "npm", "name": "fixture", "version": "1.0.0", "license": "MIT"}
            with self.assertRaisesRegex(SystemExit, "No upstream license text"):
                licenses.package_notices(record, root, [], {"cargo": {}})
            notice = root / "NOTICE"
            notice.write_text("Fixture attribution without license terms.")
            with self.assertRaisesRegex(SystemExit, "No upstream license text"):
                licenses.package_notices(record, root, [notice], {"cargo": {}})

    def test_notice_collection_preserves_upstream_text_and_uses_relative_paths(self):
        import hashlib
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "LICENSE-MIT"
            content = b"Fixture license terms.\nCopyright fixture authors.\n"
            path.write_bytes(content)
            record = {"ecosystem": "npm", "name": "fixture", "version": "1.0.0", "license": "MIT"}
            notices = licenses.package_notices(record, root, [path], {})
            self.assertEqual(notices, [({"path": "LICENSE-MIT", "origin": "installed package",
                                        "sha256": hashlib.sha256(content).hexdigest()}, content.decode())])

    def test_reviewed_override_rejects_different_source_commit(self):
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".cargo_vcs_info.json").write_text(json.dumps({"git": {"sha1": "new-commit"}}))
            record = {"ecosystem": "cargo", "name": "fixture", "version": "1.0.0", "license": "MIT"}
            overrides = {"cargo": {"fixture@1.0.0": {"commit": "old-commit", "declaredLicense": "MIT"}}}
            with self.assertRaisesRegex(SystemExit, "no longer matches"):
                licenses.package_notices(record, root, [], overrides)

    def test_pinned_source_rejects_modified_cached_text(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory, patch.object(licenses, "ROOT", Path(directory)):
            cache = Path(directory) / ".cache/license-notices" / ("a" * 64)
            cache.parent.mkdir(parents=True)
            cache.write_text("modified")
            with self.assertRaisesRegex(SystemExit, "checksum mismatch"):
                licenses.pinned_text({"sha256": "a" * 64, "url": "https://example.test/license"})

    def test_release_rejects_missing_or_mismatched_bundled_notices(self):
        import hashlib
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "Fixture.app"
            resources = app / "Contents/Resources"
            resources.mkdir(parents=True)
            with self.assertRaisesRegex(SystemExit, "missing"):
                release.validate_notices(app)
            notices = resources / "THIRD-PARTY-LICENSES.txt"
            notices.write_text("fixture terms")
            report = {"noticeBundle": {"sha256": hashlib.sha256(notices.read_bytes()).hexdigest()},
                      "packages": [{"noticeFiles": [{"path": "LICENSE"}]}]}
            (resources / "dependency-license-inventory.json").write_text(json.dumps(report))
            release.validate_notices(app)
            notices.write_text("different terms")
            with self.assertRaisesRegex(SystemExit, "do not match"):
                release.validate_notices(app)


class NativeSmoke(unittest.TestCase):
    def test_connection_uses_private_ephemeral_port_without_scanning_other_instances(self):
        import tempfile
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory)
            (profile / "api-port").write_text("59273")
            (profile / "api-token").write_text("fixture-token")
            snapshot = {"bots": [{"id": "fixture-primary"}]}
            with patch.object(smoke, "request", return_value=snapshot) as request:
                result = smoke.wait_for_api(Mock(poll=lambda: None), profile, "fixture-primary")
            request.assert_called_once_with("http://127.0.0.1:59273", "/api/snapshot", token="fixture-token")
            self.assertEqual(result, ("http://127.0.0.1:59273", "fixture-token", snapshot))

    def test_all_registered_cli_names_are_shadowed_by_local_fixtures(self):
        import re
        scanner = (Path(__file__).resolve().parents[1] / "src-tauri/src/scanner.rs").read_text()
        registry = scanner.split("fn harness_specs()", 1)[1].split("pub fn scan_local_cli_harnesses", 1)[0]
        names = {name for group in re.findall(r'&\[([^\]]+)\]', registry)
                 for name in re.findall(r'"([^\"]+)"', group)}
        self.assertEqual(set(smoke.CLI_NAMES), names)


if __name__ == "__main__":
    unittest.main()
