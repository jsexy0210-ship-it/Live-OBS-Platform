# 자동 설치·연결 상품 설계 (1차: 백엔드 골격, 실제 Gemini·브라우저·결제 없음)

정본 요구사항: `docs/PRODUCT_SCOPE.md` 「자동 설치·연결 상품」「동시 실행·급성장 대응」, `docs/ONQ_PLAN.md` 단계 4·5, 종단 흐름 E3.
작성 2026-10-03 KST, 확정 ②·⑦·⑦-1 반영 2026-10-04 KST. 코드: `lib/server/automation/**`, `app/api/automation/**`, 스키마 `prisma/schema.prisma` 「자동 설치·연결 상품」 블록, 마이그레이션 `20261004152000_automation`.

## 1. 1차 범위와 아닌 것

- 한다: 결제·작업 모델과 저장, 서버 결제 검증 뒤에만 실행, 작업 큐(lease·fencing·잠금·동시성·backoff·비용 상한), 판단·실행기·로컬 도구 **인터페이스 + 가짜 구현**, 판매자 API, 테스트·모의 부하.
- 안 한다(승인 필요): 실제 Gemini 호출·키·모델 선택, 실제 브라우저 실행기, 고객 PC 로컬 연결 도구, 실결제·환불, 작업자 프로세스 배포, 화면.

## 2. 상태기계 — 결제와 작업을 나눈다

결제 `AutomationPayment.status`: `PENDING → PAID | FAILED`, `PAID → REFUND_PENDING(환불 처리 대기) → REFUNDED`.
- `REFUNDED`로 바꾸는 실제 환불 실행은 대표님 승인 대상이라 1차 코드에 없다(billing 공통 `BillingProvider`에 환불 API도 아직 없음).
- 결제 방식(확정 ②, PRODUCT_SCOPE 8a06dfe): 연결 시작 전에 결제를 받고(승인·매입 = `PAID`), 실패 확정 때 전액 환불(카드 승인 취소) 요청 = `REFUND_PENDING`. 「승인만 받고 성공 뒤 매입」은 PG 지원 확인 뒤 결제 상태에 `AUTHORIZED`(승인)·`CAPTURED`(매입) 단계를 더하는 방식으로 바꿀 수 있다. 실행 권한을 주는 조건(서버가 확인한 결제 성공)과 작업 상태는 그대로 두고 결제 상태만 늘리면 되게 결제·작업 상태를 분리해 두었다.

### 환불·재설치 정책 (2026-10-04 대표님 확정 ②, 정본 PRODUCT_SCOPE 「미확정 → 확정 ②」)

- **결제 전 고지·동의**: 구매·재설치 결제는 `consent: { agreed: true, noticeVersion }`가 서버 문구 버전(`AUTOMATION_CONSENT.version`)과 맞을 때만 만든다. 동의 시각(DB 시계)·문구 버전을 결제 행에 남긴다. 체크 해제·값 없음·문자열 `"true"`·예전 버전은 거부(결제·작업 없음).
- **성공 기준**: 테스트 주문이 고객 OBS 오버레이에 실제 표시됨. 검증 단계에서 로컬 도구가 확인한 증거를 `verificationEvidence`·`verifiedAt`에 저장하고, 증거 없이 `SUCCEEDED`로 두지 않는다. 완료 기록 전에 연결한 쇼핑몰(`shopKey`)과 PC(`obsPairingId`)가 둘 다 저장돼 있어야 한다(없으면 `shop_identity_unverified`·`pc_identity_unverified`로 실패). OBS 쪽 성공 결과의 실행 PC(`pairingId`)는 바꾸지 않고 확인만 한 경우에도 연결 결과로 남긴다.
- **환불**: 「실패 확정 → 환불 요청」. 판매자 대표자가 `POST /api/automation/jobs/[jobId]/refund-request`로 요청하면 결제가 `PAID → REFUND_PENDING`(사유 `failed`). 대상은 ① 작업이 `FAILED`(기준 미통과, 지원으로도 해결 안 됨) ② 연결을 시작하기 전(`startedAt` 없음) 취소한 작업(`canceled_before_start`). 연결 시작 뒤 취소(단순 변심)·완료 작업·무료 재연결은 대상이 아니다. 결제 확정 전에 취소했는데 결제가 들어오면 자동으로 `REFUND_PENDING`. 지원(재시도·안내)으로 해결할지는 환불 처리 대기 단계에서 마스터가 본다(마스터 화면·API는 다음 범위).
- **재연결·재설치**: `POST /api/automation/reconnect` `{ target: { shopKey, obsPairingId } }`. 기준 = 가장 최근에 돈을 내고(처음 연결·재설치) 완료한 작업. 그 완료 시각(DB 시계)부터 30일 안 + 같은 쇼핑몰(`shopKey`) + 같은 PC(`obsPairingId`, OBS pairing) + 연결 권한 해제(`connectionRevokedAt`) 없음 → 무료(`RECONNECT_FREE`, 결제 없이 바로 대기열). 아니면 사유(`no_completed_install`·`window_expired`·`shop_changed`·`pc_changed`·`connection_revoked`)와 33,000원을 돌려주고, 동의를 붙여 다시 오면 `REINSTALL`로 결제한다. 쇼핑몰이 바뀐 재설치(`shop_changed`)는 올바른 새 쇼핑몰 주소가 있어야 결제한다(없으면 `shop_url_required` 400, 결제 0건). 재설치 작업은 요청한 쇼핑몰·PC(`targetShopKey`·`targetObsPairingId`)를 남기고, 작업자는 실제로 연결된 쇼핑몰·PC가 이 값과 같은지 확인한다(다르면 바꾸기 전에 `reconnect_target_mismatch`). 무료 재연결의 완료는 30일을 늘리지 않는다(연달아 무료로 이어 붙이기 방지). `shopKey`·`obsPairingId`는 연결 단계 결과로 작업에 남는다.
- Idempotency-Key: 무료 재연결도 키를 받아 작업 행에 남기고 재전송이면 처음 결과를 돌려준다. 결제 행·작업 행에 요청 지문(종류·쇼핑몰 주소·재설치 대상의 해시)을 남겨, 같은 키라도 다른 요청이면 `idempotency_key_reused`(409)로 거부한다(예전 작업을 돌려주지 않음).
- **다른 카드로 결제(SA-151, 이번 한 번만, 카드 저장 안 함)**: 결제 수단 `AutomationPayment.method = ONE_TIME_CARD`(기본 `BILLING_KEY`). `POST /api/automation/purchase/one-time`(본문·Idempotency-Key는 구매와 같음, 지문은 별도라 같은 키를 두 수단에 쓰면 `idempotency_key_reused`)이 결제·작업(결제 대기) 행만 만들고 나이스페이 결제창 값 `{ window: { clientId, method, orderId(=결제 id), amount, goodsName } | null, returnUrl }`을 돌려준다. 결제창 인증 결과는 `POST /api/automation/purchase/one-time/return`(form POST)이 받아 서명·금액 확인 → 거래 id(`pgTid`) 선점 → 서버 승인 → `settleFound`(구독 카드 경로와 같은 확정 함수)로 PAID일 때만 작업 `QUEUED`. 거절은 `FAILED`(작업도 실패, 새 키로 다른 카드 재시도 가능), 승인 응답 없음은 망 취소 뒤 실패, 망 취소도 모르면 `PENDING`으로 두고 대사(`reconcileOneTimeAutomationPayments`, 웹훅 `reconcileOneTimeByTid`)가 거래 id로 PG에 묻는다. 결제창만 열고 끝내지 않은 시도(`pgTid` 없음)는 다음 시도 때 또는 30분 뒤 대사가 `window_abandoned`로 닫는다(늦게 온 인증은 승인하지 않음). 카드는 승인 응답의 카드사·끝 4자리만 `cardName`·`cardLast4`에 기록하고 저장 카드(빌링키)는 바꾸지 않는다. 환불은 `pgTid`로 PG 취소(실행은 승인 대상). 나이스페이 키가 없으면 503 `payment_not_ready`.
- 작업 종류 `kind`: `INITIAL`(110,000원) · `REINSTALL`(33,000원) · `RECONNECT_FREE`(결제 없음, DB CHECK로 결제 없음과 짝).

작업 `AutomationJob.status` (전이표 정본: `lib/server/automation/states.ts`):

| 출발 | 갈 수 있는 곳 | 계기 |
|---|---|---|
| AWAITING_PAYMENT(결제 대기) | QUEUED / FAILED / CANCELED | 서버가 PG 조회로 PAID 확인 / 결제 실패 / 판매자 취소 |
| QUEUED(대기열) | RUNNING / FAILED / CANCELED / CLEANUP_NEEDED | 작업자가 자리 잡음 / 시작·전체 마감 지남(자리 주지 않음) / 취소 / 바꾼 뒤 마감·취소 |
| RUNNING(실행 중) | VERIFYING / NEEDS_CUSTOMER / QUEUED / FAILED / CANCELED / CLEANUP_NEEDED | 검증 단계 도달 / 고객 행동 필요 / 일시 오류·lease 만료 / 치명 오류·시도 소진·비용 초과·위험 행동 / 취소 / 되돌리기 실패 |
| NEEDS_CUSTOMER(고객 행동 필요) | QUEUED / FAILED / CANCELED / CLEANUP_NEEDED | 고객이 마쳤다고 알림(재개) / 고객 대기 마감 지남 / 취소 / 바꾼 뒤 마감·취소 |
| VERIFYING(검증 중) | SUCCEEDED / NEEDS_CUSTOMER / QUEUED / FAILED / CANCELED / CLEANUP_NEEDED | 테스트 표시 확인 / OBS 미연결 등 / 재시도 / 실패 / 취소 / 되돌리기 실패 |
| CLEANUP_NEEDED(정리 필요) | FAILED / CANCELED | 사람이 쇼핑몰 앱·웹훅·OBS 변경을 정리한 뒤 마스터 관리자(운영 역할 이상, `billing.manage`)가 정리 메모와 함께 닫는다(`POST /api/automation/admin/jobs/[jobId]/cleanup`, `closeCleanupNeeded`): 판매자 취소로 들어온 작업(취소 요청 때 남긴 `cancelRequestedAt`. 오류 문구로 추론하지 않으므로 실행기 오류 문구가 「canceled」여도 실패로 닫음)은 CANCELED(환불 없음, 취소 규칙과 같음), 그 밖은 FAILED·결제는 환불 처리 대기(REFUND_PENDING, 실제 PG 환불은 대표님 승인 사항)·로그 추적 `automation.cleanup_closed`. 정리 필요 동안 결제는 그대로 두고 보관 자료도 지우지 않는다. 닫기 전에는 판매자 취소·재개 불가, 열린 작업이라 새 구매도 막힘 |
| SUCCEEDED·FAILED·CANCELED | 없음 | 끝 |

