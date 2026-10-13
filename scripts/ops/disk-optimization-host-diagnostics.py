#!/usr/bin/env python3
"""귀속 판정 전 readonly 관찰. 실제 이름/경로/원문은 내보내지 않는다."""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
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

def collect(env, run=command, read_health=health):
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
    evidence.update(daemonExit=daemon_exit, daemonMatchesExpected=daemon_exit == 0 and daemon == EXPECTED, daemonMatchesOSHostname=daemon_exit == 0 and host_exit == 0 and daemon == host)
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
    evidence["runnerDiagOwned"] = runner.is_absolute() and owned(runner, True) and owned(runner / "_diag", True)
    history = Path("/opt/obs/deploy-history.log")
    evidence["historyOwned"] = owned(history)
    latest = None
    if evidence["historyOwned"]:
        try:
            with history.open("rb") as file:
                file.seek(0, 2); file.seek(max(0, file.tell() - 65536))
                versions = re.findall(rb"sha=([0-9a-f]{40})", file.read(65536))
            latest = versions[-1].decode("ascii") if versions else None
        except Exception:
            pass
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
    # 이 관찰을 후보 승인으로 바꾸지 않는다. plan/runner의 기존 gate는 별도로 그대로 실행한다.
    return evidence

if __name__ == "__main__":
    print(json.dumps(collect(dict(os.environ)), sort_keys=True))
