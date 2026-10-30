#!/usr/bin/env python3
"""Disposable Git inputs and compose config only; no image build or server writes."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('snapshot', Path(__file__).with_name('build-source-snapshot.py'))
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)


class BuildSourceFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='owned-build-fixture-')
        self.base = Path(self.temporary.name).resolve()
        self.root, self.jobs = self.base / 'repo', self.base / 'jobs'
        self.root.mkdir()
        self.jobs.mkdir(mode=0o700)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'core.autocrlf', 'false')
        (self.root / 'app').mkdir()
        (self.root / 'app/index.ts').write_bytes(b'approved source\n')
        (self.root / '.gitignore').write_bytes(b'app/ignored.ts\n.env\n')
        self.commit()
        self.prefix = 'onq-build-fixture-'

    def tearDown(self):
        self.temporary.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], stderr=subprocess.DEVNULL)

    def commit(self):
        self.git('add', '.')
        self.git('commit', '-qm', 'owned source fixture')
        self.sha = self.git('rev-parse', 'HEAD').decode().strip()

    def state(self):
        return {path.relative_to(self.root).as_posix(): path.read_bytes()
                for path in self.root.rglob('*') if path.is_file() and '.git' not in path.relative_to(self.root).parts}

    def test_exact_tree_excludes_untracked_ignored_and_working_changes(self):
        self.git('config', 'core.autocrlf', 'true')
        self.git('config', 'core.eol', 'crlf')
        (self.root / 'app/index.ts').write_bytes(b'operator working source')
        (self.root / 'app/untracked.ts').write_bytes(b'operator untracked source')
        (self.root / 'app/ignored.ts').write_bytes(b'operator ignored source')
        (self.root / 'operator-backup.dump').write_bytes(b'synthetic original backup')
        (self.root / 'operator-image.png').write_bytes(b'synthetic original image')
        (self.root / '.env').write_bytes(b'synthetic ignored config')
        before = self.state()
        path, count = source.snapshot(self.root, self.sha, self.jobs, self.prefix)
        self.assertEqual(count, 2)
        self.assertEqual((path / 'app/index.ts').read_bytes(), b'approved source\n')
        self.assertEqual({p.relative_to(path).as_posix() for p in path.rglob('*') if p.is_file()}, {'.gitignore', 'app/index.ts'})
        source.cleanup(path, self.jobs, self.prefix)
        self.assertEqual(self.state(), before)

    def test_archive_export_attributes_cannot_silently_change_source(self):
        for attribute in ('export-ignore', 'export-subst'):
            with self.subTest(attribute=attribute):
                (self.root / '.gitattributes').write_text(f'app/index.ts {attribute}\n', encoding='utf-8')
                (self.root / 'app/index.ts').write_bytes(b'$Format:%H$\n')
                self.commit()
                before = self.state()
                with self.assertRaisesRegex(ValueError, '^BUILD_ARCHIVE_(TREE|CONTENT)_MISMATCH$'):
                    source.snapshot(self.root, self.sha, self.jobs, self.prefix)
                self.assertEqual(list(self.jobs.iterdir()), [])
                self.assertEqual(self.state(), before)

    def test_head_mismatch_and_unowned_cleanup_preserve_originals(self):
        before = self.state()
        with self.assertRaisesRegex(ValueError, '^BUILD_HEAD_MISMATCH$'):
            source.snapshot(self.root, 'f' * 40, self.jobs, self.prefix)
        backup = self.jobs / 'operator-backup'
        backup.mkdir()
        (backup / 'original.dump').write_bytes(b'synthetic original')
        with self.assertRaisesRegex(ValueError, '^BUILD_SNAPSHOT_OWNER_UNKNOWN$'):
            source.cleanup(backup, self.jobs, self.prefix)
        self.assertEqual((backup / 'original.dump').read_bytes(), b'synthetic original')
        self.assertEqual(self.state(), before)

    @unittest.skipUnless(os.name == 'posix', 'Tracked symlink extraction requires POSIX fixture permissions')
    def test_internal_symlink_is_preserved_and_escaping_link_is_refused(self):
        (self.root / 'app/link').symlink_to('index.ts')
        self.commit()
        path, _ = source.snapshot(self.root, self.sha, self.jobs, self.prefix)
        self.assertEqual(os.readlink(path / 'app/link'), 'index.ts')
        source.cleanup(path, self.jobs, self.prefix)
        (self.root / 'app/unsafe').symlink_to('../../original-backup')
        self.commit()
        with self.assertRaisesRegex(ValueError, '^BUILD_SYMLINK_OUTSIDE_CONTEXT$'):
            source.snapshot(self.root, self.sha, self.jobs, self.prefix)
        self.assertEqual(list(self.jobs.iterdir()), [])

    @unittest.skipUnless(sys.platform == 'linux', 'Actual compose config is checked on the existing Linux CI host')
    def test_only_build_contexts_change_runtime_compose_stays_identical(self):
        repository = Path(__file__).resolve().parents[2]
        environment = {**os.environ, 'OBS_ENV_FILE': str(self.base / 'fixture.env'), 'APP_VERSION': 'owned-fixture'}
        environment.pop('OBS_BUILD_CONTEXT', None)
        Path(environment['OBS_ENV_FILE']).write_text('POSTGRES_USER=owned\nPOSTGRES_PASSWORD=owned\nPOSTGRES_DB=owned_test\n', encoding='utf-8')
        command = ['docker', 'compose', '-p', 'obs-web', '-f', str(repository / 'deploy/docker-compose.yml'),
                   '--env-file', environment['OBS_ENV_FILE'], 'config', '--format', 'json']
        def config(env):
            result = subprocess.run(command, env=env, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, 'Owned compose config failed')
            return json.loads(result.stdout)
        before = config(environment)
        path, _ = source.snapshot(self.root, self.sha, self.jobs, self.prefix)
        after = config({**environment, 'OBS_BUILD_CONTEXT': str(path)})
        for service in ('obs-web-app', 'obs-web-migrate'):
            self.assertTrue(before['services'][service]['build'].pop('context') == str(repository), 'Default build source moved')
            self.assertTrue(after['services'][service]['build'].pop('context') == str(path), 'Verified build source not selected')
        self.assertTrue(before == after, 'Runtime compose project/binds/environment changed')
        source.cleanup(path, self.jobs, self.prefix)


if __name__ == '__main__':
    unittest.main()
