# 자동 설치·연결 상품 설계 (1차: 백엔드 골격, 실제 Gemini·브라우저·결제 없음)

정본 요구사항: `docs/PRODUCT_SCOPE.md` 「자동 설치·연결 상품」「동시 실행·급성장 대응」, `docs/ONQ_PLAN.md` 단계 4·5, 종단 흐름 E3.
작성 2026-10-03 KST. 코드: `lib/server/automation/**`, `app/api/automation/**`, 스키마 `prisma/schema.prisma` 「자동 설치·연결 상품」 블록, 마이그레이션 `20261003220000_automation`.

## 1. 1차 범위와 아닌 것

- 한다: 결제·작업 모델과 저장, 서버 결제 검증 뒤에만 실행, 작업 큐(lease·fencing·잠금·동시성·backoff·비용 상한), 판단·실행기·로컬 도구 **인터페이스 + 가짜 구현**, 판매자 API, 테스트·모의 부하.
- 안 한다(승인 필요): 실제 Gemini 호출·키·모델 선택, 실제 브라우저 실행기, 고객 PC 로컬 연결 도구, 실결제·환불, 작업자 프로세스 배포, 화면.

## 2. 상태기계 — 결제와 작업을 나눈다

결제 `AutomationPayment.status`: `PENDING → PAID | FAILED` (한 번 확정되면 바뀌지 않음).

작업 `AutomationJob.status` (전이표 정본: `lib/server/automation/states.ts`):

| 출발 | 갈 수 있는 곳 | 계기 |
|---|---|---|
| AWAITING_PAYMENT(결제 대기) | QUEUED / FAILED / CANCELED | 서버가 PG 조회로 PAID 확인 / 결제 실패 / 판매자 취소 |
| QUEUED(대기열) | RUNNING / CANCELED | 작업자가 자리 잡음 / 취소 |
| RUNNING(실행 중) | VERIFYING / NEEDS_CUSTOMER / QUEUED / FAILED / CANCELED | 검증 단계 도달 / 고객 행동 필요 / 일시 오류·lease 만료 / 치명 오류·시도 소진·비용 초과·위험 행동 / 취소 |
| NEEDS_CUSTOMER(고객 행동 필요) | QUEUED / FAILED / CANCELED | 고객이 마쳤다고 알림(재개) / 마감 24시간 지남 / 취소 |
| VERIFYING(검증 중) | SUCCEEDED / NEEDS_CUSTOMER / QUEUED / FAILED / CANCELED | 테스트 표시 확인 / OBS 미연결 등 / 재시도 / 실패 / 취소 |
| SUCCEEDED·FAILED·CANCELED | 없음 | 끝 |

- 고객 행동 종류: `LOGIN`, `TWO_FACTOR`, `CAPTCHA`, `PERMISSION_GRANT`, `LOCAL_TOOL`. 완전 무인을 약속하지 않는다.
- 진행 위치는 `stepIndex`(단계 목록 `steps.ts`: 쇼핑몰 연결 → 웹훅 설정 → OBS 오버레이 설치 → 표시 설정 → 테스트 이벤트 검증). 재개·재시도는 멈춘 단계부터 이어 간다.
- 모든 전이는 `AutomationJobEvent`에 (전, 후, fencing 토큰, 사유)로 남긴다. 구매·취소·재개는 `AuditLog`에도 남긴다.

### 재개·재시도·취소 규칙

- 재개: `NEEDS_CUSTOMER`에서만. 고객 행동 정보·마감을 지우고 `QUEUED`(즉시 실행 가능).
- 재시도: 일시 오류마다 `attempts+1`, `runAfter = now + min(10분, 5초×2^(n-1)) × (0.5~1.0 지터)`. `maxAttempts`(기본 5) 도달 시 `FAILED`. 고객 대기·재개는 시도 횟수를 쓰지 않는다.
- 취소: 끝나지 않은 모든 상태에서 가능. 실행 중이어도 즉시 `CANCELED` + fencing 토큰 증가 → 작업자의 다음 쓰기부터 거부된다(진행 중인 외부 행동 1개는 끝까지 갈 수 있다; 단계 경계에서 멈춤).
- 환불은 자동으로 하지 않는다. 결제 확정 전에 취소했는데 결제가 들어오면 작업은 다시 열지 않고 `automation.paid_after_cancel` 감사 기록을 남긴다(환불 조건은 판단 필요, 7절).

