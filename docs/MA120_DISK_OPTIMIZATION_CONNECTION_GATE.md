# MA120 실제 연결 게이트 — 2026-10-13 KST

현재 구현은 UI/API·두 범주 읽기 전용 runner·주입형 검증 계약까지이다. production bridge는 `null`이며 preview/execute는503, 실제 job 원천이 없으면404다. 자동 정리는 꺼져 있고 실제 삭제 모드는 제공하지 않는다. 단위/합성 검증이나 화면 mock 결과를 실제 서버 실행으로 판단하지 않는다.

| 경계 | 필요한 실제 대상·권한 | 최소 변경 및 승인 전 제한 |
| --- | --- | --- |
| 앱 → GitHub | ONQ 저장소에만 설치된 GitHub App의 Actions 조회/dispatch 및 contents 조회. 기존 권한·키가 있다고 가정하지 않음 | 앱 서버에 전용 자격 증명을 별도 승인 후 구성. 키·토큰 값은 저장소/로그에 남기지 않음. provider의 저장소·main·전용 workflow/action/policy allowlist를 고정. GitHub 권한 자체는 workflow별로 제한되지 않는 저장소 Actions 권한이라는 점을 승인 범위에서 확인 |
| GitHub → TEST runner | 기존 self-hosted `obs-kakao`, `obs-test` 환경, `deploy-obs-test` 동시 실행 그룹 | 전용 preview workflow의 호스트/runner 귀속·실제 history/diag 경로를 먼저 읽기 검증. 기존 4범주 `Disk cleanup obs-test` apply 또는 배포 재실행을 연결하지 않음 |
| 앱 ↔ 실행 claim | SUPER `infra.manage`의 활성 세션과 정확 발급 preview·만료·fingerprint, 같은 요청 UUID의 단일 실행 예약 | 현 주입형 `dispatch` 계약만으로 운영 멱등성을 보장하지 않음. 기존 OpsEvent에서 예약을 먼저 확정하고, runner의 원자적 claim 및 실제 run ID 대조를 구현·검증한 뒤 연결. 관측 이벤트용 ingest 인증을 실행 권한으로 재사용하지 않음. 만료/권한 철회/다른 후보/중복 claim은 실행0 |
| 실제 실행 → job 결과 | 위 claim을 통과한 전용 runner의 실제 run ID·정책·request UUID·후보 fingerprint·상태·시각·오류·실측 회수량 | 접수 응답 유실은 같은 요청의 원 job을 조회하여 조정. 새 job 재발행이나 요청UUID를 job으로 변환하지 않음. preview artifact의 성공을 정리 성공으로 표시하지 않음. raw 로그/본문/자격 증명은 응답에 포함하지 않음 |

실제 삭제를 연결하는 후속 소스는 오래된 ONQ 앱 이미지와 14일 초과 runner 진단 로그 두 범주만 처리해야 한다. 실행 직전 같은 후보를 다시 계산하고, 이미지 사용 중/모든 별명/최근 롤백 버전과 로그의 canonical 경로·내용 변경을 확인해야 한다. 백업·DB·롤백 이미지·shared builder cache·checkout·소유권 미확인 자료는 제외한다. 추가 retention을 만들거나 기존 공용 4범주 apply를 재사용하지 않는다.

검증 순서:

1. 소유 합성 runner/앱 원천으로 발급→fresh 동일 후보→단일 claim→실제 run ID→결과 계약, 응답 유실/권한 철회/만료/동시 배포/후보 변경/중복 요청을 검증한다. 보호 목록 SHA와 mutation 호출 범위를 대조한다.
2. 새 exact CI의 owned E2E2·1440/1024/390 UI 픽셀은 미연결503과 mock 작업 상태만 판정한다. 이 결과로 실제 실행 연결을 승인하지 않는다.
3. 구체 자격 증명·설치 대상·runner/app 경계 승인을 받은 뒤 TEST에서 읽기 원천만 검증한다. 별도 실제 적용 승인 전에는 dispatch/apply/delete/SSH/재배포를 하지 않는다.
4. 실제 적용 승인 시 확인한 후보와 보호 목록을 다시 제시하고 단일 요청으로만 실행한다. 실제 상태/오류/실측 회수량과 보호 항목 보존을 독립 검수하며 불확실하면 완료로 표시하지 않는다.
