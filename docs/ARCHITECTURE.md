# 아키텍처 설계 (개발 1단계 · 기반)

> 작성: 2026-10-02 (KST) · 개발 전담(기반) · 상태: **확정** (2026-10-02 21:50 KST MASTER 검수, 판단 필요 11건 확정 반영)
> 범위: 서버 기반(DB·인증·권한·테넌트 격리·주문대기 도메인·실시간 전달). 화면(UI)·PG·알림톡·문자·배포는 제외.
> 표기: **[확정 제안]** 이 PR 병합 시 확정 · **[확정]** 대표님·MASTER 결정 반영 · **[비용]** 돈이 드는 선택(대표님 결정, 미정)

## 1. 기술 선택

| 항목 | 선택 | 근거 | 비고 |
|---|---|---|---|
| DB | **PostgreSQL 16** | 다중 판매자·다중 인스턴스, 트랜잭션·행 잠금·부분 유니크 인덱스(판매자당 「개봉 중」 1건 강제), `LISTEN/NOTIFY`(실시간 전달에 추가 자원 불필요). 망고TCG의 SQLite 단일 파일은 다중 인스턴스 불가 | [확정 제안] |
| ORM·마이그레이션 | **Prisma** (버전 고정, `latest` 금지) | 스키마 한 파일로 모델 검토가 쉬움, 마이그레이션 SQL이 저장소에 남아 리뷰 가능, 타입 생성으로 `tsc` 검사에 포함. 부분 유니크 인덱스·CHECK 제약 등 Prisma 문법 밖은 마이그레이션 SQL에 직접 추가 | 대안 Drizzle(가벼움, SQL에 가까움). 팀 규모·검토 편의로 Prisma 권고. [확정 제안] |
| 비밀번호 해시 | **argon2id** (`@node-rs/argon2`, 사전 빌드 바이너리) | 메모리 하드 해시, OWASP 1순위 권고. 네이티브 컴파일 불필요해 CI·서버 설치가 단순 | bcrypt는 72바이트 제한·GPU 내성 낮음. 설치 문제 시 대안 [확정 제안] |
| 세션 | **서버 세션 + HttpOnly 쿠키** | 무작위 256비트 토큰을 쿠키로, DB에는 SHA-256 해시만 저장. 즉시 강제 로그아웃·정지 반영 가능(JWT는 폐기 어려움) | [확정 제안] |
| 마스터 2단계 인증 | **TOTP(RFC 6238)** 자리 마련 | 비밀키는 AES-256-GCM 암호화 저장(키는 환경변수, 저장소 기록 금지). 1단계 구현에서는 필드·검증 함수·로그인 흐름 분기까지, 등록 화면은 UI 단계 | [확정 제안] |
| 테스트 | **Vitest** (단위) + 실제 Postgres 통합 테스트 | TypeScript 바로 실행, 빠름 | [확정 제안] |
| 실시간 | **SSE + Postgres `LISTEN/NOTIFY`** | 6절 | [확정 제안] |

공통 규칙
- ID: UUID(`gen_random_uuid()`). URL·오버레이에 순번 ID를 노출하지 않는다.
- 금액: 원 단위 정수(`Int`). 소수 없음.
- 시각: DB는 `timestamptz`(UTC 저장), 표시는 KST.
- 삭제: 주문·원장·감사 로그는 물리 삭제 금지. 상품·회원은 `deletedAt` 소프트 삭제.

## 2. 코드 배치

```text
prisma/schema.prisma, prisma/migrations/**   스키마·마이그레이션
lib/server/db.ts                              Prisma 클라이언트 (서버 전용, 'server-only')
lib/server/auth/                              해시·세션·TOTP·로그인 (영역별)
lib/server/authz/                             역할·권한 표, 가드 (requirePlatformAdmin, requireSellerUser …)
lib/server/tenant/                            테넌트 컨텍스트, 판매자 범위 쿼리 도우미
lib/server/queue/                             주문대기 상태 전이·순서·방송 전 주문 처리 (순수 함수 + 저장소)
lib/server/realtime/                          NOTIFY 발행·SSE 구독
lib/server/audit/                             감사 로그 기록
app/api/**                                    라우트 핸들러 (얇게: 인증 → 권한 → 도메인 호출)
tests/unit/**, tests/integration/**           테스트
```

