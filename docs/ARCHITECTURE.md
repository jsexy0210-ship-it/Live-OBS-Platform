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
| 마스터 2단계 인증 | **없음** | 대표님 결정(2026-10-02). 이메일+비밀번호만 확인한다 | [확정] |
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
lib/server/auth/                              해시·세션·로그인 (영역별)
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
| 마스터 | `PlatformAdmin` | `lo_admin` (경로 `/`, 마스터 호스트 한정) | 이메일+비밀번호(2단계 인증 없음, 대표님 결정 2026-10-02) | 미활동 30분, 최대 8시간 |
| 판매자 | `SellerUser` (대표·직원) | `lo_seller` | 이메일+비밀번호 | 미활동 12시간, 최대 30일. 방송 LIVE 중에는 미활동 로그아웃 없음 |
| 구매자 | `BuyerMember` (판매자 쇼핑몰별) | `lo_buyer` (쇼핑몰 호스트 한정) | 4.3 참고 | 최대 30일 |

- 세션 테이블도 영역별로 분리(`AdminSession`, `SellerSession`, `BuyerSession`). 판매자 세션으로 마스터 API를 호출하면 세션 조회 자체가 실패한다 → **판매자는 마스터 기능에 접근 불가**가 구조적으로 보장된다.
- 쿠키 공통: `HttpOnly`, `Secure`(운영), `SameSite=Lax`. 상태 변경 API는 공통 래퍼에서 `Origin` 검사로 CSRF 차단(Origin이 없거나 다르면 거부).
- 판매자 미활동 로그아웃은 방송이 LIVE인 동안 적용하지 않고, 방송 종료 30분 뒤부터 다시 적용한다(디자인 AU-007). 최대 유지 시간은 그대로 적용.
- 로그인 실패 잠금 없음(대표님 결정 2026-10-02). 실패는 감사 로그에 기록. IP 허용 목록·IP 기준 제한도 두지 않는다.
- 접속 IP는 감사 로그 기록용으로만 쓰고, 신뢰 프록시를 거친 경우에만 `X-Forwarded-For`에서 얻는다(환경변수 `TRUSTED_PROXY_HOPS`, 기본 0 = 믿지 않음).
- 로그인 성공·실패·차단은 감사 로그.
- 판매자 비밀번호 찾기(대표님 지시 2026-10-02): 메일 링크 없이 **대표자 PASS 본인인증**으로만 한다.
  - 이메일+쇼핑몰로 시작 → PASS 완료 → 결과 CI가 그 쇼핑몰 `Seller.representativeCiHash`와 같고 계정이 대표자(`isOwner`)일 때만 일회용·10분 재설정 권한(`PasswordResetGrant`, 토큰 해시 저장) 발급 → 새 비밀번호 저장, 그 계정의 기존 세션 모두 폐기.
  - 본인인증 건은 시작한 브라우저에만 준 일회용 값(`IdentityVerification.ownerTokenHash`, HttpOnly 쿠키)과 묶고, 한 번 쓰면 `consumedAt`으로 소진한다(구매자 가입도 같음).
  - CI 불일치·직원 계정·없는 계정은 모두 같은 거부 응답(계정 존재 비노출). 시작·발급·완료·실패는 감사 로그.
  - 시작 횟수: 쇼핑몰 하나당 하루 10회(KST 자정 초기화, DB 시계로 집계, 쇼핑몰별 직렬화). 넘으면 429 `reset_limit_exceeded`와 감사 로그(대표님 결정 2026-10-02). 없는 쇼핑몰 주소는 한 묶음으로 센다.
  - 직원(매니저·방송 담당) 비밀번호는 대표가 직원 관리에서 재설정하고, 직원의 기존 세션을 폐기한다.

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

### 3.3 판매자 직원 권한 (대표님 결정 2026-10-02: 고정 역할 대신 권한 항목)

- 대표자(`SellerUser.isOwner = true`)는 모든 권한과 아래 대표자 전용 기능을 가진다.
- 대표자가 직원 계정을 직접 만들고(이메일·이름·초기 비밀번호·권한 항목) 항목별로 켜고 끈다. 직원은 켠 항목만 쓸 수 있다.

| 권한 항목 | 내용 |
|---|---|
| `BROADCAST_RUN` | 방송 진행(주문대기·개봉·HIT·타이머, 방송 시작·종료) |
| `OVERLAY_EDIT` | 오버레이 편집·URL 재발급 |
| `PRODUCT_MANAGE` | 상품·재고 |
| `ORDER_SHIPPING` | 주문·배송 |
| `CUSTOMER_PII_VIEW` | 구매자 이름·연락처·주소 보기. 없으면 **API 응답에서 그 필드를 뺀다**(화면 가림으로는 부족). 열람은 감사 로그 `customer.pii.view` |
| `MEMBER_POINTS` | 회원·적립금 |
| `INQUIRY_REPLY` | 구매자 문의 답변 |
| `RECEIPT_TAX` | 현금영수증·세금계산서 |
| `SALES_VIEW` | 매출 보기 |
| `SHOP_SETTINGS` | 쇼핑몰 설정 |

