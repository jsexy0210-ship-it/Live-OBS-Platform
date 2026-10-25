#!/usr/bin/env python3
"""Disposable fixtures; Docker/host references are mocked, never a real daemon."""
import importlib.util
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cache_only', Path(__file__).with_name('cache-only-cleanup.py'))
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


class CacheOnlyFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve() / 'checkout'
        self.root.mkdir()
        (self.root / '.next/cache').mkdir(parents=True)
        self.old = self.root / '.next/cache/old.pack'
        self.old.write_bytes(b'old derived build cache')
        self.now = time.time() + 8 * 86400
        self.saved = self.root / '.next/BUILD_ID'
        self.saved.write_text('preserve output')
        (self.root.parent / 'backups').mkdir()
        (self.root.parent / 'backups/keep.dump').write_text('preserve backup')
        self.uid = patch.object(cache.os, 'getuid', create=True, return_value=self.root.stat().st_uid)
        self.uid.start()
        self.head = '1' * 40
        (self.root.parent / 'deploy-history.log').write_text('sha=' + self.head)
        (self.root / '.dockerignore').write_text('.next\n')

    def tearDown(self):
        self.uid.stop()
        self.tmp.cleanup()

    def test_selects_only_old_cache_files(self):
        young = self.root / '.next/cache/young.pack'
        young.write_text('recent cache')
        os.utime(young, (self.now, self.now))
        state = cache.snapshot(self.root, self.now)
        self.assertEqual(state['selected'], ['.next/cache/old.pack'])

    def test_creation_time_also_preserves_new_copy(self):
        os.utime(self.old, (0, 0))
        self.assertEqual(cache.snapshot(self.root, time.time())['selected'], [])

    def test_missing_cache_is_zero_candidate(self):
        self.old.unlink()
        (self.root / '.next/cache').rmdir()
        self.assertEqual(cache.snapshot(self.root, self.now)['selected'], [])

    def test_hardlink_is_preserved(self):
        os.link(self.old, self.root / 'source-copy')
        with self.assertRaises(cache.Preserve):
            cache.snapshot(self.root, self.now)

    def test_symlink_is_preserved(self):
        (self.root / '.next/cache/source-link').symlink_to(self.saved)
        with self.assertRaises(cache.Preserve):
            cache.snapshot(self.root, self.now)
        self.assertEqual(self.saved.read_text(), 'preserve output')

    def test_ownership_unknown_is_preserved(self):
        with patch.object(cache.os, 'getuid', return_value=-1), self.assertRaises(cache.Preserve):
            cache.snapshot(self.root, self.now)

    def test_exact_apply_or_unsupported_platform_preserves_other_scopes(self):
        state = cache.snapshot(self.root, self.now)
        report = {}
        if os.name == 'posix':
            self.assertEqual(cache.remove_selected(self.root, state, report), (1, len(b'old derived build cache')))
            self.assertFalse(self.old.exists())
            self.assertEqual(report['deleted_files'], 1)
        else:
            with self.assertRaises(cache.Preserve):
                cache.remove_selected(self.root, state, report)
            self.assertTrue(self.old.exists())
        self.assertEqual(self.saved.read_text(), 'preserve output')
        self.assertEqual((self.root.parent / 'backups/keep.dump').read_text(), 'preserve backup')
        self.assertTrue((self.root / '.next/cache').is_dir())

    def test_replaced_file_is_preserved(self):
        state = cache.snapshot(self.root, self.now)
        self.old.write_bytes(b'new working cache, preserve')
        with self.assertRaises(cache.Preserve):
            cache.remove_selected(self.root, state)
        self.assertEqual(self.old.read_bytes(), b'new working cache, preserve')

    def test_unknown_active_references_fail_closed(self):
        with patch.object(cache, 'guard', return_value='UNKNOWN'), self.assertRaises(cache.Preserve):
            cache.references(self.root)

    def test_mount_unknown_fails_closed(self):
        with patch.object(cache, 'guard', side_effect=['no', 'UNKNOWN']), self.assertRaises(cache.Preserve):
            cache.references(self.root)

    def test_container_reference_is_preserved(self):
        responses = ['a' * 12, json.dumps([{'Source': str(self.root), 'Destination': '/app'}])]
        with patch.object(cache, 'guard', side_effect=['no', 'same']), patch.object(cache, 'run', side_effect=responses), self.assertRaises(cache.Preserve):
            cache.references(self.root)

    def test_no_buildkit_or_broad_cleanup_subprocess(self):
        commands = []
        def fake_run(argv):
            commands.append(argv)
            if argv[:3] == ['docker', 'ps', '-aq']:
                return ''
            raise AssertionError('Unexpected daemon command')
        with patch.object(cache, 'guard', side_effect=['no', 'same']), patch.object(cache, 'run', side_effect=fake_run), self.assertRaises(cache.Preserve):
            cache.references(self.root)
        self.assertTrue(commands)
        self.assertTrue(all(c[:3] == ['docker', 'ps', '-aq'] for c in commands))

    def test_malformed_cache_boundary_is_preserved(self):
        state = {'nodes': {}, 'selected': ['../backups/keep.dump']}
        with self.assertRaises(cache.Preserve):
            cache.remove_selected(self.root, state)
        self.assertTrue((self.root.parent / 'backups/keep.dump').exists())

    def test_partial_failure_keeps_verified_count_and_other_paths(self):
        state = cache.snapshot(self.root, self.now)
        state['selected'].append('../backups/keep.dump')
        report = {'deleted_files': 0, 'verified_removed_file_bytes': 0}
        with self.assertRaises(cache.Preserve):
            cache.remove_selected(self.root, state, report)
        self.assertEqual(report['deleted_files'], 1 if os.name == 'posix' else 0)
        self.assertTrue((self.root.parent / 'backups/keep.dump').exists())

    def git_read(self, argv):
        self.assertEqual(argv[0], 'git')
        if 'rev-parse' in argv:
            return self.head
        return ''

    def invoke(self, mode, expected='', guard_value='ONQ clean', fresh_change=False):
        env = {'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
               'GITHUB_REF': 'refs/heads/main', 'GITHUB_REPOSITORY': cache.REPOSITORY,
               'GITHUB_WORKFLOW': 'Cache-only cleanup obs-test'}
        output = io.StringIO()
        with patch.object(cache, 'ROOT', self.root), patch.dict(os.environ, env, clear=True), \
             patch.object(cache, 'guard', return_value=guard_value), patch.object(cache, 'run', side_effect=self.git_read), \
             patch.object(cache, 'references'), patch.object(cache.time, 'time', return_value=self.now), \
             patch('sys.argv', ['cache-only', '--mode', mode, '--expected-preview', expected]), \
             contextlib.redirect_stdout(output):
            if fresh_change:
                original = cache.plan
                calls = 0
                def changed_plan():
                    nonlocal calls
                    calls += 1
                    if calls == 2:
                        self.old.write_bytes(b'changed during apply, preserve')
                    return original()
                with patch.object(cache, 'plan', side_effect=changed_plan):
                    code = cache.main()
            else:
                code = cache.main()
        return code, json.loads(output.getvalue())

    def test_preview_is_readonly_and_apply_binds_identical_selection(self):
        code, preview = self.invoke('preview')
        self.assertEqual((code, preview['candidate_files'], preview['deleted_files']), (0, 1, 0))
        self.assertTrue(self.old.exists())
        code, result = self.invoke('apply', preview['preview_sha256'])
        if os.name == 'posix':
            self.assertEqual((code, result['deleted_files']), (0, 1))
            self.assertFalse(self.old.exists())
        else:
            self.assertEqual(result['reason'], 'SAFE_UNLINK_PLATFORM_UNSUPPORTED')
        self.assertTrue(self.saved.exists())
        self.assertTrue((self.root.parent / 'backups/keep.dump').exists())

    def test_wrong_preview_never_deletes(self):
        code, result = self.invoke('apply', '0' * 64)
        self.assertEqual((code, result['reason'], result['deleted_files']), (1, 'PREVIEW_MISMATCH', 0))
        self.assertTrue(self.old.exists())

    def test_changed_preview_is_preserved(self):
        _, preview = self.invoke('preview')
        self.old.write_bytes(b'new cached source, preserve')
        _, result = self.invoke('apply', preview['preview_sha256'])
        self.assertEqual((result['reason'], result['deleted_files']), ('PREVIEW_MISMATCH', 0))
        self.assertTrue(self.old.exists())

    def test_fresh_selection_change_is_preserved(self):
        _, preview = self.invoke('preview')
        _, result = self.invoke('apply', preview['preview_sha256'], fresh_change=True)
        self.assertEqual((result['reason'], result['deleted_files']), ('FRESH_SELECTION_CHANGED', 0))
        self.assertTrue(self.old.exists())

    def test_dirty_checkout_is_preserved(self):
        _, result = self.invoke('preview', guard_value='ONQ dirty')
        self.assertEqual(result['reason'], 'CHECKOUT_IDENTITY_OR_DIRTY')
        self.assertTrue(self.old.exists())


if __name__ == '__main__':
    unittest.main(verbosity=1)