도메인 로직은 `app/api`에 두지 않는다. 라우트는 인증·권한 확인 후 `lib/server/*` 함수만 호출한다.

## 3. 권한 계층과 테넌트 격리

### 3.1 인증 영역 3개 (완전 분리)

| 영역 | 주체 | 쿠키 | 로그인 | 세션 유지 |
|---|---|---|---|---|
| 마스터 | `PlatformAdmin` | `lo_admin` (경로 `/`, 마스터 호스트 한정) | 이메일+비밀번호+TOTP | 미활동 30분, 최대 8시간 |
| 판매자 | `SellerUser` (대표·직원) | `lo_seller` | 이메일+비밀번호 | 미활동 12시간, 최대 30일. 방송 LIVE 중에는 미활동 로그아웃 없음 |
| 구매자 | `BuyerMember` (판매자 쇼핑몰별) | `lo_buyer` (쇼핑몰 호스트 한정) | 4.3 참고 | 최대 30일 |

- 세션 테이블도 영역별로 분리(`AdminSession`, `SellerSession`, `BuyerSession`). 판매자 세션으로 마스터 API를 호출하면 세션 조회 자체가 실패한다 → **판매자는 마스터 기능에 접근 불가**가 구조적으로 보장된다.
- 쿠키 공통: `HttpOnly`, `Secure`(운영), `SameSite=Lax`. 상태 변경 API는 `Origin` 검사로 CSRF 차단.
- 판매자 미활동 로그아웃은 방송이 LIVE인 동안 적용하지 않고, 방송 종료 30분 뒤부터 다시 적용한다(디자인 AU-007). 최대 유지 시간은 그대로 적용.
- 로그인 실패 5회 → 10분 잠금(계정+IP 기준, 디자인 AU-001). 로그인·실패·잠금은 감사 로그.

### 3.2 마스터 역할

| 기능 | 최고관리자 | 운영 | CS | 조회 전용 |
|---|---|---|---|---|
| 전체 조회 | O | O | O | O |
| 판매자 승인·정지·해제 | O | O | X | X |
| 요금제·구독·청구 변경 | O | O | X | X |
| 고객 문의·공지 답변·작성 | O | X | O | X |
| 판매자 대리 조회(읽기 전용, 사유 필수) | O | O | O | X |
| 관리자 계정·역할 변경 | O | X | X | X |
| 시스템 설정·점검 모드 | O | X | X | X |
| 감사 로그 조회 | O | O | X | O |

- 표는 코드의 한 곳(`lib/server/authz/permissions.ts`)에 상수로 두고, 모든 마스터 API는 `requirePlatformAdmin(permission)`을 거친다. 조회 전용은 어떤 변경 권한도 갖지 않는다.
- 최고관리자는 최소 1명 유지(마지막 최고관리자 강등·정지 거부).
- [확정] 위 표대로 운영·CS 권한 경계를 둔다.

### 3.3 판매자 직원 역할

| 역할 | 내용 |
|---|---|
| `OWNER` 대표 | 전부. 구독·PG·직원 관리·적립금 실지급 스위치 |
| `MANAGER` 매니저 | 상품·주문·회원·문의·방송·오버레이. 구독·PG·직원·실지급 스위치 제외 |
| `BROADCASTER` 방송 담당 | 방송 대시보드(주문대기 조작·HIT·타이머)와 오버레이만 |

[확정] 직원 역할은 위 3개.

### 3.4 테넌트 격리 (판매자 간 차단)