- **대표자 전용(항목으로 줄 수 없음)**: PG 연결, 구독, 직원 관리, 적립금 실지급 스위치.
- 직원 관리 API(대표자 전용): 생성, 권한 변경, 비활성화(기존 세션 폐기), 비밀번호 재설정. 같은 쇼핑몰 직원만(다른 쇼핑몰은 404), 대표자 계정은 대상 아님(403). 생성·권한 변경·비활성화는 감사 로그(누가, 누구의, 전과 후).
- 옛 역할 데이터 이전: `OWNER` → 대표자, `MANAGER` → `SHOP_SETTINGS`를 뺀 9개 항목, `BROADCASTER` → `BROADCAST_RUN`·`OVERLAY_EDIT`.
- 마스터 대리 조회(읽기 전용)는 주문·고객 정보·매출·회원 조회만 허용하고 변경은 모두 거부.

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

- `PlatformAdmin`: id, email(**유니크**), passwordHash, name, role(`SUPER_ADMIN | OPERATIONS | CS | READ_ONLY`), status(`ACTIVE | SUSPENDED`), lastLoginAt, createdAt
- `AdminSession`: id, adminId, tokenHash(**유니크**), ip, userAgent, expiresAt, lastSeenAt, revokedAt

### 4.2 판매자(쇼핑몰)·직원

- `Seller` (테넌트 = 쇼핑몰 1개): id, slug(기본 주소 하위 이름, **유니크**), shopName, status(`PENDING | ACTIVE | SUSPENDED | REJECTED | CLOSED`), businessInfo(JSON), approvedAt, approvedByAdminId, suspendedReason, representativeCiHash(대표자 PASS CI의 HMAC), representativeVerifiedAt(둘은 함께 기록), liveVersion(실시간 version 카운터, 기본 0), createdAt — **대표자 1명당 쇼핑몰 1개**: representativeCiHash 부분 유니크(해지 `CLOSED`·반려 `REJECTED` 제외)
- `SellerDomain`: id, sellerId, hostname(**유니크**), verifiedAt, certStatus — 개인 도메인 연결용 자리만
- `SellerUser`: id, sellerId, email, passwordHash, name, isOwner, permissions(권한 항목 배열, 3.3), status(`ACTIVE | DISABLED`), lastLoginAt — **(sellerId, email) 유니크**, 판매자당 OWNER 1명 이상
- `SellerSession`: id, sellerUserId, sellerId, tokenHash(**유니크**), expiresAt, lastSeenAt, revokedAt
- [확정] 한 사람이 여러 판매자의 직원이 되는 경우 판매자별 별도 계정(이메일 같아도 됨). 한 판매자가 쇼핑몰 여러 개를 갖는 경우는 지원하지 않음(별도 판매자로 가입).

### 4.3 구매자 회원 (판매자 쇼핑몰별)

- `BuyerMember`: id, sellerId, loginId, passwordHash, name, phone, ciHash(PASS 본인인증 CI의 HMAC-SHA256, 원문 CI 미저장), identityVerifiedAt, birthDate(PASS 생년월일, 미성년자 판정용), broadcastNickname, gradeId, status(`ACTIVE | DORMANT | WITHDRAWN`), marketingConsentAt, createdAt, deletedAt — **(sellerId, ciHash) 유니크**(같은 쇼핑몰 중복 가입 차단), **(sellerId, phone) 유니크**, **(sellerId, loginId) 유니크**, **(sellerId, broadcastNickname) 유니크**(방송 화면에서 구분 가능하게). 네 유니크는 `deletedAt IS NULL`인 행에만 적용(부분 유니크 인덱스)
  - 탈퇴하면 `status = WITHDRAWN`과 `deletedAt`을 같은 트랜잭션에서 함께 기록하고 개인정보(이름·휴대폰·닉네임)를 비식별 처리한다. `DORMANT`는 삭제가 아니므로 `deletedAt`이 비어 있다. 주문·원장은 회원 id로 남는다.
- `MemberGrade`: id, sellerId, displayName, sortOrder, systemKey(nullable: `BASIC | SPROUT | SILVER | GOLD | VIP`) — 등급은 **id·displayName·sortOrder로 식별**한다. 판매자 생성 시 일반·새싹·실버·골드·VIP 5개를 기본으로 만들고 `systemKey`로 표시만 한다. 판매자가 추가한 등급은 `systemKey = null`. **(sellerId, displayName) 유니크**, **(sellerId, systemKey) 유니크(null 제외)**. 디자인 지시(`docs/DESIGN_PROMPT.md` 245줄) 「이름·개수는 판매자가 정한다」에 맞춰 고정 enum으로 식별하지 않는다. 적립률(`RewardPolicy.rates`)도 등급 id 기준. [확정]
- `IdentityVerification` (PASS 본인인증 요청·결과): id, sellerId(nullable, 판매자 대표자 인증은 null), purpose(`BUYER_SIGNUP | SELLER_REPRESENTATIVE | PASSWORD_RESET`), provider, requestId, status(`PENDING | VERIFIED | FAILED | EXPIRED`), ciHash, name, phone, birthDate, verifiedAt, expiresAt — **(provider, requestId) 유니크**, `VERIFIED`면 ciHash·verifiedAt 필수(CHECK)
  - CI 원문은 저장하지 않는다. 서버 비밀키(환경변수 `IDENTITY_HASH_KEY`)로 만든 HMAC-SHA256 값만 저장한다.
  - 연동은 `IdentityProvider` 인터페이스 뒤에 둔다. 개발·테스트는 가짜 공급자만 쓰고, 실제 PASS 대행사 연동은 계약 후(이번 범위 아님).