- 고객 행동 종류: `LOGIN`, `TWO_FACTOR`, `CAPTCHA`, `PERMISSION_GRANT`, `LOCAL_TOOL`. 완전 무인을 약속하지 않는다.
- 세션 밖에 남는 변경 행동(OBS 설정·테스트 주문, `ACTION_EFFECT` external)에는 작업 id·단계와 행동의 의미(종류·대상·값, 키 순서와 무관한 해시)로 만든 고정 키(`actionKey`, 순번과 무관)를 붙여 실행기·로컬 도구에 넘기고, 같은 키는 한 번만 적용한다(같은 행동은 몇 번째로 오든 한 번, 다른 행동은 같은 순번이라도 실행)(작업자가 행동 성공 직후 죽고 회수·재실행돼도 중복 없음). 이동·확인은 새 세션에서 다시 해야 하므로 키를 붙이지 않는다. 누르기·입력은 브라우저 세션 안의 조작이라 고정 키를 붙이지 않고 재시도(새 세션) 때 다시 한다(입력값·화면 상태가 새 세션에 없음). 쇼핑몰에 남는 결과는 단계 완료 기록으로 한 번만 넘어가고, 같은 값으로 다시 저장해도 결과가 같다.
- 진행 위치는 `stepIndex`(단계 목록 `steps.ts`: 쇼핑몰 연결 → 웹훅 설정 → OBS 오버레이 설치 → 표시 설정 → 테스트 이벤트 검증). 재개·재시도는 멈춘 단계부터 이어 간다.
- 모든 전이는 `AutomationJobEvent`에 (전, 후, fencing 토큰, 사유)로 남긴다. 상태를 바꾸는 쓰기(작업자·판매자 취소·재개)는 작업 행을 잠그고 읽어, 기록의 이전 상태가 실제 상태와 어긋나지 않는다. 구매·취소·재개는 `AuditLog`에도 남긴다.

### 재개·재시도·취소 규칙

- 재개: `NEEDS_CUSTOMER`에서만, 마감 전에만. 고객 행동 정보·마감을 지우고 `QUEUED`(즉시 실행 가능). 마감이 지났으면 회수를 기다리지 않고 같은 트랜잭션에서 `FAILED(customer_action_timeout)`·결제 `REFUND_PENDING`으로 끝내고 `action_expired`(409)를 돌려준다.
- **시간 한도**(설정 `AUTOMATION_LIMITS`, 계산은 `deadlinesFor` 한 곳. 넘으면 바꾼 것이 없을 때 `FAILED`·결제 `REFUND_PENDING`, 있으면 「정리 필요」):

  | 한도 | 기준 | 값 | 사유 코드 | 강제하는 곳 |
  |---|---|---|---|---|
  | 시작 마감 | 대기열 진입(`queuedAt`, 결제 확인·무료 재연결 생성) | 24시간 | `start_deadline` | 자리 잡기(claim, 자리 주지 않고 외부 행동 0회로 닫음)·회수 |
  | 고객 대기 마감 | 대기 시작 | 24시간, 단 전체 마감보다 늦지 않게 | `customer_action_timeout` | 대기 설정(`actionDeadlineAt`)·재개·회수 |
  | 전체 마감 | 실행 시작(`startedAt`) | 72시간(고객 대기 여러 번 포함) | `total_deadline` | 자리 잡기·회수·실행 중 lease 연장(`touch`·heartbeat) |
  | 실행 시간 | 고객 대기를 뺀 실제 실행 합계(`activeMsUsed`) | 6시간 | `run_time_limit` | 실행 중 lease 연장 |

- 고객 행동 마감(24시간): 지나면 작업은 `FAILED(customer_action_timeout)`로 끝나고, 결제(110,000원·33,000원)는 확정 ②대로 `REFUND_PENDING`(전액 환불 처리 대기)이 된다(정본 fc09f13). 실제 환불 실행은 승인 뒤.
- 실행 시간 마감(6시간, 정본 d6e22c4): 고객 대기를 뺀 실제 실행 시간(`activeMsUsed`, 실행 자리를 놓을 때마다 합산·lease 만료 회수 땐 만료 시각까지)이 재시도 포함 합계 6시간을 넘으면 `touch`·heartbeat가 막고 작업을 `FAILED(run_time_limit)`로 끝내며 결제는 `REFUND_PENDING`. 보관 자료는 종료 삭제 규칙대로 지운다.
- 시작 뒤 취소(정본 d6e22c4): 즉시 `CANCELED` + fencing 토큰 증가 → heartbeat가 자리 잃음을 알아채고 다음 외부 행동 전에 멈춤(진행 중 호출 1개까지). 보관 자료는 지우고, 결제는 단순 변심이라 환불하지 않는다(`refund-request`도 거부).
- 재시도: 일시 오류마다 `attempts+1`, `runAfter = now + min(10분, 5초×2^(n-1)) × (0.5~1.0 지터)`. `maxAttempts`(기본 5) 도달 시 `FAILED`. 고객 대기·재개는 시도 횟수를 쓰지 않는다.
- 취소: 끝나지 않은 모든 상태에서 가능. 실행 중이어도 즉시 `CANCELED` + fencing 토큰 증가 → 작업자의 다음 쓰기부터 거부된다(진행 중인 외부 행동 1개는 끝까지 갈 수 있다; 단계 경계에서 멈춤).
- 환불은 위 「환불·재설치 정책」대로 요청·처리 대기까지만 한다. 결제 확정 전에 취소했는데 결제가 들어오면 작업은 다시 열지 않고 `REFUND_PENDING` + `automation.paid_after_cancel` 감사 기록.

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

