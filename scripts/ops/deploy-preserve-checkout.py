#!/usr/bin/env python3
"""Fail closed before a non-forced update of the persistent deployment checkout.

No reset, clean, source relocation, rollback, or deletion. A failed post-check is
an operator stop: automatically restoring HEAD could overwrite concurrent work.
"""
import hashlib
from contextlib import contextmanager
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


class Preserve(RuntimeError):
    pass


def command(argv, allowed=(0,)):
    result = subprocess.run([str(arg) for arg in argv], capture_output=True,
                            env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'GIT_NO_REPLACE_OBJECTS': '1'}, timeout=120)
    if result.returncode not in allowed:
        # Git diagnostics can contain original file names; do not print them.
        raise Preserve('COMMAND_REFUSED')
    return result.stdout


def git(root, *args):
    return command(['git', '-c', 'core.hooksPath=/dev/null', '-C', root, *args])


def clean_tracked(root):
    if git(root, 'status', '--porcelain=v1', '--untracked-files=no'):
        raise Preserve('TRACKED_WORK_PRESENT')
    # status can hide local changes behind these index flags.
    if any(row and row[:1] != b'H' for row in git(root, 'ls-files', '-v', '-z').split(b'\0')):
        raise Preserve('INDEX_FLAGS_OR_SUBMODULE_UNKNOWN')
    gitdir = Path(os.fsdecode(git(root, 'rev-parse', '--absolute-git-dir')).strip())
    for name in ('index.lock', 'HEAD.lock', 'config.lock', 'shallow.lock',
                 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG',
                 'rebase-merge', 'rebase-apply', 'sequencer'):
        if (gitdir / name).exists() or (gitdir / name).is_symlink():
            raise Preserve('GIT_WORK_IN_PROGRESS')
    return gitdir


def originals(root):
    paths = git(root, 'ls-files', '--others', '-z').split(b'\0')
    records = {}
    for raw in paths:
        if not raw:
            continue
        rel = Path(os.fsdecode(raw))
        if rel.is_absolute() or '..' in rel.parts:
            raise Preserve('ORIGINAL_PATH_UNKNOWN')
        path = root / rel
        for parent in path.parents:
            if parent == root:
                break
            if parent.is_symlink():
                raise Preserve('ORIGINAL_PARENT_ALIAS')
        before = path.lstat()
        if stat.S_ISLNK(before.st_mode):
            body = os.fsencode(os.readlink(path))
        elif stat.S_ISREG(before.st_mode):
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for block in iter(lambda: stream.read(1048576), b''):
                    digest.update(block)
            body = digest.digest()
        else:
            raise Preserve('ORIGINAL_SPECIAL_OR_NESTED_REPOSITORY')
        after = path.lstat()
        signature = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if signature(before) != signature(after):
            raise Preserve('ORIGINAL_CHANGED_DURING_READ')
        records[raw] = (signature(after), hashlib.sha256(body).digest())
    return records


def active_work(root):
    guards = Path(__file__).with_name('checkout-readonly-guards.sh')
    state = command(['bash', '-euo', 'pipefail', '-c',
                     'source "$1"; readonly_exact_active_ref "$2"',
                     'deploy-preserve', guards, root]).strip()
    if state != b'no':
        raise Preserve('ACTIVE_CHECKOUT_REFERENCE_OR_UNKNOWN')
    # cwd/fd checks alone miss memory mapped files.
    for proc in Path('/proc').iterdir():
        if not proc.name.isdecimal():
            continue
        for line in (proc / 'maps').read_text().splitlines():
            parts = line.split(maxsplit=5)
            if len(parts) == 6 and parts[5].startswith('/'):
                mapped = Path(parts[5].removesuffix(' (deleted)'))
                if mapped == root or root in mapped.parents:
                    raise Preserve('ACTIVE_CHECKOUT_MAPPING')
    ids = command(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=obs-web',
                   '--filter', 'label=com.docker.compose.service=obs-web-monitor']).splitlines()
    if len(ids) != 1 or not re.fullmatch(rb'[0-9a-f]{12,64}', ids[0]):
        raise Preserve('DEPLOY_LEASE_LOCATION_UNKNOWN')
    import json
    mounts = json.loads(command(['docker', 'inspect', '--format', '{{json .Mounts}}', os.fsdecode(ids[0])]))
    sources = [Path(m['Source']) for m in mounts if m.get('Destination') == '/data']
    if len(sources) != 1 or sources[0].resolve(strict=True) != sources[0]:
        raise Preserve('DEPLOY_LEASE_LOCATION_UNKNOWN')
    data = sources[0]
    marker, directory = data / 'deploy-in-progress', data / 'deploy-in-progress.d'
    if marker.exists() or marker.is_symlink() or directory.is_symlink():
        raise Preserve('DEPLOY_LEASE_PRESENT_OR_UNKNOWN')
    if directory.exists() and any(not p.name.startswith('.ended-') for p in directory.iterdir()):
        raise Preserve('DEPLOY_LEASE_PRESENT_OR_UNKNOWN')


