#!/usr/bin/env python3
"""폐기 owned dotenv만 검증. 실제 키/서버/컨테이너는 접근하지 않는다."""
import base64
import hashlib
import importlib.util
import os
import re
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("owned_env", Path(__file__).with_name("disk-optimization-env-sync.py"))
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)
VALUES = {"ONQ_DISK_APP_ID": "1", "ONQ_DISK_INSTALLATION_ID": "2", "ONQ_DISK_APP_PRIVATE_KEY_BASE64": base64.b64encode(b"owned synthetic key, not an actual credential").decode(), "ONQ_DISK_CALLBACK_TOKEN": "owned_callback_fixture_" * 3}
ORIGINAL = b"# owned env\nPAYMENT_SECRET=owned-payment\nIMAGE_SECRET=owned-image\nDATABASE_URL=owned-db\nOTHER_SECRET=owned-other\nONQ_DISK_ACTIONS_TOKEN=owned-legacy-preserved\n"

class Fixture(unittest.TestCase):
    def test_unconfigured_is_no_write_and_no_key_process(self):
        with patch.object(source.subprocess, "run") as keycheck, patch.object(source.os, "open") as opened:
            self.assertFalse(source.sync(Path("/owned/.env"), {}))
            keycheck.assert_not_called(); opened.assert_not_called()

    def test_partial_ids_callback_and_bad_encoding_reject_before_file_open(self):
        for delta in [{"ONQ_DISK_INSTALLATION_ID": ""}, {"ONQ_DISK_APP_ID": "../other"}, {"ONQ_DISK_CALLBACK_TOKEN": "unsafe value"}, {"ONQ_DISK_APP_PRIVATE_KEY_BASE64": "not!base64"}]:
            with patch.object(source.os, "open") as opened:
                with self.assertRaises(source.Rejected):
                    source.sync(Path("/owned/.env"), {**VALUES, **delta}, lambda key: True)
                opened.assert_not_called()

    def test_key_check_uses_stdin_and_never_argv(self):
        with patch.object(source.subprocess, "run") as checked:
            checked.return_value.returncode = 0
            source.checked_values(VALUES)
            self.assertEqual(checked.call_args.args[0], ["openssl", "rsa", "-check", "-noout"])
            self.assertEqual(checked.call_args.kwargs["input"], base64.b64decode(VALUES["ONQ_DISK_APP_PRIVATE_KEY_BASE64"]))
            self.assertTrue(checked.call_args.kwargs["capture_output"])

    def test_bad_key_check_keeps_file_unopened(self):
        with patch.object(source.os, "open") as opened:
            with self.assertRaisesRegex(source.Rejected, "DISK_PREVIEW_KEY_INVALID"):
                source.sync(Path("/owned/.env"), VALUES, lambda key: False)
            opened.assert_not_called()

    def test_exact_allowlist_keeps_other_secret_lines_byte_identical(self):
        values = source.checked_values(VALUES, lambda key: True)
        old = ORIGINAL + b" export ONQ_DISK_APP_ID=9\nONQ_DISK_APP_ID=8\nONQ_DISK_ACTIONS_MODE=preview\n"
        result = source.merged(old, values)
        self.assertTrue(result.startswith(ORIGINAL))
        self.assertEqual(result.count(b"ONQ_DISK_APP_ID="), 1)
        self.assertTrue(result.endswith(b"ONQ_DISK_ACTIONS_MODE=preview\n"))
        self.assertNotIn(b"BEGIN PRIVATE KEY", result)

    def test_execution_true_is_never_silently_preserved_or_enabled(self):
        with self.assertRaisesRegex(source.Rejected, "DISK_EXECUTION_MUST_REMAIN_DISABLED"):
            source.merged(ORIGINAL + b"ONQ_DISK_EXECUTION_APPROVED=true\n", source.checked_values(VALUES, lambda key: True))

    def test_actual_official_workflow_only_syncs_four_inputs_after_backup_before_build(self):
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/deploy-obs-test.yml").read_text(encoding="utf-8")
        start = workflow.index("      - name: Sync MA120 preview-only env")
        stop = workflow.index("      - name: Build and start", start)
        step = workflow[start:stop]
        self.assertLess(workflow.index("      - name: Backup DB before deploy"), start)
        self.assertEqual(re.findall(r"          ([A-Z0-9_]+): \$\{\{ secrets\.([A-Z0-9_]+) \}\}", step), [(key, key) for key in source.KEYS])
        self.assertIn("        run: python3 scripts/ops/disk-optimization-env-sync.py", step)
        self.assertNotIn("continue-on-error", step)
        self.assertNotIn("docker", step)
        self.assertNotIn("echo", step)
        self.assertNotIn("ONQ_DISK_EXECUTION_APPROVED", step)

    def test_owned_posix_atomic_owner_mode_rotation_and_protection(self):
        if source.fcntl is None or not hasattr(os, "O_NOFOLLOW"):
            if os.environ.get("CI") == "true":
                self.fail("owned Linux CI must execute safe atomic env sync")
            self.skipTest("local POSIX lock unavailable; owned CI required")
        with tempfile.TemporaryDirectory(prefix="onq-env-owned-") as temporary:
            root = Path(temporary).resolve(); os.chmod(root, 0o700)
            env = root / ".env"; env.write_bytes(ORIGINAL); os.chmod(env, 0o600)
            protected = [root / name for name in ("backup.dump", "rollback.env", "shared-cache", "dirty-checkout")]
            for path in protected: path.write_bytes(b"preserved")
            before = {path: hashlib.sha256(path.read_bytes()).digest() for path in protected}
            self.assertTrue(source.sync(env, VALUES, lambda key: True))
            self.assertEqual(env.read_bytes(), source.merged(ORIGINAL, source.checked_values(VALUES, lambda key: True)))
            self.assertEqual(stat.S_IMODE(env.stat().st_mode), 0o600)
            self.assertEqual(env.stat().st_uid, os.geteuid())
            self.assertFalse(source.sync(env, VALUES, lambda key: True))
            rotated = {**VALUES, "ONQ_DISK_APP_PRIVATE_KEY_BASE64": base64.b64encode(b"owned rotated synthetic key").decode()}
            self.assertTrue(source.sync(env, rotated, lambda key: True))
            self.assertTrue(env.read_bytes().startswith(ORIGINAL))
            self.assertEqual(before, {path: hashlib.sha256(path.read_bytes()).digest() for path in protected})
            self.assertEqual(list(root.glob(".onq-disk-env-*")), [])
            os.chmod(env, 0o644)
            with self.assertRaisesRegex(source.Rejected, "DISK_ENV_OWNER_UNVERIFIED"): source.sync(env, VALUES, lambda key: True)
            os.chmod(env, 0o600)
            link = root / "link.env"; link.symlink_to(env)
            with self.assertRaisesRegex(source.Rejected, "DISK_ENV_PATH_UNVERIFIED"): source.sync(link, VALUES, lambda key: True)
            previous = env.read_bytes()
            with patch.object(source.os, "replace", side_effect=OSError("owned atomic failure")):
                with self.assertRaises(OSError): source.sync(env, VALUES, lambda key: True)
            self.assertEqual(env.read_bytes(), previous)
            self.assertEqual(list(root.glob(".onq-disk-env-*")), [])
            with patch.object(source, "merged", side_effect=lambda original, values: (env.write_bytes(b"owned concurrent change"), original)[1]):
                # 동일 내용 판정 전에 외부 writer가 바뀐 경우도 원본으로 덮지 않는다.
                with self.assertRaisesRegex(source.Rejected, "DISK_ENV_CHANGED"): source.sync(env, VALUES, lambda key: True)
            self.assertEqual(env.read_bytes(), b"owned concurrent change")

if __name__ == "__main__":
    unittest.main()
