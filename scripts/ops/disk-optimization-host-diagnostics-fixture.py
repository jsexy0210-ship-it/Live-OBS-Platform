#!/usr/bin/env python3
"""서버 접근 없이 owned 응답만 관찰한다."""
import importlib.util
import json
from pathlib import Path
import stat
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
        from io import BytesIO
        with patch.object(source.os, "geteuid", return_value=123, create=True), patch.object(source.Path, "is_absolute", return_value=True), patch.object(source.Path, "lstat", info), patch.object(source.Path, "open", return_value=BytesIO(("sha=" + SHA + " actor=owned-sensitive\n").encode())):
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
        with patch.object(source.os, "geteuid", return_value=123, create=True), patch.object(source.Path, "is_absolute", return_value=True), patch.object(source.Path, "lstat", return_value=info), patch.object(source.Path, "open") as opened:
            result = source.collect(ENV, run, lambda: {"status": "ok", "db": "ok", "testMode": False, "version": SHA})
            opened.assert_not_called()
        for key in ("identityVerified", "runnerDiagOwned", "historyOwned", "historyHasCommit", "oneLocalApp", "appImageMatchesHistory", "localHealthTestMode", "localHealthMatchesAppImage"): self.assertFalse(result[key], key)

    def test_workflow_preserves_original_plan_and_saves_diagnostic_only_on_failure(self):
        root = Path(__file__).resolve().parents[2]
        workflow = (root / ".github/workflows/disk-optimization-preview-obs-test.yml").read_text(encoding="utf-8")
        self.assertLess(workflow.index("python3 scripts/ops/disk-optimization-host-diagnostics.py"), workflow.index("bash scripts/ops/disk-optimization-plan.sh --preview"))
        self.assertIn("      - name: Save host diagnostics\n        if: always()", workflow)
        self.assertIn("/evidence/host-diagnostics.json", workflow)
        self.assertIn("      - name: Save candidate evidence\n        uses:", workflow)
        self.assertNotIn("continue-on-error", workflow)

if __name__ == "__main__": unittest.main()
