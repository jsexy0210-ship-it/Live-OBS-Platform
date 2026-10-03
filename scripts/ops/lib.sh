#!/usr/bin/env bash
# scripts/ops 공통. 서버(obs-web-test)에서 obs 계정(docker 그룹)으로 실행한다. 절차: docs/DEPLOY.md 「운영 스크립트」.
# 비밀값(.env 내용, 접속 문자열)은 출력하지 않는다.
set -euo pipefail

OPS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${OBS_ENV_FILE:-/opt/obs/.env}"
BACKUP_DIR="${OBS_BACKUP_DIR:-/opt/obs/backups}"
CHECK_DIR="${OBS_CHECK_DIR:-/opt/obs/checks}"
HEALTH_URL="${OBS_HEALTH_URL:-http://127.0.0.1/api/health}"
AVAIL_MARK="${OBS_AVAIL_MARK:-/opt/obs/availability.on}"
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

# 감시 폴더·배포 기록 파일은 compose가 감시 서비스에 실제로 마운트하는 원본 경로를 그대로 쓴다.
# (.env 해석—따옴표·주석·공백·셸 값 우선—을 compose에 맡겨 스크립트와 감시 컨테이너가 같은 파일을 보게 한다.)
compose_monitor_mounts() {
  # JSON으로 읽는다(YAML 출력은 긴 경로를 공백에서 줄바꿈해 잘림). jq 없이 줄 단위로 읽고 JSON 이스케이프를 푼다.
  compose --profile monitor config --format json obs-web-monitor 2>/dev/null | awk '
    function str(line) {
      sub(/^[^:]*:[ ]*"/, "", line); sub(/",?[ ]*$/, "", line)
      gsub(/\\u0026/, "\\&", line); gsub(/\\u003c/, "<", line); gsub(/\\u003e/, ">", line)
      gsub(/\\"/, "\"", line); gsub(/\\\\/, "\\", line)
      return line
    }
    /^[ ]*"source": "/ { src = str($0) }
    /^[ ]*"target": "/ { t = str($0); if (t == "/data") print "data=" src; else if (t == "/deploy-history.log") print "hist=" src }'
}
if [ -z "${OBS_DEPLOY_MARK:-}" ] || [ -z "${OBS_HISTORY:-}" ]; then
  _mounts="$(compose_monitor_mounts || true)"
  _data="$(sed -n 's/^data=//p' <<<"$_mounts")"; _hist="$(sed -n 's/^hist=//p' <<<"$_mounts")"
  [ -n "${OBS_DEPLOY_MARK:-}" ] || case "$_data" in /*) ;; *) die "compose 설정에서 감시 폴더(/data 마운트)를 찾지 못했어요(docker compose config 확인)." ;; esac
  [ -n "${OBS_HISTORY:-}" ] || case "$_hist" in /*) ;; *) die "compose 설정에서 배포 기록 파일(/deploy-history.log 마운트)을 찾지 못했어요." ;; esac
fi
# 배포 진행 표시. 감시 수집기(/data)가 이 파일이 있는 동안 장애·버전 불일치 판단을 미룬다.
DEPLOY_MARK="${OBS_DEPLOY_MARK:-${_data:-}/deploy-in-progress}"
# 배포 기록. 감시 수집기가 읽는 파일과 같다. OBS_HISTORY는 로컬 시험용 덮어쓰기.
HISTORY="${OBS_HISTORY:-${_hist:-}}"

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
deploy_mark_set() { mkdir -p "$(dirname "$DEPLOY_MARK")" && echo "$(kst '+%F %T KST') $1 pid=$$" > "$DEPLOY_MARK"; }
deploy_mark_clear() { rm -f "$DEPLOY_MARK"; }
# 이 스크립트가 끝날 때(실패 포함) 표시를 지운다. 여러 단계에 걸친 배포(워크플로)는 deploy-mark.sh on/off를 쓴다.
# 15분이 넘게 걸리는 작업(복원 등)에서도 오래된 표시로 무시되지 않게, 도는 동안 표시 시각을 주기적으로 갱신한다.
# 스크립트가 SIGKILL 등으로 죽으면 갱신도 멈춰(다음 주기에 부모가 없음을 확인) 표시가 15분 뒤 오래된 것으로 처리된다.
# 갱신은 최대 OBS_DEPLOY_MARK_MAX_S(기본 1시간)까지만 한다. 스크립트가 멈춰 끝나지 않아도 그 뒤 15분이 지나면
# 표시가 오래된 것으로 처리돼 감시가 다시 장애를 판단한다(스크립트는 죽이지 않고 로그만 남긴다).
# TERM·INT·HUP로 끝날 때도 EXIT trap이 돌게 한다(기본 동작으로 죽으면 EXIT trap이 돌지 않아 표시가 15분 남음).
exit_on_signals() { trap 'exit 143' TERM; trap 'exit 130' INT; trap 'exit 129' HUP; }
mark_deploying() {
  # 순서: 설정 검사 → 정리 trap 설치 → 표시 생성 → 갱신 시작. 표시를 만든 뒤에 실패해 표시만 남는 일이 없게 한다.
  local every="${OBS_DEPLOY_MARK_REFRESH_S:-60}" max="${OBS_DEPLOY_MARK_MAX_S:-3600}" parent=$$
  [[ "$every" =~ ^[1-9][0-9]*$ && "$max" =~ ^[1-9][0-9]*$ ]] || die "OBS_DEPLOY_MARK_REFRESH_S·OBS_DEPLOY_MARK_MAX_S는 1 이상 정수여야 해요."
  DEPLOY_MARK_KEEPER=""
  # 갱신 루프와 그 안의 sleep까지 끝낸 뒤 표시를 지운다.
  # (set -e 아래에서 trap이 돌므로, 이미 끝난 프로세스를 kill하다 실패해도 표시 삭제까지 가도록 || true를 붙인다.)
  # 루프의 자식(sleep)을 먼저 적어 두고 루프 → 자식 순으로 끝낸다(루프를 먼저 죽이면 sleep이 고아로 남음).
  # 루프가 먼저 끝났으면(상한·부모 확인) 그 PID를 다른 프로세스가 다시 쓸 수 있으므로, 아직 이 셸의 자식인지 확인한 뒤에만 신호를 보낸다.
  trap 'if [ -n "$DEPLOY_MARK_KEEPER" ] && [ "$(ps -o ppid= -p "$DEPLOY_MARK_KEEPER" 2>/dev/null | tr -d " ")" = "$$" ]; then _kids="$(pgrep -P "$DEPLOY_MARK_KEEPER" || true)"; kill "$DEPLOY_MARK_KEEPER" 2>/dev/null || true; [ -z "$_kids" ] || kill $_kids 2>/dev/null || true; fi; DEPLOY_MARK_KEEPER=""; deploy_mark_clear' EXIT
  exit_on_signals
  deploy_mark_set "$1"
  (
    start=$SECONDS
    while sleep "$every"; do
      kill -0 "$parent" 2>/dev/null || exit 0
      if [ $((SECONDS - start)) -ge "$max" ]; then
        log "배포 표시 갱신을 멈췄어요(${max}초 상한). 작업이 아직 안 끝났다면 확인해 주세요. 15분 뒤 감시가 다시 장애를 판단해요." >&2
        exit 0
      fi
      [ -e "$DEPLOY_MARK" ] && touch "$DEPLOY_MARK"
    done
  ) </dev/null >/dev/null &
  DEPLOY_MARK_KEEPER=$!
}
# 감시 수집기가 떠 있으면 지금 compose 정의(가용성 여부 포함)로 다시 만든다(감시 대상이 앱 수에 맞게 바뀜).
# 컨테이너가 있으면(멈춤·생성만 됨 포함) 다시 만든다: 지난 새로 고침이 중간에 실패해 컨테이너가 멈춰 있어도 다시 실행하면 복구된다.
# 감시를 끄려면 컨테이너를 지운다(compose --profile monitor rm -sf obs-web-monitor). 실패하면 0이 아닌 코드로 끝난다.
refresh_monitor() {
  if [ -n "$(docker ps -aq --filter label=com.docker.compose.project=obs-web --filter label=com.docker.compose.service=obs-web-monitor)" ]; then
    # --wait: 감시 healthcheck(heartbeat)가 healthy가 될 때까지 기다린다. 설정 오류 등으로 시작 직후 죽으면
    # (재시작을 반복하면) 실패로 끝난다. healthcheck 첫 검사가 30초 뒤라 보통 30초쯤 걸린다.
    compose --profile monitor up -d --no-build --no-deps --force-recreate --wait --wait-timeout 90 obs-web-monitor >/dev/null \
      || die "감시 수집기를 다시 만들지 못했어요. 같은 명령을 다시 실행해 주세요(구성 전환은 끝났어요)."
    log "감시 수집기를 다시 만들었어요(감시 대상: $(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(container_of obs-web-monitor)" | grep '^MONITOR_TARGETS=' | cut -d= -f2- | tr ',' '\n' | cut -d= -f1 | paste -sd, -))"
  fi
}

db_name() { docker exec "$1" printenv POSTGRES_DB; }

# 장애 주입처럼 테스트 서버에서만 허용할 동작. .env에 OBS_ENVIRONMENT=test 가 있어야 한다.
require_test_env() {
  grep -qx 'OBS_ENVIRONMENT=test' "$ENV_FILE" || die "테스트 서버 표시(OBS_ENVIRONMENT=test)가 .env에 없어서 멈춰요. 운영 서버에서는 실행하지 않아요."
}