- `BuyerSession`: id, buyerMemberId, sellerId, tokenHash(**유니크**), expiresAt, revokedAt
- 같은 사람이 다른 판매자 쇼핑몰에 가입하면 별도 회원이다(데이터 공유 없음).
- [확정] 구매자 로그인 수단은 「아이디+비밀번호」, 가입 시 PASS 본인인증 필수(2026-10-02 대표님 지시). 휴대폰 번호 로그인·카카오 로그인은 보류.
- [비용] PASS 본인인증 대행사 계약·건당 비용 (MASTER가 대표님께 보고).

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
  - `totalAmount`: 구매자가 실제로 결제한 금액(적립금 사용액을 **뺀 뒤**, 배송비가 생기면 포함). `rewardUsedAmount`: 이 주문에 쓴 적립금.
  - 적립 기준액은 `totalAmount`를 쓰지 않고 「상품 결제 금액(주문 품목 단가 × 수량 합, 배송비 제외) − 적립금 사용액」으로 계산한다(MASTER 결정, 카페24 기본과 같음). 적립금이 두 번 빠지지 않는다.
- `OrderItem`: id, sellerId, orderId, productId, optionId, productNameSnapshot, optionNameSnapshot, unitPrice, quantity
- `OrderConsent`: id, sellerId, orderId, kind(`OPENED_NO_REFUND`), noticeVersion, agreedAt(DB 시계) — **(orderId, kind) 유니크**. 결제 전 「개봉하면 취소·환불이 안 돼요」 동의 기록(대표님 결정 2026-10-02).
- 주문 생성(`POST /api/shop/{slug}/orders`, 구매자 세션, 결제 대기까지 — 실제 PG 결제 호출 없음):
  - 동의 필수: `consent.agreed === true`(체크 기본 해제)와 화면이 보여 준 문구 버전(`noticeVersion`)이 지금 버전과 같아야 한다. 아니면 `400 consent_required`·`consent_outdated`, 주문을 만들지 않는다. 동의는 주문과 같은 트랜잭션에 기록.
  - 잠긴 판매자(체험하기·구독 끝)는 `402 shop_unavailable`, 문구 「지금은 쇼핑몰을 이용할 수 없어요」(판매자 사정은 드러내지 않음).
  - 금액은 서버가 계산(단가 = 상품 가격 + 옵션 추가금, 합계 = 단가 × 수량). 본문의 금액·상태 값은 쓰지 않는다. 적립금 사용은 방식이 정해지기 전이라 요청이 오면 `400 reward_use_not_supported`(rewardUsedAmount = 0).
  - 재고는 주문 수량만큼 있는지 확인(차감은 결제 때). 부족하면 `400 out_of_stock`. 선점 없음(확정 그대로).
  - 단가가 1원 미만(음수 추가금 등)이거나 합계(상품 + 배송비)가 정수 범위(2,147,483,647원)를 넘으면 `400 invalid_amount`, 주문을 만들지 않는다.
  - 배송지 필수(받는 분·연락처·우편번호 5자리·주소, 상세 주소·메모 선택). 틀리면 `400 invalid_shipping_address`. 4.10 참고.
  - 400·402·409 응답은 `{ error, message }`. `message`는 화면에 그대로 보여 줄 해요체 문구이고, 사유 코드별 문구는 `lib/server/orders/messages.ts` 한 곳에서만 고친다.
  - 주문 번호는 판매자별 advisory lock 아래에서 매긴다(동시 주문에도 겹치지 않음). 판매 중(`ON_SALE`)이 아니거나 다른 쇼핑몰 옵션이면 `400 product_unavailable`.
- `OrderStatusHistory`: id, sellerId, orderId, from, to, actor, reason, createdAt
- 상태 전이 (그 외 거부):

```text
PENDING_PAYMENT ─결제 확인─▶ PAID ─환불─▶ REFUNDED
       └──────취소──────▶ CANCELLED
```

- 결제 완료 → 재고 차감 + 주문대기 생성 + 적립금 지급 대기(`EARN`, 실지급 스위치가 꺼져 있으면 `testMode`) 기록(재고 부족 분기는 5절). 환불 → 재고 복원(아래 규칙) + 적립금 회수 대기(`REVOKE`) + 연결된 「대기」·「개봉 중」 주문대기 자동 취소.
- [확정] 환불 시 재고 복원 (MASTER 결정, 주문 품목 단위):
  - 연결된 주문대기가 「대기」(환불과 함께 취소됨)이거나 개봉 전에 「취소」된 경우 → 자동 복원(`StockMovement.reason = REFUND`).
  - 「개봉 중」(환불과 함께 취소됨)·개봉을 시작한 뒤 취소됨·「완료」 → 이미 개봉했으므로 복원하지 않는다.
  - 개봉한 품목이 있는 주문도 환불할 수 있다(배송 사고·판매자 판단). 대신 요청에 `confirmOpened: true`가 있어야 하고, 없으면 `409 opened_items_present`. 감사 로그에 개봉 품목 수를 남긴다.
  - 재고 부족(`stockShortageAt`)으로 차감되지 않은 주문 → 복원할 것 없음.
  - 그 밖의 조정은 판매자가 직접 `MANUAL` 이력으로 한다. 환불 API에 복원 여부 입력은 두지 않는다.
  - 주문 상태를 결제 완료 → 환불로 원자적으로 바꿔 같은 주문을 두 번 환불하거나 재고를 두 번 복원하지 않는다. 결제 대기 주문은 「취소」(재고 변화 없음), 결제 완료 주문은 「환불」만 가능. 둘 다 사유 필수, `ORDER_SHIPPING` 권한, 화면이 받은 `expectedVersion`(판매자 liveVersion) 필수 — 다르면 `409 conflict`(주문대기 조작과 같은 규칙).
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
- 결제 완료 때 `EARN`(PENDING), 환불 때 회수: `revokeMode = AUTO`면 `REVOKE`(PENDING)를 기록하고, `MANUAL`이면 기록하지 않는다. MANUAL에서 「환불된 주문에 `EARN`은 있고 `REVOKE`가 없는 상태」가 수동 확인 대기다(감사 로그 `rewardRevoke: manual_review`).
- 결제 확인에 결제수단이 없으면 주문에 저장된 결제수단으로 적립률을 정한다.
- 원장의 실제 처리(SUCCEEDED·잔액 반영), 주문에 쓴 적립금(`USE`)을 환불·취소 때 돌려주는 것은 다음 단계(적립금 사용 기능과 함께).