## 3. 세 구성요소 경계 (`ports.ts`)

| 구성요소 | 하는 일 | 하지 않는 일 |
|---|---|---|
| 판단 `AutomationPlanner` (Gemini 예정) | 정리된 관찰 → 다음 행동 1개와 비용 | 실행, 비밀값 보기, 완료 판정 |
| 서버 브라우저 실행기 `BrowserExecutor` | 작업마다 새 context에서 허용된 행동 실행, 비밀 참조를 실제 값으로 바꿔 입력 | 고객 OBS 제어, 다른 작업과 context 공유 |
| 로컬 연결 도구 `ObsBridge` (고객 PC, OBS WebSocket) | 오버레이 소스 추가·표시 설정·테스트 표시 확인 | 서버 브라우저가 고객 OBS를 직접 제어한다고 가정하지 않음 |

- 단계 완료는 판단 모델의 「끝」 요청이 아니라 실행기·로컬 도구의 실제 확인(`stepDone`)으로 정한다. 검증 단계는 `check_overlay_shows_test_event`가 `verified`를 돌려준 뒤에만 끝난다.
- 공식 API·OAuth·앱 설치를 먼저 쓴다(4절). 브라우저 실행기는 API로 안 되는 관리 화면에만 쓴다.

## 4. Cafe24 공식 경로 조사 (공개 문서 기준)

