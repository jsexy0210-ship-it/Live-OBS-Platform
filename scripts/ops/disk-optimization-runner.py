#!/usr/bin/env python3
"""전용 두 범주 runner. 운영 실행은 별도 승인·서버 claim 없이는 도달하지 않는다."""
import datetime as dt
import hashlib
import json
import os
import re
import socket
import stat
import subprocess
import sys
import urllib.request

REPO = "jsexy0210-ship-it/Live-OBS-Platform"
CALLBACK = "https://test.on-aircue.com/api/internal/ops/disk-optimization"
POLICY = "ONQ_DISK_SAFE_V1"
IMAGE = "OLD_ONQ_NON_ROLLBACK_IMAGES"
LOG = "RUNNER_DIAGNOSTIC_LOGS_OLDER_THAN_14_DAYS"

class Rejected(Exception):
    pass

def fingerprint(candidates):
    rows = sorted(f"{c['category']}\t{c['id']}\t{c['bytes']}\t{c['contentHash']}\n" for c in candidates)
    return hashlib.sha256((POLICY + "\n" + "".join(rows)).encode()).hexdigest()

def plan():
    result = subprocess.run(["bash", "scripts/ops/disk-optimization-plan.sh", "--preview"], capture_output=True, check=False)
    if result.returncode or len(result.stdout) > 64 * 1024:
        raise Rejected("PREVIEW_UNVERIFIED")
    lines = result.stdout.decode("utf-8").splitlines()
    if not lines or lines[0] != POLICY:
        raise Rejected("PREVIEW_UNVERIFIED")
    candidates, seen = [], set()
    for line in lines[1:]:
        parts = line.split("\t")
        if len(parts) != 4:
            raise Rejected("INVALID_MANIFEST")
        category, identifier, size, digest = parts
        allowed = (category == IMAGE and re.fullmatch(r"sha256:[0-9a-f]{64}", identifier)) or (category == LOG and re.fullmatch(r"(?:Runner|Worker)_[A-Za-z0-9_.-]+\.log", identifier))
        if not allowed or not size.isdigit() or int(size) > 2**53 - 1 or not re.fullmatch(r"[0-9a-f]{64}", digest) or (category, identifier) in seen:
            raise Rejected("INVALID_MANIFEST")
        seen.add((category, identifier))
        candidates.append({"category": category, "id": identifier, "bytes": int(size), "contentHash": digest})
    return candidates

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Rejected("CALLBACK_REDIRECT_DENIED")