1. **모든 판매자 데이터 테이블에 `sellerId` 필수.** 예외는 플랫폼 테이블(`PlatformAdmin`, 요금제, 감사 로그의 플랫폼 항목)뿐.
2. **판매자 범위 조회만 허용**: 판매자 API는 세션에서 `sellerId`를 얻고(요청 본문·쿼리의 `sellerId`는 무시), 저장소 함수는 `TenantContext { sellerId }`를 첫 인자로 받아 모든 `where`에 넣는다. ID 하나로만 조회하는 함수(`findUnique({ id })`)를 판매자 경로에서 쓰지 않는다 → 다른 판매자 ID를 넣으면 **없음(404)** 으로 처리해 존재 여부도 숨긴다.
3. **DB 제약으로 교차 참조 차단**: 자식 테이블은 `(sellerId, parentId)` 복합 외래키로 부모를 참조한다(예: 주문 품목 → 주문, 주문대기 → 주문 품목). 코드 실수가 있어도 다른 판매자 주문에 묶일 수 없다.
4. **구매자**는 쇼핑몰 호스트로 `sellerId`가 정해지고, 자기 회원 ID 범위만 조회한다.
5. **마스터 대리 조회**는 읽기 전용 컨텍스트(`{ sellerId, readOnly: true, actor: admin }`)로 판매자 조회 함수를 재사용하고, 변경 함수는 `readOnly`면 거부한다. 진입 시 사유와 함께 감사 로그.
6. 통합 테스트에 판매자 A·B를 만들고 B 세션으로 A의 주문·주문대기·회원·상품 조회·변경이 모두 거부되는지 검사한다.
7. [확정] Postgres 행 수준 보안(RLS)은 이번 단계에서 쓰지 않는다(Prisma 연결 풀과 세션 변수 결합이 복잡). 위 2·3으로 막고, 운영 전 보강 여부를 다시 정한다.

## 4. 데이터 모델 초안

상태값은 Postgres enum. 굵은 글씨는 주요 제약.

### 4.1 플랫폼

- `PlatformAdmin`: id, email(**유니크**), passwordHash, name, role(`SUPER_ADMIN | OPERATIONS | CS | READ_ONLY`), status(`ACTIVE | SUSPENDED`), totpSecretEnc, totpEnabledAt, failedLoginCount, lockedUntil, lastLoginAt, createdAt
- `AdminSession`: id, adminId, tokenHash(**유니크**), mfaVerifiedAt, ip, userAgent, expiresAt, lastSeenAt, revokedAt

### 4.2 판매자(쇼핑몰)·직원

- `Seller` (테넌트 = 쇼핑몰 1개): id, slug(기본 주소 하위 이름, **유니크**), shopName, status(`PENDING | ACTIVE | SUSPENDED | REJECTED | CLOSED`), businessInfo(JSON), approvedAt, approvedByAdminId, suspendedReason, representativeCiHash(대표자 PASS CI의 HMAC), liveVersion(실시간 version 카운터, 기본 0), createdAt — **대표자 1명당 쇼핑몰 1개**: representativeCiHash 부분 유니크(해지 `CLOSED`·반려 `REJECTED` 제외)
- `SellerDomain`: id, sellerId, hostname(**유니크**), verifiedAt, certStatus — 개인 도메인 연결용 자리만
- `SellerUser`: id, sellerId, email, passwordHash, name, role(`OWNER | MANAGER | BROADCASTER`), status(`ACTIVE | DISABLED`), failedLoginCount, lockedUntil, lastLoginAt — **(sellerId, email) 유니크**, 판매자당 OWNER 1명 이상
- `SellerSession`: id, sellerUserId, sellerId, tokenHash(**유니크**), expiresAt, lastSeenAt, revokedAt
- [확정] 한 사람이 여러 판매자의 직원이 되는 경우 판매자별 별도 계정(이메일 같아도 됨). 한 판매자가 쇼핑몰 여러 개를 갖는 경우는 지원하지 않음(별도 판매자로 가입).

### 4.3 구매자 회원 (판매자 쇼핑몰별)

