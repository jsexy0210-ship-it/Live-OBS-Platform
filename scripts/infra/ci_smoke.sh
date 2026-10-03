#!/usr/bin/env bash
# GitHub 호스팅 러너의 폐기용 컨테이너에서만 실행한다. 실제 VM에서는 금지.
set +x
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] || {
  echo 'CI smoke must run on a disposable GitHub-hosted runner.' >&2; exit 1;
}
[[ "${APP_VERSION:-}" =~ ^[0-9a-f]{40}$ ]] || exit 1
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
umask 077
WORK=$(mktemp -d)
python3 - "$WORK/env" <<'PY'
from pathlib import Path
import secrets, sys
Path(sys.argv[1]).write_text('POSTGRES_USER=obs_ci\nPOSTGRES_DB=obs_ci\n' + ''.join(
    k + '=' + secrets.token_hex(32) + '\n'
    for k in ('POSTGRES_PASSWORD', 'IDENTITY_HASH_KEY', 'BILLING_KEY_SECRET')))
for line in Path(sys.argv[1]).read_text().splitlines():
    if line.startswith(('POSTGRES_PASSWORD=', 'IDENTITY_HASH_KEY=', 'BILLING_KEY_SECRET=')):
        print('::add-mask::' + line.split('=', 1)[1])
PY
export OBS_CADDY_FILE=./Caddyfile
C=(docker compose -p obs-ci -f deploy/docker-compose.yml --env-file "$WORK/env")
cleanup() {
  # 이 CI가 만든 obs-ci 컨테이너와 볼륨만 정리한다.
  "${C[@]}" down --volumes >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
"${C[@]}" config --quiet
docker build --target runner --build-arg "APP_VERSION=$APP_VERSION" -t "obs-web-app:$APP_VERSION" .
docker build --target migrator -t "obs-web-migrate:$APP_VERSION" .
"${C[@]}" run --rm --no-deps obs-web-proxy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
# HTTPS 파일도 문법/구성만 검증한다. 서버를 시작하거나 인증서를 신청하지 않는다.
docker run --rm -v "$ROOT/deploy/Caddyfile.https:/etc/caddy/Caddyfile:ro" caddy:2 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
"${C[@]}" up -d --wait --wait-timeout 120 obs-web-db
if ! "${C[@]}" run --rm --no-deps -T --pull never obs-web-migrate > "$WORK/migrate.log" 2>&1; then
  echo 'Disposable migration failed (output withheld).' >&2; exit 1
fi
"${C[@]}" up -d --no-build --no-deps --wait --wait-timeout 180 obs-web-app obs-web-proxy
curl --fail --silent --max-time 10 http://127.0.0.1/api/health > "$WORK/health.json"
python3 - "$WORK/health.json" <<'PY'
import json, os, sys
j=json.load(open(sys.argv[1])); assert j['status']=='ok' and j['db']=='ok' and j['version']==os.environ['APP_VERSION']
PY
# HTTP는 생존 확인만 제공하고 로그인/결제 화면은 열지 않는다.
[[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/)" == 503 ]]
for blocked_host in www.on-aircue.com attacker.test; do
  [[ "$(curl -s --max-time 10 -H "Host: $blocked_host" -o /dev/null -w '%{http_code}' http://127.0.0.1/api/health)" == 421 ]]
done
# App-level host enforcement, independently of Caddy (the app port is not public).
"${C[@]}" exec -T obs-web-app node -e "fetch('http://127.0.0.1:3000/seller/login',{headers:{host:'attacker.test','x-forwarded-host':'on-aircue.com'}}).then(r=>process.exit(r.status===421?0:1)).catch(()=>process.exit(1))"
"${C[@]}" exec -T obs-web-app node -e "fetch('http://127.0.0.1:3000/api/live',{headers:{host:'on-aircue.com'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
[[ -z "$("${C[@]}" port obs-web-db 5432 2>/dev/null || true)" ]]
[[ -z "$("${C[@]}" port obs-web-app 3000 2>/dev/null || true)" ]]
"${C[@]}" stop obs-web-db
[[ "$(curl -s --max-time 12 -o "$WORK/not-ready.json" -w '%{http_code}' http://127.0.0.1/api/health)" == 503 ]]
curl --fail --silent --max-time 10 http://127.0.0.1/api/live > /dev/null
"${C[@]}" up -d --wait obs-web-db
for i in {1..12}; do
  curl -fs --max-time 5 http://127.0.0.1/api/health > /dev/null && break
  sleep 2
done
curl -fs --max-time 5 http://127.0.0.1/api/health > /dev/null
# 영속성·백업·복원 검증은 이 테스트 DB에만 수행한다.
SQL='psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
"${C[@]}" exec -T obs-web-db sh -c "$SQL" <<'SQL'
CREATE TABLE obs_deploy_probe (id integer PRIMARY KEY);
INSERT INTO obs_deploy_probe VALUES (1);
SQL
"${C[@]}" exec -T obs-web-db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$WORK/backup.dump"
"${C[@]}" restart obs-web-db
"${C[@]}" up -d --wait obs-web-db
[[ "$("${C[@]}" exec -T obs-web-db sh -c "$SQL -tAc 'SELECT count(*) FROM obs_deploy_probe'")" == 1 ]]
"${C[@]}" exec -T obs-web-db sh -c "$SQL -c 'INSERT INTO obs_deploy_probe VALUES (2)'"
"${C[@]}" stop obs-web-app
"${C[@]}" exec -T obs-web-db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --exit-on-error' < "$WORK/backup.dump"
[[ "$("${C[@]}" exec -T obs-web-db sh -c "$SQL -tAc 'SELECT count(*) FROM obs_deploy_probe'")" == 1 ]]
echo 'Docker build, migration, readiness, liveness, port isolation, persistence and restore checks passed.'
