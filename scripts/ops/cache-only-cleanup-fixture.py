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
from types import SimpleNamespace
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
        self.fixed_backups = patch.object(cache, 'BACKUPS', self.root.parent / 'backups')
        self.fixed_history = patch.object(cache, 'HISTORY', self.root.parent / 'deploy-history.log')
        self.fixed_backups.start()
        self.fixed_history.start()
        self.head = '1' * 40
        (self.root.parent / 'deploy-history.log').write_text('sha=' + self.head)
        (self.root / '.dockerignore').write_text('.next\n')

    def tearDown(self):
        self.uid.stop()
        self.fixed_backups.stop()
        self.fixed_history.stop()
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
        with patch.object(cache, 'mapped_reference', return_value='no'), patch.object(cache, 'guard', side_effect=['no', 'same']), patch.object(cache, 'run', side_effect=responses), self.assertRaises(cache.Preserve):
            cache.references(self.root)

    def test_no_buildkit_or_broad_cleanup_subprocess(self):
        commands = []
        def fake_run(argv):
            commands.append(argv)
            if argv[:3] == ['docker', 'ps', '-aq']:
                return ''
            raise AssertionError('Unexpected daemon command')
        with patch.object(cache, 'mapped_reference', return_value='no'), patch.object(cache, 'guard', side_effect=['no', 'same']), patch.object(cache, 'run', side_effect=fake_run), self.assertRaises(cache.Preserve):
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

    def maps_fixture(self, content):
        proc = self.root.parent / 'proc'
        (proc / '123').mkdir(parents=True)
        if content is not None:
            (proc / '123/maps').write_text(content)
        return proc

    def test_closed_fd_mapped_cache_is_preserved(self):
        proc = self.maps_fixture('0100-0200 r--p 00000000 01:01 1 ' + str(self.old) + '\n')
        self.assertEqual(cache.mapped_reference(self.root, proc), 'yes')

    def test_unreadable_maps_are_unknown(self):
        self.assertEqual(cache.mapped_reference(self.root, self.maps_fixture(None)), 'UNKNOWN')

    def test_unrelated_maps_do_not_claim_checkout_reference(self):
        proc = self.maps_fixture('0100-0200 r--p 00000000 01:01 1 /unrelated/library.so\n')
        self.assertEqual(cache.mapped_reference(self.root, proc), 'no')

    def git_read(self, argv):
        self.assertEqual(argv[0], 'git')
        if 'rev-parse' in argv:
            return self.head
        return ''

    def invoke(self, mode, expected='', guard_value='ONQ clean', fresh_change=False, protected_side_effect=None):
        env = {'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
               'GITHUB_REF': 'refs/heads/main', 'GITHUB_REPOSITORY': cache.REPOSITORY,
               'GITHUB_WORKFLOW': 'Cache-only cleanup obs-test'}
        output = io.StringIO()
        with patch.object(cache, 'ROOT', self.root), patch.dict(os.environ, env, clear=True), \
             patch.object(cache, 'deployment_context', return_value=(self.root, self.root / 'current-helper')), \
             patch.object(cache, 'guard', return_value=guard_value), patch.object(cache, 'run', side_effect=self.git_read), \
             patch.object(cache, 'protected_state', return_value={'backups': 'backup-hash', 'images': 'image-hash', 'health': [200, 'ok', 'ok', self.head, True]}, side_effect=protected_side_effect), \
             patch.object(cache, 'references'), patch.object(cache.time, 'time', return_value=self.now), \
             patch('sys.argv', ['cache-only', '--mode', mode, '--expected-preview', expected]), \
             contextlib.redirect_stdout(output):
            if fresh_change:
                original = cache.plan
                calls = 0
                def changed_plan(**kwargs):
                    nonlocal calls
                    calls += 1
                    if calls == 2:
                        self.old.write_bytes(b'changed during apply, preserve')
                    return original(**kwargs)
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

    def test_protection_read_failure_prevents_cleanup(self):
        _, result = self.invoke('apply', '0' * 64, protected_side_effect=cache.Preserve('IMAGE_METADATA_UNKNOWN'))
        self.assertFalse(result['preservation_before_verified'])
        self.assertEqual(result['deleted_files'], 0)
        self.assertTrue(self.old.exists())

    def test_after_protection_read_failure_is_reported(self):
        baseline = {'backups': 'backup-hash', 'images': 'image-hash', 'health': [200, 'ok', 'ok', self.head, True]}
        code, result = self.invoke('preview', protected_side_effect=[baseline, cache.Preserve('READ_COMMAND_FAILED')])
        self.assertEqual(code, 1)
        self.assertTrue(result['preservation_before_verified'])
        self.assertFalse(result['preservation_after_verified'])
        self.assertEqual(result['deleted_files'], 0)

    def test_changed_health_is_reported_without_values(self):
        baseline = {'backups': 'backup-hash', 'images': 'image-hash', 'health': [200, 'ok', 'ok', self.head, True]}
        changed = {**baseline, 'health': [200, 'ok', 'ok', '2' * 40, True]}
        code, result = self.invoke('preview', protected_side_effect=[baseline, changed])
        self.assertEqual(code, 1)
        self.assertFalse(result['health_unchanged'])
        self.assertTrue(result['db_health_unchanged'])
        self.assertNotIn('2' * 40, json.dumps(result))

    def test_readonly_preservation_fingerprints(self):
        def daemon(argv):
            if argv[1:3] == ['context', 'inspect']:
                return json.dumps('unix:///var/run/docker.sock')
            self.assertEqual(argv[1:3], ['image', 'ls'])
            return json.dumps({'ID': 'sha256:' + 'a' * 64, 'Repository': 'fixture', 'Tag': 'keep', 'Digest': '<none>'})
        response = SimpleNamespace(status=200, read=lambda limit: json.dumps({'status': 'ok', 'db': 'ok', 'version': self.head, 'testMode': True}).encode())
        connection = SimpleNamespace(request=lambda method, route: self.assertEqual((method, route), ('GET', '/api/health')),
                                     getresponse=lambda: response, close=lambda: None)
        with patch.object(cache, 'run', side_effect=daemon), patch.object(cache.http.client, 'HTTPConnection', return_value=connection):
            before = cache.protected_state(self.root)
            (self.root.parent / 'backups/keep.dump').write_text('external backup changed')
            after = cache.protected_state(self.root)
        self.assertNotEqual(before['backups'], after['backups'])
        self.assertEqual(before['images'], after['images'])
        self.assertEqual(before['health'], after['health'])

    def test_false_or_missing_test_mode_is_preserved(self):
        for mode in (False, None):
            with self.subTest(test_mode=mode):
                health = {'status': 'ok', 'db': 'ok', 'version': self.head}
                if mode is not None:
                    health['testMode'] = mode
                response = SimpleNamespace(status=200, read=lambda limit: json.dumps(health).encode())
                connection = SimpleNamespace(request=lambda *args: None, getresponse=lambda: response, close=lambda: None)
                image = json.dumps({'ID': 'sha256:' + 'a' * 64, 'Repository': 'fixture', 'Tag': 'keep', 'Digest': '<none>'})
                with patch.object(cache, 'run', side_effect=[json.dumps('unix:///var/run/docker.sock'), image]), \
                     patch.object(cache.http.client, 'HTTPConnection', return_value=connection), \
                     self.assertRaisesRegex(cache.Preserve, 'TEST_SERVER_MODE_REQUIRED'):
                    cache.protected_state(self.root)

    def test_only_current_helper_untracked_is_separated(self):
        helper = self.root / 'current-helper'
        metadata = {}
        with patch.object(cache, 'HELPER_ROOT', helper), patch.object(cache, 'guard', return_value='ONQ dirty'), \
             patch.object(cache, 'run', return_value='?? current-helper/\0'):
            cache.checkout_state(self.root, metadata)
        self.assertTrue(metadata['current_helper_untracked'])
        self.assertFalse(metadata['foreign_untracked'])

    def test_other_untracked_or_tracked_dirty_are_preserved(self):
        for status in ('?? current-helper/\0?? original-evidence\0', ' M app.txt\0'):
            with self.subTest(status=status), patch.object(cache, 'HELPER_ROOT', self.root / 'current-helper'), \
                 patch.object(cache, 'guard', return_value='ONQ dirty'), patch.object(cache, 'run', return_value=status), \
                 self.assertRaises(cache.Preserve):
                cache.checkout_state(self.root, {})
        self.assertTrue(self.saved.exists())

    def test_missing_runner_context_has_no_fallback(self):
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(cache.Preserve, 'RUNNER_CONTEXT_MISSING'):
            cache.deployment_context({})

    def test_missing_cache_is_classified_in_one_packet(self):
        self.old.unlink()
        (self.root / '.next/cache').rmdir()
        code, result = self.invoke('preview')
        self.assertEqual((code, result['candidate_files']), (0, 0))
        self.assertEqual(result['metadata']['cache'], {'known': True, 'exists': False})
        self.assertTrue(result['metadata']['repository_matches'])

    def test_permission_metadata_is_explicit(self):
        with patch.object(Path, 'lstat', side_effect=PermissionError):
            self.assertEqual(cache.node_metadata(self.root), {'known': False, 'error': 'PERMISSION_DENIED'})

    def test_real_checkout_helper_and_observer_flow(self):
        # Native Git + /proc fixture on the Linux CI runner; no real server or daemon.
        workspace = self.root.parent / '_work' / cache.REPOSITORY.split('/')[1] / cache.REPOSITORY.split('/')[1]
        temporary = workspace.parent.parent / '_temp'
        helper = workspace / 'cache-only-123-1'
        (helper / 'scripts/ops').mkdir(parents=True)
        temporary.mkdir()
        (workspace / '.next/cache').mkdir(parents=True)
        source = helper / 'scripts/ops/cache-only-cleanup.py'
        source.write_text(Path(cache.__file__).read_text(encoding='utf-8'), encoding='utf-8')
        (helper / 'scripts/ops/checkout-readonly-guards.sh').write_text(cache.GUARDS.read_text(encoding='utf-8'), encoding='utf-8')
        (workspace / '.gitignore').write_text('.next\n')
        def git(path, *args):
            return cache.run(['git', '-C', str(path), '-c', 'core.hooksPath=/dev/null',
                              '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', *args])
        for path, files in ((workspace, ['.gitignore']), (helper, ['scripts/ops'])):
            git(path, 'init', '-q')
            git(path, 'remote', 'add', 'origin', 'https://github.com/' + cache.REPOSITORY + '.git')
            git(path, 'add', '--', *files)
            git(path, 'commit', '-q', '-m', 'fixture')
        ops_head, app_head = git(helper, 'rev-parse', 'HEAD'), git(workspace, 'rev-parse', 'HEAD')
        env = {'GITHUB_WORKSPACE': str(workspace), 'RUNNER_TEMP': str(temporary),
               'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_SHA': ops_head}
        observer_spec = importlib.util.spec_from_file_location('cache_observer_fixture', source)
        observer = importlib.util.module_from_spec(observer_spec)
        observer_spec.loader.exec_module(observer)
        previous = Path.cwd()
        try:
            os.chdir(temporary)
            with patch.dict(os.environ, env):
                metadata = {}
                observer.ROOT, observer.HELPER_ROOT = observer.deployment_context(metadata)
                observer.checkout_state(workspace, metadata)
                self.assertTrue(metadata['current_helper_untracked'])
                self.assertNotEqual(ops_head, app_head)
                self.assertEqual(observer.BACKUPS, Path('/opt/obs/backups'))
                self.assertEqual(observer.HISTORY, Path('/opt/obs/deploy-history.log'))
                # The observer imports helper source and reads metadata, then closes it.
                proc = self.root.parent / 'observer-proc'
                proc.mkdir()
                (proc / str(os.getpid())).symlink_to('/proc/' + str(os.getpid()), target_is_directory=True)
                self.assertEqual(observer.guard('readonly_exact_active_ref', workspace, proc), 'no')
                self.assertEqual(observer.mapped_reference(workspace, proc), 'no')
                cached = workspace / '.next/cache/observed.pack'
                cached.write_bytes(b'derived cache')
                with cached.open('rb'):
                    self.assertEqual(observer.guard('readonly_exact_active_ref', workspace, proc), 'yes')
                self.assertEqual(observer.guard('readonly_exact_active_ref', workspace, proc), 'no')
        finally:
            os.chdir(previous)


if __name__ == '__main__':
    unittest.main(verbosity=1)