- `BuyerMember`: id, sellerId, loginId, passwordHash, name, phone, phoneVerifiedAt, ciHash(PASS 본인인증 CI의 HMAC-SHA256, 원문 CI 미저장), identityVerifiedAt, broadcastNickname, gradeId, status(`ACTIVE | DORMANT | WITHDRAWN`), marketingConsentAt, createdAt, deletedAt — **(sellerId, ciHash) 유니크**(같은 쇼핑몰 중복 가입 차단), **(sellerId, phone) 유니크**, **(sellerId, loginId) 유니크**, **(sellerId, broadcastNickname) 유니크**(방송 화면에서 구분 가능하게). 네 유니크는 `deletedAt IS NULL`인 행에만 적용(부분 유니크 인덱스)
  - 탈퇴하면 `status = WITHDRAWN`과 `deletedAt`을 같은 트랜잭션에서 함께 기록하고 개인정보(이름·휴대폰·닉네임)를 비식별 처리한다. `DORMANT`는 삭제가 아니므로 `deletedAt`이 비어 있다. 주문·원장은 회원 id로 남는다.
- `MemberGrade`: id, sellerId, displayName, sortOrder, systemKey(nullable: `BASIC | SPROUT | SILVER | GOLD | VIP`) — 등급은 **id·displayName·sortOrder로 식별**한다. 판매자 생성 시 일반·새싹·실버·골드·VIP 5개를 기본으로 만들고 `systemKey`로 표시만 한다. 판매자가 추가한 등급은 `systemKey = null`. **(sellerId, displayName) 유니크**, **(sellerId, systemKey) 유니크(null 제외)**. 디자인 지시(`docs/DESIGN_PROMPT.md` 245줄) 「이름·개수는 판매자가 정한다」에 맞춰 고정 enum으로 식별하지 않는다. 적립률(`RewardPolicy.rates`)도 등급 id 기준. [확정]
- `PhoneVerification`: id, sellerId, phone, codeHash, purpose(`SIGNUP | RESET`), attempts, expiresAt, verifiedAt — 발송은 `SmsSender` 인터페이스 뒤에 두고 개발·테스트는 가짜 발송기만 쓴다(실제 문자 연동 제외).
- `BuyerSession`: id, buyerMemberId, sellerId, tokenHash(**유니크**), expiresAt, revokedAt
- 같은 사람이 다른 판매자 쇼핑몰에 가입하면 별도 회원이다(데이터 공유 없음).
- [확정] 구매자 로그인 수단은 「아이디+비밀번호」, 가입 시 휴대폰 인증 필수. 휴대폰 번호 로그인·카카오 로그인은 보류.
- [비용] 휴대폰 인증 문자 발송 업체 (PRODUCT_SCOPE 미확정 항목과 동일).

### 4.4 상품·옵션·재고

- `Product`: id, sellerId, name, description, price, status(`DRAFT | ON_SALE | SOLD_OUT | HIDDEN`), sortOrder, deletedAt
- `ProductImage`: id, sellerId, productId, storageKey, sortOrder — 저장소 구성은 미확정(PRODUCT_SCOPE)
- `ProductOption`: id, sellerId, productId, name(예: 「1팩」), priceDelta, stock(**CHECK stock >= 0**), sku, sortOrder — 옵션 없는 상품도 기본 옵션 1개를 둬 재고를 한 곳에서 관리
- `StockMovement`: id, sellerId, optionId, delta, reason(`ORDER | CANCEL | REFUND | MANUAL`), orderId, actor, createdAt — 재고 변경 이력
- 재고 차감은 `UPDATE … SET stock = stock - n WHERE id = ? AND sellerId = ? AND stock >= n`의 영향 행 수로 판정(초과 판매 방지).
- 주문의 모든 품목 차감은 **한 트랜잭션**에서 처리한다. 품목 하나라도 영향 행 수가 0이면 그 트랜잭션의 모든 차감을 되돌리고(롤백), 별도 트랜잭션에서 주문에 `stockShortageAt`만 기록한다. 일부 품목만 차감된 상태는 생기지 않는다.
- [확정] 재고 차감 시점: **결제 완료 시 차감**(선점 없음, 결제 완료 순). 동시 결제로 재고가 모자라면 늦게 결제된 주문은 `PAID`로 기록하되 `stockShortageAt`을 남겨 「취소·환불 대상」으로 표시하고, 주문대기는 만들지 않는다. 실제 PG 환불 연동은 다음 단계.

