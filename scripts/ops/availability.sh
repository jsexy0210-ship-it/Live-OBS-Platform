#!/usr/bin/env bash
# 테스트 환경 가용성 프로파일(앱 2개 + health 기반 프록시 + 자원 제한) 켜기·끄기. 테스트 서버 전용.
# 사용: scripts/ops/availability.sh on|off|status
# - on : 지금 버전 그대로 obs-web-app-2를 더하고 프록시를 Caddyfile.availability로 바꾼다(빌드 없음).
# - off: 기본 정의로 돌아간다(obs-web-app-2 제거, 프록시 기본 Caddyfile).
# 배포 워크플로(Deploy obs-test)는 기본 정의만 쓴다. 실행하기 전에 off로 돌려 두거나, 배포 뒤 on을 다시 실행한다.
. "$(dirname "$0")/lib.sh"

case "${1:-status}" in
  on)
    require_test_env
    [ -n "$APP_VERSION" ] || die "떠 있는 앱 버전을 찾지 못했어요. 먼저 배포해 주세요."
    # 표시 파일은 compose가 가용성 정의를 읽게 하는 스위치다. 실패하면 지우고 기본 정의로 되돌려 「켜짐」으로 남지 않게 한다.
    touch "$AVAIL_MARK"
    if ! compose up -d --no-build --wait; then
      rm -f "$AVAIL_MARK"
      compose up -d --no-build --wait --remove-orphans || true
      die "켜기 실패. 표시를 지우고 기본 정의로 되돌렸어요(availability.sh status로 확인)."
    fi
    log "가용성 프로파일 켜짐: $(app_services), version=$APP_VERSION"
    ;;
  off)
    rm -f "$AVAIL_MARK"
    if ! compose up -d --no-build --wait --remove-orphans; then
      touch "$AVAIL_MARK"
      die "끄기 실패. 앱 2개 정의가 남아 있을 수 있어 표시를 되돌렸어요(availability.sh status로 확인 후 다시 off)."
    fi
    log "가용성 프로파일 꺼짐: 기본 정의(obs-web-app 1개)"
    ;;
  status)
    if availability_on; then echo "가용성 프로파일: 켜짐"; else echo "가용성 프로파일: 꺼짐"; fi
    compose ps --format 'table {{.Service}}\t{{.Status}}'
    ;;
  *) die "사용법: availability.sh on|off|status" ;;
esac
