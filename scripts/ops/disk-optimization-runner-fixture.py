#!/usr/bin/env python3
"""폐기 owned 합성만. 실제 Docker/HTTP/host 실행은 주입하지 않는다."""
import datetime as dt
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("owned_runner", Path(__file__).with_name("disk-optimization-runner.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
REQUEST = "00000000-0000-4000-8000-000000000001"
IMAGE = {"category": runner.IMAGE, "id": "sha256:" + "a" * 64, "bytes": 100, "contentHash": "a" * 64}
LOG = {"category": runner.LOG, "id": "Worker_owned.log", "bytes": 3, "contentHash": hashlib.sha256(b"old").hexdigest()}

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
        with patch.object(runner.subprocess, "run") as call:
            call.return_value.returncode = 0
            runner.remove_candidate(IMAGE)
            self.assertEqual(call.call_args.args[0], ["docker", "image", "rm", "--no-prune", IMAGE["id"]])
            call.return_value.returncode = 1
            with self.assertRaisesRegex(runner.Rejected, "IMAGE_REMOVAL_REJECTED"):
                runner.remove_candidate(IMAGE)

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
