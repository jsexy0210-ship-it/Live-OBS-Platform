#!/usr/bin/env python3
"""귀속 판정 전 readonly 관찰. 실제 이름/경로/원문은 내보내지 않는다."""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import urllib.request

REPO = "jsexy0210-ship-it/Live-OBS-Platform"
LOCAL = "unix:///var/run/docker.sock"
EXPECTED = "obs-web-test"

def command(args, env):
    try:
        result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=10, check=False)
        return result.returncode, result.stdout.strip() if result.returncode == 0 else ""
    except Exception:
        return -1, ""

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def health():
    try:
        # 로컬 TEST health만 읽고 proxy/redirect/자격 전달을 하지 않는다.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open("http://127.0.0.1/api/health", timeout=5) as response:
            if response.status != 200:
                return {}
            return json.loads(response.read(65537))
    except Exception:
        return {}

def read_history(path, full=False):
    descriptor = None
    try:
        if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "geteuid"):
            return False, None
        def valid(info):
            return stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.geteuid() and not info.st_mode & 0o022
        def identity(info):
            return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        before = path.lstat()
        if not valid(before):
            return False, None
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        opened = os.fstat(descriptor)
        if not valid(opened) or identity(opened) != identity(before) or identity(path.lstat()) != identity(opened):
            return False, None
        os.lseek(descriptor, 0 if full else max(0, opened.st_size - 65536), os.SEEK_SET)
        versions, carry, groups, line_count = [], b"", {}, 0
        while True:
            content = os.read(descriptor, 65536)
            if not content:
                break
            joined = carry + content
            for match in re.finditer(rb"sha=([0-9a-f]{40})", joined):
                version = match.group(1).decode("ascii")
                versions.append(version)
                if full:
                    line = line_count - carry.count(b"\n") + joined[:match.start()].count(b"\n")
                    groups.setdefault(line, []).append(version)
            if not full:
                break
            # 44-byte sha 패턴이 chunk 경계에 걸려도 누락·중복시키지 않는다.
            line_count += content.count(b"\n")
            carry = joined[-43:]
        if identity(os.fstat(descriptor)) != identity(opened) or identity(path.lstat()) != identity(opened):
            return False, None
        return True, [" ".join(group) for group in groups.values()] if full else (versions[-1] if versions else None)
    except Exception:
        return False, None
    finally:
        if descriptor is not None:
            os.close(descriptor)

def collect(env, run=command, read_health=health, history_reader=None):
    evidence = {"protocol": "ONQ_HOST_READONLY_V1", "identityVerified": False}
    if env.get("GITHUB_REPOSITORY") != REPO or env.get("GITHUB_REF") != "refs/heads/main" or env.get("RUNNER_OS") != "Linux":
        return {**evidence, "contextAllowed": False}
    evidence["contextAllowed"] = True
    evidence["registeredRunnerMatchesExpected"] = env.get("RUNNER_NAME") == EXPECTED
    endpoint = env.get("DOCKER_HOST", LOCAL) == LOCAL and env.get("DOCKER_CONTEXT", "default") == "default" and not env.get("DOCKER_TLS_VERIFY") and not env.get("DOCKER_CERT_PATH")
    evidence["endpointAllowed"] = endpoint
    if not endpoint:
        return evidence
    clean = {key: value for key, value in env.items() if key not in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH")}
    def docker(*args):
        return run(["docker", "--host", LOCAL, *args], clean)
    host_exit, host = run(["hostname", "-s"], clean)
    context_exit, context = docker("context", "inspect", "default", "--format", "{{.Endpoints.docker.Host}}")
    evidence.update(hostnameExit=host_exit, hostnameMatchesExpected=host_exit == 0 and host == EXPECTED, dockerContextExit=context_exit, dockerContextLocal=context_exit == 0 and context == LOCAL)
    if context_exit != 0 or context != LOCAL:
        return evidence
    daemon_exit, daemon = docker("info", "--format", "{{.Name}}")
    evidence.update(daemonExit=daemon_exit, daemonMatchesExpected=daemon_exit == 0 and daemon == EXPECTED, daemonMatchesOSHostname=daemon_exit == 0 and host_exit == 0 and bool(host) and daemon == host)
    def owned(path, directory=False, owner=None):
        try:
            info = path.lstat()
            return not stat.S_ISLNK(info.st_mode) and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1) and info.st_uid == (os.geteuid() if owner is None else owner) and not info.st_mode & 0o022
        except Exception:
            return False
    try:
        socket = Path("/var/run/docker.sock").lstat()
        evidence["localSocketRootOwned"] = stat.S_ISSOCK(socket.st_mode) and socket.st_uid == 0
    except Exception:
        evidence["localSocketRootOwned"] = False
    root_exit, docker_root = docker("info", "--format", "{{.DockerRootDir}}")
    evidence["dockerRootReadExit"] = root_exit
    evidence["dockerRootRootOwned"] = root_exit == 0 and Path(docker_root).is_absolute() and owned(Path(docker_root), True, 0)
    runner = Path(env.get("OBS_RUNNER_ROOT", ""))
    evidence["runnerRootAbsolute"] = runner.is_absolute()
    for prefix, path in (("runnerRoot", runner), ("runnerDiag", runner / "_diag")):
        checks = {"Exists": False, "Directory": False, "Symlink": False, "OwnerMatchesEuid": False, "GroupOrOtherWritable": False}
        try:
            info = path.lstat()
            checks.update(Exists=True, Directory=stat.S_ISDIR(info.st_mode), Symlink=stat.S_ISLNK(info.st_mode), OwnerMatchesEuid=info.st_uid == os.geteuid(), GroupOrOtherWritable=bool(info.st_mode & 0o022))
        except Exception:
            pass
        evidence.update({prefix + key: value for key, value in checks.items()})
    evidence["runnerDiagOwned"] = evidence["runnerRootAbsolute"] and all(evidence[prefix + "Exists"] and evidence[prefix + "Directory"] and not evidence[prefix + "Symlink"] and evidence[prefix + "OwnerMatchesEuid"] and not evidence[prefix + "GroupOrOtherWritable"] for prefix in ("runnerRoot", "runnerDiag"))
    history = Path("/opt/obs/deploy-history.log")
    evidence["historyOwned"], latest = (history_reader or read_history)(history)
    evidence["historyHasCommit"] = latest is not None
    app_exit, ids = docker("ps", "-q", "--filter", "label=com.docker.compose.project=obs-web", "--filter", "label=com.docker.compose.service=obs-web-app")
    evidence["appLookupExit"] = app_exit
    evidence["oneLocalApp"] = app_exit == 0 and bool(re.fullmatch(r"[0-9a-f]{12,64}", ids))
    app_sha = None
    if evidence["oneLocalApp"]:
        label_exit, labels = docker("inspect", "--format", "{{json .Config.Labels}}", ids)
        try:
            labels = json.loads(labels) if label_exit == 0 else {}
            evidence["appComposeLabelsMatch"] = labels.get("com.docker.compose.project") == "obs-web" and labels.get("com.docker.compose.service") == "obs-web-app"
        except Exception:
            evidence["appComposeLabelsMatch"] = False
        image_exit, image = docker("inspect", "--format", "{{.Config.Image}}", ids)
        match = re.fullmatch(r"obs-web-app:([0-9a-f]{40})", image) if image_exit == 0 else None
        app_sha = match.group(1) if match else None
    evidence["appImageOnqCommit"] = app_sha is not None
    evidence["appImageMatchesHistory"] = app_sha is not None and latest is not None and app_sha == latest
    result = read_health()
    result = result if isinstance(result, dict) else {}
    evidence.update(localHealthOk=result.get("status") == "ok" and result.get("db") == "ok", localHealthTestMode=result.get("testMode") is True, localHealthMatchesAppImage=app_sha is not None and result.get("version") == app_sha)
    # 기본 관찰은 승인하지 않는다. plan의 별도 fresh 검증에서 필수 근거 전체를 확인한다.
    return evidence