### 4.5 주문·주문 품목

- `Order`: id, sellerId, orderNo(판매자별 표시 번호, **(sellerId, orderNo) 유니크**), buyerMemberId, status(`PENDING_PAYMENT | PAID | CANCELLED | REFUNDED`), broadcastNicknameSnapshot, totalAmount, rewardUsedAmount, paymentMethod(`CARD | BANK_TRANSFER | …`), pgProvider, pgTxId, paidAt, stockShortageAt(재고 부족 표시), cancelledAt, refundedAt, createdAt
- `OrderItem`: id, sellerId, orderId, productId, optionId, productNameSnapshot, optionNameSnapshot, unitPrice, quantity
- `OrderStatusHistory`: id, sellerId, orderId, from, to, actor, reason, createdAt
- 상태 전이 (그 외 거부):

```text
PENDING_PAYMENT ─결제 확인─▶ PAID ─환불─▶ REFUNDED
       └──────취소──────▶ CANCELLED
```

- 결제 완료 → 재고 차감 + 주문대기 생성 + 적립금 지급 대기 기록(재고 부족 분기는 5절). 환불 → 재고 복원(아래 규칙) + 적립금 회수 + 연결된 「대기」 주문대기 취소.
- [확정] 환불 시 재고 복원 (MASTER 결정, 주문 품목 단위):
  - 연결된 주문대기가 「대기」(환불과 함께 취소됨)이거나 개봉 전에 「취소」된 경우 → 자동 복원(`StockMovement.reason = REFUND`).
  - 「개봉 중」이거나 「완료」(이미 개봉) → 복원하지 않는다.
  - 재고 부족(`stockShortageAt`)으로 차감되지 않은 주문 → 복원할 것 없음.
  - 그 밖의 조정은 판매자가 직접 `MANUAL` 이력으로 한다. 환불 API에 복원 여부 입력은 두지 않는다.
- [확정] 부분 취소·부분 환불: 이번 단계 미지원(주문 전체 단위).

### 4.6 방송 세션·주문대기·HIT

- `BroadcastSession`: id, sellerId, status(`LIVE | ENDED`), title, startedAt, endedAt — **판매자당 LIVE 1개(부분 유니크 인덱스)**
- `QueueItem` (주문대기 항목): id, sellerId, orderId, orderItemId, broadcastSessionId(nullable: 방송 전 주문), status(`WAITING | OPENING | DONE | CANCELLED`), position(정렬 순서), receivedAt(접수 시각 = 결제 완료 시각), nicknameSnapshot, gradeSnapshot, productLabel, quantity, timerSeconds, openingStartedAt, doneAt, cancelledAt, cancelReason, version
  - **판매자당 OPENING 1건(부분 유니크 인덱스 `WHERE status = 'OPENING'`)** — 동시에 두 건이 개봉 중이 되는 경합을 DB가 막는다.
  - **(sellerId, orderItemId) 유니크** — 같은 주문 품목이 두 번 들어가지 않는다(결제 웹훅 중복 대비).
- `HitCard`: id, sellerId, broadcastSessionId, queueItemId(nullable), buyerMemberId(nullable), nicknameSnapshot, cardName, note, createdByUserId, createdAt
- 주문대기 상태 전이 (그 외 전부 거부, `InvalidTransitionError`):

