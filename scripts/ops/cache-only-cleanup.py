#!/usr/bin/env python3
"""Only old files below the fixed ONQ checkout's .next/cache may be unlinked.

Next documents this directory as regenerable build cache:
https://nextjs.org/docs/app/guides/ci-build-caching
BuildKit records have no independently verified cache-ID/project join here and
are deliberately outside this program. No broad cleanup script is imported.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time

ROOT = Path('/opt/obs/src')
REL = Path('.next/cache')
REPOSITORY = 'jsexy0210-ship-it/Live-OBS-Platform'
GUARDS = Path(__file__).with_name('checkout-readonly-guards.sh')
AGE = 7 * 86400


class Preserve(Exception):
    pass


def run(argv):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=30,
                                env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})
    except (OSError, subprocess.TimeoutExpired):
        raise Preserve('READ_COMMAND_UNAVAILABLE') from None
    if result.returncode:
        raise Preserve('READ_COMMAND_FAILED')
    return result.stdout.strip()


def guard(name, *args):
    # All names are constants from this program; arguments never become shell code.
    value = run(['bash', '-euo', 'pipefail', '-c',
                 'source "$1"; shift; fn="$1"; shift; "$fn" "$@"',
                 'cache-guard', str(GUARDS), name, *map(str, args)])
    return value


def signature(info):
    return [info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns]


def canonical(path):
    if path.resolve(strict=True) != path:
        raise Preserve('PATH_ALIAS_OR_SYMLINK')
    for ancestor in [path, *path.parents]:
        if stat.S_ISLNK(ancestor.lstat().st_mode):
            raise Preserve('PATH_ALIAS_OR_SYMLINK')


def snapshot(root, now):
    target = root / REL
    canonical(root)
    if not target.exists():
        if target.is_symlink():
            raise Preserve('CACHE_SYMLINK')
        return {'nodes': {}, 'selected': []}
    canonical(target)
    root_info = root.stat()
    for ancestor in (root / '.next', target):
        info = ancestor.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_dev != root_info.st_dev or info.st_mode & 0o022:
            raise Preserve('CACHE_PARENT_OWNER_DEVICE_OR_WRITE_ACCESS')
    nodes, selected = {}, []
    def fail_walk(error):
        raise error
    for directory, dirs, files in os.walk(target, followlinks=False, onerror=fail_walk):
        for path in [Path(directory), *(Path(directory) / n for n in dirs + files)]:
            rel = path.relative_to(root).as_posix()
            info = path.lstat()
            if info.st_uid != os.getuid() or info.st_dev != root_info.st_dev or info.st_mode & 0o022:
                raise Preserve('CACHE_OWNER_DEVICE_OR_WRITE_ACCESS')
            if stat.S_ISDIR(info.st_mode):
                pass
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                if max(info.st_mtime, info.st_ctime) <= now - AGE:
                    selected.append(rel)
            else:
                raise Preserve('CACHE_SYMLINK_HARDLINK_OR_SPECIAL_FILE')
            nodes[rel] = signature(info)
    return {'nodes': nodes, 'selected': sorted(set(selected))}


def references(root):
    # These existing read guards intentionally preserve UNKNOWN / inaccessible /proc.
    if guard('readonly_exact_active_ref', root) != 'no':
        raise Preserve('CHECKOUT_ACTIVE_REFERENCE_OR_UNKNOWN')
    if guard('readonly_target_mount_state', root, root / REL) != 'same':
        raise Preserve('CACHE_MOUNT_OR_UNKNOWN')
    ids = run(['docker', 'ps', '-aq']).splitlines()
    for container in ids:
        if not re.fullmatch(r'[0-9a-f]{12,64}', container):
            raise Preserve('CONTAINER_ID_SCHEMA')
        raw = run(['docker', 'inspect', '--format',
                   '{{json .Mounts}}', container])
        mounts = json.loads(raw)
        if not isinstance(mounts, list):
            raise Preserve('CONTAINER_MOUNT_SCHEMA')
        for mount in mounts:
            source, destination = mount.get('Source'), mount.get('Destination')
            if not isinstance(source, str) or not source.startswith('/') or not isinstance(destination, str):
                raise Preserve('CONTAINER_MOUNT_SCHEMA')
            source_path = Path(source)
            canonical(source_path)
            if source_path == root or root in source_path.parents or source_path in root.parents:
                raise Preserve('CONTAINER_CHECKOUT_REFERENCE')
    monitor_ids = run(['docker', 'ps', '-aq', '--filter',
                       'label=com.docker.compose.project=obs-web', '--filter',
                       'label=com.docker.compose.service=obs-web-monitor']).splitlines()
    if len(monitor_ids) != 1 or monitor_ids[0] not in ids:
        raise Preserve('DEPLOY_MARK_LOCATION_UNKNOWN')
    mounts = json.loads(run(['docker', 'inspect', '--format', '{{json .Mounts}}', monitor_ids[0]]))
    monitor_sources = [Path(m['Source']) for m in mounts if m.get('Destination') == '/data']
    if len(monitor_sources) != 1:
        raise Preserve('DEPLOY_MARK_LOCATION_UNKNOWN')
    data = monitor_sources[0]
    canonical(data)
    marker, markers = data / 'deploy-in-progress', data / 'deploy-in-progress.d'
    if marker.exists() or marker.is_symlink():
        raise Preserve('DEPLOY_MARK_PRESENT')
    if markers.is_symlink():
        raise Preserve('DEPLOY_MARK_DIRECTORY_ALIAS')
    if markers.exists() and any(p.name and not p.name.startswith('.ended-') for p in markers.iterdir()):
        raise Preserve('DEPLOY_MARK_PRESENT_OR_UNKNOWN')


def plan(root=None):
    root = ROOT if root is None else root
    canonical(root)
    if root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o022:
        raise Preserve('CHECKOUT_OWNER_OR_WRITE_ACCESS')
    identity, clean = guard('readonly_checkout_git_state', root).split()
    if (identity, clean) != ('ONQ', 'clean'):
        raise Preserve('CHECKOUT_IDENTITY_OR_DIRTY')
    head = run(['git', '-C', str(root), 'rev-parse', 'HEAD'])
    if not re.fullmatch(r'[0-9a-f]{40}', head):
        raise Preserve('CHECKOUT_HEAD_SCHEMA')
    # The server checkout need not equal this ops workflow's newer commit.
    history = (root.parent / 'deploy-history.log').read_text()
    recent = list(dict.fromkeys(reversed(re.findall(r'\bsha=([0-9a-f]{40})\b', history))))[:5]
    if head not in recent:
        raise Preserve('CHECKOUT_NOT_IN_RECENT_DEPLOY_HISTORY')
    if run(['git', '-C', str(root), 'ls-files', '--', REL.as_posix()]):
        raise Preserve('TRACKED_CACHE_FILE')
    run(['git', '-C', str(root), 'check-ignore', '--', REL.as_posix() + '/'])
    dockerignore = (root / '.dockerignore').read_text().splitlines()
    if '.next' not in dockerignore or any(line.lstrip().startswith('!') for line in dockerignore):
        raise Preserve('DOCKER_CONTEXT_EXCLUSION_UNKNOWN')
    state = snapshot(root, time.time())
    if state['nodes']:
        references(root)
    state['head'] = head
    digest = hashlib.sha256(json.dumps(state, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return state, digest


def remove_selected(root, state, report=None):
    """Use directory descriptors; no recursive removal or pathname deletion API."""
    if os.name != 'posix' or not hasattr(os, 'O_NOFOLLOW'):
        raise Preserve('SAFE_UNLINK_PLATFORM_UNSUPPORTED')
    removed, total = 0, 0
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        root_before = root.stat()
        if (os.fstat(root_fd).st_dev, os.fstat(root_fd).st_ino) != (root_before.st_dev, root_before.st_ino):
            raise Preserve('CHECKOUT_CHANGED')
        for rel in state['selected']:
            parts = Path(rel).parts
            if parts[:2] != ('.next', 'cache') or any(p in ('', '.', '..') for p in parts):
                raise Preserve('CACHE_BOUNDARY')
            parent = os.dup(root_fd)
            try:
                prefix = []
                for component in parts[:-1]:
                    next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                    os.close(parent)
                    parent = next_fd
                    prefix.append(component)
                    key = '/'.join(prefix)
                    info = os.fstat(parent)
                    if info.st_uid != os.getuid() or info.st_mode & 0o022:
                        raise Preserve('CACHE_PARENT_CHANGED')
                    if key in state['nodes'] and signature(info)[:5] != state['nodes'][key][:5]:
                        raise Preserve('CACHE_PARENT_CHANGED')
                file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    canonical(root / Path(rel).parent)
                    current_parent = (root / Path(rel).parent).stat()
                    current_root = root.stat()
                    if ((current_parent.st_dev, current_parent.st_ino) != (os.fstat(parent).st_dev, os.fstat(parent).st_ino)
                            or (current_root.st_dev, current_root.st_ino) != (os.fstat(root_fd).st_dev, os.fstat(root_fd).st_ino)):
                        raise Preserve('CACHE_DIRECTORY_MOVED')
                    expected = state['nodes'][rel]
                    if signature(os.fstat(file_fd)) != expected or signature(os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)) != expected:
                        raise Preserve('CACHE_FILE_CHANGED')
                    os.unlink(parts[-1], dir_fd=parent)
                    removed += 1
                    total += expected[5]
                    if report is not None:
                        report.update(deleted_files=removed, verified_removed_file_bytes=total)
                finally:
                    os.close(file_fd)
            finally:
                os.close(parent)
    finally:
        os.close(root_fd)
    return removed, total


def free_bytes():
    try:
        info = os.statvfs(ROOT)
        return info.f_bavail * info.f_frsize
    except (AttributeError, OSError):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['preview', 'apply'], default='preview')
    parser.add_argument('--expected-preview', default='')
    args = parser.parse_args()
    report = {'mode': args.mode, 'scope': '.next/cache files only', 'deleted_files': 0,
              'verified_removed_file_bytes': 0, 'buildkit_deleted_records': 0}
    before = free_bytes()
    code = 0
    try:
        if any(os.environ.get(k) != v for k, v in {
            'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
            'GITHUB_REF': 'refs/heads/main', 'GITHUB_REPOSITORY': REPOSITORY,
            'GITHUB_WORKFLOW': 'Cache-only cleanup obs-test'}.items()):
            raise Preserve('OFFICIAL_WORKFLOW_REQUIRED')
        if os.environ.get('OBS_DEPLOY_MARK') or os.environ.get('OBS_HISTORY_FILE'):
            raise Preserve('DEPLOY_PATH_OVERRIDE_UNKNOWN')
        state, digest = plan()
        report.update(preview_sha256=digest, candidate_files=len(state['selected']),
                      candidate_file_bytes=sum(state['nodes'][p][5] for p in state['selected']))
        if args.mode == 'apply':
            if not re.fullmatch(r'[0-9a-f]{64}', args.expected_preview) or args.expected_preview != digest:
                raise Preserve('PREVIEW_MISMATCH')
            fresh, fresh_digest = plan()
            if fresh_digest != digest:
                raise Preserve('FRESH_SELECTION_CHANGED')
            remove_selected(ROOT, fresh, report)
        report['outcome'] = 'complete' if args.mode == 'apply' else 'preview'
    except (Preserve, OSError, ValueError, KeyError, TypeError) as error:
        report['outcome'] = 'preserved'
        report['reason'] = str(error) if isinstance(error, Preserve) else 'READ_OR_SCHEMA_FAILURE'
        code = 1
    after = free_bytes()
    report.update(free_before_bytes=before, free_after_bytes=after,
                  free_delta_bytes=after-before if before is not None and after is not None else None)
    print(json.dumps(report, sort_keys=True))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