PREVIEW_IDENTITY_CHECKS = (
    "contextAllowed", "registeredRunnerMatchesExpected", "endpointAllowed", "dockerContextLocal",
    "daemonMatchesOSHostname", "localSocketRootOwned", "dockerRootRootOwned", "runnerDiagOwned",
    "historyOwned", "historyHasCommit", "oneLocalApp", "appComposeLabelsMatch", "appImageOnqCommit",
    "appImageMatchesHistory", "localHealthOk", "localHealthTestMode", "localHealthMatchesAppImage",
)

def preview_identity_verified(evidence):
    return all(evidence.get(key) is True for key in PREVIEW_IDENTITY_CHECKS)

LOG_EXCLUSION = "EXCLUDED_CATEGORY\tRUNNER_DIAGNOSTIC_LOGS_OLDER_THAN_14_DAYS\tRUNNER_DIAG_WRITABLE_BY_GROUP_OR_OTHER\tREADONLY_ONLY"

def preview_scope(evidence):
    if preview_identity_verified(evidence):
        return []
    # 관측된 unsafe mode만 제외한다. owner/type/symlink·TEST 근거 부족은 허용하지 않는다.
    required = [key for key in PREVIEW_IDENTITY_CHECKS if key != "runnerDiagOwned"] + ["runnerRootAbsolute", "runnerRootExists", "runnerRootDirectory", "runnerRootOwnerMatchesEuid", "runnerDiagExists", "runnerDiagDirectory", "runnerDiagOwnerMatchesEuid", "runnerDiagGroupOrOtherWritable"]
    denied = ["runnerRootSymlink", "runnerRootGroupOrOtherWritable", "runnerDiagSymlink"]
    if all(evidence.get(key) is True for key in required) and all(evidence.get(key) is False for key in denied):
        return [LOG_EXCLUSION]
    return None

def main(args, env):
    if args not in ([], ["--verify-preview-host"], ["--verify-preview-history"]):
        print("HOST_ATTESTATION_ARGUMENT_DENIED", file=sys.stderr)
        return 1
    if args and env.get("OBS_HISTORY_FILE", "/opt/obs/deploy-history.log") != "/opt/obs/deploy-history.log":
        print("HISTORY_UNVERIFIED", file=sys.stderr)
        return 1
    versions = []
    def snapshot(path):
        verified, found = read_history(path, full=True)
        if verified and found:
            versions.extend(found)
        return verified, versions[-1].split()[-1] if versions else None
    evidence = collect(env, history_reader=snapshot) if args else collect(env)
    if args:
        scope = preview_scope(evidence) if args == ["--verify-preview-history"] else ([] if preview_identity_verified(evidence) else None)
        if scope is None:
            print("TEST_ATTESTATION_UNVERIFIED match=false", file=sys.stderr)
            return 1
        if args == ["--verify-preview-history"]:
            for exclusion in scope:
                print(exclusion)
            for version in versions:
                print(version)
    else:
        print(json.dumps(evidence, sort_keys=True))
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:], dict(os.environ)))
