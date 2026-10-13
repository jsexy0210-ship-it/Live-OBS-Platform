#!/usr/bin/env python3
"""폐기 owned 합성만. 실제 Docker/HTTP/host 실행은 주입하지 않는다."""
import datetime as dt
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import io
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("owned_runner", Path(__file__).with_name("disk-optimization-runner.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
REQUEST = "00000000-0000-4000-8000-000000000001"
IMAGE = {"category": runner.IMAGE, "id": "sha256:" + "a" * 64, "bytes": 100, "contentHash": "a" * 64}
LOG = {"category": runner.LOG, "id": "Worker_owned.log", "bytes": 3, "contentHash": hashlib.sha256(b"old").hexdigest()}

class OwnedHandle(io.BytesIO):
    def fileno(self):
        return 10

class Fixture(unittest.TestCase):
    def owned(self):
        candidates, mutations, requests = [dict(IMAGE), dict(LOG)], [], []
        claimed = False
        def send(payload):
            nonlocal claimed
            requests.append(payload)
            if payload["action"] == "claim":
                if claimed:
                    raise runner.Rejected("CLAIM_ALREADY_TAKEN")
                claimed = True
                return {"ok": True, "job": {"id": "101", "requestId": REQUEST, "candidateFingerprint": runner.fingerprint([IMAGE, LOG]), "state": "RUNNING"}}
            return {"ok": True}
        def remove(candidate):
            mutations.append(candidate)
            candidates.remove(candidate)
        measures = iter([1000, 1090])
        args = dict(expected=runner.fingerprint(candidates), expires_at=(dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5)).isoformat(), read=lambda: list(candidates), send=send, remove=remove, measure=lambda: next(measures))
        return args, mutations, requests, candidates

    def test_preview_has_two_categories_and_mutation_zero(self):
        args, mutations, requests, _ = self.owned()
        runner.run("preview", REQUEST, "101", **args)
        self.assertEqual([r["action"] for r in requests], ["preview"])
        self.assertEqual(requests[0]["evidence"]["candidates"], [IMAGE, LOG])
        self.assertEqual(mutations, [])

    def test_partial_manifest_exclusion_is_readonly_and_never_claims_or_mutates(self):
        marker = "EXCLUDED_CATEGORY\t" + runner.LOG + "\tRUNNER_DIAG_WRITABLE_BY_GROUP_OR_OTHER\tREADONLY_ONLY\n"
        image = "\t".join([runner.IMAGE, IMAGE["id"], str(IMAGE["bytes"]), IMAGE["contentHash"]]) + "\n"
        for rows, expected in ((image, [IMAGE]), ("", [])):
            with patch.object(runner.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=(runner.POLICY + "\n" + marker + rows).encode())):
                candidates = runner.plan()
            sent, mutations = [], []
            runner.run("preview", REQUEST, "101", read=lambda: candidates, send=lambda payload: sent.append(payload), remove=lambda c: mutations.append(c))
            self.assertFalse(sent[0]["evidence"]["runnerValidated"])
            self.assertEqual(sent[0]["evidence"]["candidates"], expected)
            self.assertEqual(sent[0]["evidence"]["excludedCategories"], [{"category": runner.LOG, "reason": "RUNNER_DIAG_WRITABLE_BY_GROUP_OR_OTHER"}])
            with self.assertRaisesRegex(runner.Rejected, "PARTIAL_PREVIEW_EXECUTION_DENIED"):
                runner.run("execute", REQUEST, "101", read=lambda: candidates, send=lambda payload: self.fail("no claim"), remove=lambda c: mutations.append(c))
            self.assertEqual(mutations, [])
        log = "\t".join([runner.LOG, LOG["id"], str(LOG["bytes"]), LOG["contentHash"]]) + "\n"
        for rows in (marker + marker, marker + log, marker.replace("READONLY_ONLY", "OTHER")):
            with patch.object(runner.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=(runner.POLICY + "\n" + rows).encode())), self.assertRaises(runner.Rejected):
                runner.plan()

    def test_claim_precedes_each_mutation_and_result_is_measured(self):
        args, mutations, requests, _ = self.owned()
        original = args["remove"]
        def remove(candidate):
            self.assertEqual(requests[0]["action"], "claim")
            original(candidate)
        args["remove"] = remove
        runner.run("execute", REQUEST, "101", **args)
        self.assertEqual(mutations, [IMAGE, LOG])
        self.assertEqual(requests[-1]["reclaimedBytes"], 90)
        self.assertIsNone(requests[-1]["errorCode"])

    def test_expiry_and_changed_candidate_mutation_zero(self):
        for reason in ["expiry", "candidate"]:
            args, mutations, requests, _ = self.owned()
            args["expires_at" if reason == "expiry" else "expected"] = "2000-01-01T00:00:00.000Z" if reason == "expiry" else "b" * 64
            with self.assertRaises(runner.Rejected):
                runner.run("execute", REQUEST, "101", **args)
            self.assertEqual(mutations, [])
            self.assertEqual(requests, [])

    def test_claim_denial_and_wrong_ack_mutation_zero(self):
        for wrong in [False, True]:
            args, mutations, _, _ = self.owned()
            def send(payload):
                if not wrong:
                    raise runner.Rejected("CLAIM_DENIED")
                return {"ok": True, "job": {"id": "102"}}
            args["send"] = send
            with self.assertRaises(runner.Rejected):
                runner.run("execute", REQUEST, "101", **args)
            self.assertEqual(mutations, [])

    def test_partial_after_claim_or_before_second_candidate_stops_with_failed_result(self):
        images = [dict(IMAGE), {**IMAGE, "id": "sha256:" + "b" * 64, "contentHash": "b" * 64}]
        exclusion = [{"category": runner.LOG, "reason": "RUNNER_DIAG_WRITABLE_BY_GROUP_OR_OTHER"}]
        for boundary in (0, 1):
            mutations, requests = [], []
            reads = iter([images, *([images] if boundary else []), runner.PlanCandidates(images[boundary:], exclusion)])
            expected = runner.fingerprint(images)
            def send(payload):
                requests.append(payload)
                if payload["action"] == "claim":
                    return {"ok": True, "job": {"id": "101", "requestId": REQUEST, "candidateFingerprint": expected, "state": "RUNNING"}}
                return {"ok": True}
            with self.subTest(boundary=boundary), self.assertRaisesRegex(runner.Rejected, "PARTIAL_PREVIEW_EXECUTION_DENIED"):
                runner.run("execute", REQUEST, "101", expected=expected, expires_at=(dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5)).isoformat(), read=lambda: next(reads), send=send, remove=lambda c: mutations.append(c), measure=lambda: 1000)
            self.assertEqual(mutations, images[:boundary])
            self.assertNotIn(images[boundary], mutations)
            self.assertEqual([r["action"] for r in requests], ["claim", "result"])
            self.assertEqual(requests[-1]["errorCode"], "PARTIAL_PREVIEW_EXECUTION_DENIED")
            self.assertEqual(requests[-1]["reclaimedBytes"], 0)
            self.assertEqual(requests[-1]["candidateFingerprint"], expected)

    def test_changed_after_claim_mutation_zero_and_failed_result(self):
        args, mutations, requests, _ = self.owned()
        reads = iter([[IMAGE, LOG], [IMAGE]])
        args["read"] = lambda: next(reads)
        with self.assertRaisesRegex(runner.Rejected, "CANDIDATE_CHANGED"):
            runner.run("execute", REQUEST, "101", **args)
        self.assertEqual(mutations, [])
        self.assertEqual(requests[-1]["errorCode"], "CANDIDATE_CHANGED")

    def test_second_claim_and_measure_failure_never_report_success(self):
        args, mutations, requests, _ = self.owned()
        args["send"]({"action": "claim"})
        with self.assertRaisesRegex(runner.Rejected, "CLAIM_ALREADY_TAKEN"):
            runner.run("execute", REQUEST, "101", **args)
        self.assertEqual(mutations, [])
        args, _, requests, _ = self.owned()
        count = 0
        def measure():
            nonlocal count
            count += 1
            if count > 1:
                raise OSError("owned measure unavailable")
            return 1000
        args["measure"] = measure
        with self.assertRaisesRegex(runner.Rejected, "DISK_MEASUREMENT_UNAVAILABLE"):
            runner.run("execute", REQUEST, "101", **args)
        self.assertFalse(any(r["action"] == "result" for r in requests))

    def test_image_delete_only_approved_id_and_nonforce_no_prune(self):
        with patch.object(runner, "verify_docker_host"), patch.object(runner.subprocess, "run") as call:
            call.return_value.returncode = 0
            runner.remove_candidate(IMAGE)
            self.assertEqual(call.call_args.args[0], ["docker", "--host", "unix:///var/run/docker.sock", "image", "rm", "--no-prune", IMAGE["id"]])
            call.return_value.returncode = 1
            with self.assertRaisesRegex(runner.Rejected, "IMAGE_REMOVAL_REJECTED"):
                runner.remove_candidate(IMAGE)

    def test_foreign_file_owner_at_every_stat_mutation_zero(self):
        at = (dt.datetime.now() - dt.timedelta(days=16)).timestamp()
        def snapshot(uid):
            return SimpleNamespace(st_uid=uid, st_mode=stat.S_IFREG | 0o600, st_dev=1, st_ino=2, st_size=3, st_mtime_ns=1, st_mtime=at)
        for foreign in range(3):
            snapshots = [snapshot(7), snapshot(7), snapshot(7)]
            snapshots[foreign].st_uid = 8
            with patch.dict(os.environ, {"OBS_RUNNER_ROOT": "/owned/runner"}), patch.object(runner.os.path, "islink", return_value=False), patch.object(runner.os.path, "realpath", side_effect=lambda p: p), patch.object(runner.os, "geteuid", return_value=7, create=True), patch.object(runner.os, "O_DIRECTORY", 0, create=True), patch.object(runner.os, "O_NOFOLLOW", 0, create=True), patch.object(runner.os, "open", return_value=10), patch.object(runner.os, "close"), patch.object(runner.os, "fdopen", return_value=OwnedHandle(b"old")), patch.object(runner.os, "fstat", side_effect=snapshots[:2]), patch.object(runner.os, "stat", side_effect=[SimpleNamespace(st_uid=7, st_mode=0o700), snapshots[2]]), patch.object(runner.os, "unlink") as mutation:
                with self.assertRaisesRegex(runner.Rejected, "LOG_CHANGED_OR_PROTECTED"):
                    runner.remove_candidate(LOG)
                mutation.assert_not_called()

    def test_foreign_endpoint_context_host_daemon_mutation_zero(self):
        endpoint = "unix:///var/run/docker.sock"
        normal = {"DOCKER_HOST": endpoint, "DOCKER_CONTEXT": "default", "DOCKER_TLS_VERIFY": "", "DOCKER_CERT_PATH": ""}
        for key, value in [("DOCKER_HOST", "tcp://other:2375"), ("DOCKER_CONTEXT", "other"), ("DOCKER_TLS_VERIFY", "1"), ("DOCKER_CERT_PATH", "/other")]:
            with patch.dict(os.environ, {**normal, key: value}), patch.object(runner.subprocess, "run") as call:
                with self.assertRaisesRegex(runner.Rejected, "DOCKER_ENDPOINT_DENIED"):
                    runner.remove_candidate(IMAGE)
                call.assert_not_called()
        for host, context, daemon in [("other-host", endpoint, "obs-web-test"), ("obs-web-test", "tcp://other:2375", "obs-web-test"), ("obs-web-test", endpoint, "other-daemon")]:
            with patch.dict(os.environ, normal), patch.object(runner.socket, "gethostname", return_value=host), patch.object(runner.subprocess, "run", side_effect=[SimpleNamespace(returncode=0, stdout=context.encode()), SimpleNamespace(returncode=0, stdout=daemon.encode())]) as call:
                with self.assertRaisesRegex(runner.Rejected, "DOCKER_HOST_UNVERIFIED"):
                    runner.remove_candidate(IMAGE)
                self.assertFalse(any("rm" in c.args[0] for c in call.call_args_list))
        with patch.dict(os.environ, normal), patch.object(runner.socket, "gethostname", return_value="obs-web-test"), patch.object(runner.subprocess, "run", side_effect=[SimpleNamespace(returncode=0, stdout=endpoint.encode()), SimpleNamespace(returncode=0, stdout=b"obs-web-test"), SimpleNamespace(returncode=0, stdout=b"")]) as call:
            runner.remove_candidate(IMAGE)
            self.assertEqual(call.call_args.args[0], ["docker", "--host", endpoint, "image", "rm", "--no-prune", IMAGE["id"]])
            self.assertFalse({"DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"} & call.call_args.kwargs["env"].keys())

    def test_owned_posix_log_and_protected_hashes(self):
        supported = hasattr(os, "O_NOFOLLOW") and os.unlink in os.supports_dir_fd and os.open in os.supports_dir_fd
        if not supported:
            if os.environ.get("CI") == "true":
                self.fail("owned CI must exercise POSIX safe unlink")
            self.skipTest("local POSIX dir_fd unavailable; owned CI required")
        with tempfile.TemporaryDirectory(prefix="onq-disk-owned-") as temporary:
            root = Path(temporary)
            diag = root / "runner" / "_diag"
            diag.mkdir(parents=True)
            for name in ["backup.dump", "shared-cache", "rollback-image", "checkout-dirty"]:
                (root / name).write_bytes(b"preserved")
            for name in ["Runner_recent.log", "customer.log"]:
                (diag / name).write_bytes(b"preserved")
            protected = {p: hashlib.sha256(p.read_bytes()).digest() for p in root.rglob("*") if p.is_file()}
            target = diag / LOG["id"]
            target.write_bytes(b"old")
            at = (dt.datetime.now() - dt.timedelta(days=16)).timestamp()
            os.utime(target, (at, at))
            with patch.dict(os.environ, {"OBS_RUNNER_ROOT": str(diag.parent)}):
                link = diag / "Worker_link.log"
                link.symlink_to(root / "backup.dump")
                with self.assertRaises((runner.Rejected, OSError)):
                    runner.remove_candidate({**LOG, "id": link.name})
                with self.assertRaises(runner.Rejected):
                    runner.remove_candidate({**LOG, "id": "Runner_recent.log", "bytes": 9, "contentHash": hashlib.sha256(b"preserved").hexdigest()})
                target.write_bytes(b"changed")
                with self.assertRaises(runner.Rejected):
                    runner.remove_candidate(LOG)
                target.write_bytes(b"old")
                os.utime(target, (at, at))
                runner.remove_candidate(LOG)
            self.assertFalse(target.exists())
            self.assertEqual({p: hashlib.sha256(p.read_bytes()).digest() for p in protected}, protected)

if __name__ == "__main__":
    unittest.main()