def post(payload):
    token = os.environ.get("ONQ_DISK_CALLBACK_TOKEN", "")
    if len(token) < 32:
        raise Rejected("CALLBACK_UNCONFIGURED")
    request = urllib.request.Request(CALLBACK, data=json.dumps(payload).encode(), method="POST", headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
            data = response.read(64 * 1024 + 1)
            if response.status != 200 or len(data) > 64 * 1024:
                raise Rejected("CALLBACK_REJECTED")
            result = json.loads(data)
            if result.get("ok") is not True:
                raise Rejected("CALLBACK_REJECTED")
            return result
    except Exception:
        raise Rejected("CALLBACK_REJECTED") from None

def docker_environment():
    # 허용 여부를 먼저 확인한 뒤 CLI context 환경의 host 우선순위 개입을 제거한다.
    return {key: value for key, value in os.environ.items() if key not in {"DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"}}

def verify_docker_host():
    endpoint = "unix:///var/run/docker.sock"
    if os.environ.get("DOCKER_HOST", endpoint) != endpoint or os.environ.get("DOCKER_CONTEXT", "default") != "default" or os.environ.get("DOCKER_TLS_VERIFY") or os.environ.get("DOCKER_CERT_PATH"):
        raise Rejected("DOCKER_ENDPOINT_DENIED")
    if socket.gethostname().split(".")[0] != "obs-web-test":
        raise Rejected("DOCKER_HOST_UNVERIFIED")
    for args, expected in [(["context", "inspect", "default", "--format", "{{.Endpoints.docker.Host}}"], endpoint), (["info", "--format", "{{.Name}}"], "obs-web-test")]:
        result = subprocess.run(["docker", "--host", endpoint] + args, capture_output=True, check=False, env=docker_environment())
        if result.returncode or result.stdout.decode().strip() != expected:
            raise Rejected("DOCKER_HOST_UNVERIFIED")

def remove_candidate(candidate):
    if candidate["category"] == IMAGE:
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", candidate["id"]) or candidate["contentHash"] != candidate["id"][7:]:
            raise Rejected("TARGET_DENIED")
        # 강제 삭제/다른 별명 제거/prune는 없다. Docker가 사용 중·다중 별명을 거부하면 중단한다.
        verify_docker_host()
        result = subprocess.run(["docker", "--host", "unix:///var/run/docker.sock", "image", "rm", "--no-prune", candidate["id"]], capture_output=True, check=False, env=docker_environment())
        if result.returncode:
            raise Rejected("IMAGE_REMOVAL_REJECTED")
        return
    if candidate["category"] != LOG or not re.fullmatch(r"(?:Runner|Worker)_[A-Za-z0-9_.-]+\.log", candidate["id"]):
        raise Rejected("TARGET_DENIED")
    root = os.environ.get("OBS_RUNNER_ROOT", "")
    diag = os.path.join(root, "_diag")
    if not root or os.path.islink(root) or os.path.islink(diag) or os.path.realpath(diag) != os.path.join(os.path.realpath(root), "_diag"):
        raise Rejected("RUNNER_UNVERIFIED")
    directory_stat = os.stat(diag)
    if directory_stat.st_uid != os.geteuid() or directory_stat.st_mode & 0o022:
        raise Rejected("RUNNER_OWNERSHIP_UNVERIFIED")
    directory = os.open(diag, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fd = os.open(candidate["id"], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        with os.fdopen(fd, "rb") as handle:
            before = os.fstat(handle.fileno())
            digest = hashlib.sha256()
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
            digest = digest.hexdigest()
            after = os.fstat(handle.fileno())
            current = os.stat(candidate["id"], dir_fd=directory, follow_symlinks=False)
            identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
            if before.st_uid != os.geteuid() or after.st_uid != os.geteuid() or current.st_uid != os.geteuid() or not stat.S_ISREG(before.st_mode) or identity(before) != identity(after) or identity(after) != identity(current) or before.st_size != candidate["bytes"] or digest != candidate["contentHash"] or dt.datetime.now().timestamp() - before.st_mtime <= 14 * 24 * 3600:
                raise Rejected("LOG_CHANGED_OR_PROTECTED")
            os.unlink(candidate["id"], dir_fd=directory)
    finally:
        os.close(directory)

def measured_available():
    verify_docker_host()
    result = subprocess.run(["docker", "--host", "unix:///var/run/docker.sock", "info", "--format", "{{.DockerRootDir}}"], capture_output=True, check=False, env=docker_environment())
    if result.returncode:
        raise Rejected("DISK_MEASUREMENT_UNAVAILABLE")
    paths = [result.stdout.decode().strip(), os.path.join(os.environ.get("OBS_RUNNER_ROOT", ""), "_diag")]
    seen, total = set(), 0
    for path in paths:
        if not os.path.isabs(path) or os.path.islink(path):
            raise Rejected("DISK_MEASUREMENT_UNAVAILABLE")
        device = os.stat(path).st_dev
        if device not in seen:
            fs = os.statvfs(path)
            total += fs.f_bavail * fs.f_frsize
            seen.add(device)
    return total

def run(mode, request_id, run_id, expected=None, expires_at=None, read=plan, send=post, remove=remove_candidate, measure=measured_available):
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", request_id) or not re.fullmatch(r"[1-9][0-9]{0,19}", run_id):
        raise Rejected("INVALID_CORRELATION")
    candidates = read()
    now = dt.datetime.now(dt.timezone.utc)
    iso = lambda value: value.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if mode == "preview":
        return send({"action": "preview", "requestId": request_id, "runId": run_id, "evidence": {"target": "OBS_TEST", "policyVersion": POLICY, "checkedAt": iso(now), "expiresAt": iso(now + dt.timedelta(minutes=5)), "hostValidated": True, "runnerValidated": True, "deploymentConcurrencyVerified": True, "candidates": candidates}})
    if mode != "execute" or not re.fullmatch(r"[0-9a-f]{64}", expected or "") or fingerprint(candidates) != expected or not candidates:
        raise Rejected("CANDIDATE_CHANGED")
    if not expires_at or dt.datetime.fromisoformat(expires_at.replace("Z", "+00:00")) <= now:
        raise Rejected("PREVIEW_EXPIRED")
    claim = send({"action": "claim", "requestId": request_id, "runId": run_id, "candidateFingerprint": expected, "previewExpiresAt": expires_at})
    job = claim.get("job", {})
    if claim.get("ok") is not True or job.get("id") != run_id or job.get("requestId") != request_id or job.get("candidateFingerprint") != expected or job.get("state") != "RUNNING":
        raise Rejected("CLAIM_UNVERIFIED")
    before = measure()
    error = None
    try:
        remaining = list(candidates)
        for candidate in candidates:
            if fingerprint(read()) != fingerprint(remaining):
                raise Rejected("CANDIDATE_CHANGED")
            remove(candidate)
            remaining.remove(candidate)
    except Rejected as rejected:
        error = str(rejected)
    except Exception:
        error = "EXECUTION_FAILED"
    try:
        reclaimed = max(0, measure() - before)
    except Exception:
        # 실측 실패를 추정 회수량으로 바꾸지 않는다. 완료 증거를 제출하지 않는다.
        raise Rejected("DISK_MEASUREMENT_UNAVAILABLE") from None
    send({"action": "result", "requestId": request_id, "runId": run_id, "candidateFingerprint": expected, "reclaimedBytes": reclaimed, "errorCode": error})
    if error:
        raise Rejected(error)

if __name__ == "__main__":
    try:
        mode = "preview" if sys.argv[1:] == ["--preview-callback"] else "execute" if sys.argv[1:] == ["--approved-execution"] else "denied"
        if os.environ.get("GITHUB_REPOSITORY") != REPO or os.environ.get("GITHUB_REF") != "refs/heads/main" or os.environ.get("GITHUB_RUN_ATTEMPT") != "1":
            raise Rejected("RUN_CONTEXT_DENIED")
        if mode == "execute" and os.environ.get("ONQ_DISK_EXECUTION_APPROVED") != "true":
            raise Rejected("EXECUTION_NOT_APPROVED")
        run(mode, os.environ.get("DISK_REQUEST_ID", ""), os.environ.get("GITHUB_RUN_ID", ""), os.environ.get("DISK_FINGERPRINT"), os.environ.get("DISK_PREVIEW_EXPIRES_AT"))
    except Exception as error:
        print(str(error) if isinstance(error, Rejected) else "RUNNER_FAILED", file=sys.stderr)
        sys.exit(1)
