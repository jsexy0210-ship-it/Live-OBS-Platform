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
# 배포 진행 표시. 감시 수집기(/data = OBS_MONITOR_DIR)가 이 파일이 있는 동안 버전 불일치 경고를 미룬다.
DEPLOY_MARK="${OBS_DEPLOY_MARK:-${OBS_MONITOR_DIR:-/opt/obs/monitor}/deploy-in-progress}"
export OBS_ENV_FILE="$ENV_FILE"

kst() { TZ=Asia/Seoul date "$@"; }
log() { printf '%s %s\n' "$(kst '+%F %T KST')" "$*"; }
die() { log "중단: $*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "$ENV_FILE 이 없어요(docs/DEPLOY.md 「서버 .env」)."

# 가용성 프로파일을 켜 두었으면(availability.sh on) 그 정의도 함께 쓴다.
availability_on() { [ -f "$AVAIL_MARK" ]; }
# compose 명령줄을 COMPOSE_ARGV에 만든다(백그라운드로 직접 실행해야 하는 곳에서 함수 대신 쓴다).
compose_argv() {
  COMPOSE_ARGV=(docker compose -p obs-web -f "$OPS_ROOT/deploy/docker-compose.yml")
  if availability_on; then COMPOSE_ARGV+=(-f "$OPS_ROOT/deploy/compose.availability.yml"); fi
  # 로컬 시험 전용 덧붙임 파일(서버에서는 쓰지 않음)
  if [ -n "${OBS_COMPOSE_EXTRA:-}" ]; then COMPOSE_ARGV+=(-f "$OBS_COMPOSE_EXTRA"); fi
  COMPOSE_ARGV+=(--env-file "$ENV_FILE")
}
compose() {
  compose_argv
  "${COMPOSE_ARGV[@]}" "$@"
}

container_of() { docker ps -aq --filter label=com.docker.compose.project=obs-web --filter "label=com.docker.compose.service=$1" | head -n1; }
db_container() { container_of obs-web-db; }
app_services() { if availability_on; then echo "obs-web-app obs-web-app-2"; else echo "obs-web-app"; fi; }

# 지금 떠 있는 앱 이미지의 커밋 SHA. compose가 없는 local 태그를 빌드하려 들지 않게 APP_VERSION으로 쓴다.
current_version() { docker ps -a --filter label=com.docker.compose.project=obs-web --filter label=com.docker.compose.service=obs-web-app --format '{{.Image}}' | head -n1 | cut -s -d: -f2; }
export APP_VERSION="${APP_VERSION:-$(current_version)}"

health() { curl -fsS --max-time 5 "$HEALTH_URL"; }
# version이 비어 있으면 db ok만 본다. 성공하면 응답을 출력한다.
# 서비스마다 컨테이너 healthcheck가 healthy가 될 때까지 기다린다(프록시 health는 앱 하나만 살아도 통과하므로 따로 본다).
wait_services_healthy() {
  local s c st="" i
  for s in "$@"; do
    for i in $(seq 1 60); do
      c="$(container_of "$s")"
      st="$( [ -n "$c" ] && docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || echo missing)"
      [ "$st" = healthy ] && break
      sleep 2
    done
    [ "$st" = healthy ] || { echo "$s 상태: $st" >&2; return 1; }
  done
}
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

# 배포(앱 교체) 동안 표시를 두고, 끝나거나 실패·중단되면 지운다.
mark_deploying() {
  mkdir -p "$(dirname "$DEPLOY_MARK")" && echo "$(kst '+%F %T KST') $1 pid=$$" > "$DEPLOY_MARK"
  trap 'rm -f "$DEPLOY_MARK"' EXIT
}
# 감시 수집기가 떠 있으면 지금 compose 정의(가용성 여부 포함)로 다시 만든다(감시 대상이 앱 수에 맞게 바뀜).
refresh_monitor() {
  if [ -n "$(docker ps -q --filter label=com.docker.compose.project=obs-web --filter label=com.docker.compose.service=obs-web-monitor)" ]; then
    compose --profile monitor up -d --no-build --no-deps --force-recreate obs-web-monitor >/dev/null
    log "감시 수집기를 다시 만들었어요(감시 대상: $(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(container_of obs-web-monitor)" | grep '^MONITOR_TARGETS=' | cut -d= -f2- | tr ',' '\n' | cut -d= -f1 | paste -sd, -))"
  fi
}

db_name() { docker exec "$1" printenv POSTGRES_DB; }

# 장애 주입처럼 테스트 서버에서만 허용할 동작. .env에 OBS_ENVIRONMENT=test 가 있어야 한다.
require_test_env() {
  grep -qx 'OBS_ENVIRONMENT=test' "$ENV_FILE" || die "테스트 서버 표시(OBS_ENVIRONMENT=test)가 .env에 없어서 멈춰요. 운영 서버에서는 실행하지 않아요."
}
