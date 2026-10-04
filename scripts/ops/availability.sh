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
# 가드를 풀면 mark_deploying의 신호 처리(종료 → EXIT trap으로 배포 표시 삭제)로 돌아간다.
unguard() { exit_on_signals; }
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

# 실제 구성이 표시와 맞는지 확인한다: 프록시(Caddy)가 실제로 가리키는 앱과 app2 컨테이너·이미지.
# (배포 워크플로처럼 기본 정의만으로 up하면 표시는 켜짐인데 프록시가 앱 1개만 가리키거나 app2가 옛 이미지로 남을 수 있다.)
verify_profile() {
  local want="$1" proxy dials app_img app2 app2_img
  proxy="$(container_of obs-web-proxy)"; [ -n "$proxy" ] || die "프록시 컨테이너가 없어요."
  dials="$(docker exec "$proxy" wget -qO- http://localhost:2019/config/apps/http/servers 2>/dev/null | grep -o '"dial":"[^"]*"' | sed 's/"dial"://;s/"//g' | sort -u | paste -sd, - || true)"
  [ -n "$dials" ] || die "프록시 설정을 읽지 못했어요(Caddy 관리 API). availability.sh status로 확인해 주세요."
  app2="$(docker ps -q --filter label=com.docker.compose.project=obs-web --filter label=com.docker.compose.service=obs-web-app-2)"
  if [ "$want" = on ]; then
    case ",$dials," in *,obs-web-app:3000,*) ;; *) die "프록시가 obs-web-app을 가리키지 않아요(지금: $dials)." ;; esac
    case ",$dials," in *,obs-web-app-2:3000,*) ;; *) die "프록시가 앱 2개를 가리키지 않아요(지금: $dials). 같은 명령을 다시 실행해 주세요." ;; esac
    [ -n "$app2" ] || die "obs-web-app-2가 떠 있지 않아요."
    app_img="$(docker inspect -f '{{.Config.Image}}' "$(container_of obs-web-app)")"; app2_img="$(docker inspect -f '{{.Config.Image}}' "$app2")"
    [ "$app_img" = "$app2_img" ] || die "app2 이미지($app2_img)가 app($app_img)과 달라요. 같은 명령을 다시 실행해 주세요."
  else
    case ",$dials," in *,obs-web-app-2:3000,*) die "프록시가 아직 app2를 가리켜요(지금: $dials). 같은 명령을 다시 실행해 주세요." ;; esac
    [ -z "$app2" ] || die "obs-web-app-2가 아직 떠 있어요. 같은 명령을 다시 실행해 주세요."
  fi
}
# 이미 요청한 상태에서 실패·중단: 표시는 그대로 두고 멈춘다. 다음 실행이 같은 정의를 다시 적용하고 확인 단계에서 바로잡는다.
abort_reapply() {
  unguard
  die "구성을 다시 맞추지 못했어요($1). availability.sh status로 확인한 뒤 같은 명령을 다시 실행해 주세요."
}
# 표시에 맞는 정의를 적용한다. 전환과 같은 상태 재적용이 함께 쓴다: 배포 표시 → 신호 가드 → setsid 그룹으로 compose → 실패·중단 시 $1 → 가드 해제 → 확인 → 감시 새로 고침.
# 앱·프록시를 다시 만드는 동안 감시가 장애를 열지 않게 배포 표시를 두고, 성공·실패·중단 어느 쪽으로 끝나도 스크립트 종료 때(EXIT trap) 지운다.
apply_profile() {
  local on_fail="$1" want="$2"
  mark_deploying "availability $want"
  guard "$on_fail"
  if [ "$want" = on ]; then touch "$AVAIL_MARK"; else rm -f "$AVAIL_MARK"; fi
  run_compose up -d --no-build --wait --remove-orphans || "$on_fail" "compose 실패"
  unguard
  verify_profile "$want"
  refresh_monitor
}

case "${1:-status}" in
  on)
    require_test_env
    [ -n "$APP_VERSION" ] || die "떠 있는 앱 버전을 찾지 못했어요. 먼저 배포해 주세요."
    # 이미 켜져 있으면 같은 정의를 다시 적용해 실제 구성을 맞춘다. 실패·중단 때는 되돌리지 않는다(시작 때와 다른 상태로 가지 않게).
    if availability_on; then apply_profile abort_reapply on; log "이미 켜져 있어요. 실제 구성(앱 2개·프록시·감시)을 다시 맞췄어요."; exit 0; fi
    # 표시 파일은 compose가 가용성 정의를 읽게 하는 스위치다.
    apply_profile rollback_on on
    log "가용성 프로파일 켜짐: $(app_services), version=$APP_VERSION"
    ;;
  off)
    require_test_env
    [ -n "$APP_VERSION" ] || die "떠 있는 앱 버전을 찾지 못했어요. 먼저 배포해 주세요."
    if ! availability_on; then apply_profile abort_reapply off; log "이미 꺼져 있어요. 실제 구성(앱 1개·프록시·감시)을 다시 맞췄어요."; exit 0; fi
    apply_profile rollback_off off
    log "가용성 프로파일 꺼짐: 기본 정의(obs-web-app 1개)"
    ;;
  status)
    if availability_on; then echo "가용성 프로파일: 켜짐"; else echo "가용성 프로파일: 꺼짐"; fi
    compose ps --format 'table {{.Service}}\t{{.Status}}'
    ;;
  *) die "사용법: availability.sh on|off|status" ;;
esac
