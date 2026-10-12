# MA120 실제 연결 게이트 — 2026-10-13 KST

현재 소스는 UI/API·ONQ exact Actions provider·사전 예약·실제 run 대조/응답 유실 조정·인증 callback의 단일 claim·두 범주 전용 runner까지이다. 실제 자격은 미설정이며 production bridge는 `null`, preview/execute503·job404를 유지한다. 자동 정리는 꺼져 있다. preview 설정만으로 실행을 열지 않으며 production factory의 execution 승인은 명시적으로 false다. 단위/합성 검증이나 화면 mock 결과를 실제 서버 실행으로 판단하지 않는다.

| 경계 | 필요한 실제 대상·권한 | 최소 변경 및 승인 전 제한 |
| --- | --- | --- |
| 앱 → GitHub | 기존 승인 App/자격의 ONQ 저장소 한정 Actions 조회/dispatch. 기존 앱 서버 권한·키가 있다고 가정하지 않음 | `ONQ_DISK_ACTIONS_TOKEN`은 별도 승인 후 서버에만 구성. `ONQ_DISK_ACTIONS_MODE=preview`와 전용 callback 자격이 함께 있어야 읽기 provider가 열린다. 저장소/main/전용 workflow 두 개가 고정이며 GitHub 권한 자체는 workflow별로 제한되지 않는 저장소 Actions 권한임을 확인. 토큰 만료/권한 오류는503이며 CLI 계정 자격을 추출하지 않음 |
| GitHub → TEST runner | 기존 self-hosted `obs-kakao`, `obs-test` 환경, `deploy-obs-test` 동시 실행 그룹 | 기존 TEST 서버 이름 `obs-web-test`를 기준으로 로컬 hostname·Docker daemon Name을 일치 검증하고 `unix:///var/run/docker.sock`만 명시 사용한다. 다른 DOCKER_HOST/context/TLS 설정 또는 default context endpoint가 다르면 거부한다. 실제 TEST의 이름·socket·history/diag 귀속이 미확인되면 설정을 바꾸지 않고 차단한다. 기존 4범주 `Disk cleanup obs-test` apply 또는 배포 재실행을 연결하지 않음 |
| 앱 ↔ 실행 claim | SUPER `infra.manage`의 활성 세션과 정확 발급 preview·만료·fingerprint, 같은 요청 UUID의 단일 실행 예약 | 기존 OpsEvent 예약을 외부 POST 전에 커밋한다. 전송 기록도 POST 전에 확정하며 응답 유실은 같은 run명 조회만 한다. `/api/internal/ops/disk-optimization`은 전용 `ONQ_DISK_CALLBACK_TOKEN`으로 인증하고 GitHub의 실제 repository/head repository/main/workflow/run-attempt1·runner labels를 대조한다. 단일 claim에서 실제 DB 시각·활성 세션·후보·동시 배포를 다시 검증한다. 관측 ingest 자격을 재사용하지 않음 |
| 실제 실행 → job 결과 | 위 claim을 통과한 전용 runner의 실제 run ID·정책·request UUID·후보 fingerprint·상태·시각·오류·실측 회수량 | 접수 응답 유실은 같은 요청의 원 job을 조회하여 조정. 새 job 재발행이나 요청UUID를 job으로 변환하지 않음. preview artifact의 성공을 정리 성공으로 표시하지 않음. raw 로그/본문/자격 증명은 응답에 포함하지 않음 |

전용 runner 소스는 오래된 ONQ 앱 이미지와 14일 초과 runner 진단 로그만 처리한다. 같은 `deploy-obs-test` 동시 실행 그룹에서 fresh manifest→단일 claim→항목마다 남은 manifest를 재확인하며, 이미지 사용 중/모든 별명/최근 롤백 버전을 보존한다. 이미지 삭제는 force/prune 없이 정확 ID만 전달해 Docker가 사용 중·다중 별명을 거부하면 실패로 남긴다. 로그는 고정 diag·현재 runner 소유·권한·NOFOLLOW/dir_fd·대상 fd/재조회 path 소유자와 inode/size/mtime/hash/14일을 확인한다. 백업·DB·롤백 이미지·shared cache·checkout 삭제 경로는 없다. 실제 회수 값은 후보 크기 합이 아니라 중복 filesystem을 제외한 전후 가용 공간 차이이며 측정 실패는 성공을 제출하지 않는다. 다른 host 쓰기의 공간 변동은 실제 적용 검수에서 별도 대조한다.

최소 외부 조치와 비삭제 검증: ① exact 두 workflow와 callback/provider 소스를 승인된 main에서 확인 ② 기존 승인 App의 ONQ 저장소 Actions 권한 및 만료/회전을 확인 ③ 앱 서버·obs-test 환경에 같은 전용 callback 자격만 별도 승인해 구성(값은 보고하지 않음) ④ 실제 TEST runner 귀속/diag 소유·권한/history·DockerRootDir/TLS를 읽기로 확인 ⑤ `preview`만 연결해 실제 run/후보와 UI 실행 disabled를 확인한다. 새 App/자격/env/서버 변경·실 dispatch/SSH는 이번 소스 작업에서 수행하지 않는다.

실제 삭제의 별도 게이트는 검수한 후보/보호목록을 제시하고 production factory의 execution 승인 및 obs-test의 `ONQ_DISK_EXECUTION_APPROVED`를 명시 승인하는 것이다. 둘 중 하나가 닫히거나 callback claim이 거부되면 실행0이다. 이 소스의 production factory는 계속 false이며 임의로 권한을 추정해 열지 않는다.

검증 순서:

1. 소유 합성 runner/앱 원천으로 발급→fresh 동일 후보→단일 claim→실제 run ID→결과 계약, 응답 유실/권한 철회/만료/동시 배포/후보 변경/중복 요청을 검증한다. 보호 목록 SHA와 mutation 호출 범위를 대조한다.
2. 새 exact CI의 owned E2E3·1440/1024/390 UI 픽셀은 미연결503·readonly 실행 차단과 mock 작업 상태만 판정한다. 이 결과로 실제 실행 연결을 승인하지 않는다.
3. 구체 자격 증명·설치 대상·runner/app 경계 승인을 받은 뒤 TEST에서 읽기 원천만 검증한다. 별도 실제 적용 승인 전에는 dispatch/apply/delete/SSH/재배포를 하지 않는다.
4. 실제 적용 승인 시 확인한 후보와 보호 목록을 다시 제시하고 단일 요청으로만 실행한다. 실제 상태/오류/실측 회수량과 보호 항목 보존을 독립 검수하며 불확실하면 완료로 표시하지 않는다.