### 4.8 오버레이·감사 로그

- `OverlayToken`: id, sellerId, tokenHash(**유니크**), createdAt, revokedAt — 오버레이 URL용 추측 불가 토큰. 재발급 시 이전 토큰 폐기.
- `AuditLog` (추가만, 수정·삭제 없음): id, actorType(`PLATFORM_ADMIN | SELLER_USER | BUYER | SYSTEM`), actorId, sellerId(nullable), action(예: `seller.suspend`, `queue.cancel`, `reward.live_payout.enable`, `admin.impersonate.view`), targetType, targetId, before(JSON), after(JSON), reason, ip, userAgent, createdAt
  - 비밀번호 해시·토큰·CI 해시·카드 정보는 before/after에 넣지 않는다(기록 전 제거).
  - DB 권한으로 UPDATE/DELETE를 막는 것은 운영 DB 계정 설계 때 적용(다음 단계).

### 4.8.1 체험하기·플랫폼 구독 (대표님 결정 2026-10-02, MASTER 결정 2026-10-03)

화면·메일·API 메시지의 무료 체험 기간 표기는 「체험하기」다(「무료 이용」이라고 쓰지 않음). 코드 이름(`trialEndsAt` 등)은 그대로 둔다.

- `Seller.trialEndsAt`: 마스터 승인 때 DB 시계로 `approvedAt + 14일`(상수 `TRIAL_DAYS`, 대표님 결정 2026-10-02 3일 → 14일)을 채운다(승인 대기인 쇼핑몰만, 동시 승인은 한 번만 반영).
- 이용 가능 여부(`sellerAccess`): 아래 중 하나면 쓸 수 있다. 아니면 판매자 API는 `402 subscription_required`, 오버레이 공개 주소(`state`·`version`·`stream`)는 404, 열려 있는 오버레이 SSE는 다음 핑 재확인 때 닫힌다.
  - `paid`: 결제한 이용 기간 안(`currentPeriodEnd > 지금`). 해지 예약·자동결제 실패여도 기간 끝까지.
  - `trial`: 체험하기 중.
  - `charging`: 카드를 등록해 두었고 예약 결제 시각이 지났지만 예약 실행이 아직 처리하지 않음. 우리 쪽 지연으로 판매자를 잠그지 않으므로 시간 제한이 없다.
  - `grace`: 자동결제 실패 뒤 유예 중(실패한 때 + 7일). 해지 예약을 하면 유예는 지운다.
  - 판단 시각은 DB 시계(`requireSeller`·오버레이 토큰·체험 한도 모두). 테스트만 시각을 넘긴다.
  - 잠겨도 열리는 것(대표님 결정, PRODUCT_SCOPE 「잠금 중 허용 범위」): 내 정보(`/api/seller/me`, 이용 상태 포함), 구독·결제(`/api/seller/subscription/**`), 로그아웃, 이미 받은 주문의 처리(주문 조회·취소·환불, 배송·구매자 문의 답변·영수증은 기능을 만들 때 같은 방식으로 연다). 막는 것은 새 판매(쇼핑몰 주문 생성·오버레이·방송 시작·상품 등록·수정·도메인 신규 연결)와 그 밖의 판매자 API다. 판정은 서버 가드(`requireSeller`, 예외는 `allowUnpaid`)에서 한다.
- 잠금 30일 뒤 자동 해지(`closeLongLockedSellers`, 예약 실행): 잠기기 시작한 시각(체험하기 끝·기간 끝·유예 끝 중 가장 늦은 시각)에서 30일이 지나면 `Seller.serviceEndedAt`을 기록하고 구독을 `CANCELED`, 연결 도메인을 비활성(`SellerDomain.suspendedAt`)으로 바꾼다. 데이터는 지우지 않는다(90일 보관 뒤 삭제·5년 주문·결제 기록 보관은 별도 작업). 보관 기간 안에 다시 결제하면 해지 표시를 지우고 해지 때 푼 도메인을 되살린다.
- 체험하기 한도(대표님 결정): 알림톡·문자 100건, 구매자 PASS 50건, 저장 용량 1GB. `SubscriptionPlan`의 `trialMessageLimit`·`trialIdentityLimit`·`trialStorageMb`에 두고 마스터 API(`POST /api/admin/plans/{code}/trial-limits`, `billing.manage`, 감사 로그)로 바꾼다. 확인 함수 `checkTrialLimit`은 체험하기 중인 판매자에게만 적용하며, 알림톡·PASS·업로드 기능을 만들 때 연결한다.
- `SubscriptionPlan`: 정가(`listPrice`)·판매가(`salePrice`), 원 단위 부가세 포함, 청구액은 판매가. 기본값 300,000원 / 199,000원은 마이그레이션 데이터로 넣는다(배포 전 운영 판매자 없음 전제로 기존 판매자 백필 포함).
- 가격 변경(대표님 결정): 최고관리자만(`billing.price`), 가격 변경·가격 기록(`SubscriptionPriceChange`)·감사 기록은 한 트랜잭션.
  - 청구 금액(`priceFor`) = 가격 기록 중 「구독을 시작할 때(`SellerSubscription.subscribedAt`) 이미 적용되던 것」 또는 「변경 + 30일이 지난 것」 가운데 가장 최근 가격. 그래서 새 가입자는 지금 가격, 기존 구독자는 고지 기간(30일)이 끝난 뒤 첫 결제부터 새 가격을 낸다. 30일 안에 두 번 바꿔도 구독 시작 때 가격(또는 고지가 끝난 가격)을 유지한다.
  - 해지 뒤 다시 구독하면 새 구독자다(`subscribedAt`을 새로 기록, 기간도 결제 시각부터).
  - 고지 대상 목록은 `listPriceChangeNoticeTargets`(가장 최근 변경 전에 구독을 시작한 구독 중 판매자). 메일·알림톡 발송은 알림 기능이 생길 때 연결.
