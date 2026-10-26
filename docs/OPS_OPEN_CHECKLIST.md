# 운영 오픈 점검표

> 2026-10-26 KST 작성(읽기 전용 점검). 근거는 저장소 코드·문서뿐이며 운영 서버·콘솔·계정은 확인하지 못했습니다. 서버 실측이 필요한 항목은 「미확인」으로 적었습니다. 절차 정본은 `docs/DEPLOY.md` 「운영 배포」입니다. 이 문서는 그 절차를 오픈 직전 점검 순서로 다시 모은 것이라 값은 적지 않습니다.

## 1. 코드에서 확인한 것

| 항목 | 확인 내용 | 근거 |
| --- | --- | --- |
| 운영 배포 워크플로 | 수동 실행만, main만, 환경 `production` 승인(대표님만), 러너 라벨 `obs-prod`. 순서: 확인 문구·40자 SHA → `.env` 운영 표시 → CI 두 작업 성공 → 디스크 10GB → 검증된 DB 백업 → 빌드·마이그레이션·앱 교체 → 헬스 체크 → 기록 | `.github/workflows/deploy-obs-prod.yml` |
| `/api/health` | DB `SELECT 1` 성공이면 `{status, db, version}`, 실패하면 503. 배포 워크플로는 `version`이 배포 SHA와 같고 `db`가 ok이며 `testMode`가 없을 때만 통과 | `app/api/health/route.ts` |
| 마이그레이션 순서 | 앱 기동 전 `obs-web-migrate`가 `prisma migrate deploy`를 한 번 실행하고, 앱은 그 뒤에 뜹니다. 실패하면 앱은 바뀌지 않습니다. 폴더 이름순으로 적용(현재 181개), 추가형만 | `deploy/docker-compose.yml`, `prisma/migrations` |
| 백업 | 배포 때마다 `pg_dump -Fc` 후 `pg_restore --list`로 읽기 검증, 실패하면 배포 중단. 매일 오프사이트 백업 `scripts/ops/db-offsite.sh`(버킷 30일 수명 주기는 콘솔에서 설정) | 워크플로, `docs/DEPLOY.md` 「운영 DB 일일 오프사이트 백업」 |
| 롤백 | 앱 기동·헬스 실패 시 이번에 배포한 버전일 때만 앱을 직전 버전으로 자동 되돌립니다. DB는 되돌리지 않으며 사람이 배포 전 백업으로 `db-restore.sh`. 마이그레이션 실패면 되돌리지 않습니다 | 워크플로, `scripts/ops/rollback-app.sh`, `docs/DEPLOY.md` 「롤백」 |
| 테스트 값 차단 | `.env`에 `OBS_TEST_MODE=1` 또는 `OBS_ENVIRONMENT=test`가 있으면 배포 중단. 시드·장애 주입은 운영에서 실행되지 않음 | 워크플로 |

## 2. 운영 서버 `.env` 필수 이름(값은 서버에서만)

배포 전 검사가 요구하는 이름: `POSTGRES_USER` · `POSTGRES_PASSWORD` · `POSTGRES_DB` · `IDENTITY_HASH_KEY` · `BILLING_KEY_SECRET` · `OBS_SITE_ADDRESS` · `OBS_ENVIRONMENT=prod`. `OBS_TEST_MODE`는 넣지 않습니다.

기능이 켜지려면 추가로 필요한 이름(코드가 읽는 것, 없으면 해당 기능이 막힘): `PORTONE_API_SECRET` · `PORTONE_STORE_ID` · `PORTONE_IDENTITY_CHANNEL_KEY`(휴대폰 본인확인), `NICEPAY_CLIENT_KEY` · `NICEPAY_SECRET_KEY`(주문 카드 결제), `BILLING_PROVIDER`(구독 결제), `NTS_BUSINESS_STATUS_API_KEY` · `FTC_MAIL_ORDER_API_KEY`(가입 사업자·통신판매업 점검), `TRUSTED_PROXY_HOPS`(프록시 뒤 IP 판단), `IMAGE_STORAGE`와 `BACKUP_S3_*`(이미지·백업 저장소). 나머지 선택 이름은 `docs/DEPLOY.md` 「서버 `.env`」 표를 따릅니다.

## 3. 외부 업체 미연동 때의 동작(코드 기준) — 오픈 차단 후보