| 동작 | 허용 전 상태 | 결과 | 추가 조건 |
|---|---|---|---|
| 개봉 시작 | `WAITING` | `OPENING`, openingStartedAt 기록 | 다른 OPENING 없음, 방송 LIVE 중 |
| 개봉 완료 | `OPENING` | `DONE` | |
| 완료 되돌리기 | `DONE` | `OPENING`, doneAt 비움 | doneAt에서 **10초 안**, 다른 OPENING 없음. 감사 로그·상태 기록 필수 |
| 취소 | `WAITING`, `OPENING` | `CANCELLED` | 사유 기록, 화면은 확인 후 호출 |
| 순서 변경 | `WAITING` 항목끼리만 | position 재배치 | 같은 방송 범위 안 |
| 타이머 조정 | `WAITING`, `OPENING` | timerSeconds 변경 | 0~3600초 |

  - [확정] `CANCELLED`는 끝 상태. `DONE`은 10초 안에만 `OPENING`으로 되돌릴 수 있고, 10초가 지나면 끝 상태(거부). 기준 시각은 서버 시각.
  - 상태 변경은 모두 `QueueItemStatusHistory`(id, sellerId, queueItemId, from, to, actor, reason, createdAt)에 남긴다.
  - 모든 변경은 트랜잭션 + `version` 비교(낙관적 잠금)로 두 화면 동시 조작 시 나중 요청을 거부한다.
  - 주문대기 취소는 주문 취소·환불과 별개다(개봉만 하지 않음). 주문 환불 시에는 연결된 `WAITING`·`OPENING` 항목을 자동 취소한다.
- 방송 전 주문 처리:
  - 방송이 없을 때 결제된 주문은 `broadcastSessionId = null`, `WAITING`으로 접수 시각 순으로 쌓인다.
  - 방송 시작 시 미배정 `WAITING` 항목을 접수 시각 순으로 새 방송에 편입하고 position을 다시 매긴다.
  - 방송 종료 시 남은 `WAITING`은 미배정으로 돌려 다음 방송에 이어진다. `OPENING`이 남아 있으면 종료를 거부(먼저 완료 또는 취소).
  - [확정] 방송 시작 때 미배정 주문은 자동 편입한다.
- [확정] 주문대기 단위: **주문 품목 1개 = 대기 1건(수량 표시)**. 수량만큼 쪼개지 않는다.

### 4.7 적립금

- `RewardPolicy` (판매자당 1행): sellerId(**PK**), rates(JSON: 등급별 `{card, bankTransfer}` 퍼센트), earnStartsAt, revokeMode(`AUTO | MANUAL`), **livePayoutEnabled 기본 false**, livePayoutChangedAt, livePayoutChangedBy, rankingBonusEnabled(기본 false), rankingBonusAmount
- `RewardLedger`: id, sellerId, buyerMemberId, orderId(nullable), type(`EARN | REVOKE | USE | RANKING_BONUS | ADJUST`), amount(부호 포함), status(`PENDING | SUCCEEDED | FAILED`), testMode(bool), failureReason, idempotencyKey, createdAt, processedAt — **(sellerId, idempotencyKey) 유니크**(같은 주문 지급·회수 중복 방지)
- `RewardBalance`: (sellerId, buyerMemberId) PK, balance(**CHECK balance >= 0**), updatedAt — `SUCCEEDED`이고 `testMode = false`인 원장만 잔액에 반영(같은 트랜잭션)
- 실지급 스위치가 꺼져 있으면 원장은 `testMode = true`로 기록만 하고 잔액은 바꾸지 않는다. 스위치 변경은 대표(OWNER)만, 감사 로그 필수.
- 이번 1단계 구현 범위는 테이블·제약까지. 지급·회수 로직은 다음 단계.

### 4.8 오버레이·감사 로그

