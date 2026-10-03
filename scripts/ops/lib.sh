#!/usr/bin/env bash
# scripts/ops 공통. 서버(obs-web-test)에서 obs 계정(docker 그룹)으로 실행한다. 절차: docs/DEPLOY.md 「운영 스크립트」.
# 비밀값(.env 내용, 접속 문자열)은 출력하지 않는다.
set -euo pipefail

OPS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${OBS_ENV_FILE:-/opt/obs/.env}"
BACKUP_DIR="${OBS_BACKUP_DIR:-/opt/obs/backups}"
CHECK_DIR="${OBS_CHECK_DIR:-/opt/obs/checks}"
HISTORY="${OBS_HISTORY:-/opt/obs/deploy-history.log}"
HEALTH_URL="${OBS_HEALTH_URL:-http://127.0.0.1/api/health}"
AVAIL_MARK="${OBS_AVAIL_MARK:-/opt/obs/availability.on}"
export OBS_ENV_FILE="$ENV_FILE"

kst() { TZ=Asia/Seoul date "$@"; }
log() { printf '%s %s\n' "$(kst '+%F %T KST')" "$*"; }
die() { log "중단: $*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "$ENV_FILE 이 없어요(docs/DEPLOY.md 「서버 .env」)."

# 가용성 프로파일을 켜 두었으면(availability.sh on) 그 정의도 함께 쓴다.
availability_on() { [ -f "$AVAIL_MARK" ]; }
compose() {
  local files=(-f "$OPS_ROOT/deploy/docker-compose.yml")
  if availability_on; then files+=(-f "$OPS_ROOT/deploy/compose.availability.yml"); fi
  # 로컬 시험 전용 덧붙임 파일(서버에서는 쓰지 않음)
  if [ -n "${OBS_COMPOSE_EXTRA:-}" ]; then files+=(-f "$OBS_COMPOSE_EXTRA"); fi
  docker compose -p obs-web "${files[@]}" --env-file "$ENV_FILE" "$@"
}

container_of() { docker ps -aq --filter label=com.docker.compose.project=obs-web --filter "label=com.docker.compose.service=$1" | head -n1; }
db_container() { container_of obs-web-db; }
app_services() { if availability_on; then echo "obs-web-app obs-web-app-2"; else echo "obs-web-app"; fi; }

# 지금 떠 있는 앱 이미지의 커밋 SHA. compose가 없는 local 태그를 빌드하려 들지 않게 APP_VERSION으로 쓴다.
current_version() { docker ps -a --filter label=com.docker.compose.project=obs-web --filter label=com.docker.compose.service=obs-web-app --format '{{.Image}}' | head -n1 | cut -s -d: -f2; }
export APP_VERSION="${APP_VERSION:-$(current_version)}"

health() { curl -fsS --max-time 5 "$HEALTH_URL"; }
# version이 비어 있으면 db ok만 본다. 성공하면 응답을 출력한다.
wait_health() {
  local want="${1:-}" tries="${2:-30}" body="" i
  for i in $(seq 1 "$tries"); do
    body="$(health 2>/dev/null || true)"
    if grep -q '"db":"ok"' <<<"$body" && { [ -z "$want" ] || grep -q "\"version\":\"$want\"" <<<"$body"; }; then
      echo "$body"; return 0
    fi
    sleep 2
  done
  echo "health 실패: ${body:-응답 없음}" >&2
  return 1
}

db_name() { docker exec "$1" printenv POSTGRES_DB; }

# 장애 주입처럼 테스트 서버에서만 허용할 동작. .env에 OBS_ENVIRONMENT=test 가 있어야 한다.
require_test_env() {
  grep -qx 'OBS_ENVIRONMENT=test' "$ENV_FILE" || die "테스트 서버 표시(OBS_ENVIRONMENT=test)가 .env에 없어서 멈춰요. 운영 서버에서는 실행하지 않아요."
}