@contextmanager
def checkout_lease(gitdir):
    # flock on the existing directory creates/deletes no lease file. This only
    # serializes cooperating guards; it is not a lock against arbitrary editors.
    import fcntl
    lease = os.open(gitdir, os.O_RDONLY)
    try:
        fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(lease)


def update(root, target, activity=active_work):
    """Candidate must already be fetched; tests use only a disposable local repo."""
    if not re.fullmatch(r'[0-9a-f]{40}', target):
        raise Preserve('TARGET_SHA_INVALID')
    if Path(os.fsdecode(git(root, 'rev-parse', '--show-toplevel')).strip()) != root:
        raise Preserve('CHECKOUT_ROOT_UNKNOWN')
    gitdir = clean_tracked(root)
    with checkout_lease(gitdir):
        clean_tracked(root)
        activity(root)
        before = originals(root)
        old_head = git(root, 'rev-parse', 'HEAD')
        activity(root)
        if originals(root) != before or git(root, 'rev-parse', 'HEAD') != old_head:
            raise Preserve('CHECKOUT_CHANGED_BEFORE_UPDATE')
        clean_tracked(root)
        # --no-overwrite-ignore is essential: ordinary checkout overwrites
        # ignored files by default. No force, reset or clean option is used.
        try:
            git(root, 'checkout', '--detach', '--no-overwrite-ignore', '--no-recurse-submodules', target)
        except Preserve:
            if originals(root) != before or git(root, 'rev-parse', 'HEAD') != old_head:
                raise Preserve('FAILED_CHECKOUT_STATE_CHANGED') from None
            raise
        if originals(root) != before:
            raise Preserve('ORIGINAL_STATE_CHANGED_STOP')
        clean_tracked(root)
        if os.fsdecode(git(root, 'rev-parse', 'HEAD')).strip() != target:
            raise Preserve('CANDIDATE_HEAD_MISMATCH')
        return len(before)


def main():
    try:
        root = Path(os.environ['GITHUB_WORKSPACE'])
        target = os.environ['GITHUB_SHA']
        if not re.fullmatch(r'[0-9a-f]{40}', target):
            raise Preserve('TARGET_SHA_INVALID')
        if not root.is_absolute() or root.resolve(strict=True) != root or Path.cwd() == root or root in Path.cwd().parents:
            raise Preserve('WORKSPACE_OR_OBSERVER_PATH_INVALID')
        if root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o022:
            raise Preserve('WORKSPACE_OWNERSHIP_UNKNOWN')
        repository = os.environ['GITHUB_REPOSITORY']
        if repository.lower() != 'jsexy0210-ship-it/live-obs-platform' or os.environ.get('GITHUB_SERVER_URL') != 'https://github.com':
            raise Preserve('REPOSITORY_IDENTITY_UNKNOWN')
        urls = os.fsdecode(git(root, 'config', '--get-all', 'remote.origin.url')).strip().splitlines()
        accepted = {f'https://github.com/{repository}', f'https://github.com/{repository}.git',
                    f'git@github.com:{repository}', f'git@github.com:{repository}.git'}
        if len(urls) != 1 or urls[0].lower() not in {url.lower() for url in accepted}:
            raise Preserve('REMOTE_IDENTITY_UNKNOWN')
        resolved_url = os.fsdecode(git(root, 'remote', 'get-url', 'origin')).strip()
        if resolved_url.lower() not in {url.lower() for url in accepted}:
            raise Preserve('REMOTE_REWRITE_UNKNOWN')
        clean_tracked(root)
        active_work(root)
        # A URL rewrite to another repository was rejected above.
        # A public repository needs no persisted credential or new secret.
        git(root, 'fetch', '--no-tags', '--no-recurse-submodules', 'origin', target)
        if os.fsdecode(git(root, 'rev-parse', '--verify', target + '^{commit}')).strip() != target:
            raise Preserve('FETCHED_COMMIT_MISMATCH')
        count = update(root, target)
        print(f'Persistent checkout verified; preserved original files: {count}; HEAD: {target}')
    except (Preserve, OSError, ValueError, KeyError, TypeError, ImportError, subprocess.SubprocessError) as error:
        reason = str(error) if isinstance(error, Preserve) else 'GUARD_STATE_UNKNOWN'
        print(f'::error::Deployment stopped, original work requires preservation: {reason}')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