- `SellerSubscription`(쇼핑몰당 1개): 카드 자동결제(빌링키)만. 빌링키는 `BILLING_KEY_SECRET`으로 AES-256-GCM 암호화해서만 저장하고 응답·감사 로그에 넣지 않는다. 상태 `ACTIVE | PAST_DUE | CANCELED`, 이용 기간, 해지 예약(`cancelAtPeriodEnd`), 다음 처리 시각(`nextChargeAt`), 재시도 횟수(`retryCount`), 유예 끝(`graceUntil`). 대표자 전용(`SUBSCRIPTION_MANAGE`), 마스터 대리 조회로도 볼 수 없다.
- `SubscriptionPayment`(청구 내역): `PENDING → PAID | FAILED`, 예약 실행이 만든 청구인지(`scheduled`).
  - 이중 결제 방지: **구독당 `PENDING` 청구는 하나만**(부분 유니크), 같은 구독·같은 기간 시작에는 `PENDING·PAID`가 하나만(부분 유니크). 카드 등록과 예약 결제는 진행 중 청구가 있으면 새로 만들지 않는다. 모든 구독 변경은 판매자 행을 먼저 잠근다.
  - 결과 확정은 멱등: `PENDING`인 청구만 확정하고, 이미 확정된 청구에 다시 결과가 와도 바꾸지 않는다.
  - PG 응답을 못 받은 청구(타임아웃·확정 실패)는 `PENDING`으로 남고, `reconcileStalePayments`(예약 실행, 10분 지난 청구)가 같은 청구 id로 PG에 조회한다. 결제 기록이 있으면 그 결과로, 없으면 판매자를 잠그고 구독을 다시 읽어 해지(`CANCELED`)·해지 예약이면 다시 결제하지 않고 `FAILED("canceled")`로 닫고, 아니면 같은 id로 다시 요청해 확정한다(PG는 같은 주문 id를 한 번만 결제).
  - 해지 시각(`SellerSubscription.canceledAt`)을 남긴다. 해지 **전에** 만든 청구가 해지 뒤에 확정되면 구독을 되살리지 않고, PG가 이미 결제한 건은 감사 로그 `subscription.refund_required`로 환불 대상만 남긴다. 해지 **뒤에** 만든 청구(다시 구독)가 결제되면 정상 결제로 보고 `ACTIVE`·이용 상태·자동 해지 표시(`serviceEndedAt`)·도메인 비활성을 되살린다. 결제가 실패하면 해지 상태 그대로다(카드 등록 때 미리 `ACTIVE`로 바꾸지 않음). 해지 예약된 구독의 예약 결제가 실패하면 재시도 없이 기간 끝에 해지한다.
- 기간 계산(대표님 결정): 기간은 항상 원래 결제일(지난 기간 끝)에 이어서 센다. 유예·잠금 중에 결제해도 시작은 지난 기간 끝이고 잠긴 날도 기간에 들어간다. 체험 뒤 첫 결제와 해지 뒤 다시 구독(해지 예약 기간이 끝났는데 예약 실행이 아직 `CANCELED`로 바꾸기 전 포함)은 결제한 시각부터(체험 종료와 결제 사이는 잠금 대기라 청구하지 않음). 기준일(`billingAnchorAt`, 첫 기간 시작)의 KST 날짜·시각으로 매달 같은 날(없으면 말일)까지 센다(1/31 → 2/28 → 3/31). 잠금이 길어 지난 기간 끝부터 세도 이미 지났으면 결제한 시각부터 새로 센다.
- 카드 등록(구독 시작·카드 변경) — 응답은 PG 결과가 아니라 반영된 뒤 실제 구독 상태로 정한다(이 결제가 기간에 반영돼 `ACTIVE`가 아니면 `409 not_activated`):
  - 결제한 기간이 남아 있고 자동결제가 정상 → 카드만 바꾼다.
  - 체험하기 중 → 카드만 등록하고 첫 결제를 체험하기 종료 시각으로 예약한다(`nextChargeAt = trialEndsAt`).
  - 그 밖(예약 결제 대기·유예·잠김) → 바로 결제한다. 기간은 위 기간 계산 규칙. 카드를 다시 등록하면 해지 예약을 푼다.