- `OverlayToken`: id, sellerId, tokenHash(**유니크**), createdAt, revokedAt — 오버레이 URL용 추측 불가 토큰. 재발급 시 이전 토큰 폐기.
- `AuditLog` (추가만, 수정·삭제 없음): id, actorType(`PLATFORM_ADMIN | SELLER_USER | BUYER | SYSTEM`), actorId, sellerId(nullable), action(예: `seller.suspend`, `queue.cancel`, `reward.live_payout.enable`, `admin.impersonate.view`), targetType, targetId, before(JSON), after(JSON), reason, ip, userAgent, createdAt
  - 비밀번호 해시·토큰·TOTP 비밀키·카드 정보는 before/after에 넣지 않는다(기록 전 제거).
  - DB 권한으로 UPDATE/DELETE를 막는 것은 운영 DB 계정 설계 때 적용(다음 단계).

### 4.9 이번 초안에서 뺀 것 (다음 단계)

요금제·구독·청구, PG 연결 정보, 구매자 문의·공지, 알림 발송 기록, 도우미 자료, 오버레이 편집 설정, 구매 랭킹. 모두 `sellerId` 범위 규칙을 그대로 따른다.

## 5. 주요 흐름 요약

- **로그인**: 해시 검증 → (마스터) TOTP 검증 → 세션 생성 → 토큰 쿠키. 정지된 판매자의 직원은 로그인 거부.
- **요청 처리**: 쿠키 → 영역별 세션 조회(만료·폐기·주체 정지 확인) → 권한 가드 → `TenantContext` 생성 → 도메인 함수 → 감사 로그 → NOTIFY.
- **결제 완료(이번 단계는 테스트용 내부 함수)**: 주문 PAID → 전 품목 재고 차감(한 트랜잭션)
  - 성공 → QueueItem 생성(방송 중이면 그 방송, 아니면 미배정) → 적립 원장 PENDING → 커밋 → NOTIFY.
  - 재고 부족 → 차감 전부 롤백 → `stockShortageAt` 기록만. **주문대기 생성·적립 원장 기록을 하지 않는다.** 판매자 화면에 「취소·환불 대상」으로 표시.

## 6. 실시간 전달 (오버레이·방송 대시보드)

| 항목 | SSE | WebSocket |
|---|---|---|
| 방향 | 서버 → 화면 한 방향 | 양방향 |
| 필요성 | 오버레이는 받기만, 대시보드 조작은 일반 POST로 충분 | 양방향 이점이 쓰일 곳이 없음 |
| OBS 브라우저 소스 | 기본 `EventSource`로 동작 | 동작하나 재연결 직접 구현 |
| 재연결 | 브라우저가 자동, `Last-Event-ID` 지원 | 직접 구현 |
| Next.js 라우트 | Route Handler 스트림 응답으로 바로 구현 | 별도 서버·업그레이드 처리 필요 |
| 프록시·방화벽 | 일반 HTTP | 업그레이드 헤더 설정 필요 |
| 참고 | 망고TCG가 SSE로 운영 중 | |

**권고: SSE.**
- 채널: 판매자별 `seller:{sellerId}`. 오버레이는 `OverlayToken`으로 판매자를 찾고, 대시보드는 판매자 세션으로 찾는다. 다른 판매자 채널은 구독할 수 없다.
- 오버레이로 보내는 데이터는 표시용 최소 필드만(닉네임·등급·상품명·수량·상태). 회원 ID·휴대폰·주문 금액은 보내지 않는다(망고TCG `liveOverlayPrivacy` 개념 재사용).
- 다중 인스턴스: 상태 변경 트랜잭션 커밋 후 Postgres `NOTIFY live_obs, '{sellerId, version}'` → 각 서버 인스턴스가 `LISTEN`해 해당 판매자 연결에 전달. Redis 등 추가 자원 불필요.
- 메시지는 「바뀌었다 + version」만 보내고 화면이 최신 상태를 다시 받는 방식 → 순서 꼬임에 강함. 25초마다 ping.
- version은 판매자별 카운터(`Seller.liveVersion`)로, 주문대기·HIT·방송 변경 트랜잭션 안에서 +1 한다.
- NOTIFY 유실 대비(커밋 후 NOTIFY 전 프로세스 종료, `LISTEN` 연결 끊김): NOTIFY는 빠른 알림일 뿐 정본이 아니다.
  - SSE가 다시 연결될 때마다 화면은 최신 상태 전체를 다시 받는다.
  - 화면은 15초마다 version만 확인하고, 가진 것과 다르면 최신 상태를 다시 받는다.
  - 서버 인스턴스는 `LISTEN` 연결이 끊기면 다시 연결한 뒤 자기 SSE 연결 전부에 「다시 받기」를 보낸다.
  - 아웃박스(내구성 있는 이벤트 저장)는 필요하면 다음 단계에서 다룬다.
