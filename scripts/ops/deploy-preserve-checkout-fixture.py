#!/usr/bin/env python3
"""Actual local Git transitions; no network, daemon, database or server writes.

Windows cannot exercise Linux flock/proc. Only those host observations are
substituted there; Git checkout, source contents and failure preservation are real.
"""
import contextlib
from datetime import datetime, timezone
from functools import wraps
import importlib.util
import os
import json
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('preserve', Path(__file__).with_name('deploy-preserve-checkout.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def owned_audit_denial(records, observations):
    for record in records[:16]:
        message = record.get('MESSAGE', '')
        if not isinstance(message, str) or not all(term in message for term in ('apparmor="DENIED"', 'operation="ptrace"')):
            continue
        if not all(re.search(field + r'="[^"\n]*\bread\b[^"\n]*"', message) for field in ('requested_mask', 'denied_mask')):
            continue
        pid = re.search(r'\bpid=([0-9]+)\b', message)
        try:
            stamp = int(record['__REALTIME_TIMESTAMP']) / 1_000_000
        except (KeyError, ValueError, TypeError):
            continue
        if pid and any(start <= stamp <= end and int(pid[1]) in owned for start, end, owned in observations):
            return True
    return False


def audit_summary(start, end, observations, run=subprocess.run):
    # CI fixture only: the TEST runner has no sudo. GitHub's disposable hosted
    # Linux runner may already permit this exact readonly administrative command.
    since = datetime.fromtimestamp(max(start - 1, end - 59), timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
    until = datetime.fromtimestamp(end + 1, timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
    args = ['/usr/bin/journalctl', '-k', '--since', since, '--until', until,
            '--grep', 'apparmor="DENIED".*operation="ptrace"', '-n', '16', '--output=json', '--no-pager']
    admin = False
    try:
        if os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted':
            permission = run(['/usr/bin/sudo', '-n', '-l', '--', *args], capture_output=True, timeout=5)
            admin = permission.returncode == 0
        result = run((['/usr/bin/sudo', '-n', '--'] if admin else []) + args, capture_output=True, timeout=10)
        if result.returncode != 0:
            return 'UNAVAILABLE', False, admin, 'AUDIT_UNAVAILABLE'
        lines = result.stdout.splitlines()
        records = []
        for line in lines[:16]:
            try:
                record = json.loads(line)
                if isinstance(record, dict):
                    records.append(record)
            except (ValueError, TypeError):
                pass
        # No readable matching records cannot establish that auditing was available.
        if not records:
            return 'UNCONFIRMED', False, admin, 'AUDIT_UNCONFIRMED'
        matched = owned_audit_denial(records, observations)
        return 'AVAILABLE', matched, admin, 'OWNED_APPARMOR_PTRACE_READ_DENIED' if matched else 'AUDIT_UNCONFIRMED'
    except (OSError, subprocess.SubprocessError):
        return 'UNAVAILABLE', False, admin, 'AUDIT_UNAVAILABLE'


def audit_existing_observers(test):
    @wraps(test)
    def wrapped(*args, **kwargs):
        original = guard.command
        observations = []
        start = time.time()

        def command(argv, allowed=(0,), input=None):
            if [str(arg) for arg in argv[:4]] != ['docker', 'start', '--attach', '--interactive']:
                return original(argv, allowed=allowed, input=input)
            container = str(argv[-1])
            if not re.fullmatch(r'[0-9a-f]{64}', container):
                return original(argv, allowed=allowed, input=input)
            owned = set()
            stop = threading.Event()
            began = time.time()

            def sample():
                for _ in range(4):
                    if stop.is_set():
                        return
                    try:
                        result = subprocess.run(['docker', 'top', container, '-eo', 'pid'], capture_output=True, timeout=5)
                        if result.returncode == 0:
                            for row in result.stdout.splitlines()[1:33]:
                                if re.fullmatch(rb'\s*[1-9][0-9]*\s*', row):
                                    owned.add(int(row))
                    except (OSError, subprocess.SubprocessError):
                        pass
                    stop.wait(0.05)

            sampler = threading.Thread(target=sample, daemon=True)
            sampler.start()
            try:
                return original(argv, allowed=allowed, input=input)
            finally:
                stop.set()
                sampler.join(timeout=6)
                observations.append((began, time.time() + 1, owned.copy()))
        try:
            with patch.object(guard, 'command', command):
                return test(*args, **kwargs)
        finally:
            access, matched, admin, reason = audit_summary(start, time.time(), observations)
            # These are the only outputs; never print raw records or sampled PIDs.
            print(f'CI_AUDIT access={access} owned_ptrace_read_denied={int(matched)} existing_admin_read={int(admin)} reason={reason} negative_is_not_absence=1', flush=True)
    return wrapped


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

    def test_observer_unknown_and_timeout_close_exact_owned_container(self):
        image, container = 'sha256:' + 'a' * 64, 'b' * 64
        for outcome in (b'UNKNOWN', subprocess.TimeoutExpired('owned observer', 120)):
            with self.subTest(outcome=type(outcome).__name__):
                with patch.object(guard, 'command', side_effect=[container.encode(), outcome, b'']) as run:
                    with self.assertRaises((guard.Preserve, subprocess.TimeoutExpired)):
                        guard.observe_processes(self.root, image)
                    create = [str(arg) for arg in run.call_args_list[0].args[0]]
                    for required in ('--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
                                     '--cap-add=SYS_PTRACE', '--cap-add=DAC_READ_SEARCH', '--pid=host',
                                     '--entrypoint=/bin/sh', '--security-opt=no-new-privileges'):
                        self.assertIn(required, create)
                    self.assertFalse(any('privileged' in arg or 'unconfined' in arg or 'DAC_OVERRIDE' in arg for arg in create))
                    self.assertNotIn(str(self.root), ' '.join(arg for arg in create if arg.startswith('--mount')))
                    self.assertEqual(run.call_args_list[-1].args[0], ['docker', 'rm', '--force', container])

    def test_observer_diagnostic_is_bounded_and_never_prints_raw_process_details(self):
        image, container = 'sha256:' + 'a' * 64, 'b' * 64
        safe = b'UNKNOWN|C/P1/D1/A1|EXE_LINK/ENOENT/P1/Z1/K0/S1|MAPS/EACCES/P1/Z0/K0/S1'
        for state in (safe, b'UNKNOWN|private-host-path-and-process-details', safe + b'\nraw stderr'):
            with self.subTest(valid=state == safe):
                with patch.object(guard, 'command', side_effect=[container.encode(), state, b'']):
                    with self.assertRaises(guard.Preserve) as result:
                        guard.observe_processes(self.root, image)
                    self.assertEqual(str(result.exception), 'ACTIVE_CHECKOUT_OBSERVATION_' + safe.decode() if state == safe else 'ACTIVE_CHECKOUT_REFERENCE_OR_UNKNOWN')

    def test_audit_requires_exact_owned_pid_time_and_ptrace_read(self):
        record = {'MESSAGE': 'apparmor="DENIED" operation="ptrace" pid=123 comm="synthetic" requested_mask="read" denied_mask="read"', '__REALTIME_TIMESTAMP': '2000000'}
        self.assertTrue(owned_audit_denial([record], [(1, 3, {123})]))
        self.assertFalse(owned_audit_denial([record], [(1, 3, {456})]))
        self.assertFalse(owned_audit_denial([record], [(3, 4, {123})]))
        self.assertFalse(owned_audit_denial([{**record, 'MESSAGE': record['MESSAGE'].replace('"read"', '"trace"')}], [(1, 3, {123})]))
        self.assertFalse(owned_audit_denial([{**record, 'MESSAGE': record['MESSAGE'].replace('denied_mask="read"', 'denied_mask="trace"')}], [(1, 3, {123})]))

    def test_audit_access_failure_or_missing_records_is_not_absence_evidence(self):
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'false'}):
            for result, expected in ((subprocess.CompletedProcess([], 1, b'', b'private details'), 'AUDIT_UNAVAILABLE'),
                                     (subprocess.CompletedProcess([], 0, b'', b''), 'AUDIT_UNCONFIRMED')):
                summary = audit_summary(1, 2, [], run=lambda *args, **kwargs: result)
                self.assertEqual(summary[-1], expected)
                self.assertFalse(summary[1])

    def test_audit_checks_existing_hosted_privilege_for_only_the_fixed_read(self):
        calls = []
        def run(argv, **kwargs):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, b'', b'')
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted'}):
            self.assertEqual(audit_summary(1, 2, [], run=run), ('UNCONFIRMED', False, True, 'AUDIT_UNCONFIRMED'))
        self.assertEqual(calls[0][:5], ['/usr/bin/sudo', '-n', '-l', '--', '/usr/bin/journalctl'])
        self.assertEqual(calls[1][:4], ['/usr/bin/sudo', '-n', '--', '/usr/bin/journalctl'])
        self.assertEqual(calls[0][4:], calls[1][3:])
        self.assertEqual(calls[1][calls[1].index('-n') + 1], '--')
        self.assertIn('16', calls[1])

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

    @unittest.skipUnless(sys.platform == 'linux', 'Actual host proc/Docker permissions require Linux')
    @audit_existing_observers
    def test_real_unprivileged_runner_observes_root_cwd_fd_and_mapping(self):
        self.assertNotEqual(os.geteuid(), 0, 'This fixture must exercise a non-root runner')
        # Already pulled by this CI job's existing PostgreSQL service. Never pull.
        image = guard.command(['docker', 'image', 'inspect', '--format', '{{.Id}}', 'postgres:16']).decode().strip()
        self.assertRegex(image, r'^sha256:[0-9a-f]{64}$')

        @contextlib.contextmanager
        def container(script, mounted=False):
            argv = ['docker', 'create', '--pull=never', '--network=none', '--read-only', '--user=0:0',
                    '--cap-drop=ALL', '--cap-add=DAC_READ_SEARCH', '--security-opt=no-new-privileges']
            if mounted:
                argv += ['--mount', f'type=bind,source={self.root},target={self.root},readonly']
            ident = guard.command([*argv, '--entrypoint=/bin/sh', image, '-c', script, 'owned-fixture', self.root]).decode().strip()
            self.assertRegex(ident, r'^[0-9a-f]{64}$')
            try:
                yield ident
            finally:
                guard.command(['docker', 'rm', '--force', ident])

        # Copy a system library into this disposable fixture only. Preloading it
        # leaves a real file-backed mapping with no cwd/fd/exe under the target.
        with container('exec cat "$(ldd /bin/sleep | awk \'$1 ~ /^libc[.]/ { print $3; exit }\')"') as ident:
            library = guard.command(['docker', 'start', '--attach', ident])
        self.assertTrue(library.startswith(b'\x7fELF'))
        (self.root / 'owned-lib.so').write_bytes(library)
        for kind, script, link in (
            ('cwd', 'cd "$1"; exec /bin/sleep 120', 'cwd'),
            ('fd', 'exec 3<"$1/source.txt"; exec /bin/sleep 120', 'fd/3'),
            ('mmap', 'LD_PRELOAD="$1/owned-lib.so" exec /bin/sleep 120', 'maps'),
        ):
            with self.subTest(kind=kind), container(script, mounted=True) as ident:
                guard.command(['docker', 'start', ident])
                pid = guard.command(['docker', 'inspect', '--format', '{{.State.Pid}}', ident]).decode().strip()
                self.assertRegex(pid, r'^[1-9][0-9]*$')
                proc = Path('/proc') / pid
                self.assertEqual(proc.stat().st_uid, 0)
                with self.assertRaises(PermissionError):
                    (proc / link).read_text() if link == 'maps' else (proc / link).readlink()
                with self.assertRaisesRegex(guard.Preserve, '^ACTIVE_CHECKOUT_REFERENCE$'):
                    guard.observe_processes(self.root, image)
        # Positive proof matters: a blanket UNKNOWN must not make the active
        # cases look successful. No root fixture is alive now; full observation works.
        guard.observe_processes(self.root, image)

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