- 예약 실행(`renewDueSubscriptions`, `nextChargeAt`이 지난 구독, 구독마다 따로 처리해 한 곳이 실패해도 나머지는 계속):
  - 첫 결제(체험하기 종료 시각), 다음 달 결제(기간 끝 하루 전).
  - 실패: 처음 실패면 `PAST_DUE` + 유예 7일, 하루 간격으로 최대 3번 다시 시도, 그 뒤에는 시도하지 않는다. 판매자가 카드를 바꾸면 바로 다시 결제한다.
  - 해지 예약은 기간이 끝나면 결제 없이 `CANCELED`.
- 해지: 결제를 처리하는 중(`PENDING` 청구)에는 `409 payment_in_progress`(「결제를 처리하고 있어요. 잠시 뒤 다시 시도해 주세요」). 결제한 기간이 남아 있으면 기간 끝까지 쓰고 다음 결제를 하지 않는다. 결제한 기간이 없으면(체험하기 중 카드만 등록, 유예 중) 바로 해지하고 청구하지 않는다. 즉시 환불은 하지 않는다.
- 결제 공급자는 인터페이스(`lib/server/billing/provider.ts`: 빌링키 발급·결제·같은 청구 id 조회)로만 부르고, 업체(후보 NICEPAY·페이플)는 바꿔 끼운다. `BILLING_PROVIDER` 환경변수로 고른다. 지금은 `fake`만 있고 명시했을 때만 쓴다(운영 환경에서는 만들 수 없음, 실제 결제 없음). 예약 실행을 주기적으로 돌리는 인프라는 승인 후 연결한다.
- 빌링키 암호화: AES-256-GCM, 판매자 id를 AAD로 묶어 다른 판매자 행으로 옮기면 풀리지 않는다. `BILLING_KEY_SECRET`이 없으면 PG를 부르기 전에 실패한다.
  - 키 교체 절차: ① 새 키를 `BILLING_KEY_SECRET_NEXT`로 배포(읽기는 새 키 → 이전 키 순으로 시도하는 코드를 그때 추가) ② 일괄 작업으로 모든 `billingKeyCipher`를 이전 키로 풀어 새 키로 다시 암호화(판매자 행 잠금 아래, 진행 중 청구가 없을 때) ③ 남은 행이 없는지 확인한 뒤 `BILLING_KEY_SECRET`을 새 키로 바꾸고 이전 키 제거 ④ 감사 로그에 교체 기록. 키 값은 저장소·로그에 남기지 않는다.

### 4.8.2 판매자 가입 신청·자동 승인 (대표님 결정 2026-10-02)

- 흐름: `POST /api/seller-signup/verification`(대표자 PASS 시작, 같은 접속 IP 하루(KST 자정 초기화) 10회까지 — 가입 PASS는 건당 비용, 넘으면 `429 daily_limit_exceeded`, 시작한 브라우저에만 `lo_sidv` 쿠키, 경로 `/api/seller-signup`) → PASS 완료 → `POST /api/seller-signup/apply`(로그인 이메일·비밀번호는 신청자가 정함, 쇼핑몰 이름·주소 이름(slug)·사업자등록번호·상호·개업일자·통신판매업 신고번호).
- 신청을 받지 않는 경우(입력 오류로 응답): 본인인증 무효(다른 브라우저·이미 씀·30분 지남·다른 용도), 대표자 1명당 쇼핑몰 1개 위반(해지·반려 제외, `409 representative_has_shop`, 문구 「이미 운영 중인 쇼핑몰이 있어요 · 한 대표자는 쇼핑몰 하나만 열 수 있어요」, 다른 쇼핑몰 이름은 보여 주지 않음, DB 부분 유니크로도 막음), 주소 이름 형식·예약어·중복, 사업자등록번호 검증 숫자 틀림, 비밀번호 8자 미만. 이 경우 본인인증은 소진되지 않는다.
- 자동 점검(`reviewReasons`, 하나라도 걸리면 자동 승인하지 않음):
  - 국세청 「사업자등록정보 진위확인 및 상태조회」: 사업자번호·대표자명(PASS로 확인한 이름)·개업일자(신청 항목) 대조 불일치(`business_info_mismatch`), 계속사업자 아님(`business_not_active`), 조회 실패·키 없음(`business_lookup_failed`). 키 `NTS_BUSINESS_STATUS_API_KEY` 하나로 진위확인·상태조회를 함께 쓴다.
  - 같은 사업자번호로 운영 중이거나 신청 중인(해지·반려 제외) 쇼핑몰이 있음(`business_duplicate`). 번호별 advisory lock으로 동시 신청도 한 건만 자동 승인.
  - 공정위 「통신판매사업자 등록상세」 조회(기준은 조회, MASTER 결정): 신고번호 없음·형식 틀림(`mail_order_number_invalid`), 조회 실패·키 없음(`mail_order_lookup_failed`), 등록 없음·사업자번호 불일치(`mail_order_not_registered`), 영업 상태 정상 아님(`mail_order_not_active`). 키 `FTC_MAIL_ORDER_API_KEY`.
  - 하나도 없으면 같은 트랜잭션에서 자동 승인(`approvedByAdminId = null`, 체험하기 시작, 감사 로그 `seller.auto_approve`).
  - 하나라도 있으면 승인 대기(`PENDING`)로 두고 마스터 「확인 필요」(`GET /api/admin/sellers/review`)에 올린다. 대표님이 승인(`approve`, 사유 비움)·반려(`reject`, 사유 필수, `rejectedReason`·`rejectedAt` 전용 컬럼 — 정지 사유와 섞지 않음)한다. 보완 요청은 화면 단계에서.
