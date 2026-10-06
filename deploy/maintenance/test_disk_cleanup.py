"""Temporary-filesystem tests. Docker is a fixture executable; no VM/daemon access."""
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("disk-cleanup.sh")


def sha(n):
    return f"{n:040x}"


def image_id(n):
    return f"sha256:{n:064x}"


FAKE_DOCKER = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
state = json.loads(Path(os.environ['DOCKER_FIXTURE']).read_text())
with open(os.environ['DOCKER_CALLS'], 'a') as f:
    f.write(json.dumps(args) + '\n')
if state.get('fail') == args[0]:
    sys.exit(1)
if args == ['info']:
    pass
elif args[:2] == ['ps', '-q']:
    print('current' if state.get('running', True) else '')
elif args == ['ps', '-aq']:
    print('current\nstopped')
elif args[:3] == ['inspect', '--format', '{{.Config.Image}}']:
    print('\n'.join(state.get('current_tags', ['obs-web-app:' + format(5, '040x')])))
elif args[:2] == ['inspect', '--format']:
    print('\n'.join(state['in_use']))
elif args[:2] == ['image', 'ls']:
    print('\n'.join(f'{tag} {iid}' for tag, iid in state['images']))
elif args[:2] == ['image', 'rm']:
    assert len(args) == 3 and args[2].startswith(('obs-web-app:', 'obs-web-migrate:'))
elif args[:2] in (['image', 'prune'], ['builder', 'prune']):
    assert args[2:] == ['--force', '--filter', 'until=168h']
else:
    sys.exit(99)