- 대시보드 단축키 조작도 POST → 같은 SSE로 결과 반영.

## 7. 테스트·CI

- 단위: 주문대기 상태 전이 표 전체(허용·거부), 완료 되돌리기(10초 안 허용 / 10초 뒤 거부 / 다른 개봉 중이 있으면 거부), 순서 변경, 방송 전 주문 편입, 권한 표, 비밀번호 해시·세션 토큰.
- 통합: 실제 Postgres에 `prisma migrate deploy` 후
  - 판매자 A·B 격리(조회·변경 거부)
  - 마스터 역할별 허용·거부, 판매자 세션으로 마스터 API 거부
  - 「개봉 중」 동시 2건 시도 시 1건만 성공
  - 잘못된 상태 전이 거부
- 테스트 DB 보호: 통합 테스트는 `DATABASE_URL`의 DB 이름이 `_test`로 끝나지 않으면 시작을 거부한다. 운영 DB 접속 불가.
- 로컬: `docker run postgres:16` 등 폐기 가능한 DB. CI: GitHub Actions `services: postgres:16` 컨테이너(무료, 외부 자원 없음). `ci.yml`에는 테스트 단계만 추가.

## 8. 비용·운영 관련 (이번 PR에서 정하지 않음)

- [비용] 운영 Postgres 위치: 카카오클라우드 기존 VM에 직접 설치(추가 비용 적음, 백업·운영 부담) vs 관리형 DB(유료, 백업·장애 대응 포함). 배포 단계에서 대표님 결정.
- [비용] 문자·알림톡·본인인증 업체 — PRODUCT_SCOPE 미확정 항목.
- 비밀값(DB 접속 문자열, 세션·TOTP 암호화 키)은 환경변수로만. 저장소·문서·로그 기록 금지.

## 9. 확정 결과 (2026-10-02 21:50 KST)

| 번호 | 항목 | 확정 | 결정 |
|---|---|---|---|
| 1 | 운영·CS 세부 권한 경계 | 3.2 표 | MASTER |
| 2 | 판매자 직원 역할 | 대표·매니저·방송 담당 3개 | MASTER |
| 3 | 직원이 여러 판매자 소속일 때 | 판매자별 별도 계정 | MASTER |
| 4 | 구매자 로그인 수단 | 아이디+비밀번호, 가입 시 휴대폰 인증 필수 | MASTER |
| 5 | 재고 차감 시점 | 결제 완료 시. 재고 부족한 늦은 결제는 취소·환불 대상 표시 | 대표님 |
| 6 | 부분 취소·환불 | 이번 단계 미지원 | MASTER |
| 7 | 주문대기 단위 | 주문 품목 1개 = 대기 1건, 수량 표시 | 대표님 |
| 8 | 개봉 완료 되돌리기 | 완료 10초 안, 다른 개봉 중 없을 때만 허용. 기록 필수 | 대표님 |
| 9 | 방송 전 주문 편입 | 방송 시작 시 자동 편입 | 대표님 |
| 10 | RLS 적용 | 이번 단계 미적용, 운영 전 재검토 | MASTER |
| 11 | 회원 등급 | 판매자별 테이블, id로 식별, 기본 5개는 systemKey 표시 | MASTER |

디자인 맞춤 수정(MASTER 검수): 로그인 잠금 10분(AU-001), 세션 시간(AU-007), 등급 식별 방식.

남은 미정은 8절 [비용] 항목뿐이다.