| 기능 | 키·계약이 없을 때 | 운영에서 실제로 쓰려면 |
| --- | --- | --- |
| 휴대폰 본인확인 | 운영 빌드는 포트원 설정이 다 있을 때만 동작. 없으면 503 「본인확인 서비스 준비 중이에요」로 막고 500으로 터지지 않음(`lib/server/identity/registry.ts`) | 대행사 계약·키(어댑터는 포트원으로 구현돼 있음) |
| 주문 카드 결제 | 키가 없으면 「결제 준비 중」으로 거절, 돈이 움직이는 경로를 열지 않음. **키가 있어도 코드는 나이스페이 샌드박스 주소(`NICEPAY_SANDBOX_API`)만 부름** | 운영 계약 뒤 **운영 주소를 부르는 코드 변경이 먼저 필요**(키만 넣어서는 운영 결제가 나가지 않음) |
| 구독 카드 자동결제 | `BILLING_PROVIDER`가 `fake`가 아니면 결제 공급자를 만들 때 오류가 나고, `fake`여도 운영 빌드(`NODE_ENV=production`)는 가짜 공급자 생성 자체를 거부함(`lib/server/billing/registry.ts`, `provider.ts`). **실제 업체 어댑터는 아직 없고 fake만 있음** → 운영에서는 구독 결제 경로가 오류로 멈춤(실제 결제가 성공한 것으로 처리되지는 않음) | 업체 선정·계약과 어댑터 구현이 먼저 필요 |
| 가입 사업자·통신판매업 점검 | 실제 조회 어댑터가 없어 `fake`가 아니면 조회 실패로 처리 → 신청 사유에 `business_lookup_failed`·`mail_order_lookup_failed`가 남음(`lib/server/sellers/businessCheck.ts`, `application.ts`). 자동 승인 대신 점검 실패 흐름을 탐 | 공공 API 키·어댑터 구현. 오픈 당일 가입 처리 방식은 별도 결정 |

위 네 줄이 해결되지 않으면 「가입 → 구독 결제 → 주문 결제」의 운영 여정 중 일부가 막히거나 샌드박스로만 동작합니다. **코드 변경이 필요한 항목은 오픈 일정에 직접 영향**을 줍니다(구독 결제 어댑터, 나이스페이 운영 주소).

## 4. 사람만 할 수 있는 조치(대표님·MASTER 확인 필요)

1. GitHub 저장소 Environment `production` 생성, Required reviewers에 대표님, 배포 브랜치 `main`만(러너 등록보다 먼저). 현재 설정은 미확인.
2. 운영 VM·데이터 디스크·공인 IP·보안그룹 생성(80·443 전체, 22는 허용 IP만). 카카오클라우드 자원 생성은 승인 범위 확인 필요. 현재 존재 여부 미확인.
3. 운영 도메인 `on-aircue.com` A 레코드를 **운영 공인 IP**로 연결(테스트 IP를 운영에 복제하지 않음). HTTPS는 Caddy 자동 발급(80·443 필요).
4. 서버 `/opt/obs/.env` 직접 작성(권한 600, 테스트와 다른 새 값). 비밀값은 저장소·채팅에 두지 않음.
5. 러너 `obs-prod` 등록(1~4가 끝난 뒤).
6. 운영 백업 전용 버킷·전용 사용자·S3 키 발급, 수명 주기 30일, 서버에서 `db-offsite.sh` 한 번 직접 실행, cron 등록.
7. 계약·키: 결제대행사(주문 카드 결제, 구독 자동결제), 본인인증 대행사(포트원 채널), 국세청·공정위 조회 API 키.
8. 첫 운영 배포는 `deploy-obs-prod` 실행(확인 문구 `DEPLOY-PROD`, 40자 SHA)과 승인을 대표님이 직접.

## 5. 오픈 직전 확인 순서(체크 후 날짜·시각 기록)

- [ ] 대상 main 커밋의 CI 세 작업(Typecheck and build, Unit and integration tests, E2E smoke) 성공
- [ ] 운영 `.env`에 §2 이름이 모두 있음(값은 열어 보지 않고 이름만 확인), `OBS_TEST_MODE` 없음
- [ ] 마이그레이션 대기 목록을 `prisma migrate status`로 확인(서버에서)
- [ ] 직전 백업 파일이 읽히는지 확인, 오프사이트 백업 마지막 줄 「오프사이트 백업 완료」
- [ ] 배포 후 `/api/health`: `status ok`, `db ok`, `version` = 배포 SHA, `testMode` 없음
- [ ] 막힘 화면 확인: 본인확인·카드 결제 미연동 시 「준비 중」 안내가 보이고 오류 화면이 아님
- [ ] 되돌릴 이전 이미지 SHA가 서버에 남아 있음(`docker image ls obs-web-app`)
- [ ] 오픈 후 첫 1시간 감시(`monitor.mjs` 알림)와 로그 확인

## 6. 이 점검에서 확인하지 못한 것

- 운영 서버·GitHub 환경 설정·콘솔 자원·DNS의 실제 상태
- 운영 도메인 HTTPS 인증서 발급 결과
- 오프사이트 백업의 실제 버킷 업로드(문서도 「실제 카카오 버킷에는 시험하지 못함」으로 기록)
- 포트원 어댑터의 실서비스 동작(계약·키 없음)
