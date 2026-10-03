"""검증된 Actions 아티팩트를 기존 obs-web-test에 배포한다. 비밀값은 출력하지 않는다."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time

from dns_preflight import check as check_dns, DOMAIN

ROOT = Path('/opt/obs')
SHA = re.compile(r'[0-9a-f]{40}')


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def verify_bundle(bundle, sha):
    if not SHA.fullmatch(sha):
        raise RuntimeError('정확한 40자리 커밋 SHA가 필요합니다.')
    manifest = json.loads((bundle / 'manifest.json').read_text())
    actual = set()
    for path in bundle.rglob('*'):
        if path.is_symlink():
            raise RuntimeError('아티팩트 심볼릭 링크를 허용하지 않습니다.')
        if path.is_file() and path.relative_to(bundle).as_posix() != 'manifest.json':
            actual.add(path.relative_to(bundle).as_posix())
    if set(manifest) != actual or 'images.tar' not in actual:
        raise RuntimeError('아티팩트 파일 목록이 일치하지 않습니다.')
    for name, expected in manifest.items():
        if name.startswith('/') or '..' in Path(name).parts:
            raise RuntimeError('허용하지 않는 아티팩트 경로입니다.')
        if name != 'images.tar' and not name.startswith('src/'):
            raise RuntimeError('허용하지 않는 아티팩트 파일입니다.')
        if digest(bundle / name) != expected:
            raise RuntimeError('아티팩트 무결성 검사 실패.')
    if (bundle / 'src/release.sha').read_text().strip() != sha:
        raise RuntimeError('배포 SHA와 아티팩트 SHA가 다릅니다.')
    migration_sha = (bundle / 'src/migrations.sha').read_text().strip()
    if not re.fullmatch(r'[0-9a-f]{64}', migration_sha):
        raise RuntimeError('마이그레이션 지문이 없습니다.')
    return migration_sha


def read_config(root):
    env_file = root / '.env'
    if env_file.is_symlink() or not env_file.is_file():
        raise RuntimeError('서버 전용 .env 파일이 필요합니다.')
    info = env_file.stat()
    if stat.S_IMODE(info.st_mode) not in (0o400, 0o600) or info.st_uid != os.getuid():
        raise RuntimeError('.env 소유자는 배포 계정이고 권한은 400/600이어야 합니다.')
    config = {}
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key) or key in config:
            raise RuntimeError('.env 구문 또는 중복 키를 확인하세요. 값은 출력하지 않습니다.')
        config[key] = value
    required = ('POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_PASSWORD',
                'IDENTITY_HASH_KEY', 'BILLING_KEY_SECRET')
    for key in required:
        if not re.fullmatch(r'[A-Za-z0-9_]+', config.get(key, '')):
            raise RuntimeError(f'{key} 형식을 확인하세요(따옴표 없는 영문·숫자·밑줄).')
    for key in ('POSTGRES_PASSWORD', 'IDENTITY_HASH_KEY', 'BILLING_KEY_SECRET'):
        if len(config[key]) < 32:
            raise RuntimeError(f'{key} 길이는 32자 이상이어야 합니다.')
    if config.get('OBS_ALLOW_LOCAL_DB') != '1':
        raise RuntimeError('기존 VM 내 테스트 DB 사용 확인: OBS_ALLOW_LOCAL_DB=1이 필요합니다.')
    # 실제 결제·인증·메일 키는 이 테스트 구성에서 앱에 주입하지 않는다.
    return {k: config[k] for k in (*required, 'OBS_ALLOW_LOCAL_DB')}


def run(args, label, env=None, stdout=subprocess.PIPE, stdin=None, timeout=240):
    try:
        child_env = env or {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'LANG')}
        child_env['DOCKER_HOST'] = 'unix:///var/run/docker.sock'
        result = subprocess.run(args, env=child_env, stdin=stdin, stdout=stdout,
                                stderr=subprocess.PIPE, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError(f'{label} 실행 실패 또는 시간 초과(출력 생략).') from None
    if result.returncode:
        raise RuntimeError(f'{label} 실패, 종료 코드 {result.returncode}(출력 생략).')
    return result.stdout or b''


def compose(release, sha, config, https):
    env = {k: v for k, v in os.environ.items()
           if k in ('PATH', 'HOME', 'LANG')}
    # 허용된 설정만 환경으로 전달한다. Compose가 원본 .env의 다른 설정을 읽지 않게 한다.
    env.update(config)
    env.update(APP_VERSION=sha, OBS_CADDY_FILE='./Caddyfile.https' if https else './Caddyfile')
    cmd = ['docker', 'compose', '-p', 'obs-web', '--env-file', '/dev/null',
           '-f', str(release / 'deploy/docker-compose.yml')]
    return cmd, env


def check_health(cmd, env, sha):
    code = "fetch('http://127.0.0.1:3000/api/health',{signal:AbortSignal.timeout(4000)}).then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))"
    data = json.loads(run(cmd + ['exec', '-T', 'obs-web-app', 'node', '-e', code],
                          '앱 health check', env, timeout=10))
    if data.get('status') != 'ok' or data.get('db') != 'ok' or data.get('version') != sha:
        raise RuntimeError('앱 health/version/DB 검사 실패.')


def check_proxy(https, sha):
    if https:
        url = f'https://{DOMAIN}/api/health'
        resolve = ['--resolve', f'{DOMAIN}:443:127.0.0.1']
    else:
        url, resolve = 'http://127.0.0.1/api/health', []
    for _ in range(18):
        try:
            data = json.loads(run(['curl', '--noproxy', '*', '--fail', '--silent',
                                   '--show-error', '--connect-timeout', '3', '--max-time', '8',
                                   *resolve, url], '프록시/TLS 검사', timeout=12))
            if data.get('status') == 'ok' and data.get('version') == sha:
                return
        except (RuntimeError, ValueError):
            pass
        time.sleep(5)
    raise RuntimeError('프록시/TLS health 실패. 인증서 검증을 우회하지 않습니다.')


def atomic_json(path, data):
    temporary = path.with_suffix('.new')
    temporary.write_text(json.dumps(data, ensure_ascii=False) + '\n')
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def deploy(bundle, sha, https):
    migration_sha = verify_bundle(bundle, sha)
    if not ROOT.is_dir() or ROOT.is_symlink() or ROOT.stat().st_uid != os.getuid():
        raise RuntimeError('/opt/obs 소유권·경로를 먼저 준비하세요.')
    if (ROOT / 'target').read_text().strip() != 'obs-web-test':
        raise RuntimeError('배포 대상 표식이 일치하지 않습니다.')
    if (ROOT / 'machine-id').read_text().strip() != Path('/etc/machine-id').read_text().strip():
        raise RuntimeError('등록한 VM과 현재 VM이 다릅니다.')
    config = read_config(ROOT)
    previous = json.loads((ROOT / 'current.json').read_text()) if (ROOT / 'current.json').exists() else None
    if previous and previous.get('https') and not https:
        raise RuntimeError('기존 HTTPS를 HTTP로 자동 하향할 수 없습니다.')
    if https:
        check_dns()  # 서비스·DB 변경 또는 인증서 발급 전에 검사한다.
    if shutil.disk_usage(ROOT).free < 6 * 1024**3:
        raise RuntimeError('여유 디스크가 6GiB 미만입니다. 자동 삭제하지 않습니다.')
    releases, backups = ROOT / 'releases', ROOT / 'backups'
    releases.mkdir(mode=0o700, exist_ok=True)
    backups.mkdir(mode=0o700, exist_ok=True)
    release = releases / sha
    if release.exists():
        # 같은 SHA 재시도는 기존 파일을 덮어쓰지 않고 비교한다.
        for path in (bundle / 'src').rglob('*'):
            if path.is_file() and (not (release / path.relative_to(bundle / 'src')).is_file()
                                   or digest(path) != digest(release / path.relative_to(bundle / 'src'))):
                raise RuntimeError('기존 릴리스 내용이 다릅니다. 덮어쓰지 않습니다.')
    else:
        staging = Path(tempfile.mkdtemp(prefix='.incoming-', dir=releases))
        shutil.copytree(bundle / 'src', staging, dirs_exist_ok=True)
        os.replace(staging, release)
    cmd, env = compose(release, sha, config, https)
    run(cmd + ['config', '--quiet'], 'Compose 설정 검증', env)
    run(['docker', 'load', '-i', str(bundle / 'images.tar')], '이미지 로드', timeout=600)
    for image in (f'obs-web-app:{sha}', f'obs-web-migrate:{sha}'):
        run(['docker', 'image', 'inspect', image], '이미지 존재 확인')
    run(cmd + ['run', '--rm', '--no-deps', 'obs-web-proxy', 'caddy', 'validate',
               '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], 'Caddy 구성 검증', env)
    run(cmd + ['up', '-d', '--wait', '--wait-timeout', '120', 'obs-web-db'], 'DB 기동', env)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = backups / f'{stamp}-{sha[:12]}.dump'
    with backup.open('xb') as output:
        run(cmd + ['exec', '-T', 'obs-web-db', 'sh', '-c',
                   'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'], '배포 전 DB 백업', env, stdout=output)
    if backup.stat().st_size == 0:
        raise RuntimeError('백업이 비어 있습니다. 마이그레이션하지 않습니다.')
    with backup.open('rb') as source:
        run(cmd + ['exec', '-T', 'obs-web-db', 'pg_restore', '--list'], '백업 구조 검증', env, stdin=source)
    changed = not previous or previous.get('migrations') != migration_sha
    try:
        run(cmd + ['stop', 'obs-web-app'], '마이그레이션 전 앱 정지', env)
        run(cmd + ['run', '--rm', '--no-deps', '-T', '--pull', 'never', 'obs-web-migrate'], 'DB 마이그레이션', env)
        for service in ('obs-web-app', 'obs-web-proxy'):
            run(cmd + ['up', '-d', '--no-build', '--pull', 'never', '--no-deps', '--wait',
                       '--wait-timeout', '180', service], f'{service} 기동', env)
        check_health(cmd, env, sha)
        check_proxy(https, sha)
    except Exception:
        if previous and not changed:
            old_cmd, old_env = compose(releases / previous['sha'], previous['sha'], config, previous['https'])
            run(old_cmd + ['up', '-d', '--no-build', '--pull', 'never', '--no-deps', '--wait',
                           '--wait-timeout', '180', 'obs-web-app', 'obs-web-proxy'], '이전 앱 릴리스 복구', old_env)
            check_health(old_cmd, old_env, previous['sha'])
            print('이전 앱 릴리스 복구 완료. 이번 배포는 실패입니다.')
        else:
            # DB 구조가 바뀌었으면 데이터 손실 우려가 있는 자동 pg_restore를 하지 않는다.
            run(cmd + ['stop', 'obs-web-app'], '안전한 앱 정지', env)
            print('자동 DB 복구는 하지 않았습니다. 백업·마이그레이션 점검이 필요합니다.')
        raise
    if previous:
        atomic_json(ROOT / 'previous.json', previous)
    atomic_json(ROOT / 'current.json', {'sha': sha, 'https': https, 'migrations': migration_sha, 'at': stamp})
    with (ROOT / 'deploy-history.log').open('a') as history:
        history.write(f'{stamp} target=obs-web-test sha={sha} https={https} health=ok\n')
    print(f'obs-web-test deployed: {sha}; DB/app/proxy verified; https={https}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--https', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        # 파일 잠금은 수동 배포와 Actions 사이의 동시 실행도 막는다.
        with (ROOT / '.deploy.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            deploy(args.bundle.resolve(), args.sha, args.https)
    except Exception as exc:
        # 검증된 자체 오류 외 예외에는 경로·URL·자격정보가 포함될 수 있다.
        print(str(exc) if isinstance(exc, RuntimeError) else '배포 중단: 서버 전제조건 또는 처리 실패.', file=sys.stderr)
        sys.exit(1)
