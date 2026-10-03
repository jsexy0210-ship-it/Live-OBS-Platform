#!/usr/bin/env bash
# 장애 주입(테스트 서버·관리자 전용). 웹으로 노출하지 않고, 서버에서 docker 권한이 있는 사람만 실행한다.
# .env에 OBS_ENVIRONMENT=test 가 있어야 하고, 앱 장애는 가용성 프로파일(앱 2개)이 켜져 있을 때만 허용한다.
# 사용:
#   chaos.sh stop-app  [1|2] [초]   앱 하나를 멈췄다가(기본 30초) 다시 시작
#   chaos.sh kill-app  [1|2] [초]   앱 하나를 밖에서 강제 종료(SIGKILL)했다가(기본 10초) 다시 시작
#                                   (docker kill은 「사람이 멈춘 것」으로 취급돼 자동 재시작되지 않아서 스크립트가 다시 켠다)
#   chaos.sh crash-app [1|2]        앱 프로세스가 스스로 끝나게 한다 → restart 정책으로 자동 재시작, 다시 healthy까지 걸린 초를 출력
#   chaos.sh pause-app [1|2] [초]   앱 하나를 얼린다(응답 지연·멈춤 흉내)
#   chaos.sh pause-db  [초]         DB를 얼린다(DB 지연. 모든 앱이 영향을 받는 단일 장애 지점)
#   chaos.sh restart-db             DB 재시작
. "$(dirname "$0")/lib.sh"

require_test_env
action="${1:-}"; shift || true
healthy() { [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$1" 2>/dev/null)" = healthy ]; }
# 장애를 넣을 앱 컨테이너. 다른 앱이 healthy가 아니면 둘 다 내려가므로 멈춘다.
app_container() {
  local n="${1:-1}" svc=obs-web-app other=obs-web-app-2
  [ "$n" = 2 ] && { svc=obs-web-app-2; other=obs-web-app; }
  availability_on || die "앱 장애는 가용성 프로파일(앱 2개)에서만 실행해요(availability.sh on)."
  local o; o="$(container_of "$other")"
  { [ -n "$o" ] && healthy "$o"; } || die "$other 가 healthy가 아니어서 멈춰요(둘 다 내려가요). availability.sh status로 확인해 주세요."
  local c; c="$(container_of "$svc")"
  { [ -n "$c" ] && healthy "$c"; } || die "$svc 가 이미 healthy가 아니에요."
  echo "$c"
}
wait_healthy() { local c="$1" t0=$SECONDS; until healthy "$c"; do [ $((SECONDS - t0)) -gt 120 ] && die "120초 안에 healthy로 돌아오지 않았어요."; sleep 1; done; echo $((SECONDS - t0)); }
mark() { echo "$(kst '+%F %T KST') chaos $*" >> "$CHECK_DIR/chaos.log"; log "장애 주입: $*"; }
mkdir -p "$CHECK_DIR"
case "$action" in
  stop-app)  c="$(app_container "${1:-1}")"; s="${2:-30}"; mark "stop-app ${1:-1} ${s}s"; docker stop "$c" >/dev/null; sleep "$s"; docker start "$c" >/dev/null; mark "start-app ${1:-1} healthy_after=$(wait_healthy "$c")s" ;;
  kill-app)  c="$(app_container "${1:-1}")"; s="${2:-10}"; mark "kill-app ${1:-1} ${s}s"; docker kill -s KILL "$c" >/dev/null; sleep "$s"; docker start "$c" >/dev/null; mark "start-app ${1:-1} healthy_after=$(wait_healthy "$c")s" ;;
  crash-app) c="$(app_container "${1:-1}")"; mark "crash-app ${1:-1}"; docker exec "$c" sh -c 'kill -TERM 1'; sleep 1; mark "crash-app ${1:-1} healthy_after=$(wait_healthy "$c")s" ;;
  pause-app) c="$(app_container "${1:-1}")"; s="${2:-15}"; mark "pause-app ${1:-1} ${s}s"; docker pause "$c" >/dev/null; sleep "$s"; docker unpause "$c" >/dev/null; mark "unpause-app ${1:-1} healthy_after=$(wait_healthy "$c")s" ;;
  pause-db)  c="$(db_container)"; s="${1:-10}"; mark "pause-db ${s}s"; docker pause "$c" >/dev/null; sleep "$s"; docker unpause "$c" >/dev/null; mark "unpause-db" ;;
  restart-db) mark "restart-db"; docker restart "$(db_container)" >/dev/null ;;
  *) die "사용법: chaos.sh stop-app|kill-app|pause-app [1|2] [초] | crash-app [1|2] | pause-db [초] | restart-db" ;;
esac
