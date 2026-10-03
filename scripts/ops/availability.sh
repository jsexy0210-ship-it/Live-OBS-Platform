#!/usr/bin/env bash
# 테스트 환경 가용성 프로파일(앱 2개 + health 기반 프록시 + 자원 제한) 켜기·끄기. 테스트 서버 전용.
# 사용: scripts/ops/availability.sh on|off|status
# - on : 지금 버전 그대로 obs-web-app-2를 더하고 프록시를 Caddyfile.availability로 바꾼다(빌드 없음).
# - off: 기본 정의로 돌아간다(obs-web-app-2 제거, 프록시 기본 Caddyfile).
# 배포 워크플로(Deploy obs-test)는 기본 정의만 쓴다. 실행하기 전에 off로 돌려 두거나, 배포 뒤 on을 다시 실행한다.
. "$(dirname "$0")/lib.sh"

# 전환(compose up)은 새 프로세스 그룹(setsid)으로 백그라운드 실행하고 wait로 기다린다. 그래야 SIGTERM·SIGHUP·SIGINT를
# 받았을 때 trap이 바로 실행되고, docker CLI와 compose 플러그인을 그룹째 끝낸 뒤 되돌리기를 시작할 수 있다.
# 전환이 끝나면 trap을 해제한다.
CHILD=""
run_compose() {
  compose_argv
  setsid "${COMPOSE_ARGV[@]}" "$@" &
  CHILD=$!
  local rc=0
  wait "$CHILD" || rc=$?
  CHILD=""
  return "$rc"
}
# 그룹 전체에 TERM → 최대 30초 기다림 → 남으면 KILL. 끝날 때까지 기다려 되돌리기와 겹치지 않게 한다.
stop_child_group() {
  local i killer
  kill -TERM -- "-$CHILD" 2>/dev/null || true
  (sleep 30; kill -KILL -- "-$CHILD" 2>/dev/null) &
  killer=$!
  wait "$CHILD" 2>/dev/null || true
  # 그룹장(docker CLI)이 끝난 뒤에도 남은 플러그인 프로세스가 끝날 때까지 기다린다.
  for i in $(seq 1 150); do
    kill -0 -- "-$CHILD" 2>/dev/null || break
    sleep 0.2
  done
  kill -KILL -- "-$CHILD" 2>/dev/null || true
  kill "$killer" 2>/dev/null || true
  CHILD=""
}
guard() {
  ROLLBACK="$1"
  trap interrupted TERM HUP INT
}
unguard() { trap - TERM HUP INT; }
interrupted() {
  unguard
  if [ -n "$CHILD" ]; then stop_child_group; fi
  "$ROLLBACK" "중단 신호를 받아 멈췄어요"
}
# 켜기 실패·중단 → 기본 정의(앱 1개)로 되돌린다.
rollback_on() {
  unguard
  rm -f "$AVAIL_MARK"
  if compose up -d --no-build --wait --remove-orphans; then
    refresh_monitor
    die "켜기 실패($1). 기본 구성(앱 1개)으로 되돌렸어요. 원인을 확인한 뒤 다시 on해 주세요."
  fi
  die "켜기 실패($1), 되돌리기도 실패했어요. 구성이 불확실해요, availability.sh status로 확인해 주세요."
}
# 끄기 실패·중단 → 가용성 정의(앱 2개)로 되돌린다. 표시만 되돌리면 실제 구성과 어긋날 수 있다.
rollback_off() {
  unguard
  touch "$AVAIL_MARK"
  if compose up -d --no-build --wait; then
    refresh_monitor
    die "끄기 실패($1). 앱 2개 구성으로 되돌렸어요. 원인을 확인한 뒤 다시 off해 주세요."
  fi
  rm -f "$AVAIL_MARK"
  die "끄기 실패($1), 되돌리기도 실패했어요. 구성이 불확실해요, availability.sh status로 확인해 주세요."
}

case "${1:-status}" in
  on)
    require_test_env
    # 이미 켜져 있으면 아무것도 바꾸지 않는다(되돌리기가 시작 때와 다른 상태로 가지 않게).
    if availability_on; then log "이미 켜져 있어요(실제 구성은 availability.sh status로 확인)."; exit 0; fi
    [ -n "$APP_VERSION" ] || die "떠 있는 앱 버전을 찾지 못했어요. 먼저 배포해 주세요."
    # 표시 파일은 compose가 가용성 정의를 읽게 하는 스위치다.
    guard rollback_on
    touch "$AVAIL_MARK"
    run_compose up -d --no-build --wait || rollback_on "compose 실패"
    unguard
    refresh_monitor
    log "가용성 프로파일 켜짐: $(app_services), version=$APP_VERSION"
    ;;
  off)
    require_test_env
    if ! availability_on; then log "이미 꺼져 있어요(실제 구성은 availability.sh status로 확인)."; exit 0; fi
    guard rollback_off
    rm -f "$AVAIL_MARK"
    run_compose up -d --no-build --wait --remove-orphans || rollback_off "compose 실패"
    unguard
    refresh_monitor
    log "가용성 프로파일 꺼짐: 기본 정의(obs-web-app 1개)"
    ;;
  status)
    if availability_on; then echo "가용성 프로파일: 켜짐"; else echo "가용성 프로파일: 꺼짐"; fi
    compose ps --format 'table {{.Service}}\t{{.Status}}'
    ;;
  *) die "사용법: availability.sh on|off|status" ;;
esac
