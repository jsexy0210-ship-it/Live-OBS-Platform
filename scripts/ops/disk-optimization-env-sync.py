#!/usr/bin/env python3
"""공식 TEST 배포의 전용 허용키만 원자 반영. 값/길이/본문을 출력하지 않는다."""
import base64
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
try:
    import fcntl
except ImportError:
    fcntl = None

KEYS = ("ONQ_DISK_APP_ID", "ONQ_DISK_INSTALLATION_ID", "ONQ_DISK_APP_PRIVATE_KEY_BASE64", "ONQ_DISK_CALLBACK_TOKEN")
MODE = "ONQ_DISK_ACTIONS_MODE"
class Rejected(Exception):
    pass

def checked_values(env, validate_key=None):
    values = {key: env.get(key, "") for key in KEYS}
    if not any(values.values()):
        return None
    if not all(values.values()) or any(not re.fullmatch(r"[1-9][0-9]{0,19}", values[key]) for key in KEYS[:2]) or not re.fullmatch(r"[A-Za-z0-9_-]{32,512}", values[KEYS[3]]) or len(values[KEYS[2]]) > 32768:
        raise Rejected("DISK_PREVIEW_CONFIG_INVALID")
    try:
        key = base64.b64decode(values[KEYS[2]], validate=True)
        if base64.b64encode(key).decode() != values[KEYS[2]]:
            raise ValueError()
        if validate_key is None:
            valid = subprocess.run(["openssl", "rsa", "-check", "-noout"], input=key, capture_output=True, check=False).returncode == 0
        else:
            valid = validate_key(key)
        if not valid:
            raise ValueError()
    except Exception:
        raise Rejected("DISK_PREVIEW_KEY_INVALID") from None
    return {**values, MODE: "preview"}

def merged(original, values):
    lines = original.splitlines(keepends=True)
    approved = re.compile(rb"^[ \t]*(?:export[ \t]+)?(" + b"|".join(key.encode() for key in (*KEYS, MODE)) + rb")[ \t]*=")
    if any(re.match(rb"^[ \t]*(?:export[ \t]+)?ONQ_DISK_EXECUTION_APPROVED[ \t]*=[ \t]*true[ \t]*(?:[\r\n]|$)", line) for line in lines):
        raise Rejected("DISK_EXECUTION_MUST_REMAIN_DISABLED")
    kept = b"".join(line for line in lines if not approved.match(line))
    if kept and not kept.endswith(b"\n"):
        kept += b"\n"
    return kept + b"".join(f"{key}={value}\n".encode("ascii") for key, value in values.items())

def sync(path, env, validate_key=None):
    values = checked_values(env, validate_key)
    if values is None:
        return False
    if fcntl is None or not hasattr(os, "O_NOFOLLOW"):
        raise Rejected("DISK_ENV_PLATFORM_UNVERIFIED")
    path = Path(path)
    parent = path.parent
    if path.is_symlink() or parent.is_symlink() or parent.resolve() != parent or not path.is_absolute():
        raise Rejected("DISK_ENV_PATH_UNVERIFIED")
    parent_stat = parent.stat()
    if parent_stat.st_uid != os.geteuid() or parent_stat.st_mode & 0o022:
        raise Rejected("DISK_ENV_OWNER_UNVERIFIED")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    temporary = None
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.geteuid() or stat.S_IMODE(before.st_mode) != 0o600:
            raise Rejected("DISK_ENV_OWNER_UNVERIFIED")
        with os.fdopen(os.dup(descriptor), "rb") as handle:
            original = handle.read()
        updated = merged(original, values)
        def verify_unchanged():
            current = path.stat(follow_symlinks=False)
            identity = lambda info: (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode, info.st_size, info.st_mtime_ns)
            if identity(before) != identity(current) or hashlib.sha256(path.read_bytes()).digest() != hashlib.sha256(original).digest():
                raise Rejected("DISK_ENV_CHANGED")
        if updated == original:
            verify_unchanged()
            return False
        fd, temporary = tempfile.mkstemp(prefix=".onq-disk-env-", dir=parent)
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            os.fchown(handle.fileno(), before.st_uid, before.st_gid)
            handle.write(updated)
            handle.flush()
            os.fsync(handle.fileno())
        verify_unchanged()
        os.replace(temporary, path)
        temporary = None
        directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return True
    finally:
        os.close(descriptor)
        if temporary is not None:
            os.unlink(temporary)

if __name__ == "__main__":
    try:
        if os.environ.get("GITHUB_REPOSITORY") != "jsexy0210-ship-it/Live-OBS-Platform" or os.environ.get("GITHUB_REF") != "refs/heads/main":
            raise Rejected("DISK_ENV_CONTEXT_DENIED")
        changed = sync(Path("/opt/obs/.env"), os.environ)
        print("MA120 preview 설정 반영" if changed else "MA120 preview 설정 변경 없음; 기존 환경 보존")
    except Exception:
        print("MA120 preview 설정 검증 실패; 배포를 계속하지 않습니다")
        raise SystemExit(1) from None
