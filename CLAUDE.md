# CLAUDE.md

## 기준

- 기획·작업지시·검수 기준 저장소: `jsexy0210-ship-it/Live-OBS-Platform` (유일)
- 참조 전용: `jsexy0210-ship-it/obs-order-queue-cafe24-webhook` (망고TCG). 수정 금지.
- 상태 정본: `PROJECT_STATUS.md`, `HANDOFF.md`, `docs/PRODUCT_SCOPE.md`

## 작업 규칙

- `main` 직접 수정 금지. 작업 브랜치 → PR → CI 통과 후 반영.
- 이력 재작성, 강제 푸시, 기존 브랜치·태그 삭제 금지.
- 테스트 삭제·skip, 타입·린트 우회 금지.
- 검증: `npm run typecheck && npm run build`.

## 승인 필요 (운영자 명시 승인 전 실행 금지)

- 운영 배포, 배포 워크플로 추가
- 카카오클라우드 자원(VM·버킷·DNS·러너·보안그룹) 생성·변경·삭제
- 비밀정보·환경변수 변경
- 실제 결제·환불·적립금 실행
- 유료 자원 생성

## 금지

- 망고TCG 운영 코드·DB·설정 변경
- 운영 주문·회원정보·비밀정보 복사
- 비밀정보를 저장소·문서·로그에 기록
