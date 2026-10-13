#!/usr/bin/env python3
"""서버 접근 없이 owned 응답만 관찰한다."""
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("owned_host", Path(__file__).with_name("disk-optimization-host-diagnostics.py"))
source = importlib.util.module_from_spec(spec); spec.loader.exec_module(source)
SHA = "a" * 40
ENV = {"GITHUB_REPOSITORY": source.REPO, "GITHUB_REF": "refs/heads/main", "RUNNER_OS": "Linux", "RUNNER_NAME": source.EXPECTED, "OBS_RUNNER_ROOT": "/owned/runner"}

class Fixture(unittest.TestCase):
    def test_context_and_remote_endpoint_denied_before_any_command(self):
        for delta in [{"GITHUB_REF": "other"}, {"GITHUB_REPOSITORY": "other"}, {"RUNNER_OS": "Windows"}, {"DOCKER_HOST": "tcp://other"}, {"DOCKER_CONTEXT": "other"}, {"DOCKER_TLS_VERIFY": "1"}, {"DOCKER_CERT_PATH": "/other"}]:
            calls = []
            result = source.collect({**ENV, **delta}, lambda *args: calls.append(args), lambda: self.fail("no health"))
            self.assertFalse(result["identityVerified"]); self.assertEqual(calls, [])

    def test_local_observations_never_approve_or_output_names_paths_or_payloads(self):
        calls = []
        def run(args, env):
            calls.append(args)
            self.assertNotIn("DOCKER_HOST", env)
            if args[0] == "hostname": return 0, "owned-os-private"
            self.assertEqual(args[:3], ["docker", "--host", source.LOCAL])
            tail = args[3:]
            if tail[:2] == ["context", "inspect"]: return 0, source.LOCAL
            if tail == ["info", "--format", "{{.Name}}"]: return 0, "owned-os-private"
            if tail == ["info", "--format", "{{.DockerRootDir}}"]: return 0, "/owned/docker-root"
            if tail[0] == "ps": return 0, "b" * 12
            if tail[0] == "inspect" and tail[2] == "{{json .Config.Labels}}": return 0, json.dumps({"com.docker.compose.project": "obs-web", "com.docker.compose.service": "obs-web-app", "other": "owned-sensitive-label"})
            if tail[0] == "inspect" and tail[2] == "{{.Config.Image}}": return 0, "obs-web-app:" + SHA
            self.fail("non-readonly command")
        def info(path):
            mode = stat.S_IFSOCK | 0o660 if path.as_posix() == "/var/run/docker.sock" else (stat.S_IFREG | 0o644 if path.name == "deploy-history.log" else stat.S_IFDIR | 0o755)
            uid = 0 if path.as_posix() in ("/var/run/docker.sock", "/owned/docker-root") else 123
            return SimpleNamespace(st_mode=mode, st_uid=uid, st_nlink=1)
        with patch.object(source.os, "geteuid", return_value=123, create=True), patch.object(source.Path, "is_absolute", return_value=True), patch.object(source.Path, "lstat", info), patch.object(source, "read_history", return_value=(True, SHA)):
            result = source.collect({**ENV, "DOCKER_HOST": source.LOCAL}, run, lambda: {"status": "ok", "db": "ok", "testMode": True, "version": SHA, "other": "owned-sensitive-health"})
        self.assertFalse(result["identityVerified"])
        self.assertFalse(result["hostnameMatchesExpected"]); self.assertFalse(result["daemonMatchesExpected"])
        for key in ("daemonMatchesOSHostname", "localSocketRootOwned", "dockerRootRootOwned", "runnerDiagOwned", "historyOwned", "historyHasCommit", "oneLocalApp", "appComposeLabelsMatch", "appImageOnqCommit", "appImageMatchesHistory", "localHealthOk", "localHealthTestMode", "localHealthMatchesAppImage"): self.assertTrue(result[key], key)
        encoded = json.dumps(result)
        for hidden in ("owned-os-private", "/owned", SHA, "owned-sensitive", "unix://"): self.assertNotIn(hidden, encoded)
        self.assertTrue(all(isinstance(value, (bool, int)) for key, value in result.items() if key != "protocol"))

    def test_query_failures_keep_exit_status_without_raw_error_or_health_probe(self):
        def run(args, env): return (41, "owned-private-error") if args[0] == "hostname" else (42, "owned-private-error")
        result = source.collect(ENV, run, lambda: self.fail("unverified context cannot read health"))
        self.assertEqual(result["hostnameExit"], 41); self.assertEqual(result["dockerContextExit"], 42)
        self.assertFalse(result["dockerContextLocal"]); self.assertNotIn("owned-private-error", json.dumps(result))

    def test_foreign_history_and_diag_are_not_read_or_presented_as_test_identity(self):
        def run(args, env):
            if args[0] == "hostname": return 0, "owned-other"
            if args[3:5] == ["context", "inspect"]: return 0, source.LOCAL
            return 0, ""
        info = SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=999, st_nlink=1)
        with patch.object(source.os, "geteuid", return_value=123, create=True), patch.object(source.Path, "is_absolute", return_value=True), patch.object(source.Path, "lstat", return_value=info), patch.object(source.os, "open") as opened:
            result = source.collect(ENV, run, lambda: {"status": "ok", "db": "ok", "testMode": False, "version": SHA})
            opened.assert_not_called()
        for key in ("identityVerified", "runnerDiagOwned", "historyOwned", "historyHasCommit", "oneLocalApp", "appImageMatchesHistory", "localHealthTestMode", "localHealthMatchesAppImage"): self.assertFalse(result[key], key)

    def test_history_fd_owner_identity_and_before_after_replacement(self):
        content = ("sha=" + SHA + "\n").encode()
        normal = dict(st_dev=1, st_ino=2, st_uid=123, st_gid=123, st_mode=stat.S_IFREG | 0o644, st_nlink=1, st_size=len(content), st_mtime_ns=1, st_ctime_ns=1)
        base = SimpleNamespace(**normal)
        changed = lambda **delta: SimpleNamespace(**{**normal, **delta})
        for case, paths, descriptors, reads in [
            ("normal", [base, base, base], [base, base], 1),
            ("symlink", [changed(st_mode=stat.S_IFLNK | 0o777)], [], 0),
            ("foreign-fd", [base], [changed(st_uid=999)], 0),
            ("replaced-before-open", [base], [changed(st_ino=3)], 0),
            ("replaced-before-read", [base, changed(st_ino=3)], [base], 0),
            ("changed-after-read", [base, base], [base, changed(st_ctime_ns=2)], 1),
            ("symlink-after-read", [base, base, changed(st_mode=stat.S_IFLNK | 0o777)], [base, base], 1),
        ]:
            with self.subTest(case=case), patch.object(source.os, "O_NOFOLLOW", 512, create=True), patch.object(source.os, "geteuid", return_value=123, create=True), patch.object(source.Path, "lstat", side_effect=paths), patch.object(source.os, "open", return_value=7) as opened, patch.object(source.os, "fstat", side_effect=descriptors), patch.object(source.os, "lseek"), patch.object(source.os, "read", return_value=content) as read, patch.object(source.os, "close") as closed:
                self.assertEqual(source.read_history(Path("/owned/history")), (True, SHA) if case == "normal" else (False, None))
                self.assertEqual(read.call_count, reads)
                if opened.called:
                    self.assertEqual(opened.call_args.args[1], source.os.O_RDONLY | source.os.O_NOFOLLOW); closed.assert_called_once_with(7)
                if read.called: read.assert_called_once_with(7, 65536)

    def test_owned_posix_history_symlink_and_actual_change_reject(self):
        if not hasattr(source.os, "O_NOFOLLOW") or not hasattr(source.os, "geteuid"):
            if source.os.environ.get("CI") == "true": self.fail("owned Linux CI must execute history fd checks")
            self.skipTest("local POSIX unavailable; owned Linux CI required")
        with tempfile.TemporaryDirectory(prefix="onq-history-owned-") as temporary:
            history = Path(temporary) / "history"; history.write_text("sha=" + SHA + "\n"); history.chmod(0o600)
            self.assertEqual(source.read_history(history), (True, SHA))
            link = Path(temporary) / "link"; link.symlink_to(history)
            self.assertEqual(source.read_history(link), (False, None))
            original_read = source.os.read
            def mutate(fd, size):
                content = original_read(fd, size); history.write_text("owned concurrent change"); return content
            with patch.object(source.os, "read", mutate): self.assertEqual(source.read_history(history), (False, None))

    def test_workflow_preserves_original_plan_and_saves_diagnostic_only_on_failure(self):
        root = Path(__file__).resolve().parents[2]
        workflow = (root / ".github/workflows/disk-optimization-preview-obs-test.yml").read_text(encoding="utf-8")
        self.assertLess(workflow.index("python3 scripts/ops/disk-optimization-host-diagnostics.py"), workflow.index("bash scripts/ops/disk-optimization-plan.sh --preview"))
        condition = workflow.split("      - name: Save host diagnostics\n        if: ", 1)[1].splitlines()[0]
        self.assertEqual(condition, "always() && steps.isolated_checkout.outcome == 'success' && steps.checkout.outcome == 'success' && steps.isolated_checkout.outputs.checkout_path != ''")
        for isolated, checkout, path, expected in [("success", "success", "disk-optimization-1-1", True), ("failure", "success", "disk-optimization-1-1", False), ("success", "failure", "disk-optimization-1-1", False), ("success", "success", "", False), ("skipped", "skipped", "", False)]:
            expression = condition.replace("always()", "True").replace("steps.isolated_checkout.outcome", repr(isolated)).replace("steps.checkout.outcome", repr(checkout)).replace("steps.isolated_checkout.outputs.checkout_path", repr(path)).replace("&&", "and")
            self.assertEqual(eval(expression, {"__builtins__": {}}, {}), expected)
        self.assertIn("/evidence/host-diagnostics.json", workflow)
        self.assertIn("      - name: Save candidate evidence\n        uses:", workflow)
        self.assertNotIn("continue-on-error", workflow)

if __name__ == "__main__": unittest.main()
