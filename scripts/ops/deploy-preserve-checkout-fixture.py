#!/usr/bin/env python3
"""Actual local Git transitions; no network, daemon, database or server writes.

Windows cannot exercise Linux flock/proc. Only those host observations are
substituted there; Git checkout, source contents and failure preservation are real.
"""
import contextlib
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('preserve', Path(__file__).with_name('deploy-preserve-checkout.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class PreserveCheckoutFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='owned-deploy-fixture-')
        self.root = Path(self.temporary.name).resolve() / 'repo'
        self.root.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'core.autocrlf', 'false')
        (self.root / 'source.txt').write_bytes(b'old source\n')
        (self.root / '.gitignore').write_bytes(b'ignored.txt\noperator-ignored.bin\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'initial fixture')
        self.old = self.git('rev-parse', 'HEAD').decode().strip()
        (self.root / 'source.txt').write_bytes(b'candidate source\n')
        (self.root / 'new.txt').write_bytes(b'candidate new file\n')
        (self.root / 'ignored.txt').write_bytes(b'candidate ignored path\n')
        self.git('add', 'source.txt', 'new.txt')
        self.git('add', '-f', 'ignored.txt')
        self.git('commit', '-qm', 'candidate fixture')
        self.target = self.git('rev-parse', 'HEAD').decode().strip()
        self.git('checkout', '-q', '--detach', self.old)
        # These are fixture-owned synthetic originals, never real DB/backup files.
        for name in ('original.txt', 'backup.dump', 'image.png', 'work-in-progress.txt'):
            (self.root / name).write_bytes(b'preserve ' + name.encode())
        self.lock = None
        if os.name != 'posix':
            self.lock = patch.object(guard, 'checkout_lease', lambda _: contextlib.nullcontext())
            self.lock.start()

    def tearDown(self):
        if self.lock:
            self.lock.stop()
        self.temporary.cleanup()

    def git(self, *args):
        result = subprocess.run(['git', '-C', str(self.root), *args], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
        return result.stdout

    def state(self):
        return {p.relative_to(self.root).as_posix(): p.read_bytes()
                for p in self.root.rglob('*') if p.is_file() and '.git' not in p.relative_to(self.root).parts}

    def update(self, activity=lambda _: None):
        return guard.update(self.root, self.target, activity=activity)

    def refused_unchanged(self, activity=lambda _: None):
        before = self.state()
        old_head = self.git('rev-parse', 'HEAD')
        with self.assertRaises((guard.Preserve, OSError)):
            self.update(activity)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.git('rev-parse', 'HEAD'), old_head)

    def test_normal_update_preserves_four_originals_and_exact_head(self):
        before = guard.originals(self.root)
        self.assertEqual(self.update(), 4)
        self.assertEqual(guard.originals(self.root), before)
        self.assertEqual(self.git('rev-parse', 'HEAD').decode().strip(), self.target)
        self.assertEqual(self.git('status', '--porcelain', '--untracked-files=no'), b'')
        self.assertEqual((self.root / 'source.txt').read_bytes(), b'candidate source\n')

    def test_tracked_dirty_refused_before_checkout(self):
        (self.root / 'source.txt').write_bytes(b'in-progress source')
        self.refused_unchanged()

    def test_staged_work_refused(self):
        (self.root / 'source.txt').write_bytes(b'staged source')
        self.git('add', 'source.txt')
        self.refused_unchanged()

    def test_untracked_collision_refused(self):
        (self.root / 'new.txt').write_bytes(b'operator original')
        self.refused_unchanged()

    def test_ignored_collision_refused(self):
        (self.root / 'ignored.txt').write_bytes(b'operator ignored original')
        self.refused_unchanged()

    def test_nonconflicting_ignored_original_preserved(self):
        (self.root / 'operator-ignored.bin').write_bytes(b'ignored original')
        before = guard.originals(self.root)
        self.assertEqual(self.update(), 5)
        self.assertEqual(guard.originals(self.root), before)

    def test_index_lock_refused(self):
        (self.root / '.git/index.lock').write_bytes(b'another Git operation')
        self.refused_unchanged()

    def test_hidden_tracked_work_refused(self):
        self.git('update-index', '--assume-unchanged', 'source.txt')
        (self.root / 'source.txt').write_bytes(b'hidden source work')
        self.refused_unchanged()

    def test_active_writer_and_unknown_observation_refused(self):
        for reason in ('ACTIVE_CHECKOUT_REFERENCE', 'ACTIVE_STATE_UNKNOWN'):
            with self.subTest(reason=reason):
                def active(_):
                    raise guard.Preserve(reason)
                self.refused_unchanged(active)

    def test_change_between_observations_refused(self):
        calls = []
        def writer(_):
            calls.append(True)
            if len(calls) == 2:
                (self.root / 'source.txt').write_bytes(b'concurrent writer')
        with self.assertRaises(guard.Preserve):
            self.update(writer)
        self.assertEqual(self.git('rev-parse', 'HEAD').decode().strip(), self.old)
        self.assertEqual((self.root / 'source.txt').read_bytes(), b'concurrent writer')

    def test_missing_candidate_fails_without_changing_originals(self):
        self.target = 'f' * 40
        self.refused_unchanged()

    def test_workflow_preserves_other_deploy_gates(self):
        workflow = Path(__file__).parents[2] / '.github/workflows/deploy-obs-test.yml'
        text = workflow.read_text(encoding='utf-8')
        self.assertNotIn('uses: actions/checkout', text)
        self.assertIn('working-directory: ${{ runner.temp }}', text)
        for gate in ('Check target commit', 'Check disk space', 'Backup DB before deploy',
                     'Sync image storage env', 'Sync payment and YouTube env',
                     'Sync external shop env', 'Sync MA120 preview-only env',
                     'Build and start', 'Health check', 'Record deploy', 'Check disk after deploy'):
            self.assertIn('name: ' + gate, text)


if __name__ == '__main__':
    unittest.main()
