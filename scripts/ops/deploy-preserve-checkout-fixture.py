#!/usr/bin/env python3
"""Actual local Git transitions; no network, daemon, database or server writes.

Windows cannot exercise Linux flock. Only that lease is substituted there;
Git checkout, source contents and failure preservation are real.
"""
import contextlib
import importlib.util
import os
import json
from pathlib import Path
import subprocess
import sys
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

    def test_deploy_marker_or_unknown_location_refused_before_checkout(self):
        data = self.root.parent / 'owned-monitor'
        data.mkdir()
        (data / 'deploy-in-progress').write_bytes(b'owned deploy lease')
        original = guard.command
        for volumes in ([{'type': 'bind', 'source': str(data), 'target': '/data'}], []):
            with self.subTest(known_location=bool(volumes)):
                def command(argv, allowed=(0,)):
                    if [str(arg) for arg in argv[:2]] == ['docker', 'compose']:
                        return json.dumps({'services': {'obs-web-monitor': {'volumes': volumes}}}).encode()
                    if [str(arg) for arg in argv[:2]] == ['docker', 'ps']:
                        return b''
                    return original(argv, allowed=allowed)
                with patch.object(guard, 'command', command):
                    self.refused_unchanged(guard.deploy_lease)

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

    def test_ignored_original_change_between_checks_refused_without_rollback(self):
        path = self.root / 'operator-ignored.bin'
        path.write_bytes(b'original ignored work')
        expected = self.state()
        expected['operator-ignored.bin'] = b'concurrent ignored work'
        calls = []
        def writer(_):
            calls.append(True)
            if len(calls) == 2:
                path.write_bytes(expected['operator-ignored.bin'])
        with self.assertRaisesRegex(guard.Preserve, '^CHECKOUT_CHANGED_BEFORE_UPDATE$'):
            self.update(writer)
        self.assertEqual(self.git('rev-parse', 'HEAD').decode().strip(), self.old)
        self.assertEqual(self.state(), expected)

    @unittest.skipUnless(os.name == 'posix', 'Actual flock contention requires a POSIX host')
    def test_host_checkout_lease_contention_refuses_then_releases(self):
        import select
        gitdir = guard.clean_tracked(self.root)
        script = ('import fcntl,os,sys; fd=os.open(sys.argv[1],os.O_RDONLY); '
                  'fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); '
                  'print("OWNED_LEASE_READY",flush=True); sys.stdin.buffer.read(1); os.close(fd)')
        child = subprocess.Popen([sys.executable, '-I', '-B', '-c', script, str(gitdir)],
                                 cwd=self.root.parent, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        before = self.state()
        try:
            self.assertTrue(select.select([child.stdout], [], [], 5)[0], 'Owned lease did not become ready')
            self.assertEqual(child.stdout.readline(), b'OWNED_LEASE_READY\n')
            with self.assertRaises(BlockingIOError):
                self.update()
            self.assertEqual(self.state(), before)
            self.assertEqual(self.git('rev-parse', 'HEAD').decode().strip(), self.old)
        finally:
            child.communicate(input=b'x', timeout=5)
        self.assertEqual(child.returncode, 0)
        self.assertEqual(self.update(), 4)

    def test_missing_candidate_fails_without_changing_originals(self):
        self.target = 'f' * 40
        self.refused_unchanged()

    def test_optional_monitor_uses_compose_data_without_container(self):
        data = self.root / 'optional-monitor'
        config = {'services': {'obs-web-monitor': {'volumes': [{'type': 'bind', 'source': str(data), 'target': '/data'}]}}}
        with patch.object(guard, 'command', side_effect=[json.dumps(config).encode(), b'']) as run:
            guard.deploy_lease(self.root)
            self.assertIn('--env-file', run.call_args_list[0].args[0])
        data.mkdir()
        with patch.object(guard, 'command', side_effect=[json.dumps(config).encode(), b'']):
            guard.deploy_lease(self.root)
        (data / 'deploy-in-progress').write_bytes(b'owned active lease')
        with patch.object(guard, 'command', side_effect=[json.dumps(config).encode(), b'']):
            with self.assertRaises(guard.Preserve):
                guard.deploy_lease(self.root)

    def test_monitor_mounted_elsewhere_or_ambiguous_data_is_unknown(self):
        data = self.root / 'monitor'
        volume = {'type': 'bind', 'source': str(data), 'target': '/data'}
        for volumes, ids, mounts in (([volume, volume], b'', []),
                                      ([volume], b'a' * 64, [{'Source': str(self.root), 'Destination': '/data'}])):
            config = {'services': {'obs-web-monitor': {'volumes': volumes}}}
            with patch.object(guard, 'command', side_effect=[json.dumps(config).encode(), ids, json.dumps(mounts).encode()]):
                with self.assertRaises(guard.Preserve):
                    guard.deploy_lease(self.root)

    def test_readonly_marker_boundaries_match_the_existing_monitor(self):
        now = 2_000_000
        cases = []
        for age in (899, 900, 901):
            cases.append({'name': 'legacy', 'legacy': True, 'age': age, 'body': 'opaque legacy content'})
        for kind, age, expires in (('kept', 899, now + 1), ('kept', 900, now + 1),
                                   ('kept', 901, now + 1), ('kept', 0, now),
                                   ('kept', 0, 0), ('kept', 0, None),
                                   (None, 900, None), (None, 901, None),
                                   ('detached', 3600, now + 1), ('detached', 0, now)):
            body = (f'kind={kind}\n' if kind else '') + (f'expiresEpoch={expires}\n' if expires is not None else '')
            cases.append({'name': 'job', 'age': age, 'body': body})
        for age, ended in ((0, now - 20), (0, now - 21), (20, None), (21, None), (20, 0), (0, now + 1)):
            cases.append({'name': '.ended-job', 'age': age, 'body': f'endedEpoch={ended}\n' if ended is not None else ''})
        for age in (0, 10000):
            cases.append({'name': '.tmp-owned', 'age': age, 'body': 'temporary input'})
        script = r'''
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const source = fs.readFileSync(input.monitor, 'utf8');
const body = source.slice(source.indexOf('async function activeDeployMarks()'), source.indexOf('\nasync function tick()'));
const run = new Function('Date','cfg','readdirSync','statSync','readFileSync','unlinkSync','event','warnOnce', body + '; return activeDeployMarks();');
(async () => {
 const results = [];
 for (const c of input.cases) {
  const path = c.legacy ? '/owned/legacy' : '/owned/marks/' + c.name;
  const cfg = {deployMark:'/owned/legacy',deployMarkDir:'/owned/marks',deployMarkStaleMin:15,timeoutMs:5000,intervalS:15};
  const active = await run({now:()=>input.now*1000},cfg,()=>c.legacy?[]:[c.name],
    p=>{if(p!==path)throw Error('absent');return {mtimeMs:(input.now-c.age)*1000}},
    ()=>c.body,()=>{},async()=>{},async()=>{});
  results.push(active.length>0);
 }
 process.stdout.write(JSON.stringify(results));
})().catch(()=>process.exit(1));
'''
        result = subprocess.run(['node', '-e', script], input=json.dumps({'monitor': str(Path(__file__).with_name('monitor.mjs')), 'now': now, 'cases': cases}).encode(), capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, 'Existing monitor contract oracle failed')
        expected = json.loads(result.stdout)
        self.assertEqual(len(expected), len(cases))
        folder = self.root.parent / 'owned-contract-marks'
        folder.mkdir()
        for case, active in zip(cases, expected):
            with self.subTest(case=case):
                path = folder / case['name']
                path.write_text(case['body'], encoding='utf-8')
                os.utime(path, (now - case['age'], now - case['age']))
                before = (path.read_bytes(), path.stat().st_mtime_ns)
                state = guard.marker_state(path, now, 900, 20, legacy=case.get('legacy', False))
                self.assertEqual(state.startswith('ACTIVE_'), active)
                self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), before)

    def test_invalid_marker_records_are_refused_and_preserved(self):
        path = self.root.parent / 'owned-job'
        for body in ('kind=other\n', 'kind=detached\n', 'kind=kept\nexpiresEpoch=invalid\n',
                     'kind=kept\nkind=detached\nexpiresEpoch=2000001\n', 'expiresEpoch=1\nexpiresEpoch=2\n'):
            with self.subTest(body=body):
                path.write_text(body, encoding='utf-8')
                before = path.read_bytes()
                with self.assertRaisesRegex(guard.Preserve, '^DEPLOY_LEASE_INVALID_RECORD$'):
                    guard.marker_state(path, 2_000_000, 900, 20)
                self.assertEqual(path.read_bytes(), before)
        ended = self.root.parent / '.ended-owned'
        ended.write_text('endedEpoch=invalid\n', encoding='utf-8')
        with self.assertRaisesRegex(guard.Preserve, '^DEPLOY_LEASE_INVALID_RECORD$'):
            guard.marker_state(ended, 2_000_000, 900, 20)

    def test_unreadable_or_changed_marker_is_unknown_not_expired(self):
        path = self.root.parent / 'owned-job'
        path.write_text('kind=kept\nexpiresEpoch=1\n', encoding='utf-8')
        with patch.object(Path, 'read_text', side_effect=PermissionError()):
            with self.assertRaisesRegex(guard.Preserve, '^DEPLOY_LEASE_READ_UNKNOWN$'):
                guard.marker_state(path, 2_000_000, 900, 20)
        original = Path.read_text
        def changed(target, **kwargs):
            body = original(target, **kwargs)
            target.write_text('kind=kept\nexpiresEpoch=2000001\n', encoding='utf-8')
            return body
        with patch.object(Path, 'read_text', changed):
            with self.assertRaisesRegex(guard.Preserve, '^DEPLOY_LEASE_CHANGED_DURING_READ$'):
                guard.marker_state(path, 2_000_000, 900, 20)

    def test_compose_monitor_overrides_and_expired_files_are_preserved(self):
        data = self.root.parent / 'owned-monitor'
        directory = data / 'deploy-in-progress.d'
        directory.mkdir(parents=True)
        legacy = data / 'deploy-in-progress'
        legacy.write_bytes(b'opaque legacy')
        ended = directory / '.ended-owned'
        ended.write_text('endedEpoch=1999997\n', encoding='utf-8')
        temporary = directory / '.tmp-owned'
        temporary.write_bytes(b'leave temporary original')
        os.utime(legacy, (1999939, 1999939))
        config = {'services': {'obs-web-monitor': {
            'volumes': [{'type': 'bind', 'source': str(data), 'target': '/data'}],
            'environment': {'MONITOR_DEPLOY_MARK_STALE_MIN': '1', 'MONITOR_INTERVAL_S': '2', 'MONITOR_TIMEOUT_MS': '100'},
        }}}
        before = {path.name: (path.read_bytes(), path.stat().st_mtime_ns) for path in (legacy, ended, temporary)}
        with patch.object(guard.time, 'time', return_value=2_000_000), patch.object(guard, 'command', side_effect=[json.dumps(config).encode(), b'']):
            self.assertEqual(guard.deploy_lease(self.root), 'EXPIRED_PRESERVED')
        self.assertEqual({path.name: (path.read_bytes(), path.stat().st_mtime_ns) for path in (legacy, ended, temporary)}, before)

    def test_live_marker_types_have_fixed_refusal_reasons(self):
        for index, (name, body, reason) in enumerate((
            ('job', 'kind=kept\nexpiresEpoch=2000001\n', 'ACTIVE_KEPT'),
            ('job', 'kind=detached\nexpiresEpoch=2000001\n', 'ACTIVE_DETACHED'),
            ('.ended-job', 'endedEpoch=1999980\n', 'ACTIVE_ENDED_GRACE'),
        )):
            with self.subTest(reason=reason):
                data = self.root.parent / f'owned-monitor-{index}'
                directory = data / 'deploy-in-progress.d'
                directory.mkdir(parents=True)
                path = directory / name
                path.write_text(body, encoding='utf-8')
                os.utime(path, (2_000_000, 2_000_000))
                config = {'services': {'obs-web-monitor': {'volumes': [{'type': 'bind', 'source': str(data), 'target': '/data'}]}}}
                with patch.object(guard.time, 'time', return_value=2_000_000), patch.object(guard, 'command', side_effect=[json.dumps(config).encode(), b'']):
                    with self.assertRaisesRegex(guard.Preserve, '^DEPLOY_LEASE_' + reason + '$'):
                        guard.deploy_lease(self.root)
                self.assertEqual(path.read_text(encoding='utf-8'), body)

    @unittest.skipUnless(os.name == 'posix', 'Actual symlink boundary requires POSIX fixture permissions')
    def test_marker_and_directory_symlinks_are_refused(self):
        data = self.root.parent / 'owned-monitor'
        data.mkdir()
        original = data / 'original'
        original.write_bytes(b'preserve symlink destination')
        marker = data / 'deploy-in-progress'
        marker.symlink_to(original)
        with self.assertRaisesRegex(guard.Preserve, '^DEPLOY_LEASE_SYMLINK$'):
            guard.marker_state(marker, 2_000_000, 900, 20, legacy=True)
        self.assertEqual(original.read_bytes(), b'preserve symlink destination')
        other = self.root.parent / 'owned-linked-monitor'
        other.mkdir()
        (other / 'deploy-in-progress.d').symlink_to(data, target_is_directory=True)
        config = {'services': {'obs-web-monitor': {'volumes': [{'type': 'bind', 'source': str(other), 'target': '/data'}]}}}
        with patch.object(guard, 'command', side_effect=[json.dumps(config).encode(), b'']):
            with self.assertRaisesRegex(guard.Preserve, '^DEPLOY_LEASE_SYMLINK$'):
                guard.deploy_lease(self.root)

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