- 고객별 격리: 작업마다 `BrowserExecutor.open({sellerId, jobId})`로 새 context(쿠키·저장소·임시파일 분리), 작업이 끝나면 `close()`로 모두 지운다. 고객 행동(로그인·2단계 인증·CAPTCHA·권한 승인) 대기로 멈출 때만 `close({ keepForResume: true })`로 그 작업의 쿠키·저장소·자격증명과 임시 파일(화면 캡처·내려받은 파일·실행 기록), 로컬 도구의 OBS 연결 정보를 **암호화해 작업 id에만 묶어** 보관하고(다른 작업 id로는 풀리지 않음), 재개 때 같은 작업에만 복원한 뒤 보관본을 지운다. 보관하기 **전에** 작업에 `browserStateHeld`(보관 중)를 fenced 쓰기로 먼저 표시하고(표시를 못 하면 보관하지 않고 바로 지운 뒤 오류를 올린다: 자리를 잃었으면 작업자가 멈추고, 일시적인 DB 오류면 고객 대기로 두지 않고 다시 시도), 작업이 끝나면(완료·취소·실패·고객 행동 마감·실행 시간 마감) 고객 대기가 없었던 작업까지 **끝난 모든 작업**에 대해 작업자 반복의 `purgeEndedBrowserState`가 실행기와 로컬 도구에 `discard`를 한 번씩 요청해(행동 키 기록·OBS 연결 정보 포함) 바로 지우고 `artifactsPurgedAt`을 남긴다(판매자 취소·마감 회수처럼 작업자 밖에서 끝난 경우 포함). 요청이 실패하면 실패 횟수와 다음 재시도 시각(30초부터 두 배씩, 최대 1시간)을 남겨 그때까지 고르지 않으므로 뒤의 작업도 정리되고, 10회째부터 마스터 관리자 알림(감사 기록 `automation.artifacts_purge_failed`) 1건을 남긴 뒤 재시도는 계속한다. 지운 뒤에는 같은 작업으로도 복원되지 않고, 끝난 작업은 실행 자리를 다시 받지 않는다. 연습 실행은 보관하지 않는다(정본 4678efb). OBS 대상 키(`obsTargetKey`, 지금은 `seller:<id>`, 로컬 도구 pairing을 붙이면 기기 id)로 OBS 연결을 나눈다.
- 비밀값: 모델은 `SecretRef`(`webhook_url`·`webhook_secret`) 이름만 쓰고, 실행기가 실행 직전에만 값을 넣는다. 비밀값을 넣어도 되는 칸은 작업서가 단계마다 정한다(`secretTargets`, 예: 웹훅 단계의 「주문 알림 주소」 칸에 `webhook_url`만). 작업서 행동이든 판단 모델 행동이든 목록 밖의 비밀 참조·칸·단계면 `secret_target_not_allowed`로 실행하지 않고 멈춘다. 작업서가 없으면 비밀값을 쓰지 못한다. 비밀값 입력은 승인 때 관찰한 주소와 실행 직전 실행기가 알려 주는 실제 문서 주소(`currentUrl`, 리다이렉트 뒤 출처)가 모두 **작업 대상 쇼핑몰의 관리자 화면**이어야 한다: ① 호스트가 판매자가 낸 쇼핑몰 주소의 호스트(`AutomationJob.shopHost`)와 정확히 같고 ② 경로가 작업서의 관리자 경로 접두사(`secretOrigin.pathPrefixes`, cafe24 초안 `/disp/admin/`·`/admin/`)로 시작하며 ③ 관찰한 화면에 관리자 로그인 상태 단서(`secretOrigin.adminCue`, 초안 「로그아웃」)가 있어야 한다. 관리자 화면이 쇼핑몰 자체 하위 도메인(`<몰>.cafe24.com/admin`)에 있어 호스트만으로는 판매자가 꾸미는 쇼핑몰 앞 화면과 가를 수 없기 때문이다(근거: 공개 자료 검색 결과 — 관리자 주소 `https://{mallId}.cafe24.com/admin`, 로그인 센터 `eclogin.cafe24.com`. 공식 개발자 문서는 이 세션 네트워크에서 열리지 않아 직접 확인하지 못함 → 실습 때 확인). 다른 몰의 관리자 경로·같은 호스트의 쇼핑몰 앞 화면·로그인 단서 없음·중앙 호스트(`admin.cafe24.com`)는 모두 거부한다. 작업서 초안의 이동 주소(`https://admin.cafe24.com/apps`)도 가정값이라 실습 때 실제 관리자 주소로 고친다. 아니거나 알 수 없으면 `secret_origin_not_allowed`로 실행하지 않는다. 비밀값이 아닌 누르기·입력도 같은 원칙으로, 관찰한 주소와 실행 직전 실제 문서 주소가 모두 이동 행동과 같은 이동 규칙 전체(작업 쇼핑몰 호스트 정확히 일치, 그 단계의 허용 경로 `allowedUrls.pathPrefixes`, 허용 쿼리 키만, 조각(#) 금지) 안이어야 하며 아니면 행동 0건으로 `page_not_allowed`(되돌리기에서는 「정리 필요」). 모델 입력은 `sanitizeObservation`이 만든다: 화면 본문을 그대로 보내지 않고 실행기가 구조화한 요소 중 조작에 필요한 것(버튼·링크·제목·폼 라벨·안내 문구)만 보내며, 표 본문·주문/회원 목록·입력값은 뺀다(ONQ 확정: 구매자 개인정보를 판단 모델에 보내지 않음). 요소 글은 허용 어휘(공통 UI 어휘 `COMMON_UI_WORDS` + 작업서 단계의 화면 단서·예외 단서·누를 대상·비밀값 칸 이름)에 정확히 있을 때만 원문으로 보내고, 그 밖은 자리표시 「[문구]」와 요소 번호만 보낸다(이름은 패턴으로 가릴 수 없어 허용 목록으로 막는다). 남은 글도 비밀값을 `[비밀값]`으로, 이메일·전화번호·주소·주문번호 같은 긴 숫자열을 가리고 8,000자로 자른다. 주소는 허용 목록으로만 보낸다: 이 작업 쇼핑몰 호스트는 `{shop}`, 다른 호스트는 `[다른 주소]`, 경로는 작업서에 적힌 고정 조각(`plannerPathSegments`)만 원문이고 나머지 조각(인코딩된 이메일·이름·번호 등)은 `:id`, 쿼리·조각은 보내지 않는다(패턴 가림은 인코딩된 값을 놓치므로 주소에 쓰지 않음). 판단 모델에 가는 필드 전체: 단계 키·종류(고정값), 행동 기록(행동 종류 이름만), 작업서 참고 자료(저장소의 작업서), 주소(위 허용 목록), 화면 요소(허용 어휘 + 자리표시, 비밀값·개인정보 패턴 가림). 작업 기록·감사 기록에 비밀값을 넣지 않는다. 고객 쇼핑몰 비밀번호는 받지도 저장하지도 않는다.
- OBS 행동에는 엔진이 직전에 확인한 PC(`expectedPairingId`)를 넘기고, 로컬 도구는 실행 직전 지금 연결된 PC와 원자적으로 비교해 다르면 행동 0건으로 `pairing_mismatch`를 돌려준다. 성공 결과에는 실제로 실행한 PC(`pairingId`)를 반드시 담고 엔진이 다시 대조한다(다르거나 없으면 `obs_target_changed`). 브라우저 변경 행동(누르기·입력)도 같은 방식으로 엔진이 확인한 문서 주소와 이동 규칙(`ExpectedPage`, 비밀값 입력이면 비밀값 출처 규칙·관리자 로그인 단서 문구까지)을 실행기에 넘기고, 실행기는 행동 직전에 지금 문서(와 화면 글)를 원자적으로 대조해 다르면 아무것도 하지 않고 `page_mismatch`를 돌려준다(확인과 실행 사이의 리다이렉트·로그아웃 차단).
- 같은 작업은 한 PC에만 설치한다: 모든 작업(첫 설치·재설치 포함)이 OBS를 바꾸기 직전마다 로컬 도구에서 실제 PC를 새로 읽는다. 검증 읽기(테스트 표시 확인)·단계 끝 직전에도 다시 읽는다. 첫 변경 직전 잠금을 잡는 같은 쓰기에서 그 PC를 `obsPairingId`로 저장해, 첫 변경 직후 작업자가 죽어도 다시 시작한 실행이 그 PC를 기준으로 삼는다. 이번 실행·이전 실행(작업 행 `obsPairingId`)에서 이미 다른 PC를 바꿨으면 `FAILED(obs_target_changed)`로 멈추고 새 PC에는 바꾸지 않으며, 다른 PC의 증거로 완료하거나 그 PC를 저장하지 않는다.
- 누르기·글 넣기 대상 고정: 작업서가 단계마다 누르거나(click) 비밀값 아닌 글을 넣어도 되는 대상을 정한다(`allowedTargets`, 예: 쇼핑몰 연결 「앱 설치」, 웹훅 「저장」). 작업서·판단 모델 행동 모두 목록 밖이면 `target_not_allowed`로 실행하지 않는다(악성 화면 지시로 삭제·권한·계정 설정을 누르지 못하게). 작업서가 없으면 누르거나 넣을 수 없다. 삭제·탈퇴·해지·초기화·권한·계정·비밀번호·결제·환불이 든 대상은 작업서 목록에 있어도 `dangerous_target`으로 거부한다(작업서 실수 방어). 거부되면 작업을 실패로 멈춘다(실행 0회). 실습 확인 필요: 앱 설치 동의 화면의 정상 버튼 문구(「권한 동의」「앱 권한」「계정 연결」 등)가 위험 단어에 걸리는지. 걸리면 단어 전체 거부 대신 작업서에 명시한 전체 문구만 예외로 두는 방식으로 바꾼다.
- 연습 실행은 실행 전에 기록(정리 대상 범위 `cleanupScopeId`, 정리 예정 `cleanupPendingAt`)부터 남기고, 끝날 때마다(성공·실패 모두) 그 실행의 브라우저·OBS 보관 자료를 `discard`로 지운다. 정리에 실패하면 기록에 남겨 작업자 반복의 `cleanupPracticeArtifacts`가 백오프로 다시 한다(도중에 죽은 연습은 실행 시간 상한 뒤 정리). 진행 중인 연습 기록(시작 때 남긴 `practice_incomplete`)은 준비 상태 판정에서 빼고, 실행 시간 상한(6시간)을 넘겨도 끝나지 않은 기록만 실패로 센다. 10회 모두 실패하면 자동 정리를 멈추고 「정리 필요」(`cleanupNeededAt`)로 바꾸며, 같은 트랜잭션에서 마스터 관리자 알림(감사 기록 운영 이벤트 `automation.practice_cleanup_needed`) 1건을 남긴다. 조용히 버리지 않는다. 정리 대기 행은 `FOR UPDATE SKIP LOCKED`로 고르면서 다음 대기 시각을 점유 시간(10분)만큼 미뤄 한 작업자만 집고, 결과는 고른 시점의 대기 시각·시도 횟수가 그대로일 때만 반영한다(동시 작업자의 중복 정리·성공 뒤 실패 덮어쓰기·잘못된 알림 방지). 연습 중 화면 이탈은 실행이 끝나기를 기다리지 않고 이탈을 본 즉시(`touch`) 작업서 배타 잠금 아래 그 연습 기록(사유 `practice_deviated`·이탈 단계)에 남긴다(이탈 뒤 실행이 죽어도 준비 상태가 이탈을 알도록). 연습 결과(실패·이탈 포함)는 보관 자료 정리 전에 작업서 배타 잠금 아래 먼저 기록한다(정리를 기다리는 동안 이전 연속 성공을 근거로 결제·작업이 확정되지 않게). 정리 결과는 기록 때 점유한 상태 그대로일 때만 반영한다.
- 작업 확정 함수(`commitJob`, 유료 첫 연결·유료 재설치·무료 재연결 공통): 바깥에서 미리 계산한 판정은 화면 안내용이고, 저장은 이 함수 안에서 다시 계산한 값으로만 한다. 무료 재연결도 잠금 안에서 판정(기준 설치 포함)을 다시 계산해, 그사이 기준 설치가 바뀌어 무료가 아니면 `payment_required`로 작업을 만들지 않는다.
- 구매 확정 직전 재확인: 결제·작업 생성 트랜잭션은 판매자 단위 잠금(`lockSellerAutomation`)과 작업서 공유 잠금(`lockPlaybook` shared)을 잡고, 커밋 직전에 작업서 준비 상태와(유료 재설치면) 무료 재연결 판정을 다시 계산한다. 준비가 풀렸으면 `shop_not_supported`, 무료 재연결 조건이 됐으면 `free_reconnect_available`(409)로 결제를 만들지 않는다. 화면 이탈 기록은 작업서 배타 잠금, 설치 완료 기록은 판매자 잠금을 행 변경 전에 잡아 같은 순서로 직렬화한다.
- 정리와 늦은 실행: 실행기·로컬 도구는 `discard`한 범위에 tombstone을 남기고, 그 뒤 늦게 끝난 행동·닫기가 보관 자료·행동 키·연결 정보를 다시 쓰는 것을 거부한다(`fatal scope_discarded`, ports.ts 계약).
- 변경 뒤 실패는 조용히 끝내지 않는다(MASTER 최소 안전 동작): 첫 변경 행동(클릭·입력·OBS 설정·테스트 주문) 직전에 `changedAt`을 남긴다. 변경 기록(`changedAt`·`mutatedSteps`, 되돌리기와 같은 증거. 진행 위치는 쓰지 않으므로 기존 설치를 확인만 한 작업은 해당 없음)이 있는 작업이 어떤 이유로든 실패(비용 상한·위험 행동·시도 소진·lease 회수·고객 행동 마감·재개 시 마감 경과·실행 시간 마감 등)하거나 취소되면, 끝 상태를 한 함수(`endStateFor`)가 정한다: 변경이 있으면 FAILED·CANCELED 대신 `CLEANUP_NEEDED`로 멈추고(되돌리기 성공 또는 운영자 정리 전까지), 같은 트랜잭션에서 정리 필요 시각(`cleanupNeededAt`)과 마스터 관리자 알림(감사 기록 `automation.job_cleanup_needed`) 1건을 남긴다. 그동안 결제는 환불 처리 대기로 바꾸지 않고 보관 자료 삭제 대상에서도 빠진다(종료 상태가 아님). 변경 전 실패는 표시·알림 없이 실패·환불 대기다. 변경 기록은 실행 전에 먼저 남기되(충돌 안전), 실행기가 행동 0회를 보장하는 거절(`page_mismatch`·`pairing_mismatch`)을 돌려주면 그 행동 직전에 새로 남긴 기록(그 단계·처음 남긴 변경 시각)만 같은 작업 행 잠금 아래 되돌린다(`unmarkChanged`). 이전 단계·이전 실행의 변경 기록은 그대로라 그런 작업은 계속 「정리 필요」다. 되돌리기는 실행 자리(lease)를 잃었거나 판매자 취소·회수와 겹쳐도 한다(fencing 없이 작업 행 잠금 아래, 그 사이 다른 작업자가 자리를 잡았으면 건드리지 않음). 이 기록 때문에 「정리 필요」로 갔는데 되돌린 뒤 바꾼 것이 없으면 판매자 취소는 `CANCELED`, 그 밖은 `FAILED`로 바꾼다. 자동 되돌리기 전체(E3-W)는 다음 PR.
- 되돌리기(MASTER 지시): 멈춰야 하는 작업이 이미 무언가를 바꿨으면(진행 위치·작업서 행동·판단 호출·PC 기록 중 하나라도 있음) 그냥 실패시키지 않고, 구매 때 버전 작업서의 되돌리기 단계(`playbook.rollback`: OBS 소스 빼기 → 웹훅 끄기 → 앱 사용 중지, 초안 가정)만으로 되돌린 뒤 실패·환불 대기로 끝낸다. 되돌리는 범위는 변경을 시작한 기록(`mutatedSteps`, 단계마다 첫 변경 직전에 `changedAt`과 같은 쓰기로 남김)이 있는 단계뿐이다(완료 여부와 무관). 기존 설정을 확인만 하고 끝낸 단계나 아직 바꾸지 않은 현재 단계는 판매자의 기존 앱·웹훅일 수 있어 건드리지 않고, 변경 시각은 있는데 단계 기록이 없어 범위를 알 수 없으면 되돌리지 않고 `CLEANUP_NEEDED`로 둔다. 되돌리기 중 화면 단서가 맞지 않아 판단 모델이 필요하거나, 검사에 걸리거나, 실행이 실패하거나, PC가 이 작업이 바꾼 PC가 아니거나, 구매 때 버전 정의가 없으면 판단 모델을 부르지 않고 `CLEANUP_NEEDED`로 두고 마스터 관리자 알림(감사 기록 `automation.job_cleanup_needed`)을 남긴다. 결제는 정리 뒤에 환불한다. 바꾼 단계 중 하나라도 되돌리기 항목(행동 1개 이상)이 없으면(작업서의 사람 정리 단계 `manualCleanupSteps` — cafe24 초안은 화면 설정·테스트 이벤트 — 또는 모르는 단계) 아무것도 하지 않고 바로 「정리 필요」로 넘긴다(fail-closed). 작업서 검사(`validatePlaybook`)는 모든 단계가 되돌리기 항목을 갖거나 사람 정리 단계로 명시돼 있는지 확인한다.
- 외부 입력 경계(`boundary.ts`): 실행기·로컬 도구·판단 모델이 준 값은 저장·기록 전에 한 곳에서 검증·정규화한다. 실패 사유는 실행기 계약 코드(`page_mismatch`·`pairing_mismatch`·`scope_discarded`·`timeout`·`page_timeout`·`obs_busy`·`admin_error`)만 그대로, 그 밖 원문(외부 화면 문구·비밀값이 섞일 수 있음)은 `executor_error`로만 남긴다. 쇼핑몰·PC 식별자는 1~200자·제어 문자 없음만 받고 자르지 않고 거절한다(바꾸기 전 읽기면 `pc_identity_invalid`·`shop_identity_invalid`로 변경 0회). 고객 행동 종류는 정해 둔 값만, 검증 증거는 키·개수·길이를 제한하고 비밀값을 가린다. 판단 모델 비용이 남은 한도를 넘으면 합계를 DB 정수 최대값 안으로만 기록하고 바로 `cost_limit`으로 끝낸다(쓰기 실패로 재시도·재호출 반복 없음).
- 성공은 검증으로만 확정한다(39차): 실행기·판단 모델의 「단계 끝」 신호만으로 단계를 끝내지 않는다. 작업서의 모든 단계는 완료 판정(`doneWhen`, 필수 필드)을 갖고, 엔진은 신호 뒤 다시 관찰한 화면·상태가 그 판정과 맞을 때만 단계를 끝낸다. 판정이 없으면(작업서 없음) `step_unverifiable`로 끝낼 수 없고, 맞지 않으면 화면 이탈로 기록하고 판단 모델로 넘긴다. 되돌리기 단계도 되돌림 확인(`doneWhen`)이 필수이며, 맞지 않으면 `rollback_unverified`로 「정리 필요」다. 연습은 매 회차 시험용 쇼핑몰·PC를 기준 상태로 되돌리고(`PracticeEnvironment.reset`) 실제 상태로 확인(`isBaseline`)한 뒤 실행한다. 되돌리기·확인이 실패하면 실행하지 않고 `practice_reset_failed`로 남아 연속 성공을 끊는다(완료 판정 문구는 초안 가정, 실습 때 확인). 연습 환경은 한 번에 한 연습만 쓴다(40차): 환경 단위 잠금 아래 진행 중(결과 미기록·실행 시간 상한 안) 연습이 있으면 시작하지 않고(`PracticeEnvironmentBusy`, 기록 없음), 그 회차 기록이 곧 환경 점유다. 결과는 DB의 시작 시각 기준 상한 안이고 정기 정리가 가져가지 않았을 때만 조건부로 기록하며, 아니면 `practice_expired`(실패)로 남겨 세지 않는다. 엔진은 변경 기록 뒤 실행기를 부르기 전에 끝나는 모든 경로(자리 잃음·취소·예외)에서 그 기록을 되돌린다(finally). 완료·되돌림 판정은 공용 장치(`verifiedOnExpected`) 하나로 본 단계·검증 단계·되돌리기 모두에 적용한다(41차): 브라우저는 판정의 기대 문서 경로(`doneWhen.pagePath`, 브라우저 단계 필수)로 시작하고 이동 규칙 안이며 관찰 주소와 지금 문서 주소가 같을 때만, OBS는 지금 PC가 이 작업이 확인한 PC일 때만 글 단서를 본다. 연습 회차는 점유 토큰(`fencingToken`)을 갖고, 새 연습은 기한 지난 진행 중 회차의 토큰을 올려 회수한 뒤에만 시작한다. 실행 중 회차는 행동 직전마다(`touch`)와 주기적으로(abort 신호) 점유를 확인해, 회수됐으면 외부 변경 없이 멈추고 결과도 토큰 조건으로만 기록한다. 이미 시작된 외부 행동은 토큰으로 취소할 수 없으므로 외부 행동 격리 창을 공용 장치로 둔다(42차): 모든 외부 행동(실행기 행동·되돌리기·연습 초기화)은 하드 상한(`actionTimeoutMs` 2분, 실행기도 넘기면 강제로 끊음) 안에서 하고, 시작마다 `lastActionStartedAt`, 끝나면 종료 확인 `lastActionEndedAt`을 남긴다. 소유권이 넘어가거나 닫히는 지점은 종료 확인 또는 시작 + 상한 + 여유(30초) 경과 중 먼저 오는 것(`quiescent`)까지 기다린다: 작업 인수(자리 잡기)·같은 OBS 대상의 다른 작업 시작·끝난 작업의 보관 자료 삭제·정리 필요 닫기(`action_in_progress` 409)·새 연습(회수 뒤 `PracticeEnvironmentBusy`의 quiescing)·연습 보관 자료 정리. 연습 초기화·기준 상태 확인도 같은 장치(`callPort`의 격리 창 기록)를 거치고, 상한에 이르면 중단 신호를 보낸다(`PracticeEnvironment` 계약: 받은 뒤 아무것도 바꾸지 않음, 43차). 포트 호출 분류(45차, 기준: 소유권이 넘어간 뒤 외부 상태를 바꾸거나 작업자를 붙잡을 수 있으면 상한을 둔다. 읽기 여부로 나누지 않음):

  | 포트 메서드 | 장치 | 이유 |
  |---|---|---|
  | `BrowserSession.perform`·`ObsBridge.perform` | 격리 창(상한 초과면 일시 실패) | 외부 변경 |
  | `BrowserSession.close` | 격리 창(자리를 잃었어도 닫으므로 시작 기록은 점유 확인 없이). 보관(`keepForResume`)이 상한 초과·오류면 고객 대기로 두지 않고 다시 시도(`state_save_timeout`·`state_save_failed`, 46차) | 브라우저 상태 보관은 외부 변경 |
  | `BrowserExecutor.open` | 격리 창(상한 초과면 중단 신호 → `read_timeout` 다시 시도). 중단 신호를 받으면 보관본을 복원하지 않고 거절(계약, 47차). 늦게 열린 세션은 보관하지 않고 닫음(`onLate`, 46차) | 보관본을 복원·삭제하는 외부 변경 |
  | `AutomationPlanner.decide` | 격리 창(상한 초과면 `planner_timeout` 실패) | 작업자를 붙잡을 수 있음 |
  | `PracticeEnvironment.reset`·`isBaseline` | 격리 창 | 시험 환경 변경 |
  | `BrowserSession.observe`·`currentUrl`·`currentShopKey`, `ObsBridge.observe`·`currentPairingId`, `SecretVault.forJob` | 상한만(넘으면 `read_timeout` 다시 시도) | 읽기라 외부 변경 없음, 작업자를 붙잡을 수 있음 |
  | `BrowserExecutor.discard`·`ObsBridge.discard` | 상한만, 격리 창이 지난 뒤에만 부름. 상한 초과·오류는 삭제 실패로 기록하고 다음 작업으로. 끝난 작업 삭제는 한 작업자만 잡음(재시도 시각을 두 요청 상한 + 여유 뒤로 미루는 조건부 갱신, 46차) | 실행기 쪽 보관 자료 삭제 |

  | `BillingProvider.getPayment`·`charge`(자동 연결 결제) | 상한만. 조회가 넘으면 결제는 PENDING 그대로 다음 대사로, 청구가 넘으면 결과 모름으로 PENDING(47차) | 작업자를 붙잡을 수 있음 |

  모든 포트 메서드는 `signal`을 필수로 받는다(47차, 타입 시험으로 강제). 결제 공급자 인터페이스(`BillingProvider`)는 구독 결제와 함께 쓰는 공용 인터페이스라 이번에 시그니처를 바꾸지 않았다(미완료, §8). 격리 창은 상한을 넘긴 호출이 실제로 끝났다는 확인(settle: 늦은 결과 정리까지 마친 뒤, 그 시작 기록이 그대로일 때만 종료 확인) 또는 강제 상한(시작 + 상한 + 여유) 중 먼저 오는 것까지 이어진다(47차). 종료 확인은 자기 시작 기록에만 묶고(시작 시각 조건), 같은 작업에 상한을 넘겨 끝나지 않은 호출이 하나라도 있으면 뒤 호출(세션 닫기 등)이 돌아와도 종료 확인을 남기지 않는다(`trackedWindow`, MASTER 검수 f8561e3). 뒤 호출의 시작 기록은 시각을 앞으로만 옮겨 창을 늘린다. 다른 작업자가 이미 이어받은(fencing 토큰이 오른) 뒤의 정리 호출(세션 닫기)은 시작만 남기고 종료 확인은 남기지 않는다: 그 사이 다른 프로세스의 새 소유자가 시작한 행동의 진행 여부를 알 수 없어, 창은 강제 상한으로만 풀린다(검수 전담, 두 작업자 반례).
  모든 포트 메서드는 `callPort` 하나로만 부른다(46차). 결과는 `{ok:true,value} | {ok:false,reason:"timeout"|"error"}` 판별 유니온이라 부른 쪽이 상한 초과를 반드시 다룬다(undefined 없음). 상한을 넘긴 뒤 늦게 도착한 자원은 `onLate`로 정리한다. 시험용 가짜는 엄격 모드에서 `callPort` 밖 호출을 거부한다. 상한 계약은 각 메서드 주석(`ports.ts`)에 있다.
- 시각은 DB 시계로만 기록·비교한다(lease·마감·재시도·이탈·준비 상태·연습 기록·보관 자료 삭제 재시도·정리 필요 시각). 프로세스 시계는 실행 시간 측정(`durationMs`)에만 쓴다. DB 시계는 트랜잭션 시작 시각(`now()`)이 아니라 실제 시각(`clock_timestamp()`)이며, 시간 판단·연장은 잠금을 잡은 뒤에 한다(잠금 대기 중 lease·마감이 지나면 그대로 반영).
- 잠금 순서(교착 방지, 모든 경로 공통): 판매자 잠금 → 작업서 잠금 → 작업 행 → 결제 행. 작업 행을 잡은 뒤에 판매자·작업서 잠금을 잡지 않는다(설치 완료·화면 이탈 기록은 작업 행보다 먼저 잡는다, `fencedWrite`의 `preLocks`).
- 작업서 버전 고정(MASTER 확정): 작업은 구매 때 고정한 작업서 버전으로만 실행한다. 실행을 시작할 때마다 확인해, 그 버전 정의가 없거나 버전이 바뀌었으면(`playbook_version_changed`) 또는 같은 버전이 그 뒤 화면 이탈로 더 이상 검증 상태가 아니면(`playbook_not_verified`) 외부 행동 없이 실패로 끝내고 결제를 `REFUND_PENDING`(전액 환불 처리 대기, 24시간 시작 마감과 같은 원칙)으로 둔다. 실제 환불 실행은 대표님 승인 뒤. 되돌리기 경로(E3-W)가 생기면 이미 변경한 작업은 그쪽으로 보낸다.
- 운영: 작업이 진행 중일 때는 작업서 버전을 바꾸는 배포를 피한다.
- 화면 이탈은 판단 모델을 부르기 전에 `lastDeviationAt`으로 기록한다. 판단 모델 호출이 계속 실패해 작업이 닫혀도 작업서는 다시 검증 대상이 되어 새 구매가 막힌다. 연속 성공은 시작 시각 순서로 세고(연습 결과는 시작 때 화면을 검증한 것), 이탈 전에 시작한 연습은 늦게 끝났어도 끊김이 아니라 제외한다.
- 악성 페이지 지시: 화면 글은 `untrustedPageText`(신뢰하지 않는 데이터)로만 넘긴다. 실행 전 `validateDecision`이 단계별 허용 행동, 이동은 https·기본 포트이고 호스트가 이 작업의 쇼핑몰 호스트(`shopHost`)와 정확히 같으며 경로가 작업서 단계별 허용 경로 접두(`allowedUrls.pathPrefixes`)로 시작하고 쿼리는 정한 키만·조각(#) 없음(다른 몰·중앙 호스트는 `host_not_allowed`, 그 밖은 `target_not_allowed`; 작업서 이동 주소는 호스트 자리에 `{shop}`), 비밀값을 글자로 적기, 모르는 비밀 참조·고객 행동, 음수 비용을 거부한다. 거부되면 실행하지 않고 작업을 `FAILED(unsafe_action:…)`로 멈춘다(무한 재시도 방지).

### 외부 쇼핑몰 플랫폼 이름 비노출 (2026-10-04 대표님 결정)

- 화면에 외부 쇼핑몰 플랫폼 이름(Cafe24 등)을 노출하지 않는다. 이 문서·코드 식별자·허용 호스트 목록 같은 내부 이름은 그대로 쓴다.
- API 응답에는 코드만 싣는다(오류 `error`, 재설치 사유 `paidReason`, 단계 `step`). 작업 조회의 `lastError`는 정해 둔 코드만 내보내고, 실행기·외부 화면에서 온 원문은 `step_failed`로 바꾼다(원문은 작업 기록에만). 결제 전 동의 문구에도 플랫폼 이름이 없다. 테스트가 응답 전체에서 플랫폼 이름 0건을 확인한다.
- 판매자는 플랫폼을 고르지 않고 쇼핑몰 주소를 입력하며, 서버가 주소로 플랫폼을 판별한다(판별·연결 단계는 외부 연동 범위). `shopKey`는 서버가 판별·연결한 결과로 채우는 내부 식별자다.

## 5-1. 연결 작업서와 연습 모드 (확정 ⑦-1, 2026-10-04 대표님 지시 「Gemini가 미리 학습하게 한다」)

모델 재학습(fine-tuning)이 아니라 **사전 자료 제공** 방식이다.

- **작업서 형식** (`lib/server/automation/playbook.ts`): 작업서 = `id`·`version`·내부용 플랫폼 이름·주소 판별용 `hostSuffixes`·판매자별 쇼핑몰 호스트 형식 `shopLabel`(접미사 바로 앞 한 단계 이름만, 형식 검사 + 예약 이름 거절. apex·중앙/서비스 호스트·두 단계 하위 도메인은 지원 밖으로 결제·작업 0건. cafe24 초안: 영문 소문자·숫자 4~16자, 예약 admin·www·api·eclogin·developers 등 — 가정값, 연습 때 확인)·단계별 `{ guide(판단 모델에 넣는 설명), referenceImages(화면 기준 이미지 경로), actions(정해진 행동 + 화면 단서 expect), exceptions(예외 화면 → 고객 행동/재시도/실패), examples(성공 사례 요약) }`. `validatePlaybook`이 모든 단계·허용 행동(판단 모델과 같은 검사)·단계 끝 행동·비밀값 원문 없음을 확인하고, 단위 테스트가 저장소의 모든 작업서를 검사한다.
- **저장 위치·버전 관리**: `lib/server/automation/playbooks/<id>.ts`, 목록 `playbooks/index.ts`. 바꿀 때는 `version`을 올린다. 연습 기록이 `id+version`으로 묶여, 버전을 올리면 다시 연습해 검증해야 지원 목록에 오른다. 이전 버전은 git 기록. 작업 중 버전이 바뀌면 그 작업은 작업서 없이 판단 모델로만 진행한다.
- **판별**: 판매자가 낸 쇼핑몰 주소(`shopUrl`)로 서버가 작업서를 고른다(`playbookForShopUrl`). 작업서 id·플랫폼 이름은 응답에 나가지 않는다.
- **실행 순서** (`engine.ts`, 고객 작업·연습이 같이 씀): 관찰 → 예외 화면이면 바로 고객 행동/재시도/실패(판단 호출 없음) → 다음 정해진 행동의 화면 단서가 맞으면 그대로 실행(판단 호출 없음, 비용 0) → 단서가 다르면 「화면 이탈」로 기록하고 그 단계 나머지는 판단 모델이 작업서 설명·성공 사례(`PlannerInput.reference`)를 참고해 고른다. 어느 쪽이든 실행 전 같은 검사(`validateDecision`). 프롬프트는 `buildPlannerPrompt`가 작업서·사례(지시)와 화면 글(신뢰하지 않는 데이터)을 나눠 만든다.
- **통계**: 작업마다 `plannerCalls`·`playbookActions`·`deviatedSteps`를 남긴다.
- **연습 모드** (`practice.ts`): `runPractice`가 시험용 쇼핑몰·시험용 PC에 연결된 실행기로 작업서를 처음부터 끝까지 실행하고 `AutomationPracticeRun`(결과·멈춘 단계·사유 코드·소요 시간·판단 호출 수·작업서 행동 수·비용·이탈 단계)을 남긴다. `playbookReadiness`: 같은 버전의 최근 연습이 **연속 5회(`PRACTICE_STREAK_REQUIRED`) 화면 이탈 없이 성공**해야 `verified`. 연속 횟수는 고객 작업에서 마지막으로 이탈이 난 시각(`lastDeviationAt`, 이탈이 생길 때만 기록) 뒤의 연습만 센다(이탈 전 성공은 바뀐 화면을 검증하지 못했으므로). 고객 작업에서 이탈이 생기면(관리 화면 변경 의심) `needsReverify`가 되고 지원 목록(`supportedPlaybookIds`)에서 빠진다 → 다시 연습해 검증.
- 비밀값은 작업서·연습 기록에 넣지 않는다(작업서는 secretRef 이름만, 기록은 사유 코드만).
- 현재 작업서: `cafe24` v1 **초안(draft)** — 화면 단서·기준 이미지·성공 사례는 시험용 쇼핑몰 연습 전이라 가정값·빈 값이다. 연습으로 채운다.
- **지원 목록 밖 구매 차단**(MASTER 판단 2026-10-04, 대표님 원지시 「개별 검증 후 지원 목록에 추가」): 구매·재설치·무료 재연결 모두 결제 전에 쇼핑몰 주소(재연결은 주소가 없으면 이전 작업의 작업서)로 작업서를 고르고, 그 작업서가 지금 `verified`가 아니면 `shop_not_supported`(409, 안내 「아직 자동 연결할 수 없는 쇼핑몰입니다. 직접 설정으로 연결해 주십시오」)로 거부한다. 재검증 대상이 되면 다시 검증될 때까지 막힌다.
- 아직 안 한 것: 실제 시험용 쇼핑몰 연습, 기준 이미지 확보, 연습 실행을 정기적으로 돌리는 장치.

### 내부 주소 접속 차단 (정본 c4cc711)

- 쇼핑몰 주소로 작업서를 고를 때(`playbookForShopUrl`) 서버는 그 주소에 접속하지 않는다(주소 문자열의 호스트 이름만 비교, HTTP·DNS 요청 없음 — 단위 테스트가 fetch 0회를 확인).
- 브라우저 이동은 서버가 https·기본 포트·허용 호스트만 승인하고, 실제 실행기는 DNS 확인 뒤·리다이렉트마다 IP를 다시 검사해 localhost·사설망·링크로컬·메타데이터 주소를 거부해야 한다(`ports.ts` `BrowserExecutor` 계약 주석).

## 6. 동시 실행·급성장 대응

- 분리: 자동 연결은 전용 테이블·전용 잠금(advisory lock `automation_claim`)만 쓰고 판매자 행을 잠그지 않는다. 작업자는 웹 서버와 다른 프로세스로 띄운다(진입 모듈 `lib/server/automation/worker.ts`의 `runWorkerLoop`).
- idempotency: 판매자별 `Idempotency-Key`(`@@unique([sellerId, idempotencyKey])`), 판매자당 열린 작업 1개(부분 유니크 `AutomationJob_one_open_per_seller`), 결제별 PG 요청 id = 청구 id, 결제 1건에 작업 1개(`@@unique([sellerId, paymentId])`), 작업별 쓰기는 fencing 토큰.
- 같은 OBS 대상 잠금: 고르기에서 제외 + 부분 유니크 `AutomationJob_one_running_per_obs_target`. 처음 연결은 판매자 키(`seller:<id>`), 재연결·재설치는 요청한 PC 키로 시작하고, 실행마다 OBS를 처음 바꾸기 직전에 로컬 도구가 알려 준 실제 PC로 잠금 키(`obs:<pairing>`)를 옮긴다(요청 값·이전 기록을 믿지 않음). 그 PC에서 다른 작업이 실행 중이면 OBS 변경 0회로 `obs_target_busy` 재시도.
- lease·fencing: 자리를 잡을 때마다 토큰 +1. 작업자 쓰기는 `토큰 일치 AND 실행 중 상태 AND lease 살아 있음`일 때만. 만료 회수·취소도 토큰을 올린다.
- 동시성 상한: 전체 실행 수(기본 20)를 잠금 안에서 세고 고른다. 공정 처리: 판매자당 열린 작업 1개 + `runAfter` 순(FIFO)이라 한 판매자가 자리를 독차지하지 못한다.
- 고객 행동 대기 중에는 lease를 반납한다(다른 작업이 그 자리를 쓴다).
- timeout: lease(기본 60초). 작업자는 행동마다 연장하고, 따로 heartbeat가 lease의 1/3마다 연장해 관찰·판단·실행 호출이 오래 걸려도 회수되지 않는다. 연장이 어떤 이유로든 실패하면(만료·취소·다른 작업자·실행 시간 상한·DB 오류) 다음 외부 행동 전에 멈추고, 진행 중이던 외부 호출이 돌아온 직후에도 다시 확인해 그 결과를 쓰지 않는다(진행 중이던 호출 1개는 끝까지 갈 수 있다). 연장을 못 하면 회수. 단계당 행동 12번 상한. 고객 행동 마감 24시간.
- 판단 모델(확정 ⑦, 2026-10-04): Pro급. 모델 이름은 `AUTOMATION_PLANNER_MODEL`(기본 `gemini-2.5-pro`, 연결 때 공식 목록으로 재확인)로 바꾼다. 실제 키 연결·호출·대규모 부하 시험은 시작 전에 MASTER 경유 재승인.
- 월 한도(2026-10-05 대표님 결정, `budget.ts`): 외부 유료 API(지금은 판단 모델 `gemini`) 비용을 원장 `ExternalApiCostLedger`에 남기고 월(KST) 합계 `ExternalApiUsage`를 올린다. 합계가 월 1만 원(`EXTERNAL_API_MONTHLY_LIMIT_WON`, 낮추는 값만 받음)에 닿으면 `stoppedAt`을 남기고 그 달은 멈춘다: 새 구매는 결제 전에 `service_paused`(503), 이미 접수된 작업은 판단 호출 직전에 `budget_limit`으로 끝낸다(변경 뒤면 정리 필요 경로, 결제는 환불 대기). 소프트 상한이라 동시에 진행 중인 호출 몫만큼 넘을 수 있다. 연습 모드는 판단 모델을 쓰지 않는 시험용이라 이 한도를 보지 않는다.
- 비용 상한: 판단 호출 비용을 `costUsed`에 쌓고 작업 생성 때 정한 `costLimit`(`AUTOMATION_COST_LIMIT_WON`, 기본 3,000원 = 예상 약 500원의 6배, 실측 후 조정) 초과 시 멈춘다. 상한을 끄는 값은 받지 않는다.
- 결제 대사: 결과를 못 받은 PENDING 청구는 작업자 반복이 1분 뒤부터 PG에 다시 묻고,  결제 요청 보낸 기록(`chargeSubmittedAt`, outbox)을 보내기 직전에 남긴다. PG에 기록이 없고 작업이 결제 대기(`AWAITING_PAYMENT`)면 — 결제 행만 만들고 요청 전에 멈췄거나(null) 요청이 PG에 닿지 않았으면(1분 지남) — 대사가 작업 행을 잠그고 같은 청구 id로 다시 보낸다(PG가 같은 id는 한 번만 결제). 취소된 작업은 다시 보내지 않는다. 「결제 안 됨」 마감은 첫 제출 시각(`chargeFirstSubmittedAt`) + 30분으로 고정한다. 대사는 고르기와 점유를 한 문장(`UPDATE … RETURNING`, `FOR UPDATE SKIP LOCKED`)으로 해 여러 작업자가 동시에 돌아도 같은 청구는 한 작업자만 PG에 묻고, 확인 간격(1분)이 지난 건만, 확인한 지 오래된 순(`lastCheckedAt`, 처음이면 먼저, 같으면 id 순)으로 50건씩 보고 확인 직전에 시각을 남겨, 앞 건이 계속 오류여도 뒤 건이 다음 회차에 확인된다. 다시 보내기는 그 전까지만 하고, 마감 뒤에는 마지막 제출(`chargeSubmittedAt`)에서 반영 지연 유예 2분이 지나고도 PG에 기록이 없으면 작업만 `FAILED(payment_unresolved)`로 닫아 열린 작업 칸을 푼다. 결제는 PG가 결과(승인·실패)를 확정해 줄 때까지 실패로 확정하지 않고 `PENDING`(대사 대상)으로 남겨 계속 묻는다. 늦게 승인이 확인되면 작업을 다시 열지 않고 결제를 `REFUND_PENDING(payment_unresolved)`로 두고 로그 추적 `automation.paid_after_close`를 남긴다(판매자 돈만 빠진 상태가 남지 않음, 실제 환불은 승인 뒤). 결제 요청 뒤 24시간이 지나도 미확정이면 마스터 관리자 알림(`automation.payment_unresolved`) 1건(`unresolvedAlertedAt`).

## 7. 측정 (모의 부하, 2026-10-03 KST, 이 세션 컨테이너 + 로컬 Postgres 16)

`tests/integration/automationLoad.test.ts`: 작업자 10개, 동시 상한 20, 가짜 실행기 행동당 5ms 지연. 같은 시간에 주문 API(`POST /api/shop/[slug]/orders`)를 순서대로 호출.

| 상황 | 자동 연결 처리 | 주문 API p50 / p95 / 최대 |
|---|---|---|
| 부하 없음(40건) | — | 32.8 / 46.1 / 51.9ms |
| 작업 10개 | 522ms, 19.2건/초, 최대 동시 10 | 31.6 / 58.8 / 95.1ms |
| 작업 50개 | 1,719ms, 29.1건/초, 최대 동시 10 | 42.3 / 65.7 / 72.9ms |
| 작업 100개 | 3,229ms, 31.0건/초, 최대 동시 10 | 43.8 / 59.3 / 69.0ms |

- 한계: 같은 프로세스·같은 DB의 모의 측정이다. 실제 Gemini·브라우저 지연, 작업자 CPU·메모리(브라우저 context당 수백 MB 예상), 운영 DB 연결 수는 반영하지 않았다. 실제 용량 목표는 실행기 연결 후 다시 잰다. VM 한 대 구성을 고가용성으로 보지 않는다.

## 8. 판단 필요 (미확정)

- **판단 필요 — 결제 공급자 인터페이스에 중단 신호 넣기 (Codex 47차)**: 자동 연결의 결제 조회·청구는 `callPort` 상한으로 묶어 작업자가 묶이지 않고 결제는 PENDING으로 남는다. 다만 `BillingProvider`는 구독 결제(`lib/server/billing`)와 함께 쓰는 공용 인터페이스라 메서드에 `signal`을 필수로 넣는 변경은 이 PR의 소유 범위 밖이다. 실제 PG 연동 때 공용 인터페이스에 `signal`을 넣고 구독 결제 쪽 호출도 함께 고친다.
- **미완료 — E3-W 자동 되돌리기 전체 (Codex 44차, 후속 PR)**: 지금 자동 되돌리기(`runRollback`)는 실행 시작 때 작업서 버전 변경·검증 해제로 멈추는 경로에서만 한다. 실행 중 실패(`failed`)·확인 실패(쇼핑몰·PC 식별값 없음)·재시도 소진·실행 시간 마감으로 끝나는 작업은 바꾼 것이 있으면 되돌리지 않고 「정리 필요」(결제 보류, 마스터 관리자 알림, 운영자가 정리 뒤 닫기)로 둔다. 안전 쪽 동작이다. 이 경로들을 한 종료 함수(되돌리기 → 확인되면 실패, 아니면 정리 필요)로 모으면 실패할 때마다 외부 행동(되돌리기)이 늘고, PC 불일치처럼 대상이 의심스러운 안전 정지에서도 되돌리기가 돌 수 있어, 경로별 허용 범위를 정해 E3-W에서 한다.
- Gemini 키 연결·실제 호출·대규모 부하 시험(확정 ⑦: 시작 전 재승인), 비용 상한 실측 조정.
- 실제 환불 실행(REFUND_PENDING → REFUNDED): PG 환불 API와 승인 절차(대표님 승인 대상).
- 「권한 해제」 감지: 기록 함수 `markConnectionRevoked`(`connection.ts`, 무료 재연결 확정과 같은 판매자 잠금을 먼저 잡아 순서를 맞춤. 해제는 작업 상태와 무관하게 판매자·쇼핑몰 단위 `AutomationShopRevocation`에 남겨, 설치 작업이 진행 중일 때 온 해제도 작업이 끝난 뒤 무료 재연결 판정이 본다 — 해제 시각이 기준 작업 생성 뒤면 무료 아님)는 있고, 앱 삭제·권한 회수 알림에서 부르는 경로는 외부 연동 단계(TODO). **감지 경로가 생기기 전에는 30일 안 같은 쇼핑몰·PC면 무료로 판정되므로 실제 판매를 열지 않는다**(MASTER 검수 2026-10-04).
- 재연결 대상 확인: 무료 판정은 요청 값(`shopKey`·`obsPairingId`)으로 하되, 작업자가 **첫 변경 행동(클릭·입력·OBS 설정·테스트 주문) 바로 전에**(이동·관찰·고객 로그인 대기는 그 전에 허용) 실행기·로컬 도구에서 읽기만으로 지금 연결된 쇼핑몰(`currentShopKey`)·PC(`currentPairingId`)를 받아 기준 작업과 대조한다. 다르면 `reconnect_target_mismatch`, 알 수 없으면 `reconnect_target_unverified`로 변경 행동 0회에 실패한다. 통과하면 그 쇼핑몰·PC와 시각(`targetVerifiedAt`)을 작업에 남겨, 재시도 때 브라우저 단계부터 다시 하지 않으면 쇼핑몰은 다시 대조하지 않는다. PC(OBS pairing)는 **OBS를 바꾸기 직전마다** 로컬 도구에서 새로 읽어 대조한다(앞선 대조 기록을 믿지 않음. 브라우저 단계 뒤 PC가 바뀌면 OBS 변경 0회로 mismatch). 서버가 따로 아는 PC 등록 정보(pairing 목록)는 로컬 연결 도구가 생기면 판정 시점 대조에 더한다.
- 결제 수단: 1차는 구독용 등록 카드(빌링키)로 일회 결제한다. 카드 없는 판매자의 일회 결제창(PG 결제창)은 billing 공통 코드 확장이 필요하다. PG 결과 조회에 금액이 없어(`PaymentLookup`) 금액 대조를 못 한다.
- 직원(대표자 아님)에게 조회·재개를 열지. 지금은 대표자 전용.
- `sellerId` 외래키: Seller 모델에 역관계 한 줄이 필요해(다른 모델 수정 금지) 두지 않았다. 판매자 삭제 시 정리 정책과 함께 결정.

## 9. 구독별 OBS 연결 계약 제안 (2026-10-07 KST)

상태: 대표님 최신 구독 방향을 반영한 개발 검토안입니다. 기존 결제·환불·기기 권리와 구현을 이 문서만으로 바꾸지 않습니다. 근거 기준 main은 04660460이며, 기존 작업 골격은 위 1~8절 그대로입니다.

### 기본 제공과 자동 연결 상품의 차이

| 구분 | 쇼핑몰 통합 구독 INTEGRATED | 오버레이 전용 구독 OVERLAY_ONLY | 110,000원 자동 설치·연결 구매 |
|---|---|---|---|
| OBS 연결 | 기존 구독에 포함합니다 | 미연결이 기본입니다 | OBS 연결·오버레이 소스 설치가 포함됩니다 |
| 오버레이 URL·직접 사용 | 유지합니다 | URL 제공·사용자의 직접 OBS 브라우저 소스 사용을 유지합니다 | 직접 사용 권리를 없애지 않습니다 |
| 사용자 준비 | 최초 OBS·로컬 연결 도구 설치와 PC 연결 승인 | 웹훅 직접 연결과 수동 OBS 사용, 필요하면 자동 연결 구매 | 최초 PC 승인·쇼핑몰 로그인·추가 인증·권한 부여 |
| 웹훅 설정 | 판매자가 연결합니다 | 판매자가 연결합니다 | 기존 지원 쇼핑몰의 연결·웹훅 설정을 대신 자동 처리합니다 |
| 자동화 범위 | 로컬 OBS 연결·소스 생성·표시 설정·검증 | 기본 자동 PC 제어는 제공하지 않습니다 | 쇼핑몰 관리 설정부터 OBS 테스트 표시 확인까지 기존 E3를 수행합니다 |

통합 구독의 기본 제공은 전체 서비스 무료를 의미하지 않습니다. 기본 OBS 연결을 유료 AutomationPayment 구매 경로에 억지로 넣지 않으며, 기존 OVERLAY 기능만으로 PC 원격 제어를 허용하지 않습니다. 유료 작업은 기존 PAID 서버 검증 뒤 실행하고, 결제 실패·취소·환불 상태에 신규 실행 권한을 주지 않습니다. 이미 완료한 연결의 유지·회수는 기존 결제 권리와 별도로 검토해야 하며 임의 소급 변경하지 않습니다.

30일 같은 쇼핑몰·PC 무료 재연결, 그 밖의 33,000원 재설치, 기존 환불·동의 버전은 그대로입니다. 이 값은 유료 상품의 서비스 정책이며 30일 뒤 정상 연결을 강제로 끊는 기기 인증 만료 정책이 아닙니다. 통합 구독 기본 연결과 유료 쇼핑몰 설정 대행의 OBS 작업은 겹칩니다. 공통 도구·연결 확인을 재사용하고, 이미 정상인 소스는 다시 만들거나 그 작업만으로 자동 결제하지 않습니다. 통합 구독에서 유료 재설치 사유 중 PC 변경을 어떻게 안내할지는 상품 고지 정합화 항목으로 남깁니다.

### 연결 구조와 최초 승인

- 주문 표시 데이터는 기존 overlay SSE·상태 조회·버전 복구를 유지합니다. OBS WebSocket은 OBS 설정·제어용이며 주문 웹훅이나 영상 전송을 대체하지 않습니다.
- 권고 구조: 판매자 웹훅 → 기존 주문/overlay SSE → OBS 브라우저 소스. PC 제어는 인증된 서버 명령 → 로컬 연결 도구의 출발 WSS → 같은 PC의 OBS WebSocket입니다. 기존 VM 외 새 유료 인프라는 전제하지 않습니다.
- OBS 28 이상은 obs-websocket을 기본 포함합니다. 최초 OBS와 연결 도구 설치·PC 연결 승인은 필요합니다. 웹훅만으로 로컬 PC를 제어할 수 없습니다. Windows부터 지원·bootstrap 실검증하며 다른 OS 지원을 미리 약속하지 않습니다.
- 연결 도구가 승인된 로컬 설정 경로에서 OBS 설치·서버 활성화·자격증명·브라우저 소스를 자동 처리하도록 구현합니다. WebSocket 자체는 비활성 서버를 켜거나 PC 프로그램을 설치할 수 없습니다. bootstrap은 별도 OS 권한 경계이며 기존 OBS 비밀번호를 무단 교체하거나 실행 중 방송을 재시작하지 않습니다. 불가능하면 PC 승인/설치 필요 상태를 표시합니다.
- OBS 암호·주소·오버레이 토큰을 사용자가 복사하지 않도록 하되, 암호를 URL·명령행·브라우저 저장소·모델 입력·로그에 넣지 않습니다. OBS 암호는 로컬 OS 보안 저장소, 클라우드는 해시된 기기 인증 정보만 사용합니다. OBS 포트를 인터넷에 공개하거나 공유기 포트 개방을 요구하지 않습니다. 실제 listen 범위·방화벽은 OS별 검증 항목입니다.

### 인증·명령·복구 계약

- 연결 가능 권한과 관측된 연결 상태를 분리합니다. 권한은 서버의 실제 구독/기능 상태 또는 결제 검증된 유료 작업 위임으로 판정합니다. 클라이언트의 plan·sellerId·paid 값은 근거가 아닙니다. 화면은 연결 권한 없음, PC 연결 승인 필요, 도구 오프라인, OBS 미실행/인증 실패, 정상 연결을 구분합니다.
- 페어링은 로그인한 대표자의 일회·단기 코드와 PC에서 확인한 판매자/기기 승인으로 확정합니다. sellerId·deviceId·pairing generation을 고정하고 코드 재사용·다른 판매자 교차 수락을 거부합니다. 직원은 명시 OBS 권한이 필요하고 마스터 대리 조회는 쓰기 권한을 얻지 않습니다.
- 지속 기기 인증과 AutomationJob 임시 위임은 별도 수명입니다. 기존 ObsBridge.discard(scope)는 해당 작업의 토큰·행동 키·tombstone만 관리하고 다른 작업이나 지속 기기 등록을 지우지 않도록 어댑터를 둡니다. 연결 해제/PC 교체/권한 회수는 generation을 올리고 진행 중·지연 명령을 차단합니다. 기기 소유권 변경은 별도 재페어링입니다.
- 명령 계약: commandId, 서버가 확정한 sellerId/deviceId/generation, 권한 scope, target source/scene 식별자, expiresAt, request fingerprint, fencing epoch. 유료 job 변경은 기존 jobId·step·행동 의미로 만든 exact actionKey를 그대로 재사용합니다. 같은 키·같은 내용은 기존 결과, 같은 키·다른 내용은 409이며 새 순번으로 중복 적용하지 않습니다.
- RECEIVED → APPLYING → APPLIED 또는 FAILED 상태와 관측 증거를 구분합니다. OBS RequestResponse의 requestId/result는 요청 응답이며 자체 영속 중복 방지나 화면 표시 증거가 아닙니다. 서버 내구성 기록과 로컬 실행 저널을 두고 apply 뒤 ACK 유실·PC 종료 시 재연결 후 실제 소스/설정을 읽어 대사합니다. 적용 여부가 불명확하면 UNKNOWN으로 두고 무조건 재실행하지 않습니다.
- 초기 허용 명령은 버전/상태 조회, ONQ 소유 브라우저 소스의 생성·설정·검증·해당 작업 rollback입니다. 임의 RPC·외부 주소·다른 소스 삭제·파일 접근은 허용하지 않습니다. obs-websocket 암호를 아는 연결이 판매자별 세부 권한을 자동 보장한다고 가정하지 않고 연결 도구에서 allowlist를 적용합니다.
- 출발 연결은 heartbeat·지수 backoff/jitter·상한·판매자별 공정 큐·기기별 직렬화·lease/fencing을 사용합니다. 재연결 시 현재 OBS·명령 저널·overlay 최신 버전을 맞추고 과거 이벤트/만료 명령을 그대로 재생하지 않습니다. 한 PC의 여러 OBS 인스턴스·scene collection은 별도 대상 식별이며 서로 설정을 덮어쓰지 않습니다.
- ONQ 방송 시작/종료 상태와 OBS 실송출 시작/종료를 구분합니다. 실송출은 사용자의 명시적 최신 입력과 현재 대상·권한 확인이 있어야 합니다. 설치·테스트 주문·재접속·스케줄러·웹훅은 실송출/녹화/장면 전환을 자동 실행하지 않습니다. Start/Stop은 오프라인 큐에 보관했다가 자동 재생하지 않고 Toggle을 쓰지 않습니다.
- 미리보기는 기존 오버레이 렌더 또는 별도 동의한 제한 이미지부터 분리합니다. GetSourceScreenshot은 정지 이미지이며 실시간 영상 채널이 아닙니다. 영상 미리보기의 전송·코덱·부하·개인정보 계약은 후속 별도이며 영상 송출 성공으로 연결 설치를 판정하지 않습니다. 기존 완료 기준은 실제 시험 이벤트가 해당 PC 오버레이에 표시되는 것입니다.

### 개발 소유와 검증 경계

| 담당 | 최소 소유 범위 | 완료 근거 |
|---|---|---|
| 서버 기기/명령 | 신규 lib/server/obs 계약·페어링/명령 API·해당 모델/마이그레이션. 기존 automation과 overlay SSE는 소유자와 연결 경계만 협의 | 구독/서버 결제 권한·tenant 격리·명령/ACK 대사 통합 검증 |
| PC 연결 도구 | bootstrap·OS 보안 저장소·출발 인증·OBS 5.x 어댑터·로컬 저널 | 승인된 시험 PC에서 소스 설치/재연결/실표시, 실송출 0회 |
| 디자인/UI | SA-051/052/055 및 SA-150~153·온보딩의 FINAL source 선행 | 구독별 기본/구매 배너·안내→결제→자동 연결, 권한과 연결 상태 구분 |
| 독립 검수 | 다판매자·다기기·장애 주입·실표시 검수 | 모의 계약, 실제 PC, 실제 외부 연동 증거를 분리 |

다음 최소 개발 PR은 지속 기기/명령 입력·권한 결정 계약과 모의 전송 검증으로 제한할 수 있습니다. 기존 FakeObsBridge·ObsBridge/actionKey를 재사용하되 테스트용만 연결하고 실제 API·DB·설치기·외부 RPC를 만들지 않습니다. 신규 lib/server/obs/contract.ts와 해당 tests/unit/obsConnectionContract.test.ts를 한 소유자에게 배정하는 안입니다. 기존 ports.ts/fakes.ts/결제 코드는 수정하지 않습니다. 계약 단위 통과를 실제 인증·PC 연결 완료로 보고하지 않습니다.

필수 반례: 통합/오버레이 구독 분기, 수동 URL 사용 보존, 클라이언트 plan 위조, 결제 실패·취소·중복 callback·동시 요청, 다른 판매자/기기의 페어링/명령/ACK, revoked generation·늦은 ACK·apply 뒤 crash, 같은 actionKey 내용 변경·중복 소스, OBS 재시작/도구 오프라인/구독 변경, 한 기기 지연이 다른 판매자에 미치는 영향, 설치와 재연결에서 실송출 0회. 목표 지연·판매자/기기 용량은 기존 VM에서 측정 후 정하고 무중단을 보장했다고 표현하지 않습니다.

공식 근거: [obs-websocket README](https://github.com/obsproject/obs-websocket#using-obs-websocket), [5.x 프로토콜](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md) (2026-10-07 KST 확인). CreateInput·SetInputSettings·GetStreamStatus·GetSourceScreenshot과 인증/RequestResponse를 확인했습니다. 입력 kind와 browser_source 설정 키는 해당 OBS 설치의 GetVersion/입력 종류·기본 설정 조회로 확인하고 고정 가정하지 않습니다.

### 후속 최소 범위: 기기 페어링 저장 계약 (2026-10-07 KST, 설계 검토 반영·구현 독립 검수 전)

기준 main은 reader가 병합된 `23b4086d`입니다. 이 절은 다음 구현의 범위안이며 현재 PC 연결·기기 인증·명령 권한 발급이 완료됐다는 뜻이 아닙니다. 기존 `readObsConnectionEligibility`의 `pairing_required`는 구독/INITIAL 작업 자격의 저장값 판정이며 연결 성공이나 `ObsAuthority`가 아닙니다.

| 신규 저장 모델 | 최소 필드와 경계 |
|---|---|
| `ObsPairingChallenge` | 서버 발급 UUID, PC 도구에 한 번 전달할 256비트 verifier의 해시, DB 시계 기준 만료(초기 제안 5분), 최초 승인의 sellerId/actorId와 승인 시각, 일회 소비 시각, 확정 deviceId. 기기 표시명은 길이 제한된 안내값이며 PC 소유권 증거가 아니다. 유료 INITIAL을 선택했다면 해당 jobId도 승인 때 고정한다. |
| `ObsDevice` | 서버 발급 UUID, 고정 sellerId, 서버 발급 기기 credential의 해시, generation, 등록/철회 시각. seller-device 복합 키로 다른 판매자 연결을 막는다. 설치 job의 obsPairingId·fencingToken을 이 모델의 인증 근거로 복사하지 않는다. |

- 모델은 additive migration으로 추가한다. Seller 역관계와 seller 외래키·seller/device 복합 키·해시 유일 제약·만료 조회 인덱스만 추가하며 기존 subscription/payment/AutomationJob 열·결제 상태·가격을 바꾸지 않는다. challenge는 만료돼도 승인/소비 상태를 되살리지 않는다.
- 초기 경로는 PC challenge 생성 → 로그인한 대표자의 같은 PC 확인·승인 → PC 도구의 현재 verifier 확인과 명시 동의 → 서버의 원자적 소비·기기 등록이다. 대표자 세션은 기존 서버 guard/CSRF를 사용하고 대리 조회·직원 승인은 초기 범위에서 닫는다. 최초 등록/권한 해제에 대한 동의 문구 버전과 서버 시각을 기록한다.
- challenge 생성·확정 경로는 별도의 제한된 미인증 bootstrap이며 판매자 cookie guard를 느슨하게 만들지 않는다. 발급/검증 횟수 제한·요청 크기/시간 상한·만료 조건을 두고, verifier는 본문 또는 인증 헤더만 사용한다. URL·로그·브라우저 저장소에 넣지 않는다. 대표자 승인 뒤 seller/job 범위를 변경하거나 다른 판매자 세션이 재승인하지 못한다.
- 대표자 승인은 구독/유료 INITIAL 저장값을 조회하고, PC 확정 때 같은 범위를 새로 조회한다. 두 시점 사이 미결제·만료·철회·job 취소/lease 만료가 발생하면 확정하지 않는다. OVERLAY_ONLY의 manual_only는 수동 사용을 유지하지만 이 경로의 자동 기기 등록 자격은 아니다.
- PC 요청의 `consent=true`만으로 실제 PC 동의를 검증했다고 주장하지 않는다. 서버는 양쪽 확인의 상태/nonce/verifier와 동의 버전을 확인할 뿐이며, 실제 화면에서 현재 PC 사용자에게 승인받는 helper와 그 독립 검증은 후속 범위다. helper가 없는 이번 서버 단계는 실제 PC 승인/연결 완료가 아니다.
- 만료되지 않은 미소비 challenge의 조건부 갱신, device 생성, 기존 `writeAudit` 기록은 한 트랜잭션에서 수행한다. 동시에 확정해도 한 번만 성공하며 감사 기록 실패 시 등록도 롤백한다. 명시 승인 없이 기존 기기를 교체하거나 sellerId를 바꾸지 않는다.
- credential은 확정된 PC에 한 번만 반환하고 서버에는 기존 `generateToken/hashToken` 방식의 해시만 남긴다. PC는 OS 보안 저장소에 저장한다. helper는 소비 요청 전에 challenge ID와 승인된 기기 ID를 보존해야 한다(실helper 구현은 후속). 응답 유실 뒤 원문 credential을 DB에서 복구/재반환하지 않는다. 새 challenge의 대표자 승인에서 `replacesChallengeId`로 같은 판매자·대표자의 기존 발급을 지정하고, 현재 device generation을 대조해 기존 tokenHash 회수·generation 증가를 원자 처리한 뒤 새 PC 소비를 허용한다. 이전 credential을 남긴 채 응답 유실을 자동 새 등록으로 처리하지 않는다. OBS 암호·쇼핑몰 자격증명은 이 저장 모델에 넣지 않는다.
- 기기 철회는 인증된 대표자의 sellerId/deviceId/current generation 조건으로 수행하고 generation을 증가시켜 기존 credential/지연 명령을 거부한다. 반복 철회는 추가 권한을 만들지 않는다. `writeAudit`에는 challenge/device ID·generation·상태·사유만 허용하며 verifier/credential/해시·OBS 암호는 넘기지 않는다. 기기 철회와 기존 쇼핑몰 권한 해제/무료 재연결 과금 정책을 같은 사건으로 간주하지 않는다.
- 등록된 기기는 인증 대상일 뿐 영구 명령 권리가 아니다. INTEGRATED 명령에는 현재 서버 구독 검사, 유료 INITIAL 명령에는 현재 job scope/lease/fencing 검사가 별도로 필요하다. OVERLAY_ONLY의 완료 job만으로 지속 제어·재페어링 권한을 발급하지 않으며 정의 전에는 제한 상태를 유지한다. 수동 overlay URL 사용은 차단하지 않는다.
- 현재 계약의 `device.epoch === job.fencingToken` 혼합을 분리한다. 기기 인증의 generation과 명령/job별 fencing은 다른 수명이다. 서버 명령 권한에는 jobFence를 별도로 두고 INITIAL은 현재 jobFence로 검증한다. 서버가 명령에 현재 jobFence를 찍고 ACK도 같은 jobFence를 요구한다(이전 fence/미포함 ACK는 UNKNOWN). 기존 exact actionKey·임시 discard scope를 유지하고 fence 갱신만으로 UNKNOWN 행동을 다시 실행하지 않는다. 이전 INITIAL 모의 계약의 동일 epoch 강제는 독립 fence/늦은 ACK 반례로 교체하며 기존 판매자·결제·lease·단계·PC 거부 반례는 보존한다.

최소 API는 `/api/obs/pairing/challenges`(PC 생성), `/api/seller/obs/pairing/challenges/[id]/approve`(대표자 승인), `/api/obs/pairing/challenges/[id]/consume`(PC 확정), `/api/seller/obs/devices/[id]/revoke`(대표자 철회)이다. 대표자 경로는 기존 seller cookie/Origin/대리 조회 보호를 유지하고, PC bootstrap은 cookie를 거부하며 consume에 정확한 서버 발급 verifier와 저장된 seller/device 대조를 요구한다. 요청은 2KiB/5초 상한, challenge 발급은 DB 공유 잠금으로 전체 100회/분 상한이다(대량 공급/공정성 목표를 충족했다고 주장하지 않는다). challenge ID가 노출돼도 verifier와 대표자 승인 없이 credential을 얻을 수 없어야 한다. 명령·WSS·helper 설치·영상·방송 시작/종료 API는 이 PR 범위가 아니다. 일반 API 인증을 느슨하게 만들지 않는다.

표적 검증: 만료 경계·challenge 재사용/동시 소비·교차 seller/device/job·대표자/PC 한쪽만 승인·승인 이후 구독/job 변경·해시만 저장·감사 실패 롤백·철회 후 credential/generation·응답 유실·완료/재설치/무료 재연결 job를 INITIAL로 승격하지 않는 반례를 격리 폐기 DB에서 수행한다. 기존 INITIAL 계약 시험은 정책 회귀를 확인하며 운영 DB migration·실기기 동의 조작·실송출·실결제는 실행하지 않는다.

비용/롤백: 기존 VM/DB에 짧은 challenge와 기기 행을 추가하고 외부 유료 인프라/API를 전제하지 않는다. 실제 저장량·발급 제한은 측정 대상이다. 앱 롤백은 신규 등록과 제어를 닫고 기존 표·해시·로그를 보존한다. 운영 down migration이나 credential 원문 복구는 하지 않는다. 판단 필요는 OVERLAY_ONLY 완료 연결의 지속 제어/재페어링 근거, 통합 기본 PC 변경과 유료 재설치 고지, 응답 유실/PC 교체 시 기존 기기 처리이다. 정의 전에는 임의 권한 발급이나 기존 33,000원/30일 권리의 소급 변경을 하지 않는다.