'''


class DiskCleanupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.backups = self.root / "backups"
        self.backups.mkdir()
        self.history = self.root / "deploy-history.log"
        self.history.write_text("".join(f"2026-10-0{n} sha={sha(n)} run={n}\n" for n in [1, 2, 3, 4, 5, 5]))
        for n in range(1, 7):
            (self.backups / f"obs-2026100{n}-030000-before-{sha(n)[:7]}.dump").write_text(f"backup-{n}")
        for name in ["manual.dump", "obs-20261001-030000-before-restore.dump", "obs-20261001-030000-before-0000000.dump.part", "unrelated.txt"]:
            (self.backups / name).write_text("preserve")
        (self.root / ".env").write_text("sentinel")
        (self.root / "postgres-volume").mkdir()
        (self.root / "postgres-volume/data").write_text("database sentinel")
        self.state = {
            "images": [(f"obs-web-{service}:{sha(n)}", image_id(n if service == "app" else n + 100)) for n in range(1, 7) for service in ["app", "migrate"]]
            + [("postgres:16", image_id(900)), ("unrelated:latest", image_id(901))],
            "in_use": [image_id(5), image_id(2), image_id(105), image_id(900)],
        }
        self.fixture = self.root / "docker.json"
        self.calls = self.root / "calls.jsonl"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        fake = self.bin / "docker"
        fake.write_text(FAKE_DOCKER)
        fake.chmod(0o755)

    def run_script(self, *args):
        self.fixture.write_text(json.dumps(self.state))
        env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}", OBS_BACKUP_DIR=str(self.backups), OBS_HISTORY_FILE=str(self.history), DOCKER_FIXTURE=str(self.fixture), DOCKER_CALLS=str(self.calls))
        return subprocess.run(["bash", str(SCRIPT), *args], env=env, capture_output=True, text=True)

    def docker_calls(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def snapshot(self):
        return {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob("*") if p.is_file() and p not in [self.fixture, self.calls]}

    def assert_no_mutations(self):
        self.assertFalse(any(c[:2] in [["image", "rm"], ["image", "prune"], ["builder", "prune"]] for c in self.docker_calls()))

    def test_default_dry_run_changes_no_files_or_docker(self):
        before = self.snapshot()
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.snapshot(), before)
        self.assert_no_mutations()

    def test_apply_keeps_latest_three_automatic_backups_and_other_data(self):
        result = self.run_script("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        automatic = sorted(p for p in self.backups.iterdir() if re.fullmatch(r"obs-[0-9]{8}-[0-9]{6}-before-[0-9a-f]{7}\.dump", p.name))
        self.assertEqual([p.read_text() for p in automatic], ["backup-4", "backup-5", "backup-6"])
        self.assertEqual((self.backups / "manual.dump").read_text(), "preserve")
        self.assertTrue((self.backups / "obs-20261001-030000-before-0000000.dump.part").exists())
        self.assertEqual((self.root / ".env").read_text(), "sentinel")
        self.assertEqual((self.root / "postgres-volume/data").read_text(), "database sentinel")
        removed = [c[2] for c in self.docker_calls() if c[:2] == ["image", "rm"]]
        self.assertEqual(set(removed), {f"obs-web-{service}:{sha(n)}" for service, n in [("app", 1), ("migrate", 1), ("migrate", 2), ("app", 6), ("migrate", 6)]})
        self.assertIn(["image", "prune", "--force", "--filter", "until=168h"], self.docker_calls())
        self.assertIn(["builder", "prune", "--force", "--filter", "until=168h"], self.docker_calls())

    def test_image_alias_used_by_container_is_preserved(self):
        self.state["images"].append((f"obs-web-app:{sha(42)}", image_id(5)))
        result = self.run_script("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(["image", "rm", f"obs-web-app:{sha(42)}"], self.docker_calls())

    def test_missing_history_fails_without_deletion(self):
        self.history.unlink()
        before = self.snapshot()
        self.assertNotEqual(self.run_script("--apply").returncode, 0)
        self.assertEqual(self.snapshot(), before)
        self.assert_no_mutations()

    def test_invalid_history_fails_without_deletion(self):
        self.history.write_text("sha=invalid\n")
        before = self.snapshot()
        self.assertNotEqual(self.run_script("--apply").returncode, 0)
        self.assertEqual(self.snapshot(), before)
        self.assert_no_mutations()

    def test_docker_query_failure_aborts_before_backup_deletion(self):
        for operation in ["info", "ps", "inspect", "image"]:
            with self.subTest(operation=operation):
                self.state["fail"] = operation
                before = self.snapshot()
                self.assertNotEqual(self.run_script("--apply").returncode, 0)
                self.assertEqual(self.snapshot(), before)
                self.assert_no_mutations()

    def test_missing_current_app_aborts(self):
        self.state["running"] = False
        before = self.snapshot()
        self.assertNotEqual(self.run_script("--apply").returncode, 0)
        self.assertEqual(self.snapshot(), before)
        self.assert_no_mutations()

    def test_symlink_backup_directory_is_rejected(self):
        original = self.backups
        self.backups = self.root / "backup-link"
        self.backups.symlink_to(original, target_is_directory=True)
        self.assertNotEqual(self.run_script("--apply").returncode, 0)
        self.assert_no_mutations()

    def test_symlink_backup_file_is_preserved(self):
        p = self.backups / "obs-20261001-020000-before-0000000.dump"
        p.symlink_to(self.root / ".env")
        self.assertEqual(self.run_script("--apply").returncode, 0)
        self.assertTrue(p.is_symlink())
        self.assertEqual((self.root / ".env").read_text(), "sentinel")

    def test_older_current_rollback_keeps_both_app_and_migrator_images(self):
        self.state["current_tags"] = [f"obs-web-app:{sha(1)}"]
        self.state["in_use"] = [image_id(1), image_id(105), image_id(900)]
        self.assertEqual(self.run_script("--apply").returncode, 0)
        for service in ["app", "migrate"]:
            self.assertNotIn(["image", "rm", f"obs-web-{service}:{sha(1)}"], self.docker_calls())

    def test_unknown_current_version_tag_aborts(self):
        self.state["current_tags"] = ["obs-web-app:local"]
        before = self.snapshot()
        self.assertNotEqual(self.run_script("--apply").returncode, 0)
        self.assertEqual(self.snapshot(), before)
        self.assert_no_mutations()

    def test_corrupt_record_among_valid_history_aborts(self):
        self.history.write_text(self.history.read_text() + "2026-10-06 sha=corrupt run=6\n")
        before = self.snapshot()
        self.assertNotEqual(self.run_script("--apply").returncode, 0)
        self.assertEqual(self.snapshot(), before)
        self.assert_no_mutations()

    def test_duplicate_sha_field_is_rejected(self):
        self.history.write_text(f"sha={sha(5)} sha={sha(4)}\n")
        self.assertNotEqual(self.run_script("--apply").returncode, 0)
        self.assert_no_mutations()

    def test_parent_traversal_path_is_rejected(self):
        self.backups = self.backups / ".." / "backups"
        self.assertNotEqual(self.run_script("--apply").returncode, 0)
        self.assert_no_mutations()

    def test_symlink_history_is_rejected(self):
        target = self.root / "history-target"
        self.history.rename(target)
        self.history.symlink_to(target)
        self.assertNotEqual(self.run_script("--apply").returncode, 0)
        self.assert_no_mutations()

    def test_malformed_docker_image_ids_aborts(self):
        self.state["in_use"] = ["invalid"]
        before = self.snapshot()
        self.assertNotEqual(self.run_script("--apply").returncode, 0)
        self.assertEqual(self.snapshot(), before)
        self.assert_no_mutations()

    def test_unknown_options_do_not_call_docker(self):
        self.assertEqual(self.run_script("--force").returncode, 2)
        self.assertEqual(self.run_script("--apply", "extra").returncode, 2)
        self.assertEqual(self.docker_calls(), [])


if __name__ == "__main__":
    unittest.main()