- 신청 때 쇼핑몰·대표자 계정(PASS 이름)·기본 등급 5개를 만든다. 사업자 정보는 `Seller.businessInfo`(사업자등록번호·상호·대표자명·개업일자·통신판매업 신고번호·국세청·공정위 조회 결과·점검 시각)에 둔다.
- 국세청·공정위 조회는 공급자 인터페이스(`lib/server/sellers/businessCheck.ts`)로만 부른다. `BUSINESS_STATUS_PROVIDER=fake`·`MAIL_ORDER_PROVIDER=fake`를 명시했을 때만 가짜(운영 불가). 그 밖에는 실제 조회 자리이며, 실제 연동 전이거나 키가 없으면 조회 실패로 처리해 자동 승인하지 않는다. 환경변수 이름은 `.env.example`.

### 4.9 이번 초안에서 뺀 것 (다음 단계)

PG 연결 정보, 구매자 문의·공지, 알림 발송 기록, 도우미 자료, 오버레이 편집 설정, 구매 랭킹. 모두 `sellerId` 범위 규칙을 그대로 따른다.

아래는 스키마를 다시 만들지 않도록 자리만 정해 둔다(이번에 테이블은 만들지 않음, 모두 추가 테이블·추가 컬럼으로 붙인다).

- 현금영수증·세금계산서: 주문별 신청 정보(`OrderReceiptRequest`)와 발행 레코드(`ReceiptIssue`: 종류, 상태 `PENDING | ISSUED | FAILED | CANCELLED`, 연동 결과 키).
- 배송: 즉시 발송은 4.10에서 만들었다. 보관(`STORAGE`)·합배송은 출시 후 1차.
- 무통장 입금: `Order.paymentDueAt`, 기한이 지난 결제 대기 주문은 자동 취소.
- 법정 동의 기록: 회원 가입 시 약관·처리방침 버전과 마케팅 동의 시각·철회 시각(`MemberConsent`). 주문 단위 「개봉하면 취소·환불 불가」 결제 전 동의를 기록한다(`OrderConsent`: 주문, 동의 시각, 고지 문구 버전. 대표님 결정 2026-10-02, 개봉 전 취소 규칙은 그대로). 구매자 「내 차례 N건 전」 알림도 두지 않는다(주문·결제·발송 알림만).
- 미성년자 정책: `Seller` 설정 `minorPurchasePolicy`(`BLOCK | NOTICE`), `BuyerMember.birthDate`(PASS)로 판정.
- 판매자 직원 개인정보 접속기록: 기존 `AuditLog`를 확장해 기록하고 1년 보관.
- 보존 기간: 거래기록(주문·결제·원장)은 5년 보존, 탈퇴 회원 개인정보는 탈퇴 시 비식별(4.3)하고 거래기록과 분리해 파기 일정 적용.
- 1인 구매 수량 제한(상품·옵션별), 상품 카테고리, 구매 제한 회원.

### 4.10 배송(즉시 발송, PRODUCT_SCOPE MVP)

- `Order.fulfillmentType`(`IMMEDIATE | STORAGE`, 지금은 `IMMEDIATE`만), `Order.shippingFee`(주문 때 계산한 배송비, `totalAmount`에 포함).
- `SellerShippingPolicy`(판매자당 1개, 없으면 기본값): baseFee(기본 3,000원), freeOverAmount(상품 합계가 이 금액 이상이면 기본 배송비 0원, null이면 무료 배송 없음), remoteSurcharge(도서산간 추가비, 기본 3,000원, 무료 배송이어도 붙음), remoteZipRanges(우편번호 범위, 기본 제주 63000~63644·울릉 40200~40240).
  - 도서산간 판정: 우편번호가 범위에 들거나, 주소의 첫 행정구역 토큰이 제주·제주도·제주특별자치도·제주시·서귀포시·울릉·울릉군·울릉도이면 도서산간. 둘 중 하나라도 맞으면 추가비를 붙인다(구매자가 보낸 우편번호만 믿지 않음). 주소는 NFKC로 정규화하고 앞머리 기호·숫자, 「대한민국」·「경상북도」 같은 앞 토큰은 건너뛴다. 영문은 Jeju·Seogwipo·Ulleung(-do·-si·-gun) 토큰이 어디에 있든 본다. 도로명·건물명에 든 지명(「제주로」)은 해당하지 않는다.
  - `GET·PUT /api/seller/shipping-policy`(`SHOP_SETTINGS`). 금액은 0~100,000원 정수, 무료 기준은 1~1억 원, 범위는 50개까지. 틀리면 `400 invalid_shipping_policy`. 변경은 감사 로그.
  - 배송비 = (무료 기준 이상이면 0, 아니면 baseFee) + (도서산간이면 remoteSurcharge). 바꾼 설정은 다음 주문부터(이미 만든 주문은 그대로).
