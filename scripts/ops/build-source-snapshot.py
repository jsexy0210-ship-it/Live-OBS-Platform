#!/usr/bin/env python3
"""Build context from one verified Git tree; never copy the persistent checkout."""
import hashlib
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile


def git(root, *args):
    return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(root), *args],
                                   stderr=subprocess.DEVNULL,
                                   env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'GIT_NO_REPLACE_OBJECTS': '1'})


def owned_directory(path):
    info = path.lstat()
    if not path.is_absolute() or path.resolve(strict=True) != path or not path.is_dir():
        raise ValueError('BUILD_TEMP_UNKNOWN')
    if os.name == 'posix' and (info.st_uid != os.getuid() or info.st_mode & 0o022):
        raise ValueError('BUILD_TEMP_OWNER_UNKNOWN')


def cleanup(path, temporary, prefix):
    owned_directory(temporary)
    if path.parent != temporary or not re.fullmatch(re.escape(prefix) + r'[a-z0-9_]{8}', path.name):
        raise ValueError('BUILD_SNAPSHOT_OWNER_UNKNOWN')
    owned_directory(path)
    shutil.rmtree(path)  # Only this job's exclusive mkdtemp child, never source/backups.


def snapshot(root, sha, temporary, prefix):
    owned_directory(temporary)
    if not re.fullmatch(r'[0-9a-f]{40}', sha) or root.resolve(strict=True) != root:
        raise ValueError('BUILD_SOURCE_UNKNOWN')
    if temporary == root or root in temporary.parents:
        raise ValueError('BUILD_TEMP_OVERLAPS_SOURCE')
    if git(root, 'rev-parse', 'HEAD').decode().strip() != sha:
        raise ValueError('BUILD_HEAD_MISMATCH')
    expected, directories = {}, set()
    for entry in git(root, 'ls-tree', '-rz', '--full-tree', sha).split(b'\0'):
        if not entry:
            continue
        header, raw = entry.split(b'\t', 1)
        mode, kind, blob = header.decode().split()
        name = raw.decode('utf-8')
        parts = PurePosixPath(name)
        if mode not in ('100644', '100755', '120000') or kind != 'blob' or parts.is_absolute() or '..' in parts.parts or '\\' in name:
            raise ValueError('BUILD_TREE_UNSUPPORTED')
        expected[name] = (mode, blob)
        directories.update(str(parent) for parent in parts.parents if str(parent) != '.')
    path = Path(tempfile.mkdtemp(prefix=prefix, dir=temporary))
    archive = None
    try:
        archive = subprocess.Popen(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf',
                                    '-C', str(root), 'archive', '--format=tar', sha],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'GIT_NO_REPLACE_OBJECTS': '1'})
        seen = set()
        with tarfile.open(fileobj=archive.stdout, mode='r|') as contents:
            for member in contents:
                name = member.name
                target = path / name
                if member.isdir() and name in directories:
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                if name not in expected or name in seen:
                    raise ValueError('BUILD_ARCHIVE_TREE_MISMATCH')
                mode, blob = expected[name]
                if mode == '120000' and member.issym():
                    body = member.linkname.encode('utf-8')
                    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
                    if member.linkname.startswith('/') or resolved == '..' or resolved.startswith('../') or '\\' in member.linkname:
                        raise ValueError('BUILD_SYMLINK_OUTSIDE_CONTEXT')
                elif mode != '120000' and member.isfile():
                    body = contents.extractfile(member).read()
                else:
                    raise ValueError('BUILD_ARCHIVE_TYPE_MISMATCH')
                digest = hashlib.sha1(f'blob {len(body)}\0'.encode() + body).hexdigest()
                if digest != blob:
                    raise ValueError('BUILD_ARCHIVE_CONTENT_MISMATCH')
                target.parent.mkdir(parents=True, exist_ok=True)
                if mode == '120000':
                    target.symlink_to(member.linkname)
                else:
                    with target.open('xb') as output:
                        output.write(body)
                    target.chmod(0o755 if mode == '100755' else 0o644)
                seen.add(name)
        if archive.wait() != 0 or seen != set(expected):
            raise ValueError('BUILD_ARCHIVE_TREE_MISMATCH')
        if git(root, 'rev-parse', 'HEAD').decode().strip() != sha:
            raise ValueError('BUILD_HEAD_CHANGED')
        return path, len(seen)
    except Exception:
        cleanup(path, temporary, prefix)
        raise
    finally:
        if archive is not None:
            if archive.poll() is None:
                archive.kill()
            archive.wait()
            archive.stdout.close()


def main():
    try:
        sha = os.environ['GITHUB_SHA']
        run, attempt = os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT']
        if not re.fullmatch(r'[0-9a-f]{40}', sha) or not run.isdecimal() or not attempt.isdecimal():
            raise ValueError('BUILD_JOB_UNKNOWN')
        temporary = Path(os.environ['RUNNER_TEMP'])
        prefix = f'onq-build-{run}-{attempt}-{sha[:12]}-'
        if sys.argv[1:] == ['--cleanup']:
            cleanup(Path(os.environ['BUILD_SOURCE_PATH']), temporary, prefix)
            print('Owned build source removed')
        elif not sys.argv[1:]:
            path, count = snapshot(Path(os.environ['GITHUB_WORKSPACE']), sha, temporary, prefix)
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
                output.write(f'path={path}\n')
            print(f'Build source verified: SHA={sha}; tracked files={count}')
        else:
            raise ValueError('BUILD_ACTION_UNKNOWN')
    except (OSError, ValueError, KeyError, subprocess.SubprocessError, tarfile.TarError):
        print('::error::Verified build source unavailable; persistent originals were not changed')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