- Cafe24 API는 OAuth 2.0 인증, HTTPS(TLS 1.2 이상), JSON 응답. 앱을 개발자센터에 등록해 Client ID·Secret을 받는다. 출처: [Getting Started with CAFE24 API](https://developers.cafe24.com/docs-new/en/docs/guide/intro)
- 인가 코드는 **웹 브라우저에서만** 요청하고, 코드로 `oauth/token`에 POST해 Access Token을 받는다. scope로 권한을 나눈다. Access Token 2시간, Refresh Token 14일. 출처: [OAuth 2.0 인증 가이드](https://developers.cafe24.com/docs-new/docs/guide/oauth2-authentication) (영문 [OAuth 2.0 Authentication Guide](https://developers.cafe24.com/docs-new/en/docs/guide/oauth2-authentication))
- 따라서 쇼핑몰 연결 단계는 「고객이 브라우저에서 앱 설치·권한 승인(`PERMISSION_GRANT`) → 서버가 토큰 교환」이 기본 경로다. 서버 브라우저로 고객 Cafe24 비밀번호를 입력하지 않는다(로그인·2단계 인증은 고객 행동).
- 기존 참고 구현(망고TCG, 읽기 전용): 카페24 웹훅 수신·OAuth 토큰 AES-256-GCM 암호화 저장·누락 보정 대조가 있다(`docs/REFERENCE_MANGOTCG.md`).
- 확인 필요(이 세션은 developers.cafe24.com 직접 열람이 네트워크 정책으로 막혀 검색 요약으로만 확인): 웹훅 등록이 개발자센터 설정인지 API인지, 주문 관련 scope 이름, 호출 한도, 앱 심사 절차. 실제 연결 전에 문서를 직접 확인해 이 절을 고친다.

## 5. 격리·비밀값·악성 페이지 방어

- 고객별 격리: 작업마다 `BrowserExecutor.open({sellerId, jobId})`로 새 context(쿠키·저장소·임시파일 분리), 작업이 어떻게 끝나든 `close()`. OBS 대상 키(`obsTargetKey`, 지금은 `seller:<id>`, 로컬 도구 pairing을 붙이면 기기 id)로 OBS 연결을 나눈다.
- 비밀값: 모델은 `SecretRef`(`webhook_url`·`webhook_secret`) 이름만 쓰고, 실행기가 실행 직전에만 값을 넣는다. 모델 입력은 `sanitizeObservation`이 비밀값을 `[비밀값]`으로 지우고 8,000자로 자른다. 작업 기록·감사 기록에 비밀값을 넣지 않는다. 고객 쇼핑몰 비밀번호는 받지도 저장하지도 않는다.
- 악성 페이지 지시: 화면 글은 `untrustedPageText`(신뢰하지 않는 데이터)로만 넘긴다. 실행 전 `validateDecision`이 단계별 허용 행동, https·허용 호스트(`cafe24.com`, `cafe24api.com`과 하위 도메인), 비밀값을 글자로 적기, 모르는 비밀 참조·고객 행동, 음수 비용을 거부한다. 거부되면 실행하지 않고 작업을 `FAILED(unsafe_action:…)`로 멈춘다(무한 재시도 방지).

## 6. 동시 실행·급성장 대응

- 분리: 자동 연결은 전용 테이블·전용 잠금(advisory lock `automation_claim`)만 쓰고 판매자 행을 잠그지 않는다. 작업자는 웹 서버와 다른 프로세스로 띄운다(진입 모듈 `lib/server/automation/worker.ts`의 `runWorkerLoop`).
- idempotency: 판매자별 `Idempotency-Key`(`@@unique([sellerId, idempotencyKey])`), 판매자당 열린 작업 1개(부분 유니크 `AutomationJob_one_open_per_seller`), 결제별 PG 요청 id = 청구 id, 결제 1건에 작업 1개(`@@unique([sellerId, paymentId])`), 작업별 쓰기는 fencing 토큰.
- 같은 OBS 대상 잠금: 고르기에서 제외 + 부분 유니크 `AutomationJob_one_running_per_obs_target`.
- lease·fencing: 자리를 잡을 때마다 토큰 +1. 작업자 쓰기는 `토큰 일치 AND 실행 중 상태 AND lease 살아 있음`일 때만. 만료 회수·취소도 토큰을 올린다.
- 동시성 상한: 전체 실행 수(기본 20)를 잠금 안에서 세고 고른다. 공정 처리: 판매자당 열린 작업 1개 + `runAfter` 순(FIFO)이라 한 판매자가 자리를 독차지하지 못한다.
- 고객 행동 대기 중에는 lease를 반납한다(다른 작업이 그 자리를 쓴다).
- timeout: lease(기본 60초)를 행동마다 연장, 못 하면 회수. 단계당 행동 12번 상한. 고객 행동 마감 24시간.
- 비용 상한: 판단 호출 비용을 `costUsed`에 쌓고 `costLimit`(기본 3,000원, 가정값) 초과 시 멈춘다.
- 결제 대사: 결과를 못 받은 PENDING 청구는 작업자 반복이 1분 뒤부터 PG에 다시 묻고, 기록 없음이 30분 이어지면 실패로 닫는다.

## 7. 측정 (모의 부하, 2026-10-03 KST, 이 세션 컨테이너 + 로컬 Postgres 16)

`tests/integration/automationLoad.test.ts`: 작업자 10개, 동시 상한 20, 가짜 실행기 행동당 5ms 지연. 같은 시간에 주문 API(`POST /api/shop/[slug]/orders`)를 순서대로 호출.

| 상황 | 자동 연결 처리 | 주문 API p50 / p95 / 최대 |
|---|---|---|
| 부하 없음(40건) | — | 33.4 / 44.7 / 45.1ms |
| 작업 10개 | 545ms, 18.3건/초, 최대 동시 10 | 34.4 / 70.1 / 92.1ms |
| 작업 50개 | 1,773ms, 28.2건/초, 최대 동시 10 | 47.0 / 66.9 / 74.0ms |
| 작업 100개 | 3,072ms, 32.6건/초, 최대 동시 10 | 40.2 / 53.0 / 64.8ms |

- 한계: 같은 프로세스·같은 DB의 모의 측정이다. 실제 Gemini·브라우저 지연, 작업자 CPU·메모리(브라우저 context당 수백 MB 예상), 운영 DB 연결 수는 반영하지 않았다. 실제 용량 목표는 실행기 연결 후 다시 잰다. VM 한 대 구성을 고가용성으로 보지 않는다.

## 8. 판단 필요 (미확정)

- 실제 Gemini 모델·키·호출 비용(PR 본문에 추정), 비용 상한 값.
- 환불 조건(실패·취소·결제 후 취소), 재설치 추가 과금.
- 결제 수단: 1차는 구독용 등록 카드(빌링키)로 일회 결제한다. 카드 없는 판매자의 일회 결제창(PG 결제창)은 billing 공통 코드 확장이 필요하다. PG 결과 조회에 금액이 없어(`PaymentLookup`) 금액 대조를 못 한다.
- 직원(대표자 아님)에게 조회·재개를 열지. 지금은 대표자 전용.
- `sellerId` 외래키: Seller 모델에 역관계 한 줄이 필요해(다른 모델 수정 금지) 두지 않았다. 판매자 삭제 시 정리 정책과 함께 결정.