- `OrderShippingAddress`(주문당 1개, 스냅숏): 받는 분, 연락처(숫자만), 우편번호, 주소, 상세 주소, 메모, 도서산간 여부. 값은 NFKC로 정규화해 저장한다(전각 공백·NBSP는 일반 공백). 제어문자(Cc)·보이지 않는 서식 문자(Cf: 방향 바꿈·폭 없는 공백 등)·줄·문단 구분 문자(Zl·Zp)가 든 값은 `400 invalid_shipping_address`. 판매자 주문 조회에서는 `CUSTOMER_PII_VIEW`가 있을 때만 주소를 주고(열람 기록), 없으면 도서산간 여부만 준다.
- `Shipment`(주문당 1개): 택배사 코드(`CJ | HANJIN | LOTTE | LOGEN | EPOST`), 송장번호(영문·숫자 8~30자, 하이픈·공백 제거), 상태, 발송 시각(DB 시계), 배송 완료 시각.
  - `POST /api/seller/orders/{orderId}/ship`(`ORDER_SHIPPING`, 잠금 중에도 가능): 결제 완료(`PAID`) 즉시 발송 주문만 `IN_TRANSIT`로 만든다. 재고 부족(`stockShortageAt`) 주문, 배송지가 없는 주문도 `409 not_shippable`. 배송 중에는 송장을 고쳐 다시 넣을 수 있고(첫 발송 시각 유지, `order.shipment.update` 기록), 배송 완료 뒤에는 바꾸지 않는다. 주문 상태는 `PAID` 그대로.
  - 발송한(Shipment가 있는) 주문을 환불하면 재고를 되돌리지 않고 배송 기록도 그대로 둔다. 감사 로그 `order.refund`에 `shippedBeforeRefund: true`와 배송 상태를 남긴다. 배송비 환불 금액 규칙은 대표님 결정 대기(지금은 주문 전체 금액 기준 그대로).
  - 배송 완료(`DELIVERED`) 전환·배송 추적·발송 알림은 아직 없다.

## 5. 주요 흐름 요약

- **로그인**: 해시 검증 → 세션 생성 → 토큰 쿠키. 정지된 판매자의 직원은 로그인 거부.
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
- 화면은 「지금까지 받은 version 중 최댓값」보다 큰 version이 올 때만 다시 받는다. NOTIFY는 커밋 순서와 도착 순서가 뒤바뀔 수 있으므로 마지막에 받은 값으로 판단하지 않는다.
- 연결 순서: `LISTEN` 구독이 끝난 뒤에 현재 version을 읽어 첫 이벤트로 보낸다(그 사이 변경을 놓치지 않게). 구독 전에 받은 알림은 모았다가 보낸다.
- 연결 유지 확인: SSE는 25초 핑마다 토큰(재발급·폐기)·세션·판매자 상태·방송 진행 권한(`BROADCAST_RUN`)을 다시 확인하고, 무효면 연결을 닫는다.
- 연결 수 상한: 오버레이 토큰·판매자 세션 하나당 SSE 10개(서버 인스턴스별). 넘으면 `429 too_many_streams`.
- `LISTEN` 연결: TCP keepalive를 켜고 45초마다 `SELECT 1`로 확인한다. 응답이 없거나 실패하면 다시 연결하고 「다시 받기」를 보낸다. 첫 연결이 실패하면 구독은 오류로 끝나고 리스너를 남기지 않는다.
- `LISTEN`은 PgBouncer transaction 모드에서 동작하지 않는다. 운영에서 연결 풀러를 쓰면 풀러를 거치지 않는 직접 연결 주소를 `DATABASE_DIRECT_URL`(값은 저장소에 적지 않음)로 따로 준다. 없으면 `DATABASE_URL`을 쓴다.
- 오버레이 주소(`/api/overlay/{token}/*`)는 경로에 토큰이 들어간다. 리버스 프록시·로드밸런서 접근 로그에서 이 경로를 가리거나 남기지 않게 설정해야 한다.

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
- 비밀값(DB 접속 문자열, CI 해시 키)은 환경변수로만. 저장소·문서·로그 기록 금지.

## 9. 확정 결과 (2026-10-02 21:50 KST)

| 번호 | 항목 | 확정 | 결정 |
|---|---|---|---|
| 1 | 운영·CS 세부 권한 경계 | 3.2 표 | MASTER |
| 2 | 판매자 직원 권한 | 고정 역할 대신 권한 항목 10개(3.3, 대표님 결정 2026-10-02로 변경) | 대표님 |
| 3 | 직원이 여러 판매자 소속일 때 | 판매자별 별도 계정 | MASTER |
| 4 | 구매자 로그인 수단 | 아이디+비밀번호, 가입 시 PASS 본인인증 필수(2026-10-02 대표님 지시로 변경) | MASTER |
| 5 | 재고 차감 시점 | 결제 완료 시. 재고 부족한 늦은 결제는 취소·환불 대상 표시 | 대표님 |
| 6 | 부분 취소·환불 | 이번 단계 미지원 | MASTER |
| 7 | 주문대기 단위 | 주문 품목 1개 = 대기 1건, 수량 표시 | 대표님 |
| 8 | 개봉 완료 되돌리기 | 완료 10초 안, 다른 개봉 중 없을 때만 허용. 기록 필수 | 대표님 |
| 9 | 방송 전 주문 편입 | 방송 시작 시 자동 편입 | 대표님 |
| 10 | RLS 적용 | 이번 단계 미적용, 운영 전 재검토 | MASTER |
| 11 | 회원 등급 | 판매자별 테이블, id로 식별, 기본 5개는 systemKey 표시 | MASTER |

디자인 맞춤 수정(MASTER 검수): 세션 시간(AU-007), 등급 식별 방식. 로그인 실패 잠금은 없음(대표님 결정 2026-10-02, 실패는 감사 로그에 기록).

남은 미정은 8절 [비용] 항목뿐이다.
