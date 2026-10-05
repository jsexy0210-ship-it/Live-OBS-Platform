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
- 구매자 가입(쇼핑몰 단위, `lib/server/buyers/signup.ts`):
  - `POST /api/shop/{slug}/signup/verification` `{ name, phone, birth7, carrier, device?, attemptKey?, agreedTerms, agreedPrivacy, termsVersion, privacyVersion, agreedRejoinRetention?, rejoinRetentionVersion?, rejoinRestrictionDaysShown?, agreedMarketing?, marketingVersion? }`: 가입 필수·선택 동의를 본인확인 전에 받는다(PRODUCT_SCOPE 「동의 순서」, `lib/server/buyers/consent.ts`). 동의가 없으면 `400 terms_required`, 재가입 제한 정보 보관 동의는 선택이라 빠지거나 false여도 시작된다(그 회원은 기간 스냅숏 없이 가입됨), 보관 동의 값이 불리언이 아니면 `400 invalid_rejoin_consent`, 마케팅 정보 수신 동의(선택)도 같은 요청에서 받는다(빠지거나 false면 동의 안 함, 불리언이 아니면 `400 invalid_marketing_consent`, 동의했는데 `marketingVersion`이 지금 버전(`SIGNUP_CONSENT_VERSIONS.marketing`)과 다르거나 빠지면 `409 consent_outdated`), 문서 버전이 지금과 다르면 `409 consent_outdated`, 화면이 보여 준 재가입 제한 기간이 지금과 다르면 `409 rejoin_policy_changed`(기록·문자 없음, 화면은 동의 정보를 다시 불러옴). 입력한 생년월일(birth7) 기준 KST 오늘 만 14세 미만이면 공급자를 부르지 않고 `403 under_age`(기록·문자·일일 횟수 없음, 가입 때 본인확인 결과 생년월일로 다시 확인). 받은 동의(문서 버전·시각·재가입 제한 기간·마케팅 수신 동의 문서 버전)는 `IdentityVerification.signupConsent`에 묶고, 가입하면 `BuyerMember.signupConsent`로 옮긴다(가입 본문의 약관 값은 보지 않음, 동의 기록 없는 본인확인은 `verification_invalid`). 가입을 끝내지 않은 기록은 유효 시간이 지나면 `purgeUnfinishedSignupVerifications`가 행을 지우지 않고 식별 항목(이름·휴대폰·요청 휴대폰·생년월일·CI 해시·subjectId·동의·ownerTokenHash)을 비우고 `requestId`를 무작위 값(`anonymized:…`)으로 바꾸며 `anonymizedAt`을 남긴다. 쇼핑몰·상태·요청 시각·요청 IP는 남겨 같은 IP 하루 횟수와 체험 한도(`identityUsage`, VERIFIED 건수, 비식별 행 포함)를 그대로 센다(지우면 만료를 기다려 유료 문자를 다시 받는 남용). CHECK는 「VERIFIED이고 비식별 전이면 ciHash·verifiedAt 필수」. 요청 IP는 3개월 뒤 `purgeOldSignupVerificationIps`가 비운다(가입을 마친 기록·비식별 기록). 두 정리는 앱 안 정기 실행(`jobs/scheduler.ts`)에 연결했고, 가입 처리(본인확인 확인을 통과한 요청만, 비인증 반복 쿼리 방지)·탈퇴 처리 때도 그 쇼핑몰 것을 정리한다(`purgeSignupVerificationsForShop`). 화면 가입 페이지는 문서 버전·재가입 제한 기간을 서버에서 받아 넘긴다. attemptKey(UUID, 클라이언트가 만든 값, 해시로 저장, `(sellerId, attemptKeyHash)` 유니크)로 다시 보내면 같은 쇼핑몰·같은 키의 확인 전 기록을 새로 만들거나 문자를 다시 보내지 않고 같은 `verificationId`와 같은 쿠키 값을 준다(키로 시작한 기록의 ownerToken은 키와 기록 id의 SHA-256이라 재요청이 겹쳐도 토큰이 바뀌지 않음). 일일 횟수·체험 한도도 다시 세지 않는다. 같은 키의 기록이 확인됨이면 409 `already_verified`, 만료면 410, 실패면 400. 키별 잠금 아래의 짧은 트랜잭션에서 기록을 만들고(`sendStartedAt`), 첫 문자는 트랜잭션 밖에서 보낸다(성공 `sendCount` 0→1, 실패는 `FAILED`·키 비움이라 같은 키로 새로 시작). 보내는 중(20초 안)에 같은 키로 오면 기다리지 않고 409 `start_in_progress`, 보내는 중으로 20초가 지난 기록은 공급자가 받았는지 알 수 없어 같은 요청 id로 다시 보내지 않고, 재요청이 조건부 갱신으로 `FAILED`·키 비움으로 버린 뒤 새 기록·새 요청 id로 처음부터 시작한다(일일 횟수 1회 더). 늦게 끝난 앞 요청은 502 `provider_error`를 받는다. 키가 없으면 그대로. 운영 중·잠기지 않은 쇼핑몰만(없으면 404, 잠기면 402). 같은 IP·같은 쇼핑몰 하루 10회(KST, 넘으면 429 `daily_limit_exceeded`). 첫 인증번호를 보내고 시작한 브라우저에만 `lo_bidv` 쿠키(경로 `/api/shop/{slug}/signup`)를 준다. 운영에 본인확인 설정이 없으면 503.
  - `…/verification/resend`·`…/verification/confirm` `{ verificationId, code? }`: 판매자 가입과 같은 본인확인 단계(체험 중 성공 건수 한도 포함). URL의 쇼핑몰이 본인확인 기록의 쇼핑몰과 다르면 404, 잠긴 쇼핑몰이면 402. confirm 성공은 `{ ok: true, identity: { name, phone, birthDate: "YYYY-MM-DD" } }`로 저장된 본인확인 결과(공급자 결과, NFKC 정규화)를 돌려준다(시작한 브라우저에만, 판매자 쪽 용도는 `{ ok: true }` 그대로).
  - `POST /api/shop/{slug}/signup` `{ verificationId, loginId, password, broadcastNickname }`: `completeIdentityVerification`(공급자·용도·쇼핑몰·ownerToken)을 거친 본인확인만 쓴다. 아이디는 이메일(형식 검사, 254자까지, 소문자로 맞춰 저장해 대소문자만 다른 중복을 막음, 로그인도 소문자로 맞춰 찾음), 비밀번호 8~200자, 방송 닉네임 1~20자, 필수 약관 동의(감사 로그 `buyer.signup`에 동의 기록). 선택 마케팅 수신 동의는 본인확인 시작 때 받은 기록(`signupConsent.marketing`)을 쓴다(가입 본문의 `agreedMarketing`은 보지 않음): 동의했으면 그 동의 시각을 `BuyerMember.marketingConsentAt`에 남기고 감사 로그에 동의 여부·문서 버전(`marketingVersion`)을 함께 기록한다. 이름·휴대폰·생년월일은 본인확인 결과. 같은 CI·아이디·닉네임은 409. 본인확인 생년월일 기준 KST 오늘 만 14세 미만이면 `403 under_age`(「만 14세 미만은 가입할 수 없어요」, 생일 당일부터 가입 가능, 시도 횟수에 넣지 않음, MASTER 결정 2026-10-03). 본인확인 1건으로 가입 시도는 5번까지(중복 실패 포함, 입력 형식 오류는 제외, `IdentityVerification.useAttemptCount`), 넘으면 429 `too_many_signup_attempts`. 성공하면 201 `{ ok: true, broadcastNickname }`과 구매자 세션 쿠키(바로 로그인). 본인확인 쿠키(`lo_bidv`)는 지우지 않는다(응답 본문이 끊겨도 같은 요청을 다시 보낼 수 있게, 확인 뒤 10분이 지나면 쓸모없음). 가입하면 본인확인 기록에 만든 회원(`subjectId`)을 남긴다. 응답이 끊겨 같은 `verificationId`·같은 브라우저(ownerToken)로 다시 보내면, 그 본인확인으로 만든 회원과 아이디(대소문자 무시)·비밀번호가 같을 때 새로 만들지 않고 같은 201과 세션을 다시 준다(시도 횟수에 넣지 않음). 다른 아이디·틀린 비밀번호·쿠키 없음은 400 `verification_invalid`.
- 판매자 비밀번호 찾기(대표님 지시 2026-10-02): 메일 링크 없이 **대표자 휴대폰 본인확인(문자)**으로만 한다.
  - 이메일+쇼핑몰+대표자 인적사항으로 시작(첫 인증번호 발송) → 인증번호 확인(`/confirm`) → `/verify`에서 결과 CI가 그 쇼핑몰 `Seller.representativeCiHash`와 같고 계정이 대표자(`isOwner`)일 때만(직원은 아래 「로그인 탭·계정 찾기」의 연결 CI) 일회용·10분 재설정 권한(`PasswordResetGrant`, 토큰 해시 저장) 발급 → 새 비밀번호 저장, 그 계정의 기존 세션 모두 폐기.
  - 본인인증 건은 시작한 브라우저에만 준 일회용 값(`IdentityVerification.ownerTokenHash`, HttpOnly 쿠키)과 묶고, 한 번 쓰면 `consumedAt`으로 소진한다(구매자 가입도 같음).
  - CI 불일치·직원 계정·없는 계정은 모두 같은 거부 응답(계정 존재 비노출). 시작·발급·완료·실패는 감사 로그.
  - 시작 횟수: 쇼핑몰 하나당 하루 10회(KST 자정 초기화, DB 시계로 집계, 쇼핑몰별 직렬화). 넘으면 429 `reset_limit_exceeded`와 감사 로그(대표님 결정 2026-10-02). 없는 쇼핑몰 주소는 한 묶음으로 센다.
  - 시작 재시도(`POST /api/seller/password-reset/start` `{ email, shopSlug, person, attemptKey? }`, 2026-10-04): attemptKey(클라이언트 UUID)로 다시 보내면 같은 쇼핑몰 주소·같은 아이디 범위의 같은 키 기록을 찾아 같은 `verificationId`·같은 쿠키 값을 준다(문자·하루 10회·감사 로그 다시 안 씀, 계정 유무와 상관없이 같은 응답). 첫 문자를 보내는 중이면 `409 start_in_progress`, 이미 확인됐거나 끝난 기록이면 `already_verified`·`expired`·`failed`, 키 형식이 틀리면 400. 판정은 구매자 가입과 같은 `lib/server/identity/attempt.ts`(`reuseKeyedAttempt`, 보내는 중 20초 넘게 멈춘 기록은 버리고 새로 시작).
  - 직원(매니저·방송 담당) 비밀번호는 대표가 직원 관리에서 재설정하고, 직원의 기존 세션을 폐기한다.
  - **로그인 탭·계정 찾기(2026-10-03·04 대표님 결정, 정본 `docs/PRODUCT_SCOPE.md` 로그인·본인확인 횟수 제한, IA AU-002·003·011)**:
    - 로그인 `POST /api/seller/auth/login` `{ email, password, shopSlug?, accountType?: owner|staff }`: 비밀번호가 맞은 계정 중 고른 탭과 같은 종류만 본다. 맞은 계정이 모두 다른 종류면 세션 없이 `409 wrong_account_type`(감사 로그 `auth.seller.login_blocked`). 비밀번호가 틀리면 탭과 상관없이 `401 invalid_credentials`. accountType이 없으면 종류를 보지 않는다(하위 호환), 다른 값은 400.
    - 직원 휴대폰·연결 CI: `SellerUser.phone`(대표자가 등록, nullable)·`identityCiHash`·`identityLinkedAt`. 대표자는 `POST /api/seller/staff`(phone 선택)·`PATCH /api/seller/staff/{id}` `{ name?, phone? }`로 채우거나 바꾸고, 번호가 바뀌면 연결 CI를 지운다(감사 로그 `seller.staff.profile`, 번호는 끝 4자리만). 목록은 `phone`·`identityLinked`만 주고 해시는 내보내지 않는다.
    - 직원 연결(로그인한 직원만, 연결 전·풀린 뒤에도 로그인·권한은 그대로, 셀프 찾기에만 씀): `GET /api/seller/me/identity` `{ available(본인확인 사용 가능), phoneRegistered, registeredPhoneLast4(끝 4자리만), linked, relinkRequired(연결돼 있다가 대표자의 번호 변경으로 풀림, `SellerUser.identityUnlinkedAt`, 다시 연결하면 해제) }` → `POST …/start`(인적사항, 등록 번호 없음 `409 phone_not_registered`, 입력 이름·번호가 등록 정보와 다르면 문자 없이 `409 identity_mismatch`, 직원당 하루 10회 `429 link_limit_exceeded`, 쿠키 `lo_lidv`, `attemptKey?`로 다시 보내면 같은 직원·같은 키의 기록을 찾아 같은 `verificationId`·같은 쿠키 값(문자·하루 횟수 다시 안 씀, 보내는 중 `409 start_in_progress`)) → `…/resend`·`…/confirm` → `…/link` `{ verificationId }`(결과 이름·휴대폰이 등록 정보와 같으면 연결, 다르면 `409 identity_mismatch`, 본인확인은 소진). 직원 이름은 만들기·고치기가 `cleanStaffName`(= `cleanText(…, STAFF_NAME_MAX)`, NFKC·앞뒤 공백·제어·서식 문자 거부·코드포인트 50자)으로 정규화해 저장하고, 연결 비교도 같은 정규화를 쓴다(정규화 전 예전 이름의 제어·서식 문자는 비교할 때 빼고 봄, `lib/server/sellers/staffName.ts`). 본인확인 이름 상한은 목적별(`identityNameMax`: 직원 연결 50, 나머지 30)로 시작과 확인 결과 정리가 같은 값을 쓴다. 연결 시작은 문자를 보내기 전에 직원 행을 잠그고 이름·휴대폰·상태를 다시 비교한다(다르면 기록·문자·하루 횟수 없음). 대표자·마스터 대리 조회는 403.
    - 비밀번호 찾기(이메일+쇼핑몰) `start`에 `accountType?`: 주면 그 종류 계정만 대상. `/verify`는 대표자면 쇼핑몰 대표자 CI, 직원이면 연결 CI와 결과 CI가 같을 때만 같은 일회용·10분 권한을 준다. CI 불일치·연결 전 직원·종류 다름·없는 계정은 모두 `reset_not_allowed`(계정 존재 비노출, 화면이 탭에 맞는 안내). 권한을 쓸 때 대조 CI(대표자 CI·직원 연결 CI)가 바뀌었으면 거부한다.
    - 아이디 찾기·계정 고르기 비밀번호 찾기(쇼핑몰 몰라도 됨, `lib/server/auth/accountRecovery.ts`): `POST /api/seller/find-id/start`(인적사항, `attemptKey?`, 쿠키 `lo_fidv`) → `…/resend`·`…/confirm` → `…/accounts` `{ verificationId, accountType }` → `{ accounts: [{ accountId, shopName, shopSlug, email }] }`(활성 계정·해지·반려 쇼핑몰 제외, 맞는 계정이 없으면 빈 목록, 본인확인 소진 안 함) → `…/reset` `{ verificationId, accountType, accountId }`(목록에 있는 계정만, 비밀번호 찾기와 같은 `lo_pwreset` 권한 쿠키를 주고 `/api/seller/password-reset/complete`로 저장, 본인확인 소진. 흐름 쿠키는 지우지 않아, 응답을 잃으면 같은 본인확인·같은 계정으로 소진 뒤 10분 안에 다시 요청해 같은 권한을 받는다(권한 행에 본인확인 id와 nonce를 두고 토큰 = `IDENTITY_HASH_KEY` HMAC(nonce)로 다시 만듦, 원문 저장 안 함, 동시 재시도도 같은 토큰, 조회는 그 본인확인 범위만, 그 권한을 이미 썼으면 거부)). 실패는 `400 recovery_not_allowed`·확인 전 `409 pending`.
    - 한도(`lib/server/auth/recoveryLimit.ts`): 아이디 찾기·비밀번호 찾기 시작을 합쳐 같은 휴대폰 하루 10회·같은 접속 IP 하루 30회(KST, 번호·IP별 advisory lock), 비밀번호 찾기는 쇼핑몰당 하루 10회도 함께. 넘으면 아이디 찾기 `429 recovery_limit_exceeded`, 비밀번호 찾기 `429 reset_limit_exceeded`(문자 없음). 비밀번호 찾기 기록에도 요청 IP를 남긴다. 본인확인 목적 `STAFF_LINK`·`ACCOUNT_RECOVERY` 추가. 두 목적의 기록은 그 기록의 KST 날짜가 지나고 유효 시간+10분도 지나면 정기 실행 `identity_verification.anonymize_old_recovery`가 이름·휴대폰·생년월일·CI 해시·subjectId·ownerTokenHash·요청 IP를 비운다(행·상태·시각은 남김, 직원 연결 CI는 `SellerUser`에 그대로).

### 3.2 마스터 역할

| 기능 | 최고관리자 | 운영 | CS | 조회 전용 |
|---|---|---|---|---|
| 전체 조회 | O | O | O | O |
| 판매자 승인·정지·해제 | O | O | X | X |
| 요금제·구독·청구 변경 | O | O | X | X |
| 가격 변경·구독 환불 승인 | O | X | X | X |
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

- 추가 기능 11건(쿠폰·상품 리뷰·교환·반품 등, 2026-10-04 확정)은 새 항목 없이 위 항목에 대응한다. 기능별 대응표는 `HANDOFF.md` 「추가 기능 11건 개발 배정」이다.
- **대표자 전용(항목으로 줄 수 없음)**: PG 연결, 구독, 직원 관리, 적립금 실지급 스위치.
- 직원 관리 API(대표자 전용): 생성, 권한 변경, 비활성화(기존 세션 폐기), 비밀번호 재설정. 같은 쇼핑몰 직원만(다른 쇼핑몰은 404), 대표자 계정은 대상 아님(403). 생성·권한 변경·비활성화는 감사 로그(누가, 누구의, 전과 후).
- 옛 역할 데이터 이전: `OWNER` → 대표자, `MANAGER` → `SHOP_SETTINGS`를 뺀 9개 항목, `BROADCASTER` → `BROADCAST_RUN`·`OVERLAY_EDIT`.
- 마스터 대리 조회(읽기 전용)는 주문·고객 정보·매출·회원 조회만 허용하고 변경은 모두 거부.

### 3.4 테넌트 격리 (판매자 간 차단)

1. **모든 판매자 데이터 테이블에 `sellerId` 필수.** 예외는 플랫폼 테이블(`PlatformAdmin`, 요금제, 감사 로그의 플랫폼 항목)뿐.
2. **판매자 범위 조회만 허용**: 판매자 API는 세션에서 `sellerId`를 얻고(요청 본문·쿼리의 `sellerId`는 무시), 저장소 함수는 `TenantContext { sellerId }`를 첫 인자로 받아 모든 `where`에 넣는다. ID 하나로만 조회하는 함수(`findUnique({ id })`)를 판매자 경로에서 쓰지 않는다 → 다른 판매자 ID를 넣으면 **없음(404)** 으로 처리해 존재 여부도 숨긴다.
3. **DB 제약으로 교차 참조 차단**: 자식 테이블은 `(sellerId, parentId)` 복합 외래키로 부모를 참조한다(예: 주문 품목 → 주문, 주문대기 → 주문 품목). 코드 실수가 있어도 다른 판매자 주문에 묶일 수 없다.
4. **구매자**는 쇼핑몰 호스트로 `sellerId`가 정해지고, 자기 회원 ID 범위만 조회한다.
5. **마스터 대리 조회**는 읽기 전용 컨텍스트(`{ sellerId, readOnly: true, actor: admin }`)로 판매자 조회 함수를 재사용하고, 변경 함수는 `readOnly`면 거부한다. 진입 시 사유와 함께 감사 로그. 구현(MA-016): `POST /api/admin/sellers/{id}/impersonate { reason }`가 30분짜리 별도 세션(`AdminImpersonationSession`)과 쿠키 `lo_imp`(경로 `/api/seller`, `imp.` 토큰)를 주고, `GET·DELETE /api/admin/impersonation`(내 열린 세션 조회·끝내기), `GET /api/seller/impersonation`(읽기 전용 배너용). 읽기 전용은 proxy(조회 허용 경로 `orders·members·products·stats·impersonation`과 정확히 `/api/seller/me`의 GET·HEAD만, 나머지 403 `impersonation_read_only`). 로그인 전 흐름(`auth/login`·`auth/logout`·`password-reset`·`find-id`)은 쿠키가 남아 있어도 막지 않고, 로그인 성공·로그아웃 응답이 `lo_imp`를 지운다(로그아웃은 `lo_seller`로 진짜 세션을 끊는다). 화면 틀이 읽는 `GET /api/seller/me`는 대리 조회면 `readOnly: true`·`impersonation { adminName, reason, startedAt, expiresAt }`·표시용 권한(주문·상품·회원·통계)·`user`(관리자 이름)를 내린다와 가드(`readOnly`·권한 없음)가 겹쳐 지킨다. 열기·끝내기는 `admin.impersonate.view`·`admin.impersonate.end`.
6. 통합 테스트에 판매자 A·B를 만들고 B 세션으로 A의 주문·주문대기·회원·상품 조회·변경이 모두 거부되는지 검사한다.
7. [확정] Postgres 행 수준 보안(RLS)은 이번 단계에서 쓰지 않는다(Prisma 연결 풀과 세션 변수 결합이 복잡). 위 2·3으로 막고, 운영 전 보강 여부를 다시 정한다.

## 4. 데이터 모델 초안

상태값은 Postgres enum. 굵은 글씨는 주요 제약.

### 4.1 플랫폼

- `PlatformAdmin`: id, email(**유니크**), passwordHash, name, role(`SUPER_ADMIN | OPERATIONS | CS | READ_ONLY`), status(`ACTIVE | SUSPENDED`), lastLoginAt, createdAt
- `AdminSession`: id, adminId, tokenHash(**유니크**), ip, userAgent, expiresAt, lastSeenAt, revokedAt

### 4.2 판매자(쇼핑몰)·직원

- `Seller` (테넌트 = 쇼핑몰 1개): id, slug(기본 주소 하위 이름, **유니크**), shopName, status(`PENDING | ACTIVE | SUSPENDED | REJECTED | CLOSED`), businessInfo(JSON), approvedAt, approvedByAdminId, suspendedReason, representativeCiHash(대표자 휴대폰 본인확인 CI의 HMAC), representativeVerifiedAt(둘은 함께 기록), liveVersion(실시간 version 카운터, 기본 0), createdAt — **대표자 1명당 쇼핑몰 1개**: representativeCiHash 부분 유니크(해지 `CLOSED`·반려 `REJECTED` 제외)
- 공유 미리보기(SA-060, 대기열 4번 C안): `Seller.shareTitle`(60자)·`shareDescription`(160자), `GET·PUT /api/seller/share-preview`(대표자·`SHOP_SETTINGS`). 공개 `GET /api/shop/{slug}/share`(제목·설명·카드 주소, 상품 상세는 상품 이름 우선)와 `GET /api/shop/{slug}/og.png`(쇼핑몰 이름 기본 카드, 원티드 산스로 서버에서 그림, `lib/server/shop/ogCard.ts`). 로고·배너·팝업 이미지 업로드는 대표님 지시(2026-10-04)로 이미지 저장소 결정 전까지 A(DB 저장, PNG, `lib/server/branding/image.ts` 검사기 재사용)로 만든다. 쇼핑몰별 파비콘·카드 이미지 업로드도 같은 방식으로 뒤따른다
- `SellerDomain`: id, sellerId, hostname(**유니크**), verifiedAt, certStatus — 개인 도메인 연결용 자리만
- `SellerUser`: id, sellerId, email, passwordHash, name, isOwner, permissions(권한 항목 배열, 3.3), status(`ACTIVE | DISABLED`), lastLoginAt, phone(직원 휴대폰, nullable), identityCiHash·identityLinkedAt(직원 본인확인 연결, 3.1) — **(sellerId, email) 유니크**, 판매자당 OWNER 1명 이상
- `SellerSession`: id, sellerUserId, sellerId, tokenHash(**유니크**), expiresAt, lastSeenAt, revokedAt
- [확정] 한 사람이 여러 판매자의 직원이 되는 경우 판매자별 별도 계정(이메일 같아도 됨). 한 판매자가 쇼핑몰 여러 개를 갖는 경우는 지원하지 않음(별도 판매자로 가입).

### 4.3 구매자 회원 (판매자 쇼핑몰별)

- `BuyerMember`: id, sellerId, loginId, passwordHash, name, phone, ciHash(휴대폰 본인확인 CI의 HMAC-SHA256, 원문 CI 미저장), identityVerifiedAt, birthDate(본인확인 생년월일, 미성년자 판정용), broadcastNickname, gradeId, status(`ACTIVE | DORMANT | WITHDRAWN`), marketingConsentAt, createdAt, deletedAt — **(sellerId, ciHash) 유니크**(같은 쇼핑몰 중복 가입 차단), **(sellerId, phone) 유니크**, **(sellerId, loginId) 유니크**, **(sellerId, broadcastNickname) 유니크**(방송 화면에서 구분 가능하게). 네 유니크는 `deletedAt IS NULL`인 행에만 적용(부분 유니크 인덱스)
  - 탈퇴하면 `status = WITHDRAWN`과 `deletedAt`을 같은 트랜잭션에서 함께 기록하고 개인정보(이름·휴대폰·닉네임)를 비식별 처리한다. `POST /api/shop/{slug}/me/withdraw` `{ password }`(구매자 세션, `lib/server/buyers/withdraw.ts`, MASTER 기준 2026-10-03): 비밀번호를 다시 확인하고(틀리면 구매자 로그인과 같은 401 `invalid_credentials`·문구, 실패 감사 로그 `buyer.withdraw_failed`), 같은 회원이 15분 안에 5번 틀리면 429 `too_many_attempts`(회원별 advisory lock 아래에서 세어 동시 요청에도 한도를 넘지 않음). 결제 완료 뒤 배송 완료 전 주문(발송 전·배송 중·재고 부족 환불 대기)이 있으면 409 `orders_in_progress`(「배송 중인 주문이 끝나거나 환불되면 탈퇴할 수 있어요」). 결제 대기 주문은 막지 않고 탈퇴 트랜잭션 안에서 판매자 취소와 같은 경로(`queue/service.ts` `cancelPendingOrderInTx`: 상태 이력·주문 때 뺀 재고 되돌리기·감사 로그 `order.cancel`, 사유 `member_withdrawn`)로 자동 취소한다(약관 제7조 ①, 감사 로그 `cancelledPendingOrders`). 탈퇴는 주문 생성과 같은 순서로 판매자 주문 잠금 → 회원 행을 잡는다. 이름·휴대폰·닉네임·아이디(이메일)를 비식별 값으로 바꾸고 CI 해시·생년월일은 비운다(같은 사람·아이디·닉네임으로 다시 가입 가능). 이 쇼핑몰에서 그 회원과 이어진(`subjectId`) 또는 같은 CI 해시의 본인확인 기록은 미가입 기록 정리와 같이 행을 두고 식별 항목만 비운다(requestId 무작위, `anonymizedAt`, 쇼핑몰·상태·요청 시각·요청 IP는 체험 한도·같은 IP 하루 횟수 계산에 남김). 주문·주문대기·히트 카드의 방송 닉네임 스냅숏은 「탈퇴한 회원」으로 바꾸고(받는 사람 스냅숏 등 법정 거래 기록은 그대로), 구매 제한·세션 행은 지운다. 표마다 처리(삭제·비식별·법정 보관)는 `lib/server/buyers/memberData.ts` `MEMBER_DATA_POLICY`(회원 칸)·`MEMBER_REFERENCE_POLICY`(AuditLog·StockMovement·OrderStatusHistory·QueueItemStatusHistory의 행위자·대상 공용 칸, 구매자 행은 법정 보관)에 두고, 회원과 이어진 표가 목록에 없으면 `tests/unit/memberData.test.ts`가 실패한다(감사 로그 `anonymizedVerifications`·`anonymizedOrders`·`anonymizedQueueItems`·`anonymizedHitCards`·`deletedRestrictions`·`deletedSessions`). 비밀번호는 아무도 모르는 값으로, 마케팅 동의는 지운다. 남은 적립금은 소멸한다(대표님 결정 2026-10-03): 잔액이 있으면 `EXPIRE` 원장(음수, `SUCCEEDED`, 키 `expire:withdraw:{회원 id}`)을 남기고 잔액을 0으로, 처리 전(`PENDING`) 원장은 `FAILED`(`member_withdrawn`)로 닫는다(감사 로그 `expiredPoints`·`closedPendingRewards`). 재가입은 새 회원이라 되살아나지 않는다. 저장 배송지 삭제, 감사 로그 `buyer.withdraw`, 세션 쿠키 삭제. 주문·결제·환불 기록과 주문의 받는 사람 스냅숏은 그대로 둔다(전자상거래법 보관 의무).
  - 법정 보관(대표님 결정 2026-10-03, PRODUCT_SCOPE 탈퇴 절·처리방침 2-(1)-③, `lib/server/buyers/legalHold.ts`): 끝난 주문(취소·자동 취소·환불·구매 확정, 받는 사람 스냅숏·결제·환불 칸 포함)은 회원과 상관없이 `Order.legalRetainUntil` = 끝난 날(createdAt·paidAt·cancelledAt·refundedAt·purchaseConfirmedAt 중 가장 늦은 때) + 5년을 계산해 두고, 끝나는 일이 생길 때마다 다시 계산한다(구매 확정 뒤 환불되면 환불 날 기준, `refreshOrderRetention`). 탈퇴하지 않은 회원의 끝난 주문은 회원 서비스(주문 내역, 교환·반품·문의)를 위해 그대로 두고, 분리 보관 표시 `Order.legalHoldAt`은 탈퇴 때 그 회원의 끝난 주문에, 탈퇴 뒤 끝나는 주문은 끝날 때 단다. 분리된 주문은 판매자 일반 조회(`orders/read.ts` 상세·목록·검색)와 구매자 조회(`orders/buyer.ts`)에서 없는 주문으로 다룬다. 회원이 행위자(actorType=BUYER)·대상(targetType=BuyerMember)인 감사 로그는 기록할 때(`audit/log.ts` `writeAudit`) 행동 종류별(`MEMBER_AUDIT_RETENTION`, `order.*` = 거래 관련) `AuditLog.retainUntil` = 기록 시각 + 5년(거래 관련·분류 없음) 또는 + 3개월(거래 무관: 로그인·로그인 실패·가입·회원 정보 수정·탈퇴·구매 제한)을 단다(탈퇴와 상관없이, 기존 행은 마이그레이션에서 채움). 탈퇴하면 거래 관련 행에 `AuditLog.legalHoldAt`을 단다. 탈퇴한 회원에게는 구매 제한을 새로 만들지 않는다(`maybeRestrict`). 소스의 주문·구매자 행동이 분류에 없으면 `tests/unit/memberData.test.ts`가 실패한다. 보관 만료 뒤 파기·회원 id 비식별과 분리 기록 별도 조회 경로(최고관리자·지정 담당자, 조회마다 감사 로그)는 후속.
  - 재가입 제한(대표님 결정 2026-10-03, `lib/server/buyers/rejoin.ts`): 판매자 설정 `SellerMemberPolicy`(rejoinRestrictionEnabled 기본 false, rejoinRestrictionDays 기본 30·1~365, CHECK). `GET·PUT /api/seller/member-policy` `{ rejoinRestrictionEnabled, rejoinRestrictionDays? }`(`MEMBER_POINTS`, 감사 로그 `member_policy.rejoin_restriction`, 틀리면 `400 invalid_member_policy`). 제한이 켜진 쇼핑몰은 본인확인 시작 때(가입 필수 동의와 함께, `buyers/consent.ts`) 「재가입 제한 정보 보관 동의」(`agreedRejoinRetention`, **선택**, 대표님 결정 2026-10-03, 개인정보 수집·이용 동의와 별도, 기본 체크 안 함)를 받는다. 동의하지 않아도 가입되고, 그 회원은 기간 스냅숏이 없어 탈퇴 때 CI 해시를 남기지 않으며 재가입 제한도 받지 않는다(불리언이 아니면 `400 invalid_rejoin_consent`). 동의한 경우만 화면이 보여 준 기간(`rejoinRestrictionDaysShown`)·문서 버전(`rejoinRetentionVersion`)이 지금과 같아야 한다(다르면 시작하지 않고 `409 rejoin_policy_changed`·`409 consent_outdated`, 화면은 동의 정보를 다시 불러와 다시 동의받음). 동의한 기간은 본인확인 기록에 묶여 가입 때 회원으로 옮기므로, 가입 단계는 정책을 다시 대조하지 않는다(커밋된 가입 재시도도 그대로 201·세션). 판매자 화면은 「쇼핑몰 설정 › 회원 정책」(`/seller/settings/member`, 켜기·30·90·180·365일). 그때 기간·동의 시각·문서 버전을 `BuyerMember.rejoinRestrictionDaysAgreed·rejoinRetentionAgreedAt·rejoinRetentionVersion`에 남긴다(감사 로그 `buyer.signup`에도). 회원은 언제든 철회한다(`lib/server/buyers/rejoinConsent.ts`, 개인정보 보호법 제37조): `GET·PUT /api/shop/{slug}/me/rejoin-retention-consent`(로그인한 회원 본인, 잠긴 쇼핑몰·기능 권한과 관계없이 열림) `GET → { agreed, agreedAt, version, restrictionDays, withdrawnAt }`, `PUT { agreed: false }`로 위 세 칸과 가입 동의 기록(`BuyerMember.signupConsent`·그 회원을 만든 본인확인 기록의 `signupConsent`)의 `rejoinRetention`을 비우고 `rejoinRetentionWithdrawnAt`을 남긴다(감사 로그 `buyer.rejoin_retention_consent.withdraw`, 이미 철회됐으면 바꾸지 않음, 그 밖의 본문은 `400 invalid_rejoin_retention_consent`, 다시 동의는 없음). 탈퇴는 회원 행을 잠근 뒤 다시 읽은 지금 동의 상태로 CI 해시 보관을 정한다(잠그기 전에 읽은 값으로 정하지 않음). 켜진 쇼핑몰에서 그 값이 있는 회원이 탈퇴하면 `BuyerRejoinBlock`(sellerId, ciHash, expiresAt = 탈퇴 + min(가입 때 기간, 지금 기간), **(sellerId, ciHash) 유니크**, 다시 탈퇴하면 기간을 새로)을 남긴다. 제한이 꺼져 있을 때 가입한 회원은 남기지 않는다. 목적은 재가입 제한뿐이고 다른 정보는 두지 않는다. 가입 때 같은 쇼핑몰·같은 CI 해시의 기록이 안 끝났으면 `403 rejoin_restricted` `{ message: 「지금은 다시 가입할 수 없어요」, rejoinAvailableAt }`(화면이 「…부터 가입할 수 있어요」를 붙임, SH-011)(가입 시도 횟수에 들어감). 기간이 끝난 기록은 `purgeExpiredRejoinBlocks`가 지운다: 앱 안 정기 실행(`lib/server/jobs/scheduler.ts`, `instrumentation.ts` register·nodejs 런타임, 1시간 간격, 작업마다 `pg_try_advisory_xact_lock`으로 한 인스턴스만, 실패해도 앱은 계속, `SCHEDULER_DISABLED=1`이면 끔)이 모든 쇼핑몰을 지우고, 가입 처리(본인확인 확인을 통과한 요청만, 비인증 반복 DELETE 방지)·탈퇴 처리 때도 그 쇼핑몰 것을 지운다(끝난 기록은 가입을 막지 않음). 정리 작업을 새로 만들면 `SCHEDULED_JOBS`에 넣는다. 판매자가 제한을 끄면 그 쇼핑몰 기록을 모두 지운다. 기록 만들기와 끄기는 같은 advisory lock을 쓴다.
- `MemberGrade`: id, sellerId, displayName, sortOrder, systemKey(nullable: `BASIC | SPROUT | SILVER | GOLD | VIP`) — 등급은 **id·displayName·sortOrder로 식별**한다. 판매자 생성 시 일반·새싹·실버·골드·VIP 5개를 기본으로 만들고 `systemKey`로 표시만 한다. 판매자가 추가한 등급은 `systemKey = null`. **(sellerId, displayName) 유니크**, **(sellerId, systemKey) 유니크(null 제외)**. 디자인 지시(`docs/DESIGN_PROMPT.md` 245줄) 「이름·개수는 판매자가 정한다」에 맞춰 고정 enum으로 식별하지 않는다. 적립률(`RewardPolicy.rates`)도 등급 id 기준. [확정]
- `IdentityVerification` (휴대폰 본인확인 요청·결과): id, sellerId(nullable, 판매자 대표자 인증은 null), purpose(`BUYER_SIGNUP | SELLER_REPRESENTATIVE | PASSWORD_RESET`), provider, method(`PASS_APP | SMS`, 2026-10-03 전환 전 기록은 `PASS_APP` 그대로), requestId, status(`PENDING | VERIFIED | FAILED | EXPIRED`), requestedPhone, sendCount, lastSentAt, otpFailCount, ciHash, name, phone, birthDate, verifiedAt, anonymizedAt, expiresAt — **(provider, requestId) 유니크**, `VERIFIED`이고 비식별 전(anonymizedAt 없음)이면 ciHash·verifiedAt 필수(CHECK)
  - CI 원문은 저장하지 않는다. 서버 비밀키(환경변수 `IDENTITY_HASH_KEY`)로 만든 HMAC-SHA256 값만 저장한다.
  - 방식(대표님 결정 2026-10-03, PRODUCT_SCOPE 「휴대폰 본인확인 방식」): 본인확인기관 대행사의 「문자로 본인확인」. 인적사항(이름·휴대폰번호·생년월일+성별 자리 7자리·통신사) → 인증번호 보내기 → (다시 보내기) → 인증번호 확인 → 서버 결과 조회로만 `VERIFIED` 확정. 결과의 요청 id·용도·휴대폰번호가 요청 기록과 다르면 실패.
  - 제한(`lib/server/identity/verification.ts` 상수, 대행사 규격을 알게 되면 맞춤): 인증번호 3분, 다시 보내기 30초 간격·처음 포함 4번, 5번 틀리면 실패, 시작부터 10분, 확인 뒤 10분 안에 사용. 공급자 호출 10초 넘으면 장애로 처리.
  - 연동은 `IdentityProvider` 인터페이스 뒤에 둔다. 개발·테스트는 가짜 공급자만 쓴다(운영에서 만들 수 없음). 운영 후보는 포트원 V2 + KCP 「API 방식」(`lib/server/identity/portone.ts`, 키 `PORTONE_API_SECRET`·`PORTONE_STORE_ID`·`PORTONE_IDENTITY_CHANNEL_KEY`, 계약 전이라 실제 호출 미검증). 운영에서 키가 없으면 본인확인 라우트는 `503 identity_unavailable`: 구매자 가입·파트너스 가입 신청은 「본인확인 서비스 준비 중이에요」, 파트너스 아이디·비밀번호 찾기·직원 본인확인 연결은 「본인확인 서비스를 준비하고 있습니다」.
- `BuyerSession`: id, buyerMemberId, sellerId, tokenHash(**유니크**), expiresAt, revokedAt
- 같은 사람이 다른 판매자 쇼핑몰에 가입하면 별도 회원이다(데이터 공유 없음).
- [확정] 구매자 로그인 수단은 「아이디+비밀번호」, 가입 시 휴대폰 본인확인 필수(2026-10-02 대표님 지시, 2026-10-03 PASS 앱 → 문자 방식 전환). 휴대폰 번호 로그인·카카오 로그인은 보류.
- [비용] 휴대폰 본인확인 대행사 계약·건당 비용 (MASTER가 대표님께 보고).

### 4.4 상품·옵션·재고

- `Product`: id, sellerId, name, description, price, status(`DRAFT | ON_SALE | SOLD_OUT | HIDDEN`), sortOrder, deletedAt
- `ProductImage`: id, sellerId, productId, storageKey, sortOrder — 저장소 구성은 미확정(PRODUCT_SCOPE)
- `ProductOption`: id, sellerId, productId, name(예: 「1팩」), priceDelta, stock(**CHECK stock >= 0**), sku, sortOrder, deletedAt(소프트 삭제) — 옵션 없는 상품도 기본 옵션 1개를 둬 재고를 한 곳에서 관리
- `StockMovement`: id, sellerId, optionId, delta, reason(`ORDER | CANCEL | REFUND | MANUAL`), orderId, note(수동 증감 사유), actor, createdAt — 재고 변경 이력
- 재고 차감은 `UPDATE … SET stock = stock - n WHERE id = ? AND sellerId = ? AND stock >= n`의 영향 행 수로 판정(초과 판매 방지).
- 주문의 모든 품목 차감은 **한 트랜잭션**에서 처리한다. 품목 하나라도 영향 행 수가 0이면 그 트랜잭션의 모든 차감을 되돌리고(롤백), 별도 트랜잭션에서 주문에 `stockShortageAt`만 기록한다. 일부 품목만 차감된 상태는 생기지 않는다.
- 판매자 상품·옵션 API(`PRODUCT_MANAGE`, 잠긴 판매자는 402, 마스터 대리 조회는 목록·조회만 되고 변경은 403): `GET·POST /api/seller/products`, `GET·PATCH·DELETE /api/seller/products/{productId}`, `POST /api/seller/products/{productId}/options`, `PATCH·DELETE /api/seller/products/{productId}/options/{optionId}`.
  - 다른 판매자 상품·옵션, 다른 상품의 옵션은 404. 상품 행을 잠근 뒤 가격·옵션을 검사한다.
  - 목록은 커서 페이지(`?cursor·limit`, 기본 50·최대 200, 응답 `{ products, nextCursor }`, 정렬 진열 순서 → 최근 등록 → id). 커서는 이 판매자 상품 id만 받고(아니면 `400 invalid_cursor`), 그 행의 (sortOrder, createdAt, id) 값 바로 뒤부터 keyset으로 고른다 — 기준 상품이 그사이 지워지거나 필터 밖이 되어도 다음 상품을 건너뛰지 않는다. limit은 숫자만 있는 값 1~200만 받고 아니면 `400 invalid_limit`.
  - 목록 검색·정렬(SA-011): `display=shown|hidden`(쇼핑몰에 보임=판매 중·품절 / 안 보임=판매 대기·숨김), `code`(상품 코드 P0000012·P·앞 0 생략 가능, 상품 id 전체, 옵션 SKU 부분 일치, 64자), `stockDeductMode=ORDER|PAYMENT`(재고 차감 시점. 시안의 「판매 방식」은 정의가 생기면 따로), `createdFrom·createdTo`(KST 날짜, 양 끝 포함), `sort=newest|sales|price_asc|price_desc`(같으면 id 순, 커서는 그 행의 지금 정렬 값 뒤부터). 판매량 `soldQuantity`는 결제 완료(PAID) 주문 품목 수량 합. 틀리면 `400 invalid_display·invalid_code·invalid_stock_deduct_mode·invalid_date_range·invalid_sort`. 선택 일괄 처리 `POST /api/seller/products/bulk` `{ action: "status", status } | { action: "delete" }` + `productIds`(1~200): 한 트랜잭션에서 잠그고 상품마다 로그 추적(`bulk: true`), 다른 판매자·지운 상품은 `skipped: not_found`, 옵션 없는 상품의 판매 중 전환은 `skipped: no_sellable_option`. 응답 `{ updated, skipped }`.
  - 카테고리(SA-015, `lib/server/shop-category/service.ts`, `PRODUCT_MANAGE`): `GET·POST /api/seller/categories`(트리 `{ categories: [{ id, name, visible, sortOrder, productCount, children }] }`, 본문 `{ name, parentId?, visible? }`), `PATCH·DELETE /api/seller/categories/{categoryId}`, `PUT /api/seller/categories/order` `{ parentId, categoryIds }`(그 부모 아래 전부, 아니면 `409 invalid_category_order`). 2단까지, 이름 30자, 판매자당 300개, 부모는 바꾸지 않음, 하위가 있으면 삭제 `409 category_has_children`. 상품 지정 `GET·PUT /api/seller/products/{productId}/categories` `{ categoryIds }`(0~10개, 통째로 바꿈, 남의 것이 섞이면 하나도 안 바꿈). 상품 목록 `?categoryId`(대분류는 하위 포함). 구매자 `GET /api/shop/{slug}/categories`(로그인 없음, 보이는 대분류·그 아래 보이는 소분류만, 운영 중 아니면 404). 판매자 격리는 (sellerId, id) 복합 FK.
  - 자동 상품 코드: `Product.codeNo`(판매자별 1부터 순번, 응답에 `code` = 「P」 + 7자리). 넣을 때 0(기본)이면 DB 트리거 `product_assign_code_no`가 판매자별 advisory 잠금 아래 MAX + 1로 매기므로 어떤 경로로 넣어도 겹치지 않고, 지운(소프트 삭제) 상품 번호도 다시 쓰지 않는다. 기존 상품은 마이그레이션 `20261004220000_shop_categories`가 등록 순(createdAt, id)으로 채웠다.
  - 상품 사진(PR-A, `lib/server/products/images.ts`, `PRODUCT_MANAGE`): `GET·POST /api/seller/products/{id}/images`(본문은 파일 바이트 그대로, 5MB 넘으면 413, 응답 201 `{ image: { id, url, sortOrder, width, height } }`), `PUT .../images/order` `{ imageIds }`(전부, 아니면 409), `GET·DELETE .../images/{imageId}`(미리보기 private). 상품당 10장(409 `too_many_images`), 첫 장이 대표 사진, PNG(checkPng 전체 확인)·JPG·WEBP(구조 확인 후 EXIF·XMP·주석 등 메타데이터를 잘라 저장, `imageFormats.ts`, 움직이는 WEBP 거절), 가로·세로 100~4000px. 상품 조회 응답 `images`, 목록 `thumbnailUrl`. 구매자 `GET /api/shop/{slug}/products/{id}/images/{imageId}`(운영 중 쇼핑몰의 판매 중·품절 상품만). 바이트는 공통 저장소 `lib/server/storage`(`putImage·getImage·deleteImage`, storageKey `드라이버:값`, `IMAGE_STORAGE` 기본 db → `StoredImage`), 주소는 저장 방식과 무관한 우리 경로(`?v=` 해시 12자, 1년 immutable).
  - 상세 페이지(PR-B, `lib/server/products/detail.ts`, `PRODUCT_MANAGE`): `GET·PUT /api/seller/products/{id}/detail` 본문 `{ blocks: [{ type: "text", text(1~2000자, 줄바꿈만) } | { type: "image", imageId }] }` 최대 30개, 통째로 바꿈, 틀리면 `400 invalid_detail`. HTML·모르는 칸은 받지 않는다(글자 그대로 저장, 화면은 글자로만 그림). 사진 블록은 이 상품의 상세 사진(`ProductImage.kind = DETAIL`, 업로드·목록 `?kind=detail`, 30장, 대표 사진 10장과 따로, 목록·썸네일에 안 섞임)만. 상세 사진을 지우면 그 블록도 빠진다. 응답 `{ blocks(사진은 url·크기 포함), images }`. 구매자용은 `publicDetailBlocks`(구매자 사진 주소).
  - 구매자 상품 API(`lib/server/products/shopCatalog.ts`, 로그인 없음, 운영 중 쇼핑몰의 판매 중·품절 상품만): `GET /api/shop/{slug}/products?categoryId(대분류는 하위 포함, 보이는 것만, 아니면 404)&q(50자)&sort=new|recommended|popular|low|high&page&limit(1~60, 기본 24)` → `{ products: [{ id, code, name, price, salePrice, soldOut, thumbnailUrl }], total, page, hasMore }`(public 30초), `GET /api/shop/{slug}/products/{id}` → `{ product: { id, code, name, description, price, salePrice, event:{endsAt}|null, soldOut, images, options:[{ id, name, price, salePrice, soldOut, stockLeft(1~5일 때만) }], detail(블록), categories(보이는 것), shipping:{ freeShipping, baseFee, freeOverAmount, remoteSurcharge }, reward:{ card, bankTransfer }|null } }`(no-store). 가격은 DB 시계의 이벤트 할인 반영 표시용(주문 금액은 주문 API가 다시 계산), 적립 예정은 로그인 회원 등급(아니면 가입 기본 등급) 적립률 × 표시 가격(원 단위 내림). 판매량순은 결제 완료 수량.
  - 상품 진열(SA-016, `lib/server/shop-display/service.ts`, `PRODUCT_MANAGE`): `GET /api/seller/display` → `{ listSort, sections, recommended }`, `PUT /api/seller/display/settings { listSort }`(구매자 목록에서 정렬을 안 고르면 이 값, 기본 new), `PUT /api/seller/display/sections { sections: [{ kind: RECOMMENDED|NEW|CATEGORY, categoryId?, title(1~30자), visible?, itemCount?(1~20) }] }`(최대 10, 추천·신상품은 하나씩, 통째로 바꿈, 비우면 기본 추천 8 → 신상품 8), `PUT /api/seller/display/recommended { productIds }`(최대 20, 지우지 않은 자기 상품만, 통째로 바꿈). 틀리면 `400 invalid_display_settings`. 구매자 `GET /api/shop/{slug}/home` → `{ sections: [{ kind, title, categoryId, products(상품 카드) }], listSort }`: 켜진 영역만, 상품 없는 영역·보이지 않는 카테고리 영역은 뺌, 추천은 보이는 상품만 순서대로, 카테고리 영역은 하위 포함 진열 순서. 카테고리를 지우면 그 영역도 지워진다(FK cascade).
  - 진열 확장(SA-016, 2026-10-05): 영역 종류 `LIVE`(지금 LIVE 방송에서 주문된 상품, 취소 대기열 제외, 최근 주문 순)·`BEST`(최근 30일 결제 완료 판매량, 동률이면 최근 판매 순)·`SALE`(이벤트 할인이 지금 걸린 상품)·`HALL_OF_FAME`(지금 방송의 HIT 카드가 나온 상품, 최근 순. LIVE·HALL_OF_FAME은 오버레이와 같은 기준이라 방송 중이 아니면 빠짐), 카테고리 말고는 종류마다 하나씩. 진열 옵션 `PUT /api/seller/display/settings { listSort?, soldOutLast?, hideSoldOut?, liveFirst? }`(보낸 것만, GET 응답 `options`): 구매자 목록·홈 진열 모두에 품절 숨기기 → 방송 상품 앞으로(자동 정렬 목록만, 추천·방송·명예의 전당 영역은 정한 순서) → 품절 맨 뒤로 순으로 건다. 카테고리 안 진열 순서 `GET·PUT /api/seller/categories/{id}/products { productIds }`(직접 지정한 지우지 않은 상품 전부, 아니면 409 `invalid_category_order`), 새로 지정하면 맨 뒤. 구매자 목록에서 카테고리를 고르고 `sort=recommended`면 고른 카테고리 순서 → 하위 카테고리(카테고리 순서) → 상품 진열 순서.
  - 재입고 알림(SA-017, `lib/server/shop-restock-alerts/service.ts`, 마이그레이션 `20261005011000`): 구매자(로그인 회원) `GET·POST /api/shop/{slug}/restock-alerts { productId }`·`DELETE …/{productId}` — 지금 품절인 상품만 신청(재고 있으면 409 `not_sold_out`), 회원당 100개, 상품마다 한 줄(다시 신청하면 200). 상태 WAITING → QUEUED(재고가 들어와 판매 중인 상품, 21~08시 KST는 `notifyAt`을 아침 8시 KST로 미룸) → SENT(발송 **기록만**, 실제 발송 없음). 재고가 들어오는 길이 여럿이라 `sweepRestock`(멱등)이 판매자 목록·구매자 신청·조회 때 돈다. 판매자 `GET /api/seller/restock-alerts`(`PRODUCT_MANAGE`) → 상품별 `{ waiting, queued, sent, nextNotifyAt, lastNotifiedAt, soldOut }`(회원 정보 없음). 탈퇴하면 신청을 지운다. 야간 「바로 보내기」 허용 여부는 대표님 결정 대기.
  - 이름 검색 `?q`: 상품 이름이나 지우지 않은 옵션 이름에 들어 있으면 나온다(대소문자 무시, 부분 일치, NFKC로 맞춤, `%`·`_`도 글자 그대로). 앞뒤 공백을 지우고 50자까지, 비었으면 검색 안 함. 쓸 수 없는 글자·50자 초과는 `400 invalid_search`. 상태·재고 필터·커서와 함께 쓴다. 필터·정렬·커서는 SQL 안에서 걸러 그 쪽의 상품 id만 고른다(결과가 많아도 바인드 변수 한도에 걸리지 않음). 대소문자 무시는 `lower()`라 운영 DB는 UTF-8 계열 collation(예: `ko_KR.UTF-8`·`en_US.UTF-8`)으로 만들어야 한다(「C」이면 ASCII만 소문자가 된다).
  - 옵션 단위 재고 목록 `GET /api/seller/products/options?stock=out|low&q&status&cursor&limit`(`PRODUCT_MANAGE`, `lib/server/products/optionStock.ts`): 재고 조건을 옵션마다 본다(out 0, low 1~5). q는 상품 이름이나 그 옵션 이름, status는 상품 판매 상태. 지운 상품·옵션 제외. 정렬은 상품 목록 순서 → 옵션 진열 순서 → 등록 → id, 커서는 마지막 옵션 id(그 행의 정렬 값 뒤부터). 응답 `{ options: [{ productId, productName, productStatus, optionId, optionName, sku, stock }], nextCursor }`, no-store. 검사 규칙(limit·q·stock)은 상품 목록과 같다.
  - 가격은 1원~2,147,483,647원 정수. 살아 있는 옵션의 단가(가격 + 추가금)도 1원~정수 범위여야 하고, 상품 가격·추가금을 바꿀 때 다시 확인한다. 틀리면 `400 invalid_price`.
  - 재고는 0 이상 정수. 바꿀 때는 `{ stock, expectedStock }`을 함께 보내고, 지금 재고가 expectedStock과 다르면(결제 차감과 겹침) `409 stock_conflict`로 덮어쓰지 않는다. 차이와 등록 때 재고는 `MANUAL` 재고 이력.
  - 상태는 `DRAFT | ON_SALE | SOLD_OUT | HIDDEN`. 판매 중은 살아 있는 옵션이 하나 이상 있어야 하고(`400 no_sellable_option`), 판매 중 상품의 마지막 옵션은 지울 수 없다. 옵션은 상품당 100개까지.
  - 삭제는 소프트 삭제(`deletedAt`). 지운 상품·옵션은 목록·조회·새 주문에서 빠지고, 지난 주문 품목은 그대로 둔다. 글자 검사는 배송지와 같은 `lib/server/text/clean.ts`: NFKC 정규화 후 제어·서식·짝 없는 서로게이트·사용자 정의·미할당·줄 구분 문자를 거부하고, 이름·SKU는 한글 채움 문자·점자 빈칸을 거부하며 눈에 보이는 글자(문자·숫자·기호·문장부호)가 하나 이상 있어야 한다. 설명은 줄바꿈만 허용한다. 등록·수정·삭제는 감사 로그.
  - 옵션 순서: 진열 순서 → 등록 시각 → id. 상품과 함께 등록한 옵션은 입력 순서대로 sortOrder를 매기고, 나중에 추가한 옵션은 맨 뒤.
  - 글자 수는 코드포인트로 센다(이모지 1자). 상품명은 공백 포함 100자, 넘으면 `400 product_name_too_long`(대표님 결정 2026-10-03). 상품 응답에 `stockDeductMode`가 있고 등록·수정에서 `ORDER | PAYMENT`를 받는다.
  - 상품 이미지는 저장소가 정해지지 않아 이번에 만들지 않았다.
- [확정] 재고 차감 시점(카페24 방식, 대표님 결정 2026-10-03): 상품마다 `stockDeductMode`로 고른다. `PAYMENT`(기본) = 결제 확인 때 차감, `ORDER` = 주문할 때 차감. 품목마다 뺀 시각(`OrderItem.stockDeductedAt`)과 되돌린 시각(`stockRestoredAt`)을 남겨, 결제 때는 아직 안 뺀 품목만 빼고 같은 품목을 두 번 빼거나 되돌리지 않는다. 차감 기준을 바꿔도 이미 받은 주문은 품목에 남은 기록대로 처리한다.
  - 주문 때 차감: 주문 트랜잭션 안에서 조건부 UPDATE(stock >= 수량)로 빼고, 모자라면 주문 전체를 되돌려 `400 out_of_stock`(동시 주문은 마지막 1개를 한 명만 가져간다). 이력 `ORDER`.
  - 취소·반품 때 자동 복구(`SellerOrderPolicy.restockOnCancel`, 기본 켜짐, `PUT /api/seller/order-policy`의 `restockOnCancel`, 빼면 지금 값 유지): 결제 전 취소·미입금 자동 취소·발송 전 환불에서 실제로 뺀 품목만 되돌린다(이력 `CANCEL`·`REFUND`). 되돌리면 정수 상한을 넘는 품목은 되돌리지 않고 감사 로그 `stock.restore_skipped`를 남긴다(취소·환불 자체는 끝남). 발송 후 환불·개봉한 품목은 되돌리지 않는다.
  - 수동 증감 `POST /api/seller/products/{productId}/options/{optionId}/stock-adjust` `{ delta, reason }`(`PRODUCT_MANAGE`): delta는 0이 아닌 정수, 사유 필수(글자 검사, 100자). 조건부 UPDATE(stock + delta >= 0)라 결제 차감과 겹쳐도 음수가 되거나 차감이 사라지지 않고, 모자라면 `409 insufficient_stock`, 더해서 정수 상한(약 21억)을 넘으면 `409 stock_too_large`. 이력 `MANUAL`(수량·사유 `note`·직원·시각)과 감사 로그 `product_option.stock_adjust`. 값 직접 설정(`expectedStock`)은 그대로 둔다.
- 결제 때 차감의 동시 결제: 재고가 모자라면 늦게 결제된 주문은 `PAID`로 기록하되 `stockShortageAt`을 남겨 「취소·환불 대상」으로 표시하고, 주문대기는 만들지 않는다. 카드 결제 주문의 환불은 아래 「결제(PG)」대로 PG 취소까지 이어진다.

### 4.5 주문·주문 품목

- `Order`: id, sellerId, orderNo(판매자별 표시 번호, **(sellerId, orderNo) 유니크**), buyerMemberId, status(`PENDING_PAYMENT | PAID | CANCELLED | REFUNDED`), broadcastNicknameSnapshot, totalAmount, rewardUsedAmount, paymentMethod(`CARD | BANK_TRANSFER | …`), pgProvider, pgTxId, paidAt, stockShortageAt(재고 부족 표시), cancelledAt, refundedAt, createdAt
  - `totalAmount`: 구매자가 실제로 결제한 금액(적립금 사용액을 **뺀 뒤**, 배송비가 생기면 포함). `rewardUsedAmount`: 이 주문에 쓴 적립금.
  - 적립 기준액은 `totalAmount`를 쓰지 않고 「할인 후 상품 금액(주문 품목 단가 × 수량 합)」으로 계산한다. 배송비는 빼고, 적립금으로 낸 금액은 빼지 않는다(대표님 결정 2026-10-03).
- `OrderItem`: id, sellerId, orderId, productId, optionId, productNameSnapshot, optionNameSnapshot, unitPrice, quantity
- `OrderConsent`: id, sellerId, orderId, kind(`OPENED_NO_REFUND`), noticeVersion, agreedAt(DB 시계) — **(orderId, kind) 유니크**. 결제 전 개봉 고지 동의 기록(대표님 결정 2026-10-02, 문구 v2 「개봉하면 단순 변심으로는 취소·환불이 안 돼요. 상품이 설명과 다르거나 잘못 왔으면 환불받을 수 있어요」 2026-10-03 확정).
- 주문 생성(`POST /api/shop/{slug}/orders`, 구매자 세션, 결제 대기까지 — 결제는 아래 「결제(PG)·무통장 입금」):
  - 동의 필수: `consent.agreed === true`(체크 기본 해제)와 화면이 보여 준 문구 버전(`noticeVersion`)이 지금 버전과 같아야 한다. 아니면 `400 consent_required`·`consent_outdated`, 주문을 만들지 않는다. 동의는 주문과 같은 트랜잭션에 기록.
  - 잠긴 판매자(체험하기·구독 끝)는 `402 shop_unavailable`, 문구 「지금은 쇼핑몰을 이용할 수 없어요」(판매자 사정은 드러내지 않음).
  - 금액은 서버가 계산(단가 = 상품 가격 + 옵션 추가금, 합계 = 단가 × 수량). 본문의 금액·상태 값은 쓰지 않는다. 적립금 사용(`rewardUseAmount`, 대표님 결정 2026-10-05, `lib/server/payments/rewardUse.ts`): 1,000원 이상 10원 단위, 상품 금액(상품 할인 쿠폰 뺀 값)까지·배송비 불가·결제할 금액 1원 이상 남김, 판매자 실지급 스위치가 꺼져 있으면 불가. 주문 잠금 → 회원 → 잔액 행 순서로 잡고 잔액을 바로 빼며 USE 원장(음수, 멱등 키 `use:{orderId}`)을 남긴다. 결제 금액 = 상품 + 배송비 − 쿠폰 − 적립금. 거부: `invalid_reward_use`·`reward_use_unavailable`·`reward_use_over_limit`·`reward_balance_insufficient`(주문 안 만듦).
  - 재고는 주문 수량만큼 있는지 확인하고, 주문 때 차감 상품은 이때 뺀다(4.4). 부족하면 `400 out_of_stock`.
  - 단가가 1원 미만(음수 추가금 등)이거나 합계(상품 + 배송비)가 정수 범위(2,147,483,647원)를 넘으면 `400 invalid_amount`, 주문을 만들지 않는다.
  - 주문 닉네임(선택, MASTER 결정 2026-10-05): `orderNickname`(1~20자, 가입 닉네임과 같은 글자 검사·앞뒤 공백 제거)을 주면 이 주문의 `broadcastNicknameSnapshot`(주문대기·HIT 카드에 보이는 닉네임)에 쓰고, 없거나 비우면 회원 방송 닉네임. 회원 닉네임 자체는 바꾸지 않는다. 틀리면 `400 invalid_order_nickname`.
  - 배송지 필수(받는 분·연락처·우편번호 5자리·주소, 상세 주소·메모 선택). 틀리면 `400 invalid_shipping_address`. 4.10 참고.
  - 400·402·409 응답은 `{ error, message }`. `message`는 화면에 그대로 보여 줄 문구이고, 사유 코드별 문구는 `lib/server/orders/messages.ts` 한 곳에서만 고친다. 말투는 부르는 API 대상으로 정한다(`lib/server/text/tone.ts`, 대표님 지시 2026-10-04): 파트너스·마스터 관리자 API(`app/api/seller/**`·`app/api/admin/**`)는 합니다체(요청은 「~해 주십시오」), 구매자 쇼핑몰·공개·오버레이 API와 파트너스 가입 신청(`app/api/seller-signup/**`)은 해요체. 같은 사유를 두 쪽이 쓰는 문구표(주문·로그인·본인확인)는 두 벌을 두고, `tests/unit/messageTone.test.ts`가 표의 말투와 경로별 호출을 확인한다.
  - 주문 번호는 판매자별 advisory lock 아래에서 매긴다(동시 주문에도 겹치지 않음). 판매 중(`ON_SALE`)이 아니거나 다른 쇼핑몰 옵션이면 `400 product_unavailable`.
- 입금 기한·자동 취소·구매 제한·주문 횟수 제한: 4.11.
- 결제(PG)·무통장 입금(기반-결제, 대표님 결정 2026-10-05: 나이스페이 테스트(샌드박스) 결제. 실결제 전환은 대표님 승인 뒤 별도 작업, 코드에 실결제 주소 없음). 코드 `lib/server/payments/**`.
  - 카드(나이스페이 서버 승인 모델): `POST /api/shop/{slug}/payments` `{ orderId }` → 결제 창 값(금액은 서버가 품목 + 배송비 − 쿠폰 − 적립금으로 다시 계산해 `totalAmount`와 같을 때만, 결제 시도마다 `Payment` 1행, 그 id가 PG 주문번호) → 결제 창 → `POST /api/payments/nicepay/return`(서명·금액 대조) → 주문 잠금 아래 `READY → APPROVING` → PG 승인 → `PAID` → `markOrderPaid`(재고·주문대기·적립 그대로) → 구매자 주문 화면으로 303. 같은 주문은 승인 중·완료 결제가 하나만(부분 유니크 인덱스), 같은 tid 두 번 승인 없음. 승인 응답을 못 받으면 망 취소, 그것도 모르면 `APPROVING`으로 두고 조회로 확정. 승인 중에 주문이 취소됐거나 무통장으로 이미 결제됐으면 카드 결제를 전액 취소한다(이중 결제 방지). 웹훅 `POST /api/payments/nicepay/webhook`은 서명 확인 뒤 PG 조회로 확정한다. 수신 결과는 로그 추적(SYSTEM)에 남긴다: `payment.webhook_received`(tid·웹훅 종류·우리 결제와 맞았는지·처리 뒤 결제 상태, 본문·카드·개인정보 없음), `payment.webhook_rejected`(서명 불일치, 본문 값 없음, 분당 10건까지), `payment.webhook_failed`(처리 오류, 오류 이름만, 500으로 재전송을 받음). 결제 창 인증 실패(authResultCode≠0000)는 서명이 없어 상태를 바꾸지 않지만(READY 유지) 코드·문구를 로그 추적 `payment.auth_failed`에 결제 시도마다 1건 남기고, 승인 거절(`payment.failed`)에는 PG 거절 문구(`message`)를 함께 남긴다(카드·개인정보 아님). 나이스페이 키(`NICEPAY_CLIENT_KEY`·`NICEPAY_SECRET_KEY`)가 없으면 결제 시작은 `503 payment_not_ready`. 외부 호출은 모두 30초 타임아웃.
  - 환불 → PG 취소: `refundOrder` 트랜잭션에서 `PaymentCancel`(멱등 키 `refund:{orderId}`)을 남기고, 환불 라우트가 커밋 뒤 PG 취소를 보낸다(취소 주문번호 = 요청 id 고정, 응답을 잃으면 PG 잔액 조회로 한 번만 반영). 결과를 모르면 요청이 남아 결제 타이머(`lib/server/payments/worker.ts`, 5분 간격, 서버 프로세스 안, advisory lock으로 한 인스턴스만)가 다시 보내고 승인 중 결제도 확정한다. PG가 거절하면 `FAILED`와 감사 로그 `payment.cancel_failed`(사람이 확인).
  - 배송비 미리보기(주문서): `POST /api/shop/{slug}/payments/shipping-preview` `{ items, zipCode, address1 }`(로그인 없이) → `{ itemsSubtotal, shippingFee, isRemote, total }`. 주문 생성과 같은 단가(이벤트 할인)·배송비·도서산간 규칙, 쿠폰 할인 전, 계산만 한다.
  - 무통장 입금: 판매자 계좌 `GET·PUT /api/seller/payments/bank-account`(`SHOP_SETTINGS`, 감사 로그에는 계좌번호 끝 4자리만). 구매자 선택 `POST /api/shop/{slug}/payments/bank-transfer` `{ orderId }` → 주문 결제수단 무통장, 응답 `{ orderId, amount, bankName, accountNumber, accountHolder, paymentDueAt }`(계좌 없으면 `409 bank_account_missing`, 기한은 주문할 때 값 그대로라 다시 골라도 늘지 않음). 판매자 입금 대기 `GET /api/seller/payments/deposits`(SA-026, 기한 빠른 순, 입금자 이름은 `CUSTOMER_PII_VIEW`일 때만)·입금 확인 `POST /api/seller/payments/deposits/confirm` `{ orderIds(1~50), expectedVersion }`(`ORDER_SHIPPING`, 주문마다 `markOrderPaid`, 결과 paid·stock_shortage·already_paid·card_in_progress·not_payable·not_found, 감사 로그 `order.deposit_confirm`). 카드 결제가 승인 중이면 확인하지 않고, 확인할 때 열려 있던 카드 결제 창(READY)은 같은 잠금 아래에서 닫는다(그 창으로 인증해도 승인하지 않음). 카드 결제 시작 응답에도 남은 기한 표시용 `paymentDueAt`을 준다.
- 결제 전 동의 문구(`GET /api/shop/{slug}/order-consent`, 로그인 없이): `{ consents: [{ kind, version, text }] }`. 화면은 이 version을 주문 요청의 `consent.noticeVersion`으로 보낸다. 문구는 아직 코드 상수(`lib/server/orders/consent.ts`)에만 있다.
- 구매자 본인 주문 조회(`GET /api/shop/{slug}/orders?cursor·limit`, `GET /api/shop/{slug}/orders/{orderId}`, 구매자 세션): 조회 조건에 쇼핑몰과 본인이 항상 들어가고 다른 구매자·다른 쇼핑몰 주문은 404. 상태·품목 스냅숏·금액·배송비·배송 상태·송장(택배사 이름 포함)을 주고, 배송지는 본인 상세에서만 준다. 결제사 거래 번호·재고 부족 표시·판매자·회원 id는 주지 않는다. 목록은 최근순 keyset 커서(기본 20·최대 50, `invalid_cursor`·`invalid_limit`). 잠긴 쇼핑몰이어도 기존 주문 조회는 열린다.
- `OrderStatusHistory`: id, sellerId, orderId, from, to, actor, reason, createdAt
- 상태 전이 (그 외 거부):

```text
PENDING_PAYMENT ─결제 확인─▶ PAID ─환불─▶ REFUNDED
       └──────취소──────▶ CANCELLED
```

- 결제 완료 → 재고 차감 + 주문대기 생성 + 적립금 지급 시점이 「결제 즉시」면 지급 대기(`EARN`, 실지급 스위치가 꺼져 있으면 `testMode`) 기록(재고 부족 분기는 5절). 환불 → 재고 복원(아래 규칙) + 적립금 회수 대기(`REVOKE`) + 연결된 「대기」·「개봉 중」 주문대기 자동 취소.
- [확정] 환불 시 재고 복원 (MASTER 결정, 주문 품목 단위):
  - 연결된 주문대기가 「대기」(환불과 함께 취소됨)이거나 개봉 전에 「취소」된 경우 → 자동 복원(`StockMovement.reason = REFUND`).
  - 「개봉 중」(환불과 함께 취소됨)·개봉을 시작한 뒤 취소됨·「완료」 → 이미 개봉했으므로 복원하지 않는다.
  - 개봉한 품목이 있는 주문도 환불할 수 있다(배송 사고·판매자 판단). 대신 요청에 `confirmOpened: true`가 있어야 하고, 없으면 `409 opened_items_present`. 감사 로그에 개봉 품목 수를 남긴다.
  - 환불액(PRODUCT_SCOPE 「반품·교환 배송비」): 발송했거나 개봉한 품목이 있으면 `fault: "BUYER" | "SELLER"`(구매자·판매자 사정)를 꼭 보낸다(없으면 `400 fault_required`). 발송 전은 결제 금액 전부, 발송 후 판매자 사정은 상품 + 처음 배송비, 발송 후 구매자 사정은 상품 − 반품 배송비(처음 배송비 0원이면 × 2, 처음 배송비는 안 돌려줌, 0원 아래로 안 내려감). 구매자 사정이면 개봉한 품목은 빼고 계산한다. 발송 전 주문에 개봉 품목이 있으면 구매자 사정 환불은 `409 opened_items_unshipped`로 막는다(부분 환불 구조 전까지 임시, MASTER 결정 2026-10-03). 판매자 사정은 전액. 거부 응답에는 합니다체 `message`가 붙는다(파트너스 API, 예: 「개봉한 상품이 있습니다. 확인한 뒤 다시 환불해 주십시오」). 반품 배송비는 주문할 때 값(`Order.returnFeeSnapshot`)을 쓴다. 돈으로 돌려주는 환불액은 실제 결제액(`totalAmount`, 적립금을 이미 뺀 금액)을 넘지 않는다. 쓴 적립금은 상품 금액 기준으로 돌려준다(MASTER 2026-10-05): 돌아오는 상품이 주문 상품 전부면 전부(반품 배송비를 빼는 구매자 사정 환불도 전부), 구매자가 개봉 품목을 갖는 부분 환불이면 쓴 적립금 × 돌아오는 상품 금액 ÷ 주문 상품 금액(품목별 쿠폰 배분 뺀 값, 배송비 제외)을 10원 단위로 내려 돌려주고, 그 몫은 현금 환불액에서 뺀다(현금 + 적립금 반환 = 돌아오는 상품(+배송비) − 반품 배송비, 검수 #346). 환불 미리보기 `byFault`에 `rewardReturn`이 함께 나온다(USE 양수 원장, 멱등 키 `use_return:{orderId}`). 결제 대기 주문 취소·입금 기한 자동 취소는 전부 돌려준다. 탈퇴 회원이면 잔액에 넣지 않는다. 결과는 `Order.refundAmount·refundFault·returnFeeDeducted`와 응답·감사 로그에 남는다. 카드 결제 주문이면 환불액만큼 PG 취소(부분 취소 포함)가 이어진다(아래 「결제(PG)」).
  - 구매 확정 뒤 환불(대표님 결정 2026-10-03, 카페24 방식): 구매 확정한 주문(`purchaseConfirmedAt`)은 환불이 `409 purchase_confirmed`(「구매 확정한 주문입니다. 구매 확정을 먼저 취소해 주십시오」). 판매자가 `POST /api/seller/orders/{orderId}/unconfirm` `{ reason }`(1~200자, `ORDER_SHIPPING`·`ORDER_FOLLOWUP`, 잠금 중에도 가능, `lib/server/orders/delivery.ts` `unconfirmPurchase`)로 확정을 풀면 `purchaseConfirmedAt = null`, `purchaseUnconfirmedAt = 지금`(감사 로그 `order.purchase_unconfirm`), 그 뒤 환불할 수 있다. 확정 전·환불된 주문은 `409 not_confirmed`, 사유가 없거나 길면 `400 invalid_reason`. 이 주문으로 지급한 적립금은 환불의 기존 회수 규칙(`revokeMode` AUTO → `REVOKE`, MANUAL → 수동 확인 대기)대로 회수한다. 구매 확정 때 따로 지급하는 적립금은 없다. PG 취소는 일반 환불과 같다. 확정을 취소하고 환불하지 않는 주문은 판매자가 `POST /api/seller/orders/{orderId}/reconfirm`(본문 없음, 같은 권한, `reconfirmPurchase`)으로 다시 확정하거나(`purchaseConfirmedAt = 지금`, `purchaseUnconfirmedAt = null`, 감사 로그 `order.purchase_reconfirm`, 응답 `{ purchaseConfirmedAt }`, 확정을 취소한 결제 완료 주문이 아니면 `409 not_unconfirmed`), 취소한 때부터 자동 구매 확정 기간이 지나면 자동 구매 확정이 다시 확정한다. 확정을 취소한 채 남은 주문은 후속 처리 대상(`hasOrderFollowup`)에 든다.
  - 재고 부족(`stockShortageAt`)으로 차감되지 않은 주문 → 복원할 것 없음.
  - 그 밖의 조정은 판매자가 직접 `MANUAL` 이력으로 한다. 환불 API에 복원 여부 입력은 두지 않는다.
  - 교환·반품(`lib/server/shop-returns/**`, SA-029 · SH-022-R, 2026-10-04): 구매자는 배송 완료 뒤 구매 확정 전의 결제 완료 주문에 신청한다(반품은 주문 전체, 교환은 품목 선택). 주문당 진행 중인 신청은 1건(부분 유니크 인덱스 `ReturnRequest_one_active_per_order`). 흐름 `REQUESTED → ACCEPTED(접수, 사유 주체 정함) → RECEIVED(회수 완료, 재고 되돌리기 선택) → COMPLETED`, 신청 단계는 거절(`REJECTED`), 신청·접수 단계는 구매자 철회(`CANCELLED`). 반품 완료는 기존 `refundOrder`를 호출하고(같은 트랜잭션에서 `closeReturnsOnRefund`가 신청을 완료로 닫음, 실제 PG 취소는 결제 연결 담당), 교환 완료는 교환 상품 재고를 빼고(`StockMovement` `EXCHANGE`, 부족하면 409 `insufficient_stock`) 송장을 남긴다. 진행 중인 신청이 있는 주문은 자동 구매 확정이 확정하지 않는다(`hasActiveReturn`). 직접 환불하면 진행 중인 신청을 닫는다(회수 완료한 반품은 완료, 그 밖은 철회). 구매자 API `/api/shop/{slug}/returns/**`(신청·철회·송장·사진), 파트너스 API `/api/seller/returns/**`(`ORDER_SHIPPING`, `ORDER_FOLLOWUP`). 신청 사진은 리뷰 사진과 같은 검사·어댑터 방식(`ReturnImageStore`).
  - 교환·반품 v2(마이그레이션 `20261005072000_returns_v2`, 2026-10-05): ① 신청 기한은 배송 완료 뒤 7일(`rules.ts withinReturnWindow`). 불량·오배송·설명과 다름은 기한과 상관없이 받고 단순 변심·기타는 `period_expired`. ② 개봉한 상품(주문대기 개봉 시작·진행·완료)은 단순 변심으로 신청할 수 없다(교환은 하나라도, 반품은 전부 개봉일 때 `opened_blocked`. 일부만 개봉한 반품은 환불 계산이 개봉분을 뺀다). ③ 수거 방법 `pickupMethod`(택배사 수거·구매자 직접 발송·수거 없음): 구매자는 앞 둘 중 희망을 고르고 접수 때 판매자가 정한다(직접 발송일 때만 구매자 송장). ④ 검수는 별도 상태를 두지 않고 `RECEIVED`(화면 이름 「검수 중」)에서 검수 결과(`inspectionResult` 이상 없음·사용 흔적 훼손·구성품 누락)를 입력한다. 재고 되돌리기는 입고 확인이 아니라 검수 이상 없음 저장 때만(`inspect restock`, 되돌린 뒤에는 문제 있음으로 못 바꿈 `inspection_locked`)이다. 이상 없음이어야 반품 환불·교환 발송이 되고(`inspection_required`·`inspection_not_ok`), 문제가 있으면 반송·거절(`reject-inspected`, 접수·입고 기록을 남긴 채 `REJECTED`, CHECK 제약 완화)만 된다. ⑤ 교환 재고 없음: 재입고 뒤 발송(`hold`, `exchangeHeldAt` 표시만)과 환불로 전환(`convert`, 교환→반품 `convertedFromExchange`, 신청한 품목만 `refundOrder items`로 환불하고 부분 환불이라 자동 닫기가 안 도는 경우 `refundReturn`이 완료로 닫는다). 실제 PG 환불은 하지 않는다. ⑥ 무통장 입금 주문은 환불 계좌(은행·예금주·계좌번호)를 신청 때 받는다(없으면 `refund_account_required`). 계좌번호는 원문으로 저장하지 않고 빌링키와 같은 `sealBillingKey`(AES-256-GCM, 쇼핑몰 id 묶음)로 봉인하며 비밀키가 없으면 신청을 받지 않는다(`refund_account_unavailable` 503). 구매자 응답·목록·로그 추적에는 값이 없고 파트너스 상세에서만 풀어 보여 주며(봉인 전에 저장된 원문 값은 그대로, 풀 수 없으면 null), 환불·종료(거절·철회) 때와 탈퇴 때(`clearReturnRefundAccounts`) 비운다. ⑦ 목록 응답 `summary`: 접수 대기, 수거·검수 중, 이번 달(KST) 완료 반품·교환, 30일 반품률(철회·거절·환불 전환 제외 반품 신청 ÷ 배송 완료 주문). 새 경로: `seller/returns/[id]/{inspect,reject-inspected,hold,convert}`. 금액 조정 환불(검수 훼손 시 일부 환불)은 환불 엔진(기반-결제) 변경이 필요해 만들지 않았다.
  - 부분 반품·환불 내역(2026-10-05, 마이그레이션 없음): 반품도 `items [{orderItemId, quantity}]`로 품목·수량을 골라 신청할 수 있다(없으면 남은 주문 전체, 남은 수량을 넘거나 중복이면 `invalid_items`). 환불(`refundReturn`)과 미리보기는 신청한 품목·수량만 `refundOrder items`/`previewRefundSelection`으로 처리하고, 전체 환불이 아니라 주문이 결제 완료로 남으면 환불 뒤 신청을 완료로 닫는다(닫히면 남은 수량으로 다시 신청). 재고 복구(`products/stock.ts`)는 품목의 주문 수량 전체를 되돌리므로 일부 수량만 반품한 품목은 검수 재고 되돌리기에서 제외한다(`partialQuantity` 안내, 재고 조정으로 직접 맞춘다). 파트너스 상세 `refunds`와 구매자 화면 `refunds`(`orderRefund` 이력, 구매자 쪽에는 행위자 등 내부 값 없음)로 환불 내역을 보여 준다.
  - 회원 등급(`lib/server/shop-member-grades/**`, SA-044, 2026-10-05): 등급 이름·승급 기준 금액(`MemberGrade.minAmount`, 첫 등급 0·순서대로 증가)을 `MEMBER_POINTS`로 편집, 등급은 10개까지 추가하고 기본 등급(일반)만 못 지운다(회원이 있으면 모두 기본 등급으로 옮기고 변경 기록 `GRADE_REMOVED`). 산정 기준은 `MemberGradePolicy`: 기간(3·6·12개월·누적) × 주기(매월 1일·매주 월요일·매일, KST) × 강등(한 단계씩·바로·없음). 자동 재산정은 쇼핑몰이 켠 경우만(기본 꺼짐): 앱 안 스케줄러가 매시간 `recalcMonthlyGrades`를 불러 주기 키(월 `YYYY-MM`·주 `YYYY-Www`·일 `YYYY-MM-DD`)마다 쇼핑몰당 한 번(`MemberGradeRun` 기본 키가 보장) 기간 안 결제 완료 주문의 `totalAmount − refundAmount` 합계로 목표 등급을 정한다. 켜거나 주기를 바꾸면 그 주기는 이미 돈 것으로 기록해 바로 돌지 않는다. 승급은 목표까지 한 번에, 파트너스가 「고정」한 회원(`MemberGradeOverride`, 종료일·사유 선택, 끝나면 재산정 때 지움)과 정상이 아닌 회원은 건너뛴다. 「지금 재산정」(`POST /api/seller/member-grades/recalc`)은 켜짐·실행 기록과 상관없이 한 번 더 계산한다(기록 안 남김). 직접 조정·재산정은 `MemberGradeHistory`와 로그 추적(`member_grade.*`)에 남는다. API `/api/seller/member-grades/**`(`STORE_OPERATIONS`).
  - 회원 등급 혜택(마이그레이션 `20261005073000_grade_benefits`, 2026-10-05): 등급별 배송비 혜택(`shippingBenefit` 없음·정액 할인·무료, 정액은 1~100,000원)과 승급 쿠폰(`promotionCouponId`, 직접 지급 방식 쿠폰만, 저장 때 검사). ① 배송비 혜택은 주문 견적(`quote.ts`)과 주문 생성(`create.ts`)이 함께 쓰는 `orders/pricing.ts priceOrder`에서 `shop-member-grades/benefits.ts applyGradeShipping`을 불러 적용하므로 견적 금액 = 결제 금액이다(견적 응답 `gradeShippingDiscount`). 등급 혜택으로 줄어든 배송비에 배송비 무료 쿠폰이 다시 적용된다. ② 승급 쿠폰은 자동 재산정 승급과 직접 올림(`setMemberGrade`)에서 `issueCouponToMember`로 한 장 지급한다: 쿠폰 행 잠금 + `BuyerCoupon (couponId, buyerMemberId)` 유니크 + 조건부 `issuedCount` 증가라 동시 재산정에도 한 번만 가고, 같은 쿠폰은 강등 뒤 재승급해도 다시 주지 않으며, 중지·기간 지남·수량 소진이면 승급은 그대로 두고 쿠폰만 건너뛴다. 승급 쿠폰으로 연결된 쿠폰은 삭제할 수 없다(`grade_benefit`). ③ 승급·강등 알림은 발송 채널이 정해질 때까지 로그 추적 `member_grade.notice`(delivered=false)만 남긴다. ④ 구매자 내 정보 `buyerGradeStatus`: 지금 등급·혜택·다음 등급까지 남은 금액(재산정과 같은 기준, 자동 재산정이 켜졌을 때만), 파트너스 `GET /api/seller/member-grades/changes?kind=up|down` 변동 회원 보기.
  - 회원 대상 발송(`lib/server/shop-member-messages/**`, SA-049, 마이그레이션 `20261005074000_member_messages`, 2026-10-05): 실제 발송 채널(알림톡·문자·메일)과 충전 잔액 차감은 대표님 결정 전이라 만들지 않고 발송 「기록」(`RECORDED`)만 남긴다(화면 문구 「기록됨 · 실제 발송 전」). `MemberMessage`(종류 광고성·정보성, 채널 3종, 대상 7종 `targetType`+`targetParams`, 상태 예약·기록·취소)와 `MemberMessageRecipient`(기록 때 확정한 받는 사람, 연락처는 저장하지 않음). 규칙: ① 광고성은 수신 동의(`marketingConsentAt`) 정상 회원만, 정보성은 정상 회원 전체. ② 광고성 문구에 (광고)·쇼핑몰 이름·무료 수신거부 자동 삽입(`renderBody`), 광고성 최종 문구에 (광고)·무료 수신거부가 없으면 기록하지 않는다(`opt_out_missing`, 예약은 시각이 되어도 취소). 광고성은 08:00~21:00(KST)에만: 「지금」이 밖이면 다음 08:00 예약, 직접 정한 예약 시각이 밖이면 `ad_time_window`(suggestedAt). ③ 같은 회원 하루(KST) 기록 2건까지: 쇼핑몰 단위 advisory lock 아래 계산해 동시 발송도 넘지 않고 넘는 회원은 제외(`skippedDailyCap`), 모두 빠지면 기록하지 않는다(`no_recipients`). ④ 예약은 30일 안 미래만, 수정·취소는 예약일 때만(취소는 조건부 UPDATE), 시각이 되면 정기 작업 `member_message.record_due`(`processDueMemberMessages`)가 대상을 다시 계산해 받는 사람 행을 만들고 기록으로 바꾼다(정기 작업 간격이 1시간이라 예약 시각보다 최대 1시간 늦게 기록될 수 있다). ⑤ 요약·상세: 동의 회원·이번 달 기록(채널별)·기록 뒤 24시간 안 결제 주문 수·금액(부분 환불 뺌, 실제 DB 값)·최근 30일 수신 철회. 열람·클릭 집계는 채널이 없어 없다(`reaction: null`). ⑥ 탈퇴하면 받는 사람 행을 지운다(`memberData.ts`). 로그 추적 `member_message.create|update|cancel|record`에는 문구·대상 종류·수만 남기고 회원 id는 남기지 않는다. 권한 MEMBER_POINTS.
  - 주문 상태를 결제 완료 → 환불로 원자적으로 바꿔 같은 주문을 두 번 환불하거나 재고를 두 번 복원하지 않는다. 결제 대기 주문은 「취소」(재고 변화 없음), 결제 완료 주문은 「환불」만 가능. 둘 다 사유 필수, `ORDER_SHIPPING` 권한, 화면이 받은 `expectedVersion`(판매자 liveVersion) 필수 — 다르면 `409 conflict`(주문대기 조작과 같은 규칙).
- [확정] 부분 환불(MASTER 배정 2026-10-05, SA-023, `lib/server/payments/refundCalc.ts`·`queue/service.ts` `refundOrder`): 환불 API에 `items?: [{ orderItemId, quantity }]`(최대 100개, 없으면 남은 품목 전부)를 보내 품목·수량을 골라 여러 번 나눠 환불한다. 환불 1건마다 `OrderRefund`(순번 `seq`, 품목·금액·적립금 반환·적립 회수, `isFinal`)를 남기고 품목별 `OrderItem.refundedQuantity`(0~수량, DB CHECK)를 올린다. 남은 품목을 모두 돌려주는 환불(`isFinal`)에서만 주문이 환불(REFUNDED)로 바뀌고 상태 이력·쿠폰 되돌리기(결제 금액 전부를 돌려줬고 남긴 품목이 없을 때)·교환·반품 신청 닫기·구매 제한 횟수·보관 만료일을 처리한다. 금액은 누적으로 계산해(이번 몫 = 이번까지 누적 목표 − 지난번까지 누적) 끝전이 쌓이지 않는다: 품목 금액은 단가 × n − ⌊쿠폰 배분 × n ÷ 수량⌋, 배송비는 마지막 환불에서만(발송 전·판매자 사정), 반품 배송비는 발송 후 구매자 사정 환불마다, 쓴 적립금은 누적 돌아오는 상품 금액 비율로 10원 내림(누적이 주문 상품 전부면 남은 전액), 현금은 결제 금액 − 이미 돌려준 현금을 넘지 않는다. 주문 적립 회수는 누적 환불 수량의 적립 기준액(단가 × 수량) 비율(마지막은 남은 전부): 적립이 기록됐으면 회수 원장(AUTO) 또는 수동 확인(MANUAL), 배송 완료 적립이 기록 전이면 `rewardEarnAmount`를 줄인다. 다 돌려준 품목만 주문대기 카드를 취소하고, 발송 전·개봉 전이면 재고를 품목 단위로 되돌린다(수량 일부만 돌려준 품목은 다 돌려줄 때 한꺼번에). 개봉 대기·개봉 중인 품목(카드 1장 = 품목 전체)은 수량 일부만 환불할 수 없다(`409 queued_item_partial`). 잘못 고르면 `400 invalid_refund_items`. 발송 전 개봉한 품목을 구매자 사정으로 고르면 `409 opened_items_unshipped`(개봉하지 않은 품목만 고르면 됨). 멱등 키: 한 번에 전부면 지금과 같은 `refund:{orderId}`·`use_return:{orderId}`·`revoke:{orderId}`, 나눠 환불하면 `…:{orderId}:{seq}`. 같은 주문의 동시 환불은 판매자 주문 잠금·주문 행 잠금·실시간 version으로 하나만 된다. 미리보기 `POST /api/seller/orders/{orderId}/refund/preview` `{ items? }`(계산만, `ORDER_SHIPPING` 읽기·`ORDER_FOLLOWUP`)와 주문 상세 `refundPreview`는 같은 모양: `byFault.{BUYER,SELLER}.{refundAmount, returnFeeDeducted, rewardReturn, itemsAmount, shippingRefunded, blocked}`, `items[]`(품목별 `quantity·refundedQuantity·refundableQuantity·opened·queued·refundableAmount`), `isFinal`, `refundedAmount`(이미 돌려준 현금), `rewardRevoke { amount, kind: "ledger"|"manual"|"pending"|null }`. 환불 응답에 `refundId·seq·isFinal·rewardReturn·rewardRevokeAmount`가 더해졌다. 반품 환불(`refundReturn`)은 지금처럼 남은 품목 전부.
- [확정] 주문 상세 상태 이력(MASTER 배정 2026-10-05, SA-022, `lib/server/orders/history.ts`): `GET /api/seller/orders/{orderId}`에 `history[]`(시각 오름차순)를 더했다. 원천은 `OrderStatusHistory`(상태 변경)·`Payment.approvedAt`(결제 승인)·`PaymentCancel`(결제 취소, 끝났으면 끝난 시각)·로그 추적 `order.refund_partial`(일부 환불). 행: `{ kind: "status"|"payment_approved"|"refund_partial"|"payment_cancel", at, status, fromStatus, amount, quantity, cancelStatus: "REQUESTED"|"DONE"|"FAILED"|null, actor: { type: "SELLER"|"BUYER"|"ADMIN"|"SYSTEM", role: "OWNER"|"STAFF"|null, name }, note }`. 처리자는 역할·이름 수준(파트너스 직원만 이름, 이메일·id 없음), 모든 조회에 `sellerId`를 건다(다른 파트너스 주문은 상세가 404). 전체 환불은 `status` 행(REFUNDED)으로, 일부 환불은 `refund_partial` 행으로 남는다.
- [확정] 구매자 환불 요청(MASTER 배정 2026-10-05, SA-023 · SH-022 취소 요청, `lib/server/payments/refundRequest.ts`, 모델 `RefundRequest`): 결제 완료·발송 기록 없음·구매 확정 전 주문에 구매자가 사유(교환·반품과 같은 5종, 「기타」는 설명 필수 500자)와 품목·수량(`items?`, 없으면 남은 품목 전부)으로 요청한다(`POST /api/shop/{slug}/refund-requests` `{ orderId, reason, reasonText?, items? }` → 201, 화면 정보 `GET …?orderId=`, 철회 `POST …/{id}/cancel`). 주문당 진행 중(REQUESTED) 요청 1건(부분 유니크 인덱스, 동시 요청은 하나만, 나머지 `409 active_exists`), 발송·구매 확정·환불된 주문은 `409 not_refundable`. 파트너스(`ORDER_SHIPPING`·`ORDER_FOLLOWUP`): 목록 `GET /api/seller/refund-requests?status&cursor`(상태별 counts), 상세 `GET …/{id}`(진행 중이면 요청 품목의 `refundPreview`·`queueVersion`, 못 만들면 `previewError`), 거절 `POST …/{id}/reject { reason }`(1~200자 필수, 로그 추적 `refund_request.reject`), 승인 `POST …/{id}/approve { expectedVersion, expectedRefundAmount, fault?, confirmOpened? }` = 요청 품목으로 `refundOrder`(같은 규칙·거부 사유, 같은 트랜잭션에서 요청 행을 잠가 진행 중일 때만 승인으로 닫고 `refundId`를 남김. 그사이 철회·거절됐으면 환불까지 되돌리고 `409 invalid_transition`). 주문 화면에서 남은 품목을 모두 환불해도 진행 중인 요청은 승인으로 닫힌다(`refund_request.close_on_refund`, 부분 환불이면 그대로). DB CHECK: 거절은 사유, 승인은 `refundId` 필수. 구매자 행동 `buyer_refund_request.*`은 거래 관련 기록(5년), 요청은 주문과 같은 법정 보관.

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
- `RewardLedger`: id, sellerId, buyerMemberId, orderId(nullable), type(`EARN | REVOKE | USE | RANKING_BONUS | ADJUST | EXPIRE`), amount(부호 포함), status(`PENDING | SUCCEEDED | FAILED`), testMode(bool), failureReason, idempotencyKey, createdAt, processedAt — **(sellerId, idempotencyKey) 유니크**(같은 주문 지급·회수 중복 방지)
- `RewardBalance`: (sellerId, buyerMemberId) PK, balance(**CHECK balance >= 0**), updatedAt — `SUCCEEDED`이고 `testMode = false`인 원장만 잔액에 반영(같은 트랜잭션)
- 구매자 본인 적립금(SH-023, 탈퇴 화면 안내): `GET /api/shop/{slug}/me/rewards` → `{ balance, pendingEarn }`(`lib/server/rewards/balance.ts`, 로그인한 회원 본인만, 잠긴 쇼핑몰·기능 권한과 관계없이 열림, 캐시 안 함). `balance`는 `RewardBalance`(없으면 0), `pendingEarn`은 처리 전(`PENDING`)·실지급(`testMode = false`) 원장 중 양수 금액의 합(회수 같은 음수는 넣지 않음)
- 실지급 스위치가 꺼져 있으면 원장은 `testMode = true`로 기록만 하고 잔액은 바꾸지 않는다. 스위치 변경은 대표(OWNER)만, 감사 로그 필수.
- 지급 시점 `RewardPolicy.earnTiming`(대표님 결정 2026-10-03): `ON_PAYMENT`(결제 즉시) 또는 `ON_DELIVERY`(배송 완료 후, 기본). `GET·PUT /api/seller/reward-policy` `{ earnTiming }`(`MEMBER_POINTS`, 감사 로그 `reward_policy.earn_timing`, 틀리면 `400 invalid_reward_policy`). 적립은 결제 시점 스냅숏으로 판정한다(MASTER 결정 2026-10-03): 결제 때 주문에 지급 시점·회원 등급·적립률·적립 예정액(`Order.rewardEarnTiming·rewardGradeId·rewardRate·rewardEarnAmount`)을 남기고, 지급 시작일(`earnStartsAt`)은 결제 시각과 비교한다. 배송 완료 때는 스냅숏 지급 시점이 `ON_DELIVERY`이고 예정액이 0원보다 큰 주문만 그 금액으로 한 번 기록한다. 결제 때 0원이면 나중에도 적립하지 않고, 결제 뒤 적립률·등급·지급 시점을 바꿔도 결과는 같다. 실지급 스위치(`testMode`)만 기록하는 때의 값을 쓴다.
- 처리 대기 원장(지급·회수 등)은 `lib/server/rewards/ledger.ts` `createPendingRewardLedger`로만 만든다. 회원 행을 `FOR SHARE`로 잠가 탈퇴(`FOR NO KEY UPDATE`)와 순서를 맞추고, 탈퇴한 회원이면 처음부터 `FAILED`(`member_withdrawn`)로 남긴다.
- `EARN`(PENDING), 환불 때 회수: `revokeMode = AUTO`면 `REVOKE`(PENDING)를 기록하고, `MANUAL`이면 기록하지 않는다. MANUAL에서 「환불된 주문에 `EARN`은 있고 `REVOKE`가 없는 상태」가 수동 확인 대기다(감사 로그 `rewardRevoke: manual_review`).
- 결제 확인에 결제수단이 없으면 주문에 저장된 결제수단으로 적립률을 정한다.
- 적립금 3년 소멸(대표님 결정 2026-10-03, `lib/server/rewards/expire.ts` `expireDormantRewards`, 정기 실행 연결은 인프라 승인 대기): 마지막 적립일(실지급·실패 아닌 양수 `EARN`·`RANKING_BONUS`·`ADJUST` 원장의 가장 늦은 `createdAt`)부터 3년이 지난 잔액을 `EXPIRE`(음수, `SUCCEEDED`)로 남기고 0으로 만든다(감사 로그 `reward.expire`, 사유 `no_earn_3_years`). 적립 기록이 없는 잔액은 소멸하지 않는다. 오래된 순으로 limit(기본 100)건, 회원마다 잔액 행을 잠그고 다시 확인한다(멱등, 한 건 실패해도 계속). 소멸 30일 전 안내(알림톡, 실패하면 문자, 메일 없음): `claimRewardExpiryNotices`가 소멸 예정 30일 전~소멸 전인 회원을 `RewardExpiryNotice`((buyerMemberId, lastEarnAt) 유니크, 상태 PENDING·SENT·FAILED, 시도 3번·10분 멈춤 다시 잡기)로 한 번만 잡아 소멸 예정 금액·시각을 돌려주고, 보내는 쪽이 `markRewardExpiryNoticeSent·Failed`(같은 시도 번호만)로 결과를 남긴다. 실제 발송·정기 실행은 연동·인프라 승인 뒤.
- 원장의 실제 처리(SUCCEEDED·잔액 반영), 주문에 쓴 적립금(`USE`)을 환불·취소 때 돌려주는 것은 다음 단계(적립금 사용 기능과 함께).

### 4.8 오버레이·감사 로그

- `OverlayToken`: id, sellerId, tokenHash(**유니크**), createdAt, revokedAt — 오버레이 URL용 추측 불가 토큰. 재발급 시 이전 토큰 폐기.
- 오버레이 레이아웃(SA-051 편집기 → OV-001·002, `lib/server/overlay/layout.ts`, 마이그레이션 `20261004232000_overlay_layout`): `OverlayLayout`(판매자·비율 `9x16`|`16x9`마다 1행, templateKey, widgets JSON, version) — 저장한 적 없으면 기본 템플릿 `queue_focus`(version 0, `isDefault`). 위젯 `{ id([a-z0-9_-] 40자), type, visible, x, y, w, h(화면 대비 %, 0~100, x+w·y+h ≤ 100, w·h > 0), z(0~99), props }`, 20개까지. type은 `HALL_OF_FAME`·`NOTICE`·`SHOP_INFO`·`CURRENT_ORDER`·`QUEUE`·`OPEN_TIMER`·`NEW_ORDER_ALERT`이고 종류마다 하나(신규 주문 알림만 `variant` first·repeat·vip 각 하나). props는 허용 목록만: 공통 title·format(40·100자)·accentColor·titleColor·nicknameColor·bodyColor·titleBgColor·cardBgColor·borderColor(`#RRGGBB`·`#RRGGBBAA`)·titleBgOpacity·cardBgOpacity(0~1)·radius(0~64)·fontSize(8~200)·fontWeight(100~900, 100 단위)·glow·marquee·ticker·flowSec(1~120)·appear(none·fade·up·left·flip)·appearSec(0~10), NOTICE text(여러 줄 200자), QUEUE open*·wait* 색과 rows(1~10), HALL_OF_FAME rows, NEW_ORDER_ALERT variant·durationSec(1~30). 기본 템플릿 3종 `queue_focus`(줄서기형)·`spotlight`(스포트라이트형)·`minimal`(미니형), 값은 디자인 OV-008 수치표 그대로: 7종 위젯 하나씩, 오픈 타이머는 기본 숨김, 신규 주문 알림(first, 6초)은 공지 자리 z9, 공통 radius 16. 바꿔도 저장된 판매자 레이아웃은 그대로. 내 템플릿 `OverlayTemplate`(판매자당 20개). API(`OVERLAY_EDIT`): `GET /api/seller/overlay/layout?aspect=` → `{ aspect, templateKey, widgets, version, updatedAt, isDefault }`, `PUT …/layout { aspect, widgets, expectedVersion }`(다르면 `409 version_conflict` + `currentVersion`, 틀리면 `400 invalid_layout`, 판매자·비율 advisory 잠금, `overlay.layout.update`), `POST …/layout/reset { aspect, template(기본 키·내 템플릿 id), expectedVersion }`(없으면 404, `overlay.layout.reset`), `GET /api/seller/overlay/templates?aspect=` → `{ builtin: [{ key, name, widgets }], mine: [{ id, name, widgets, createdAt }] }`, `POST …/templates { name(30자), aspect, widgets }` 201(20개 넘으면 `409 too_many_templates`, `overlay.template.create`), `DELETE …/templates/{id}`(내 것만, `overlay.template.delete`). 오버레이 주소 `GET /api/overlay/{token}/layout?aspect=`(기본 9x16) → `{ aspect, version, widgets }`(토큰 폐기·잠김 404). 레이아웃 저장은 liveVersion을 올리지 않으므로(환불 등의 버전 확인과 무관) 오버레이 화면은 layout의 version을 따로 확인한다.
- 플랫폼 공지(MA-053·054 → SA-111·112 · PF-005·006, `lib/server/platform-notices/service.ts`, 마이그레이션 `20261005020000_platform_notice`): `PlatformNotice`(title 100자·body 여러 줄 1만 자, category `MAINTENANCE`·`POLICY`·`FEATURE`·`GENERAL`, audience `PARTNERS`·`PUBLIC`·`ALL`, isPinned, publishedAt(null이면 임시 저장), version, deletedAt). 보기는 `platform.read`, 작성·수정·삭제는 `support.manage`(최고관리자·CS), 로그 추적 `platform.notice.create`·`update`·`delete`. 마스터 `GET·POST /api/admin/platform-notices`(?status=draft|published&cursor=), `GET·PUT·DELETE …/{id}`(PUT 전체 값 + `publish`·`expectedVersion`, 다르면 `409 version_conflict` + `currentVersion`, 행 잠금. 다시 게시해도 처음 게시일 유지. DELETE `?expectedVersion=`). 파트너스 `GET /api/seller/platform-notices`·`…/{id}`(누구나, 잠김·정지 중에도), 공개 `GET /api/notices`·`…/{id}`(로그인 없음) — 게시된 대상 공지만 `{ pinned(첫 쪽만), items(본문 없음, 게시일 최신순 20건), nextCursor }`. 발송 채널은 지금 공지 화면뿐(`channels: ["IN_APP"]`), 메일 발송은 만들지 않음.
- 구독 환불 요청·처리(MA-026·027, `lib/server/admin/subscriptionRefunds.ts`, 마이그레이션 `20261005022000_subscription_refund`): `SubscriptionRefund`(결제당 진행 중·끝난 환불 하나, 부분 유니크). 요청은 시스템(해지 뒤 확정된 결제, `settlePayment`가 `subscription.refund_required`와 함께 만듦, 마이그레이션이 기존 로그를 옮김)과 마스터 관리자 직접(PAID 청구, 금액 1원~결제 금액, 사유 필수). 보기 `platform.read`, 요청·반려 `billing.manage`(최고관리자·운영), 승인(결제 취소 요청)은 최고관리자만 `billing.refund`(MASTER 결정 2026-10-05). 실패한 환불이 있는 청구에 새 요청을 만든 뒤 옛 요청을 다시 승인하면 `409 already_requested`. `GET·POST /api/admin/subscription-refunds`(?status=&cursor=, 상태별 수), `GET …/{id}`, `POST …/{id}/approve { expectedVersion, note? }`(PROCESSING 커밋 뒤 `BillingProvider.cancelPayment`, 환불 id 멱등키 → REFUNDED·FAILED, 응답 끊김은 PROCESSING으로 두고 다시 승인), `POST …/{id}/reject { note, expectedVersion }`(REQUESTED·FAILED만). 로그 추적 `subscription.refund.request·approve·refunded·failed·reject`. 공급자는 아직 가짜뿐이라 실제 돈은 오가지 않음(실제 업체·실제 환불은 대표님 승인 뒤). 구독 상태는 바꾸지 않음.
- 플랫폼 문의(파트너스 → 플랫폼, SA-113·114·115 → MA-051·052, `lib/server/platform-inquiries/service.ts`, 마이그레이션 `20261005023000_platform_inquiry`): `PlatformInquiry`(유형 BILLING·ACCOUNT·FEATURE·BUG·OTHER, 상태 OPEN 답변 대기 → ANSWERED 답변 완료 → 추가 문의면 다시 OPEN, CLOSED 종료) + 대화 `PlatformInquiryMessage`(파트너스 글·마스터 답변, 쓴 사람 CHECK) + 첨부 사진 `PlatformInquiryImage`(먼저 올리고 보낼 때 붙임, 리뷰 사진과 같은 검사, 글 하나 5장, 붙지 않은 사진 계정당 10장). 파트너스: 계정 누구나, 잠김·정지 중에도(`feature: BILLING, allowSuspended`), 대표자는 쇼핑몰 문의 전부·직원은 자기가 쓴 것만, 쇼핑몰당 24시간 20건(쇼핑몰 잠금으로 동시에도 정확), 관련 공지는 파트너스에 게시된 공지만. `GET·POST /api/seller/platform-inquiries`, `GET …/{id}`(연 시각 = 읽음, 목록 `hasNewReply`), `POST …/{id}/messages`, `POST …/images`, `GET …/images/{id}`. 파트너스 화면에는 답변한 관리자 이름·id를 보이지 않는다. 마스터: 보기 `platform.read`, 답변·종료 `support.manage`(최고관리자·CS), `GET /api/admin/platform-inquiries`(?status=&sellerId=&cursor=, 상태별 수), `GET …/{id}`, `POST …/{id}/reply { body, expectedVersion }`, `POST …/{id}/close { expectedVersion }`(그 사이 추가 문의가 달리면 409 version_conflict, 종료 뒤 409 inquiry_closed), `GET …/images/{id}`(붙은 사진만). 로그 추적 `platform_inquiry.create·message·image_upload·reply·close`. 메일·알림톡 발송 없음(알림 센터 연결은 5번).
- 점검 모드(MA-083 · AU-010, `lib/server/maintenance/service.ts`, 루트 `proxy.ts`, 마이그레이션 `20261005024000_platform_maintenance`): `PlatformMaintenance` 한 줄(id 1, CHECK). 켜져 있고 시작 시각이 지났으면(없으면 바로) 점검 중, 종료 예정은 안내용(저절로 끄지 않음). 보기 `platform.read`, 바꾸기 최고관리자만 `system.manage`(`GET·PUT /api/admin/settings/maintenance { enabled, message(켜려면 필수), startsAt?, endsAt?, expectedVersion }`, 로그 추적 `platform.maintenance.update`). 공개 `GET /api/maintenance` → `{ active, scheduled, message, startsAt, endsAt }`. 점검 중 `proxy.ts`가 `/api/seller/**`·`/api/seller-signup/**`·`/api/shop/**`·`/api/automation/purchase·reconnect`는 503 `maintenance`(문구 비우면 파트너스 합니다체·구매자 해요체 기본 문구), `/seller/**`·`/shop/**` 화면은 주소를 두고 `/maintenance`(AU-010)를 보여 준다. 마스터 관리자·오버레이(방송 화면 유지)·결제사 결과 알림·정기 작업·상태 확인·공지·요금 정보는 열어 둔다. 상태는 서버마다 5초 기억(바꾼 서버는 바로 지움), DB를 못 읽으면 막지 않는다.
- 쇼핑몰별 이용약관·개인정보처리방침(구매자 `/shop/{슬러그}/terms`·`privacy`, `lib/server/shop-legal/service.ts`, 마이그레이션 `20261005110000_shop_legal_doc`): `ShopLegalDoc`(쇼핑몰·종류 TERMS·PRIVACY마다 한 줄, body 6만 자 텍스트, effectiveOn 시행일, isPublished·publishedAt(처음 게시 시각 유지), version). 파트너스가 입력한 본문만 보여 준다(`docs/terms` 기본 서식은 게시 조건이 있어 앱이 대신 게시하지 않음, 게시 전에는 구매자 화면이 「준비 중」). 파트너스 `GET·PUT /api/seller/shop-legal/{terms|privacy}`: 조회는 같은 쇼핑몰 계정 누구나, 쓰기는 대표자·`SHOP_SETTINGS` 직원만(플랜 기능 `STORE_OPERATIONS`), 본문 `{ body, effectiveOn(YYYY-MM-DD), isPublished(게시하려면 본문·시행일 필요), expectedVersion }`, 옛 version은 409 `version_conflict`(+`currentVersion`, 행 잠금), 로그 추적 `shop.legal.update`(본문은 남기지 않고 글자 수만). 구매자 `GET /api/shop/{slug}/legal/{terms|privacy}`(로그인 없음, 운영 중이 아닌 쇼핑몰·다른 종류는 404) → `{ published:false }` 또는 `{ published:true, body, effectiveOn, version }`. 화면은 본문을 텍스트로만 그려 HTML을 해석하지 않는다. 가입 동의 기록(`lib/server/buyers/consent.ts` 전역 상수 버전)을 쇼핑몰별 문서 version에 연결하는 일은 후속이다.
- 쇼핑몰 바닥글 법정 표시(SA-062 「사업자 정보·고지」, `lib/server/shop-legal/notice.ts`, `components/shop/footNotice.ts`, 마이그레이션 `20261005111000_shop_legal_notice`): `ShopLegalNotice`(쇼핑몰당 한 줄: address 200자·csPhone(숫자·하이픈·괄호)·csEmail·csHours 100자·escrowKind NONE·ESCROW·INSURANCE+escrowProvider 60자(가입했으면 필수)·escrowUrl(https만, 사용자 정보·localhost 거부)·minorNotice 1000자·version). 상호·대표자·사업자등록번호·통신판매업 신고번호는 입점 신청 때 받은 검증 값(`Seller.businessInfo`)을 읽기 전용으로만 쓴다(여기서 바꾸지 않음). 파트너스 `GET·PUT /api/seller/shop-legal-notice`: 조회는 같은 쇼핑몰 계정 누구나, 쓰기는 대표자·`SHOP_SETTINGS` 직원만(`STORE_OPERATIONS`), 옛 version은 409 `version_conflict`(행 잠금), 로그 추적 `shop.legal_notice.update`는 값을 남기지 않고 바뀐 칸 이름만. 구매자 바닥글(`ShopFrame`)은 서버에서 직접 읽어 입력한 항목만 행으로 보여 준다(주소·고객센터·이메일·사업자정보 확인 링크(공정거래위원회 주소+사업자등록번호 10자리, `BIZ_INFO_URL` 한 곳)·호스팅 제공(운영사 상호가 마스터 설정으로 정해지기 전까지 상수 「ONQ」)·구매안전서비스 가입·미성년자 구매 안내 글, 값은 텍스트로만). 구매안전서비스의 법정 표시 위치(초기화면·결제수단 선택부 위)와 미성년자 구매 막기·고지 정책(주문 흐름)은 후속이다.
- 운영 현황(MA-041·042·043, `lib/server/admin/ops.ts`, 조회만 `platform.read`, 마이그레이션 `20261005021000_overlay_token_last_seen`): `GET /api/admin/ops/live-broadcasts`(방송 중 방송 최근 시작 순 200개, 주문대기 상태별 수·주문 수·오버레이 접속), `GET /api/admin/ops/seller-activity?cursor=`(이용 중·정지 파트너스 가입 최신 순 50곳, 오늘(KST) 주문·결제 수·결제 금액(환불 뺌)·방송 중·오버레이 접속), `GET /api/admin/ops/live-payout-sellers`(적립금 실지급 켠 파트너스, 켠 시각 최근 순, 남은 적립금 합계·회원 수). 오버레이 접속은 `OverlayToken.lastSeenAt`(오버레이 주소 확인 때 1분이 지났을 때만 갱신), 폐기 안 된 토큰이 2분 안에 접속했으면 `connected`. 쇼핑몰 이름·주소와 숫자만, 구매자·직원 개인정보 없음. 실시간 감시(MA-100) `GET /api/admin/ops/monitor`(조회만): 살아 있는 인스턴스 정상(2시간 안 정기 실행)·멈춤·신호 없음 수, 작업별 마지막 실행·결과·마지막 성공(오류 문구는 `system.manage`만), 실행할 때가 된 자동 연결 작업 대기 수·가장 오래된 시각, 결제 확인 대기(주문 결제 승인 중·구독 청구·자동 연결 결제·발송 충전) 건수·가장 오래된 시각, 시스템 자동 처리(로그 추적 SYSTEM) 최근 20건, 열린 장애. 웹훅은 받은 기록을 저장하지 않아 `not_measured`. 요금제 목록(MA-021·022) `GET /api/admin/plans`(조회만, 모든 역할) → `{ plans: [{ code, name, listPrice, salePrice, trialDays, trialMessageLimit, trialIdentityLimit, trialStorageMb, mailMonthlyQuota(적용 예정일이 지났으면 새 값), next: { mailMonthlyQuota, effectiveAt } | null, updatedAt }] }`.
- `AuditLog` (추가만, 수정·삭제 없음): id, actorType(`PLATFORM_ADMIN | SELLER_USER | BUYER | SYSTEM`), actorId, sellerId(nullable), action(예: `seller.suspend`, `queue.cancel`, `reward.live_payout.enable`, `admin.impersonate.view`), targetType, targetId, before(JSON), after(JSON), reason, ip, userAgent, createdAt
  - 비밀번호 해시·토큰·CI 해시·카드 정보는 before/after에 넣지 않는다(기록 전 제거).
  - DB 권한으로 UPDATE/DELETE를 막는 것은 운영 DB 계정 설계 때 적용(다음 단계).

### 4.8.0 ONQ 플랜·기능 권한 (목표, ONQ_PLAN 1단계)

정본은 `docs/PRODUCT_SCOPE.md` 「ONQ 통합 지시」·「가격」·「미확정」 확정 ①③④, 계획·검증 표는 `docs/ONQ_PLAN.md` 1단계·E1-B·E1-C다. 이 절은 목표 설계이고, 아래 4.8.1·4.8.2는 **현재 코드** 설명이다(목표와 다른 곳은 각 줄에 「대체 예정」으로 표시). 정본에 없는 값은 지어내지 않고 「미확정」에 둔다.

- 현재 코드(1-C-1 뒤): 플랜 행 `OVERLAY_ONLY`(99,000/69,000원, `trialDays` 7)·`INTEGRATED`(249,000/179,000원, `trialDays` 0)와 이전 전 `STANDARD`(신규 가입에 쓰지 않음). 판매자 플랜 `Seller.planId`(가입 신청 `planCode`, 없으면 신규 가입 기본 플랜 `DEFAULT_PLAN_CODE` = `INTEGRATED`, MASTER 결정 대기), 승인 때 그 플랜의 `trialDays`로 체험(통합은 `trialEndsAt` null). 기능 권한은 1-B(`lib/server/billing/features.ts`). 상위·하위 변경은 1-C-2.
- 목표 플랜 2종(부가세 포함 월 요금):

| 플랜 | 정가 | 런칭 할인가 | 체험 | 주는 기능 권한 |
|---|---:|---:|---|---|
| 오버레이 전용 | 99,000원 | 69,000원 | 마스터 승인 시각부터 7일 | 오버레이, 외부 연동 |
| 쇼핑몰 통합 | 249,000원 | 179,000원 | 없음(첫 결제 확정 뒤 사용) | 오버레이, 외부 연동, 스토어 운영 |

- 기능 권한 3종: 오버레이(OBS 오버레이·방송 화면), 외부 연동(외부 쇼핑몰 주소 확인·연동 인증·웹훅 수신·외부 주문 표시), 스토어 운영(ONQ 스토어·상품·옵션·재고·주문·PG·도메인·구매자 회원·적립금 등 쇼핑몰 기능). 플랜이 권한을 주고, 서버가 매 요청 검사한다(화면 메뉴·버튼 숨김만으로 막지 않음). 오버레이 전용에서 외부 웹훅을 막지 않는다.
  - 검사 위치 ① 판매자 API: 판매자 API 가드(`requireSeller`) 뒤에 기능 권한 검사를 둔다. 기능 권한이 없으면 403 `plan_feature_required`로 거절하고 아무것도 바꾸지 않는다(잠금 402가 먼저, MASTER 확정 2026-10-04). 판매자 API는 모두 아래 분류 중 하나를 `requireSeller(…, { feature })`로 지정한다(경로 목록 시험 `tests/unit/planFeatures.test.ts`).

| 판매자 API 분류 | 경로(지금 코드) | 열리는 조건 |
|---|---|---|
| `BILLING` | 구독·결제(`/api/seller/subscription`·`…/card`·`…/cancel`), 내 정보(`/api/seller/me`) | 항상(기능 권한과 무관, 잠금 허용 범위는 지금처럼) |
| `ACCOUNT` | 직원 관리(`/api/seller/staff/**`), 직원 본인확인 연결(`/api/seller/me/identity/**`, 다시 받기·확인은 본인확인 기록의 쇼핑몰로 검사) | 기능 권한이 하나라도 있을 때. **통합 첫 결제 확정 전 막음** |
| `ORDER_FOLLOWUP` | 이미 받은 주문 처리(`/api/seller/orders/**`·`/api/seller/shipments/**`·`/api/seller/returns/**`), 구매 제한(`/api/seller/purchase-restrictions/**`), 회원 조회(`/api/seller/members/**`) | 기능 권한이 하나라도 있을 때(하위 변경 뒤에도 기존 주문 처리). **통합 첫 결제 확정 전 막음** |
| `OVERLAY` | 방송·주문대기·오버레이 토큰·레이아웃·템플릿·방송 실시간 채널(`/api/seller/broadcast/**`·`queue/**`·`overlay/token`·`overlay/layout/**`·`overlay/templates/**`·`stream`) | 오버레이 권한 |
| `STORE_OPERATIONS` | 상품·옵션·재고, 배송비·주문·회원·적립 정책, 공유 미리보기 설정 | 스토어 운영 권한 |
| `EXTERNAL_INTEGRATION` | (아직 경로 없음, 외부 연동 경로가 생기면 지정) | 외부 연동 권한 |

- 후속 처리 대상 여부 `orderFollowup`(`GET /api/seller/me`, MASTER 2026-10-04, `lib/server/orders/followup.ts` `hasOrderFollowup` 한 곳): 오버레이 전용으로 내린 뒤에도 화면 셸이 주문·배송·문의 메뉴를 계속 보여 줄지 정한다. 끝나지 않은 주문(결제 대기, 결제 완료인데 배송 완료 전 — 발송 전·배송 중·재고 부족 환불 대기, 법정 보관 주문 제외) 또는 유효한 구매 제한(풀리지 않았고 끝나는 시각 전)이 하나라도 있으면 true, 다 끝나면 false. 기능 권한이 하나도 없어 `ORDER_FOLLOWUP` 가드가 막는 판매자는 false.

  - 검사 위치 ② 공개·구매자 경로(#174 Codex P1): 판매자 세션이 없는 경로도 주소의 쇼핑몰(slug → 판매자) 또는 오버레이 토큰의 판매자로 기능 권한을 검사한다. 스토어 운영 권한이 없는 쇼핑몰(오버레이 전용, 통합 첫 결제 확정 전)은 **새 거래 시작**을 막는다. 하위 변경 전에 생긴 주문의 조회·배송·환불·구매자 본인 정보 관리는 계속 연다. 막을 때는 기존 잠금과 같은 402 `shop_unavailable`(판매자 사정은 드러내지 않음), 공유 미리보기·공유 카드·오버레이 공개 주소는 지금처럼 404다(MASTER 확정 2026-10-04). 1-B 시험은 아래 표의 경로마다 「막을 것은 거절되고 DB 변경 0건, 허용할 것은 지금처럼 동작」을 확인한다.

| 경로(지금 코드) | 필요한 기능 권한 | 스토어 운영 권한 없을 때 |
|---|---|---|
| `POST /api/shop/{slug}/orders`(주문 생성) | 스토어 운영 | 막음 |
| `GET /api/shop/{slug}/order-consent`(주문서 동의 문구) | 스토어 운영 | 막음(주문서 진입) |
| `POST /api/shop/{slug}/signup/verification`·`…/resend`·`…/confirm`·`POST /api/shop/{slug}/signup`(구매자 가입) | 스토어 운영 | 막음 |
| `GET /api/shop/{slug}/share`·`GET /api/shop/{slug}/og.png`(공유 미리보기) | 스토어 운영 | 막음(공개 쇼핑몰 페이지와 함께 닫힘) |
| 화면 `/shop/{slug}/signup`(구매자 가입 화면, 앞으로 생길 장바구니·주문서·상품 구매 버튼 화면도 같음, 아래 ③) | 스토어 운영 | 막음(안내 화면, 폼·구매 버튼 없음) |
| `GET /api/shop/{slug}/orders`·`…/orders/{orderId}`(내 주문 조회) | 없음(기존 주문) | 허용 |
| `POST /api/shop/{slug}/auth/login`·`…/logout`(구매자 로그인) | 없음 | 허용(기존 주문 조회·탈퇴용) |
| `GET·POST /api/shop/{slug}/addresses`·`…/addresses/{id}`(배송지) | 없음 | 허용(기존 주문 배송·구매자 정보 관리) |
| `GET·PUT /api/shop/{slug}/me/marketing-consent`·`POST …/me/withdraw` | 없음 | 허용(동의 철회·탈퇴는 언제든) |
| `GET·PUT /api/shop/{slug}/me/rejoin-retention-consent`(재가입 제한 정보 보관 동의 철회) | 없음 | 허용(동의 철회는 언제든) |
| `GET /api/shop/{slug}/me/rewards`(내 적립금 잔액) | 없음 | 허용(탈퇴 전 확인) |
| `GET /api/overlay/{token}/state`·`…/version`·`…/stream`·`…/layout`(오버레이 공개 주소) | 오버레이 | 오버레이 권한이 없으면 막음(통합 첫 결제 확정 전) |

  - 검사 위치 ③ 서버 렌더 쇼핑몰 화면(#174 Codex P2): 「새 거래 시작」 화면도 화면 단계에서 막는다(API 거절에만 기대지 않음). 지금은 `app/(shop)/shop/[slug]/signup/page.tsx`(구매자 가입, `/shop/{slug}/signup`)가 있고, 장바구니·주문서·상품 구매 버튼이 있는 화면이 생기면 같은 규칙이다. 스토어 운영 권한이 없으면 가입 폼·구매 버튼을 보여 주지 않고 안내 화면을 그린다. 이 검사는 `shopOpen`(운영 중·잠김)과 별도로 한다. 1-B 시험은 화면 경로마다 「렌더 결과가 안내 화면이고 폼·구매 버튼이 없음」을 확인한다(화면 파일은 화면 세션 소유라, 서버가 화면에 줄 판정 함수·값을 1-B에서 만들고 화면 연결은 화면 세션에 배정). 1-B 구현: 판정 함수는 `shopOpen`(`lib/server/buyers/signup.ts`, 운영 중·잠김·스토어 운영 권한을 함께 봄)이고, 기능 권한만 따로 볼 때는 `sellerHasFeature(db, sellerId, "STORE_OPERATIONS")`(`lib/server/billing/features.ts`)를 쓴다. 지금 가입 화면은 이미 `shopOpen`으로 안내 화면을 그려 화면 수정 없이 막힌다. 파트너스 화면 메뉴용으로 `GET /api/seller/me`가 `features`를 준다.

    새 공개·구매자 경로나 화면을 만들면 이 표(화면은 위 ③)에 넣고 1-B 시험(경로 목록 검사)에 더한다. 장바구니처럼 아직 없는 「새 거래 시작」 경로도 생기면 「막음」으로 분류한다.
  - 직원 권한과의 관계: 직원은 「플랜이 준 기능 권한」과 「대표자가 준 직원 권한」을 둘 다 가져야 한다(교집합). 대표자는 플랜이 준 기능 권한 전부를 가진다.
  - 잠금(4.8.1 `sellerAccess`)은 기능 권한과 따로 판정한다. 잠기면 기능 권한이 있어도 잠금 규칙이 먼저다.
  - 하위 변경(통합 → 오버레이 전용) 뒤에도 변경 전에 받은 주문의 배송·취소·환불·구매자 문의·영수증은 끝날 때까지 연다(「잠금 중 허용 범위」와 같은 범위, 확정 ①).
- 가입 때 플랜 고르기: 가입 신청에서 「지금 운영 중인 쇼핑몰이 있나요?」로 플랜을 정한다(있어요 → 오버레이 전용, 없어요 → 쇼핑몰 통합). 체험 시작점이 승인 시각이라 승인 전에 정한다(PRODUCT_SCOPE 「판매자 가입 순서」, MASTER 해석). 기존 쇼핑몰이 있어도 통합을 막지 않는다. 오버레이 전용도 대표자 휴대폰 본인확인을 한다(확정 ④). 오버레이 전용 최소 가입(사업자 정보 없이)과 통합 전환 때 사업자·정산 정보는 ONQ_PLAN 2단계다.
- 결제 규칙(확정 ①③, MASTER 해석 포함):
  - 오버레이 전용: 체험 7일이 끝나면 런칭 할인가 69,000원으로 첫 결제, 이후 매달. 체험 뒤 첫 결제 실패는 기존 「결제 실패·잠금·해지」 규칙(하루 간격 3번 재시도·7일 유예, 유예 동안 오버레이 권한 유지).
  - 쇼핑몰 통합: 체험 없이 179,000원 첫 결제. 결제가 거절·대기·시간 초과면 통합 권한을 열지 않고, 대사로 확정된 뒤에만 연다.
  - [확정] 통합 첫 결제 확정 전 이용 범위: 구독·결제 화면(과 내 정보·로그아웃)만 열고, 기능 권한(외부 연동·스토어 운영)은 첫 결제가 확정된 뒤에 연다(PRODUCT_SCOPE 「판매자 가입 순서」 「쇼핑몰 통합은 체험 없이 구독 결제 후 사용」, MASTER 결정 2026-10-04).
  - 해지: 이번 결제 기간이 끝날 때까지 쓰고 다음 결제부터 청구하지 않는다. 이미 낸 구독료는 일할 환불하지 않는다(법이 요구하는 경우 제외, 법무 확인 필요).
  - 상위 변경(오버레이 전용 → 통합): 결제사가 결제를 확정한 뒤에만 적용하고, 대기·실패·시간 초과면 지금 플랜 유지. 결제 중이면 차액 = (새 플랜 금액 − 지금 플랜 금액) × 남은 일수 ÷ 이번 결제 기간 일수, 원 단위 절사, 결제일 그대로. 체험 중이면 체험을 끝내고 179,000원을 바로 결제하고 결제일을 그날로 새로 잡는다. 결제 실패 유예 중(`PAST_DUE`)이면 밀린 결제 금액과 차액을 함께 결제해 둘 다 확정된 뒤에만 연다. 사업자·통신판매업 점검이 필요하면 점검 통과 뒤에 결제한다(대기 중 결제 0건, 거절이면 결제 없이 기존 플랜).
  - 하위 변경: 다음 결제일부터.
  - [확정(대표님 2026-10-04)] 런칭 할인 계정당 1회: ① 런칭가 첫 결제가 확정되는 순간 계정(판매자)에 `Seller.launchDiscountUsedAt`을 남긴다(거절·대기·해지 뒤 확정돼 환불 대상인 청구는 세지 않음). ② 구독이 끊기지 않고 이어지는 동안은 매달 갱신·상위 변경 모두 런칭가를 유지한다. 할인 종료일이 정해지면 그날 이후 결제부터 정가(가격 변경 고지 규칙). ③ 해지 뒤 다시 구독하면 정가(통합 249,000원·오버레이 전용 99,000원)이고 그 구독이 이어지는 동안 정가다(`SellerSubscription.regularPrice`, 상위 변경 차액도 정가 기준). ④ 이전 전 STANDARD 결제 이력(이전 전 가격 스냅숏 청구 포함)은 사용으로 세지 않는다. 그래서 이전된 판매자는 처음 재구독할 때 한 번 통합 런칭가 179,000원이다(아래 「해지 보관 구독 재시작 = 그때 통합 런칭가」와 같은 뜻). 구현 `chargeFor`(`lib/server/billing/subscription.ts`), 청구마다 런칭가 여부 `SubscriptionPayment.launchDiscount`. 새 플랜 뒤 마이그레이션 `20261004155000_plan_change` 전에 만든 청구는 마이그레이션이 같은 조건으로 표시하고, 이미 확정된 런칭가 청구가 있는 판매자는 첫 확정 시각으로 채운다(BACKFILL). 할인 종료일은 아직 없다(미확정).
  - 할인 종료 뒤 정가: 결제 전 화면과 구독 관리 화면에 바뀌는 날짜·금액을 함께 보여 준다. 기존 구독자에게는 「가격 변경 적용」(30일 전 고지 뒤 다음 결제부터, 4.8.1 `chargeFor`)을 그대로 쓴다.
  - 결제·구독 상태(체험·결제 실패·유예·잠금·해지)는 두 플랜이 같은 구조를 쓴다(4.8.1).
- 기존 `STANDARD` 이전(ONQ_PLAN 1행, 결정적 백필): 기존 구독을 쇼핑몰 통합으로 옮기고 진행 중 체험 종료일·결제일은 그대로 둔다. 새 가격은 「가격 변경 적용」대로 30일 전 고지 뒤 다음 결제부터. 구독 행 없는 기존 판매자(승인 뒤 카드 미등록, `trialEndsAt`만 있음)도 체험 중이든 체험이 끝나 잠겼든 쇼핑몰 통합을 배정한다(체험 중이면 남은 체험 종료일을 두고 끝나면 통합 런칭가로 첫 결제, 이미 잠긴 판매자는 잠금 유지 뒤 카드 등록·결제 때 통합 런칭가). 해지 뒤 90일 보관 중인 `STANDARD` 구독도 쇼핑몰 통합으로 바꿔 둔다(복구 결제 때 옛 플랜·옛 가격으로 시작하지 않게). `STANDARD`는 이전 뒤 신규 가입에 쓰지 않는다. 유예 중·해지 예약 구독의 상태·일정 유지는 ONQ_PLAN E1-C로 확인한다.
  - 이전 전 가격 유지(#174 Codex P1): 구독의 플랜만 바꾸면 청구 금액 계산이 새 플랜 가격 기록으로 계산해 고지 기간 없이 바뀐 금액을 청구한다. 그래서 이전 대상 구독마다 **이전 전 가격 스냅숏**(금액, 고지 발송 완료 시각 `noticeSentAt`)을 남기고, `chargeFor`는 스냅숏이 유효한 동안 그 금액을 우선 쓴다. 이전(백필) 때 고지 대상 목록(`listPriceChangeNoticeTargets`)에 올린다.
    - 고지 시각은 실제 발송이 끝난 시각(`noticeSentAt`)으로만 기록한다. 스냅숏은 `noticeSentAt + 30일` 뒤 첫 결제 전까지 유효하다. 발송 기능이 없거나 아직 보내지 않았으면 `noticeSentAt = null`이고, 이전 전 가격을 계속 쓴다(새 가격 청구 0건, #174 Codex P1).
    - 스냅숏은 결제가 이어지는 구독(체험 중·결제 중·유예 중·해지 예약)에만 남긴다. 해지(`CANCELED`) 뒤 보관 중인 구독은 스냅숏 없이 통합으로 옮기고, 다시 결제해 재시작(복구 결제)하면 새 가입자 규칙(그때 통합 런칭가)을 쓴다. 다른 상태의 구독도 해지 뒤 재시작하면 스냅숏을 무효로 한다(#174 Codex P1). 금액이 내려가는 경우도 정본 「가격 변경 적용」대로 고지 뒤 다음 결제부터 적용한다(바로 낮추는 예외는 정본에 없음).
  - 1-C 시험(ONQ_PLAN E1-C에 더함): 이전 직후 다음 결제 금액 = 이전 전 금액, 고지 발송 30일 뒤의 다음 결제부터 새 플랜 금액, 고지 미발송(`noticeSentAt = null`)이면 새 가격 청구 0건, 해지 보관 구독 재시작 = 그때 통합 런칭가(스냅숏 없음). 구독 행 없는 판매자는 이전 전 청구 금액이 없으므로 통합 런칭가로 첫 결제(위 규칙).
- 구현 순서(MASTER 결정 2026-10-04): 1-A 이 문서 → 1-B 플랜 → 기능 권한 매핑과 서버 검사(기존 판매자는 지금 동작이 바뀌지 않게 통합 권한으로 두고 시험으로 확인, 결제 엔진은 건드리지 않음) → 1-C 결제 엔진 전환·`STANDARD` 이전 백필(범위는 MASTER가 따로 정함).
- [확정] 코드 이름(MASTER 2026-10-04, 1-B 구현 `lib/server/billing/features.ts`): 기능 권한 `OVERLAY`·`EXTERNAL_INTEGRATION`·`STORE_OPERATIONS`, 플랜 `OVERLAY_ONLY`·`INTEGRATED`(지금 판매자의 `STANDARD`는 1-C 이전 전까지 통합과 같은 3종, 표에 없는 플랜 코드는 권한 없음). 오류 코드는 위 ①·②. 파트너스 화면 메뉴용으로 `GET /api/seller/me`가 `features`를 준다.
- 미확정(정본에 값이 없어 정하지 않음):
  - 런칭 할인 기간·종료일(대표님이 나중에 정함, 「첫 3개월」은 확정 값이 아님).
  - 오버레이 전용 체험 중 플랫폼 비용 한도(지금 체험 한도는 알림톡·문자 100건·구매자 본인확인 50건·저장 1GB로 플랜 하나 기준). 오버레이 전용 체험에 그대로 쓸지.
  - 국내 전자상거래법 청약철회(결제 후 7일·미사용)·중도 해지 환불 요구가 「환불 없음」보다 우선하는지(법무 확인).

### 4.8.1 체험하기·플랫폼 구독 (대표님 결정 2026-10-02, MASTER 결정 2026-10-03)

화면·메일·API 메시지의 무료 체험 기간 표기는 「체험하기」다(「무료 이용」이라고 쓰지 않음). 코드 이름(`trialEndsAt` 등)은 그대로 둔다.

- `Seller.trialEndsAt`: 마스터 승인(또는 자동 승인) 때 DB 시계로 `approvedAt + 판매자 플랜의 trialDays`를 채운다(오버레이 전용 7일, 통합은 체험 없음 = null, ONQ 1-C·4.8.0). 판매자 플랜이 없으면 그때 신규 가입 기본 플랜을 정해 남긴다. 승인 대기인 쇼핑몰만, 동시 승인은 한 번만 반영. 1-C 이전으로 통합에 옮긴 기존 판매자는 받았던 체험 종료일을 그대로 둔다(그동안 기능 권한도 통합 3종, 체험이 끝나면 잠금 규칙).
- 이용 가능 여부(`sellerAccess`): 아래 중 하나면 쓸 수 있다. 아니면 판매자 API는 `402 subscription_required`, 오버레이 공개 주소(`state`·`version`·`stream`)는 404, 열려 있는 오버레이 SSE는 다음 핑 재확인 때 닫힌다.
  - `paid`: 결제한 이용 기간 안(`currentPeriodEnd > 지금`). 해지 예약·자동결제 실패여도 기간 끝까지.
  - `trial`: 체험하기 중.
  - `charging`: 카드를 등록해 두었고 예약 결제 시각이 지났지만 예약 실행이 아직 처리하지 않음. 우리 쪽 지연으로 판매자를 잠그지 않으므로 시간 제한이 없다.
  - `grace`: 자동결제 실패 뒤 유예 중(실패한 때 + 7일). 해지 예약을 하면 유예는 지운다.
  - 판단 시각은 DB 시계(`requireSeller`·오버레이 토큰·체험 한도 모두). 테스트만 시각을 넘긴다.
  - 잠겨도 열리는 것(대표님 결정, PRODUCT_SCOPE 「잠금 중 허용 범위」): 내 정보(`/api/seller/me`, 이용 상태 포함), 구독·결제(`/api/seller/subscription/**`), 로그아웃, 이미 받은 주문의 처리(주문 조회·취소·환불, 배송·구매자 문의 답변·영수증은 기능을 만들 때 같은 방식으로 연다). 막는 것은 새 판매(쇼핑몰 주문 생성·오버레이·방송 시작·상품 등록·수정·도메인 신규 연결)와 그 밖의 판매자 API다. 판정은 서버 가드(`requireSeller`, 예외는 `allowUnpaid`)에서 한다.
- 잠금 30일 뒤 자동 해지(`closeLongLockedSellers`, 예약 실행): 잠기기 시작한 시각(체험하기 끝·기간 끝·유예 끝 중 가장 늦은 시각)에서 30일이 지나면 `Seller.serviceEndedAt`을 기록하고 구독을 `CANCELED`, 연결 도메인을 비활성(`SellerDomain.suspendedAt`)으로 바꾼다. 데이터는 지우지 않는다(90일 보관 뒤 삭제·5년 주문·결제 기록 보관은 별도 작업). 보관 기간 안에 다시 결제하면 해지 표시를 지우고 해지 때 푼 도메인을 되살린다.
- 체험하기 한도(대표님 결정): 알림톡·문자 100건, 구매자 휴대폰 본인확인 50건, 저장 용량 1GB. `SubscriptionPlan`의 `trialMessageLimit`·`trialIdentityLimit`·`trialStorageMb`에 두고 마스터 API(`POST /api/admin/plans/{code}/trial-limits`, `billing.manage`, 감사 로그)로 바꾼다. 확인 함수 `checkTrialLimit`은 체험하기 중인 판매자에게만 적용하며, 알림톡·업로드 기능을 만들 때 연결한다. 휴대폰 본인확인은 연결됨: 구매자 가입 본인확인 성공 1건을 1로 세고(`identityUsage`, 중복 확인은 세지 않음), 주문 알림 문자와 따로 센다. 한도가 이미 찼으면 구매자 가입 본인확인 시작·인증번호 다시 보내기에서 문자를 보내기 전에 `403 trial_limit_exceeded`로 막는다(`buyerSignupIdentityLimitReached`). 확정 때 잠금 아래 최종 확인은 그대로 둔다.
- 메일 제공량·발송 충전 잔액(대표님 결정 2026-10-05, 서식 `docs/terms/SELLER_MESSAGE_FEE_NOTICE.md`, `lib/server/mail/quota.ts`·`lib/server/messaging/balance.ts`·`settings.ts`, 마이그레이션 `20261004230000_mail_quota`): 거래 메일은 플랜별 월 제공량 `SubscriptionPlan.mailMonthlyQuota`(통, KST 달, 이월 없음, 기본 100 — 값은 대표님이 정함)까지 무료. 넘은 거래 메일·광고/공지 대량 메일(`bulk`)·(향후) 문자·알림톡·구매자 본인인증(쇼핑몰에서 켠 경우)·배송 자동 조회는 파트너스 선불 잔액 `SellerMessageBalance`(유료 `paidBalance`·무상 `freeBalance`, DB CHECK로 음수 불가)에서 채널 단가 `MessageChannelPrice`(기본 0원)만큼 차감한다. 차감은 유료 먼저, 모자라면 무상(서식 4-2). `reserveDebit`(잔액 행 FOR UPDATE, 보내기 전에 잡음, PENDING) → 성공 `captureDebit`(SUCCEEDED)·실패 `releaseDebit`(REVERSED, 유료·무상 각각 되돌림). 같은 요청 키는 되돌린 것을 빼고 한 건만(부분 유니크 `SellerMessageLedger_sellerId_idempotencyKey_live_key`): 알림톡 실패 뒤 같은 키로 문자를 잡으면 최종 성공 채널 한 건만 남는다. 잔액이 모자라면 공급자를 부르지 않고 `MailDelivery` `SKIPPED_BALANCE`(잔액 부족 미발송, 부른 쪽 처리는 계속). 플랫폼 전체 무료 한도(`PlatformMessageSetting` 하루 100·월 3,000, Resend 무료 범위)에 이르면 모든 메일을 `SKIPPED_PLATFORM_LIMIT`(차감 없음)로 남기고, 80%·다 씀을 기간마다 한 번 로그 추적(`mail.platform_near_limit`·`mail.platform_limit_reached`, SYSTEM). 메일 예약 잠금 순서는 advisory `mail_quota` → 잔액 행. 메일 셈은 PENDING·SENT(실패는 빠짐). 발송 기록 id를 공급자 멱등키·차감 키(`mail:{id}`)로 쓴다. 받는 사람 주소·내용은 남기지 않는다. 충전 스위치 `chargingEnabled` 기본 꺼짐(서식 값·법률 검토 전). 단가·제공량은 적용 예정일(`effectiveAt`, 지나면 새 값)을 둘 수 있다. 비용 안내 동의 `SellerMessageFeeConsent`(서식 버전 `MESSAGE_FEE_NOTICE_VERSION`·시각·직원 id). API: 파트너스(대표자, `BILLING`) `GET /api/seller/message-balance`(정지 중 보기, `{ paidBalance, freeBalance, total, lowBalanceThreshold, lowBalance, chargingEnabled, noticeVersion, consent, prices: [{ channel, unitPrice, next }], mail: { month, quota, sent, freeSent, chargedSent, pending, skippedBalance, skippedPlatformLimit, failed } }`)·`PUT { lowBalanceThreshold }`(`400 invalid_threshold`, `seller.message_balance.threshold_update`)·`POST …/consent { version }`(다르면 `409 notice_version_mismatch`, 멱등, `seller.message_fee.consent`)·`GET …/ledger?cursor&limit`. 마스터 `GET /api/admin/message-settings`(`platform.read`, `{ chargingEnabled, platformDailyLimit, platformMonthlyLimit, noticeVersion, prices, plans: [{ code, name, mailMonthlyQuota, next }], usage }`)·`PUT`(최고관리자, `admin.message_settings.update`)·`POST /api/admin/message-prices/{channel} { unitPrice, effectiveAt? }`(최고관리자, `admin.message_price.update`)·`POST /api/admin/plans/{code}/mail-quota { monthlyQuota, effectiveAt? }`(최고관리자, `admin.plan.mail_quota_update`)·`GET·POST /api/admin/sellers/{id}/message-balance`(조회 `platform.read`, 무상 지급 최고관리자 `{ amount, reason, idempotencyKey }` 201/같은 키 200, `admin.message_balance.grant`). 충전 스위치가 꺼진 동안은 단가와 상관없이 차감하지 않는다(`reserveDebit` → `charging_disabled`, 메일은 제공량을 넘으면 차감 없이 `SKIPPED_BALANCE`). 충전(`lib/server/messaging/charge.ts`, 마이그레이션 `20261004231000_message_charge`): 대표자가 `POST /api/seller/message-balance/charges { amount(1,000~1,000,000원, 1,000원 단위), idempotencyKey }`로 구독 결제 카드(빌링키)에 결제한다(결제 공급자는 구독과 같은 것, 지금은 가짜 공급자만). 스위치 꺼짐 `403 charging_disabled`, 지금 서식 버전 동의 전 `409 consent_required`, 카드 없음 `409 card_required`, 금액 틀림 `400 invalid_charge`. `MessageCharge`(PENDING → PAID·FAILED, id = PG 주문 번호, 같은 키는 한 번만)를 먼저 커밋하고 결제한 뒤, 충전 행을 잠그고 PENDING일 때만 유료 잔액 + 원장 `CHARGE`(키 `charge:{id}`)를 남긴다(로그 추적 `seller.message_charge.request`·`paid`·`failed`). 결과 200 PAID, 202 PENDING(응답 끊김, 같은 키 재요청이 공급자 조회로 확정), 402 FAILED. `reconcileMessageCharges`가 1분 지난 PENDING을 공급자 조회로 확정하고 기록이 없으면 10분 뒤 `not_charged`로 닫는다. `GET …/charges`(최근 20건·잔액). 멈춘 예약 정리 `expireStaleMessageHolds`(`lib/server/messaging/holds.ts`): 15분 넘은 PENDING 메일은 FAILED + 차감 되돌림, 메일에 묶이지 않은 30분 넘은 PENDING 차감은 되돌림. 대조·정리는 앱 안 정기 실행 작업 `message.reconcile_and_release`(`lib/server/messaging/jobs.ts`, `jobs/scheduler.ts`, 1시간마다, 작업별 잠금으로 인스턴스 하나만, 대조 오류·공급자 설정 없이 남은 확인 중 충전은 실패로 남김, 스케줄러 트랜잭션 60초 제한 안에 끝나도록 처리 시간 예산 40초·50건씩, 넘기면 다음 건을 시작하지 않고 멈추고 다음 실행이 오래된 순으로 이어서 처리)로 돈다. 충전 기능을 켤 때(꺼짐 → 켜짐)는 이 작업의 heartbeat가 2시간 안에 성공(`done`)이어야 하고, 아니면 `409 jobs_not_running`(끄기·다른 값 변경은 언제든). 아직: 유료 잔액 환불(수수료율·청약 철회 기간 서식 값 필요)·잔액 부족 알림 발송·변경 공지 발송·문자·알림톡·본인인증·배송 조회 차감 연결, 메일 공급자 연결.
- `SubscriptionPlan`: 정가(`listPrice`)·판매가(`salePrice`), 원 단위 부가세 포함, 청구액은 판매가. 체험 일수 `trialDays`. 플랜 행은 마이그레이션 데이터로 넣는다: `OVERLAY_ONLY` 99,000/69,000원·7일, `INTEGRATED` 249,000/179,000원·0일(`20261004150000_onq_plans`), 이전 전 `STANDARD` 300,000/199,000원은 남겨 두되 신규 가입에 쓰지 않는다. 구독 행이 없을 때 청구·표시 플랜은 판매자 플랜(`sellerPlanOf`). 요금 안내 `GET /api/plans`는 기본 플랜 값과 `plans`(가입할 수 있는 두 플랜)를 준다.
- STANDARD → 통합 이전(`20261004150000_onq_plans` BACKFILL, 결정적): 모든 STANDARD 구독(해지 보관 포함)과 모든 기존 판매자(구독 행 없는 체험 중·잠김 포함)를 `INTEGRATED`로 옮기고 상태·체험 종료일·결제일·유예·재시도·해지 예약은 그대로 둔다. 결제가 이어지는 구독(ACTIVE·PAST_DUE, 해지 예약 기간이 끝나지 않음)에만 이전 전 가격 스냅숏 `SellerSubscription.legacyPrice`(청구 금액과 같은 규칙으로 계산)를 남긴다. `chargeFor`는 스냅숏이 있고 `legacyPriceNoticeSentAt`이 없거나 그 + 30일 전이면 스냅숏 금액을 쓴다(고지 미발송이면 새 가격 청구 0건). 해지 뒤 다시 구독하면 스냅숏을 비운다(그때 플랜 가격). 고지 대상은 `listPlanMigrationNoticeTargets`(최고관리자), 발송 기능이 생기면 보낸 뒤 `legacyPriceNoticeSentAt`을 남긴다. 시험 `tests/integration/planMigration.test.ts`(ONQ_PLAN E1-C).
- 플랜 변경(ONQ 1-C-2, `lib/server/billing/planChange.ts`, `POST /api/seller/subscription/plan { planCode }`, 대표자 전용·잠겨도 열림·`BILLING`): 상위 변경(오버레이 전용 → 통합)은 결제사가 확정한 뒤에만 적용하고 대기·실패·시간 초과면 지금 플랜 그대로(유예 없음). 결제한 기간 중이면 차액 = (새 플랜 금액 − 지금 플랜 금액) × 남은 일수 ÷ 이번 기간 일수(KST 달력 날짜, 결제일 당일 0일·전날 1일, 원 단위 절사, MASTER 결정 2026-10-04, 응답 `remainingDays`)를 `kind = PRORATION` 청구로 결제하고 기간·결제일은 그대로. 체험 중이면 새 플랜 금액을 기간 결제로 바로 내고 확정되면 체험을 끝내고 결제일을 그날로. 유예 중(`PAST_DUE`)이면 밀린 기간의 지금 플랜 금액 + 그 기간 남은 일수 차액을 한 기간 결제로 내고 둘 다 확정된 뒤 ACTIVE·새 플랜. 체험·유예 중 카드가 없으면 409 `card_required`(결제 없이 통합을 열지 않음). 결제한 기간도 체험도 없으면(잠김·첫 결제 전) 결제 없이 플랜만 바꾼다(다음 결제가 새 플랜 금액). 하위 변경은 결제한 기간·유예 중이면 `SellerSubscription.pendingPlanId`에 두고 갱신 결제 직전에 옮겨 그 결제부터 새 금액(환불 없음, 해지 예약 구독은 그대로 해지), 아니면 바로. 지금 플랜을 다시 고르면 예약을 거둔다. 플랜이 바뀌면 이전 전 가격 스냅숏은 끝난다. 청구 종류 `SubscriptionPayment.kind`(`PERIOD`·`PRORATION`)와 확정 때 옮길 `targetPlanId`, 같은 기간 결제 하나 제한(부분 유니크)은 `PERIOD`에만 건다. 사업자·통신판매업 점검 게이트는 ONQ 2단계(MASTER 승인). 런칭 할인 계정당 1회는 위 4.8.0 확정 규칙(`chargeFor`). 시험 `tests/integration/planChange.test.ts`(ONQ_PLAN E1-B). 미리보기 `GET /api/seller/subscription/plan/preview`(대표자 전용·잠겨도 열림·`BILLING`, 쓰기 없음): 플랜마다 다음 결제 금액(`price`, 구독 화면 다음 결제 금액과 같은 기준)과 지금 바꾸면 어떻게 되는지(`change`: `applied`·`chargeNow`·`remainingDays`·`effectiveAt` 또는 POST와 같은 실패 사유). 판단은 실제 변경과 같은 함수(`quotePlanChange`)를 쓴다. POST에 확인 금액 `expectedAmount`(미리보기 `chargeNow`, 0 이상 정수)를 보내면 지금 낼 금액과 같을 때만 바꾸고 다르면 `409 amount_changed`(아무것도 바꾸지 않음, 형식 오류 400). 필수다(구독 화면이 미리보기 금액을 보냄, #253). 없으면 다른 거절 사유가 먼저이고 그다음 `400 amount_required`.
- 가격 변경(대표님 결정): 최고관리자만(`billing.price`), 가격 변경·가격 기록(`SubscriptionPriceChange`)·감사 기록은 한 트랜잭션.
  - 청구 금액(`chargeFor`, 가격을 읽는 유일한 출처: 갱신·재시도·재구독·상위 변경 차액·구독 화면 다음 결제 금액·가격 변경 고지 대상) = 가격 기록 중 「구독을 시작할 때(`SellerSubscription.subscribedAt`) 이미 적용되던 것」 또는 「변경 + 30일이 지난 것」 가운데 가장 최근 가격. 정가 구독(`regularPrice`)은 그 기록의 정가, 그 밖은 판매가다. 그래서 새 가입자는 지금 가격, 기존 구독자는 고지 기간(30일)이 끝난 뒤 첫 결제부터 새 가격을 낸다. 30일 안에 두 번 바꿔도 구독 시작 때 가격(또는 고지가 끝난 가격)을 유지한다.
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
- 해지: 결제를 처리하는 중(`PENDING` 청구)에는 `409 payment_in_progress`(「결제를 처리하고 있습니다. 잠시 뒤 다시 시도해 주십시오」). 결제한 기간이 남아 있으면 기간 끝까지 쓰고 다음 결제를 하지 않는다. 결제한 기간이 없으면(체험하기 중 카드만 등록, 유예 중) 바로 해지하고 청구하지 않는다. 즉시 환불은 하지 않는다.
- 결제 공급자는 인터페이스(`lib/server/billing/provider.ts`: 빌링키 발급·결제·같은 청구 id 조회)로만 부르고, 업체(후보 NICEPAY·페이플)는 바꿔 끼운다. `BILLING_PROVIDER` 환경변수로 고른다. 지금은 `fake`만 있고 명시했을 때만 쓴다(운영 환경에서는 만들 수 없음, 실제 결제 없음). 예약 실행을 주기적으로 돌리는 인프라는 승인 후 연결한다.
- 빌링키 암호화: AES-256-GCM, 판매자 id를 AAD로 묶어 다른 판매자 행으로 옮기면 풀리지 않는다. `BILLING_KEY_SECRET`이 없으면 PG를 부르기 전에 실패한다.
  - 키 교체 절차: ① 새 키를 `BILLING_KEY_SECRET_NEXT`로 배포(읽기는 새 키 → 이전 키 순으로 시도하는 코드를 그때 추가) ② 일괄 작업으로 모든 `billingKeyCipher`를 이전 키로 풀어 새 키로 다시 암호화(판매자 행 잠금 아래, 진행 중 청구가 없을 때) ③ 남은 행이 없는지 확인한 뒤 `BILLING_KEY_SECRET`을 새 키로 바꾸고 이전 키 제거 ④ 감사 로그에 교체 기록. 키 값은 저장소·로그에 남기지 않는다.

### 4.8.2 판매자 가입 신청·자동 승인 (대표님 결정 2026-10-02)

- (2026-10-04 대체 예정, 목표는 4.8.0 「가입 때 플랜 고르기」: 가입 신청에서 플랜을 정하고, 오버레이 전용은 사업자 정보 없이 최소 가입, 통합 전환 때 사업자·정산 정보. 계획 `docs/ONQ_PLAN.md` 2단계)

- 흐름: `POST /api/seller-signup/verification`(대표자 휴대폰 본인확인 시작·첫 인증번호, 같은 접속 IP 하루(KST 자정 초기화) 10회까지 — 건당 비용, 넘으면 `429 daily_limit_exceeded`, 시작한 브라우저에만 `lo_sidv` 쿠키, 경로 `/api/seller-signup`, `attemptKey?`(클라이언트 UUID)로 다시 보내면 같은 `verificationId`·같은 쿠키 값을 주고 문자·하루 횟수를 다시 쓰지 않음 — 보내는 중이면 `409 start_in_progress`, 확인 뒤 같은 키는 `409 already_verified`, 쇼핑몰이 없는 기록이라 `(purpose, attemptKeyHash) WHERE sellerId IS NULL` 부분 유니크) → `…/verification/resend`·`…/verification/confirm`(인증번호 확인) → `POST /api/seller-signup/apply`(로그인 이메일·비밀번호는 신청자가 정함, 쇼핑몰 이름·주소 이름(slug)·사업자등록번호·상호·개업일자·통신판매업 신고번호). 응답 `{ approved, reviewReasons, resumed }`. 신청이 커밋된 뒤 응답이 끊겨 같은 브라우저(쿠키)가 같은 본인확인·이메일·비밀번호·주소 이름으로 다시 보내면 새로 만들지 않고 그 신청의 지금 상태를 `resumed: true`로 준다(본인확인 `subjectId` = 만든 대표자 계정). 하나라도 다르면 지금처럼 `400 verification_invalid`. 성공 응답은 `lo_sidv` 쿠키를 지우지 않는다(성공 응답이 잘려도 같은 쿠키로 다시 보내 같은 결과를 받게, 쿠키는 시작 때 정한 40분 뒤 사라짐). 재개 확인은 본인확인 유효 시간 검사보다 먼저 한다(이미 쓴 본인확인이면 유효 시간이 지나도 재개 결과, 새 신청은 지금처럼 거부).
- 신청을 받지 않는 경우(입력 오류로 응답): 본인인증 무효(다른 브라우저·이미 씀·30분 지남·다른 용도), 대표자 1명당 쇼핑몰 1개 위반(해지·반려 제외, `409 representative_has_shop`, 문구 「이미 운영 중인 쇼핑몰이 있어요 · 한 대표자는 쇼핑몰 하나만 열 수 있어요」, 다른 쇼핑몰 이름은 보여 주지 않음, DB 부분 유니크로도 막음), 주소 이름 형식·예약어·중복, 사업자등록번호 검증 숫자 틀림, 비밀번호 8자 미만. 이 경우 본인인증은 소진되지 않는다.
- 자동 점검(`reviewReasons`, 하나라도 걸리면 자동 승인하지 않음):
  - 국세청 「사업자등록정보 진위확인 및 상태조회」: 사업자번호·대표자명(휴대폰 본인확인으로 확인한 이름)·개업일자(신청 항목) 대조 불일치(`business_info_mismatch`), 계속사업자 아님(`business_not_active`), 조회 실패·키 없음(`business_lookup_failed`). 키 `NTS_BUSINESS_STATUS_API_KEY` 하나로 진위확인·상태조회를 함께 쓴다.
  - 같은 사업자번호로 운영 중이거나 신청 중인(해지·반려 제외) 쇼핑몰이 있음(`business_duplicate`). 번호별 advisory lock으로 동시 신청도 한 건만 자동 승인.
  - 공정위 「통신판매사업자 등록상세」 조회(기준은 조회, MASTER 결정): 신고번호 없음·형식 틀림(`mail_order_number_invalid`), 조회 실패·키 없음(`mail_order_lookup_failed`), 등록 없음·사업자번호 불일치(`mail_order_not_registered`), 영업 상태 정상 아님(`mail_order_not_active`). 키 `FTC_MAIL_ORDER_API_KEY`.
  - 하나도 없으면 같은 트랜잭션에서 자동 승인(`approvedByAdminId = null`, 체험하기 시작, 감사 로그 `seller.auto_approve`).
  - 하나라도 있으면 승인 대기(`PENDING`)로 두고 마스터 「확인 필요」(`GET /api/admin/sellers/review`)에 올린다. 대표님이 승인(`approve`, 사유 비움)·반려(`reject`, 사유 필수, `rejectedReason`·`rejectedAt` 전용 컬럼 — 정지 사유와 섞지 않음)한다. 보완 요청은 화면 단계에서.
- 마스터 관리자 파트너스(`lib/server/admin/sellers.ts`): 목록 `GET /api/admin/sellers`(MA-011, `platform.read`, q 쇼핑몰 이름·주소·status·plan, 가입 시각 내림차순 커서 limit 기본 50·최대 200)·상세 `GET /api/admin/sellers/{id}`(MA-012, 기본 정보·대표자·구독·최근 30일 주문 요약). 이용 정지 `POST …/{id}/suspend { reason }`(MA-015, `seller.moderate`, 운영 중만, 사유 1~200자 `suspendedReason`)·해제 `POST …/{id}/unsuspend`(정지만). 정지는 「신규만 막기」(대표님 결정 2026-10-04): 구매자 새 주문·가입·오버레이 공개 주소는 기존 `status = ACTIVE` 검사로 막히고, 파트너스 세션·로그인은 살리되 가드(`requireSeller`)가 이미 받은 주문 처리(`ORDER_FOLLOWUP` + `allowUnpaid`)와 내 정보·구독 조회(`allowSuspended`) 밖을 `403 seller_suspended`로 막는다(방송·오버레이·상품·설정·카드 등록·플랜 변경·해지). 구독 자동결제(`renewDueSubscriptions`)는 정지 중 건너뛰고 해제 뒤 다음 실행에서 다시 한다. 상세 열람은 로그 추적 `admin.seller.view`(대표자 이메일·사업자 정보는 전 역할 열람, 대표님 결정). 로그 추적 `admin.seller.suspend`·`unsuspend`.
- 마스터 관리자 구독·청구 조회(`lib/server/admin/billing.ts`, `platform.read`, 조회만): 구독 현황 `GET /api/admin/subscriptions`(MA-023, 승인된 파트너스마다 이용 상태 `access` = `sellerAccess`와 같은 판정을 SQL로 · access·plan·q 필터 · 상태별 `counts` · 가입 시각 커서), 청구·결제 내역 `GET /api/admin/payments`(MA-024, status·kind·sellerId·from·to KST 날짜 · 청구 시각 커서), 청구 상세 `GET /api/admin/payments/{id}`(MA-025, 결제사 결제 번호·카드 매출전표 주소).
- 마스터 관리자 결제 조회(MASTER 배정 2026-10-05, `lib/server/payments/adminStatus.ts`, `platform.read`·모든 마스터 역할, 조회만, 키 값·비밀정보 없음): PG 연결 상태 `GET /api/admin/pg-status?q&cursor&limit`(MA-031) = `gateway { provider: "nicepay", configured(키 설정 여부만), mode: "sandbox", lastSuccessAt, lastFailureAt, lastFailureCode, lastFailureMessage }` + 주문 결제가 있는 파트너스별 `{ seller, lastSuccessAt, lastFailureAt, lastFailureCode, lastFailureMessage, failures24h, cancelsPending, cancelsFailed }`(최근 실패 먼저, 결제는 플랫폼 키 하나라 파트너스가 PG를 따로 연결하지 않음). 실패 문구는 서버가 준다(`paymentFailureMessage`: 우리 코드와 나이스페이 결과 코드(공식 매뉴얼 code.md) 대응, 한도 초과·정지 카드는 나이스페이가 3095 「카드사 실패 응답」으로 묶어 주므로 따로 나누지 않음, 모르는 코드는 일반 문구). 구독료 수납 현황 `GET /api/admin/subscription-billing?from&to`(MA-032, KST 날짜·청구 시각·끝 날짜 포함·최대 366일·기본 오늘) = `summary { charged, paid, failed, pending, paidAmount, failedAmount, retrying, pastDue, grace }` + 날짜별 `daily`. 목록은 MA-024 `GET /api/admin/payments`, 연체·유예 파트너스는 MA-023 `?access=`를 쓴다.
- 마스터 관리자 통합 대시보드 `GET /api/admin/dashboard`(MA-001, `lib/server/admin/dashboard.ts`, `platform.read`, 조회만·no-store): 상태별 파트너스 수, 방송 중(LIVE) 수, 오늘(KST 0시부터) 주문 수·결제 수·결제 금액(환불액 뺌), 이용 상태별 수(구독 현황과 같은 `subscriptionAccessCounts`)와 연체(`grace`) 수. 개인정보 없음.
- 마스터 관리자 계정·권한·로그 추적: 계정 목록·추가 `GET·POST /api/admin/admins`(MA-061·062)·수정 `PATCH /api/admin/admins/{id}`(이름·역할·상태, 정지하면 세션 종료. 최고관리자는 한 명·시드로만 만들고 누구도 정지·역할 변경 불가 — 409 `super_admin_protected`, 이름만 변경. 최고관리자 역할 부여는 400 `super_admin_not_assignable`, 대표님 지시 2026-10-04)·역할별 권한 표 `GET /api/admin/permissions`(MA-063, `permissions.ts`가 정본)는 `admin.manage`(최고관리자)만(`lib/server/admin/accounts.ts`). 로그 추적 `GET /api/admin/audit-logs`(MA-070, action 정확·「.」접두어·actorType·actorId·sellerId·targetId·KST 날짜·커서, 목록엔 before·after 없음)·`GET /api/admin/audit-logs/{id}`(MA-071, before·after·관리자 행위자 이름)는 `audit.read`(CS 제외, `lib/server/admin/auditLogs.ts`). 계정 변경은 로그 추적 `admin.account.create`·`update`(비밀번호 없음).
- 신청 때 쇼핑몰·대표자 계정(본인확인 이름)·기본 등급 5개를 만든다. 사업자 정보는 `Seller.businessInfo`(사업자등록번호·상호·대표자명·개업일자·통신판매업 신고번호·국세청·공정위 조회 결과·점검 시각)에 둔다.
- 국세청·공정위 조회는 공급자 인터페이스(`lib/server/sellers/businessCheck.ts`)로만 부른다. `BUSINESS_STATUS_PROVIDER=fake`·`MAIL_ORDER_PROVIDER=fake`를 명시했을 때만 가짜(운영 불가). 그 밖에는 실제 조회 자리이며, 실제 연동 전이거나 키가 없으면 조회 실패로 처리해 자동 승인하지 않는다. 환경변수 이름은 `.env.example`.

### 4.9 이번 초안에서 뺀 것 (다음 단계)

PG 연결 정보, 구매자 문의·공지, 알림 발송 기록, 도우미 자료, 오버레이 편집 설정, 구매 랭킹. 모두 `sellerId` 범위 규칙을 그대로 따른다.

아래는 스키마를 다시 만들지 않도록 자리만 정해 둔다(이번에 테이블은 만들지 않음, 모두 추가 테이블·추가 컬럼으로 붙인다).

- 현금영수증·세금계산서(SA-024, `lib/server/receipts/service.ts`): 주문별 신청(`OrderReceiptRequest`: 종류 `CASH_RECEIPT_INCOME | CASH_RECEIPT_EXPENSE | TAX_INVOICE`, 번호는 AES-256-GCM 봉인·뒤 4자리만 노출, 세금계산서 사업자 정보, 철회 시각, 주문당 철회 안 한 신청 1건)과 발행 이력(`ReceiptIssue`: 상태 `PENDING | ISSUED | FAILED | CANCELLED`, 금액, 시도 횟수, 실패 코드, 업체 문서 번호). 무통장·계좌이체 주문(입금 전·결제 완료)만 신청하고 카드는 매출전표로 대신한다. 구매자 `GET·POST /api/shop/[slug]/receipt-requests`(`?orderId`)·`POST …/[id]/withdraw`(발행 전만), 파트너스(RECEIPT_TAX) `GET /api/seller/receipt-requests`·`POST …/[id]/retry`(실패 → 대기). 발행은 파트너스(판매자) 명의로 외부 발행 업체를 통해 한다(대표님 결정 2026-10-05, 플랫폼 명의 나이스페이 현금영수증은 쓰지 않음). 발행자 정보 `SellerReceiptIssuer`(사업자번호·상호·대표자, 인증서 등록 상태 `NOT_REGISTERED | REGISTERED | EXPIRED`, 인증서는 업체 쪽에 등록하고 서버에 저장하지 않음, 사업자번호가 바뀌면 미등록으로 되돌림)는 `GET·PUT /api/seller/receipt-issuer`(RECEIPT_TAX). 업체 연동 인터페이스는 `lib/server/receipts/provider.ts`(`ReceiptProvider`, `processReceiptIssue`: 업체 없음·발행자 미준비면 대기 유지, 시도 횟수를 조건부로 올려 한 번만 호출, 발행 id를 멱등 키로 전달)이고 **구현체는 아직 없다**(업체 계약·요금 확인은 대표님 조치). 환불 때 발행 취소와 충전금 차감·보류 전환도 연동 뒤에 붙인다.
- 배송: 즉시 발송은 4.10에서 만들었다. 보관(`STORAGE`)·합배송은 출시 후 1차.
- 무통장 입금: 4.11에서 만들었다.
- 법정 동의 기록: 회원 가입 시 약관·처리방침 버전과 마케팅 동의 시각·철회 시각(`MemberConsent`). 주문 단위 「개봉하면 취소·환불 불가」 결제 전 동의를 기록한다(`OrderConsent`: 주문, 동의 시각, 고지 문구 버전. 대표님 결정 2026-10-02, 개봉 전 취소 규칙은 그대로). 구매자 「내 차례 N건 전」 알림도 두지 않는다(주문·결제·발송 알림만).
- 미성년자 정책: `Seller` 설정 `minorPurchasePolicy`(`BLOCK | NOTICE`), `BuyerMember.birthDate`(휴대폰 본인확인)로 판정.
- 판매자 직원 개인정보 접속기록: 기존 `AuditLog`를 확장해 기록하고 1년 보관.
- 보존 기간: 거래기록(주문·결제·원장)은 5년 보존, 탈퇴 회원 개인정보는 탈퇴 시 비식별(4.3)하고 거래기록과 분리해 파기 일정 적용.
- 1인 구매 수량 제한(상품·옵션별), 상품 카테고리, 구매 제한 회원.

### 4.10 배송(즉시 발송, PRODUCT_SCOPE MVP)

- `Order.fulfillmentType`(`IMMEDIATE | STORAGE`, 지금은 `IMMEDIATE`만), `Order.shippingFee`(주문 때 계산한 배송비, `totalAmount`에 포함).
- `SellerShippingPolicy`(판매자당 1개, 없으면 기본값): freeShipping(무료 0원 유형, 기본 꺼짐, 대표님 결정 2026-10-03), baseFee(기본 3,000원), freeOverAmount(상품 합계가 이 금액 이상이면 기본 배송비 0원, null이면 무료 배송 없음), remoteSurcharge(도서산간 추가비, 기본 3,000원, 무료 배송이어도 붙음), remoteZipRanges(우편번호 범위, 기본 제주 63000~63644·울릉 40200~40240).
  - 도서산간 판정: 우편번호가 범위에 들거나, NFKC로 정규화하고 공백을 모두 지운 주소에 제주특별자치도·제주도·제주시·서귀포시·울릉군·울릉도가 들어 있으면 도서산간(붙여 쓴 「경상북도울릉군」도 잡힘). 둘 중 하나라도 맞으면 추가비를 붙인다(구매자가 보낸 우편번호만 믿지 않음). 영문은 Jeju·Seogwipo·Ulleung(-do·-si·-gun) 토큰이 어디에 있든 본다. 「제주로」·「울릉길」 같은 도로명은 해당하지 않고, 「제주도로」처럼 잘못 잡히는 경우는 추가비가 붙는 쪽이라 허용한다.
  - `GET·PUT /api/seller/shipping-policy`(`SHOP_SETTINGS`). 반품 배송비(`returnFee`, 편도, 기본 3,000원)·교환 배송비(`exchangeFee`, 왕복, 기본 6,000원)도 여기서 정한다(빼고 보내면 지금 값 유지). 금액은 0~100,000원 정수, 무료 기준은 1~1억 원, 범위는 50개까지. 틀리면 `400 invalid_shipping_policy`. 변경은 감사 로그.
  - 배송비 = (무료 배송 유형이거나 무료 기준 이상이면 0, 아니면 baseFee) + (도서산간이면 remoteSurcharge, 무료여도 붙음). 바꾼 설정은 다음 주문부터(이미 만든 주문은 그대로).
- 판매자 주문 목록 `GET /api/seller/orders`(`ORDER_SHIPPING`, 잠금 중에도 가능, `lib/server/orders/read.ts` `listSellerOrders`): 주문 시각·id 내림차순 커서 페이지(limit 기본 50·최대 200, 인덱스 `(sellerId, createdAt DESC, id DESC)`). status(여러 개)·from·to(KST 날짜)·q(주문번호 전체 일치·방송 닉네임, 받는 분 이름은 `CUSTOMER_PII_VIEW`가 있을 때만, 그때는 `customer.pii.view` 기록에 검색어 없이 주문 id·건수) 필터. 행: id·orderNo·status·createdAt·paidAt·buyer{id, broadcastNickname}·totalAmount·itemSummary{firstProductName, otherCount}·shipped·refundable(`PAID`), 응답 `{ orders, nextCursor }`.
- 파트너스 배송 처리 `GET /api/seller/shipments`(`ORDER_SHIPPING`, 잠금 중에도 가능, `lib/server/orders/shipments.ts`): tab `ready`(발송할 수 있는 주문: 결제 완료·즉시 발송·재고 차감됨·배송지 있음·발송 전, `shipOrder` 조건과 같음)·`in_transit`(결제 완료·배송 중)·`delivered`(배송 완료), from·to(KST 날짜, 기준은 탭마다 다름: 발송 대기 = 주문 시각, 배송 중 = 발송 시각, 배송 완료 = 배송 완료 시각, 응답 `dateBasis`)·q(주문번호·방송 닉네임·송장번호, 받는 분 이름은 `CUSTOMER_PII_VIEW`일 때만), 탭의 기준 시각(발송 대기 = 주문 시각, 배송 중 = 발송 시각, 배송 완료 = 배송 완료 시각)·주문 id 내림차순 커서(limit 기본 50·최대 200), 시작일이 종료일보다 늦거나 기간이 366일을 넘으면 `400 bad_request`. 행: orderId·orderNo·status·createdAt·paidAt·buyer·itemSummary·shipment{courier, trackingNumber, status, shippedAt, deliveredAt}|null·shippingAddress(개인정보 권한이 없으면 `{ isRemote }`만, 넣었거나 받는 분 이름으로 찾았으면(0건 포함) `customer.pii.view`에 주문 id·건수), 응답 `{ dateBasis, shipments, nextCursor }`. 송장 입력·일괄 입력 `POST /api/seller/shipments { items: [{ orderId, courier, trackingNumber }] }`, 배송 완료 `POST /api/seller/shipments/deliver { orderIds }`(각 1~100건, 같은 주문 중복·형식 오류는 `400 bad_request`): 상태 전이는 새로 만들지 않고 주문마다 `shipOrder`·`completeDelivery`를 따로 불러 결과 `{ results: [{ orderId, ok, … | error, message }] }`를 준다(한 건 실패가 나머지를 막지 않음). 송장 입력 결과의 성공 줄에는 `mode`(`shipped` 처음 발송 · `updated` 배송 중이던 송장 바꿈)와 `previous`(바꾸기 전 `{ courier, trackingNumber }`, 처음이면 null)를 넣는다.
- 파트너스 회원 목록 `GET /api/seller/members`·상세 `GET /api/seller/members/{id}`(`MEMBER_POINTS`, 잠금 중에도 가능, `lib/server/buyers/sellerMembers.ts`): 탈퇴(`deletedAt`, 분리 보관) 회원은 목록·상세에서 없는 회원(404). 가입 시각·id 내림차순 커서 페이지(limit 기본 50·최대 200, 인덱스 `(sellerId, createdAt)`). gradeId·status(`ACTIVE`·`DORMANT`)·q(방송 닉네임, 이름·휴대폰 끝 4자리는 `CUSTOMER_PII_VIEW`가 있을 때만) 필터. 행: id·broadcastNickname·(name·phone: 개인정보 권한)·grade{id, displayName}·status·marketingConsent·createdAt·lastLoginAt, 응답 `{ members, nextCursor }`. 상세는 행 + orderCount·totalPaid(결제된 주문 금액 − 환불액, 법정 보관 주문 제외)·rewardBalance, 응답 `{ member }`. 이름·휴대폰을 응답에 넣으면 `customer.pii.view`(목록은 회원 id·건수만, 검색어는 남기지 않음).
- `OrderShippingAddress`(주문당 1개, 스냅숏): 받는 분, 연락처(숫자만), 우편번호, 주소, 상세 주소, 메모, 도서산간 여부. 값은 NFKC로 정규화해 저장한다(전각 공백·NBSP는 일반 공백). 제어(Cc)·서식(Cf: 방향 바꿈·폭 없는 공백 등)·짝 없는 서로게이트(Cs)·사용자 정의(Co)·미할당(Cn)·줄·문단 구분(Zl·Zp) 문자가 든 값, 받는 분·주소의 한글 채움 문자(U+115F·U+1160·U+3164·U+FFA0)·점자 빈칸(U+2800), 눈에 보이는 글자가 없는 받는 분·주소는 `400 invalid_shipping_address`(`lib/server/text/clean.ts`, 상품과 같은 규칙). 메모만 이모지용 ZWJ·변형 선택자를 허용하고, 태그 문자는 깃발 시퀀스(U+1F3F4 + 태그 + U+E007F) 안에서만 허용하며, 비문자(U+FDD0–FDEF, 각 평면의 xFFFE·xFFFF)는 거부한다. 또 서버가 모르는 최신 이모지로 주문이 막히지 않게 미할당(Cn) 검사를 하지 않는다. 연락처·우편번호도 NFKC 정규화 뒤 검사한다(전각 숫자 허용). 판매자 주문 조회에서는 `CUSTOMER_PII_VIEW`가 있을 때만 주소를 주고(열람 기록), 없으면 도서산간 여부만 준다.
- `Shipment`(주문당 1개): 택배사 코드(`CJ | HANJIN | LOTTE | LOGEN | EPOST`), 송장번호(영문·숫자 8~30자, 하이픈·공백 제거), 상태, 발송 시각(DB 시계), 배송 완료 시각.
  - `POST /api/seller/orders/{orderId}/ship`(`ORDER_SHIPPING`, 잠금 중에도 가능): 결제 완료(`PAID`) 즉시 발송 주문만 `IN_TRANSIT`로 만든다. 재고 부족(`stockShortageAt`) 주문, 배송지가 없는 주문도 `409 not_shippable`. 배송 중에는 송장을 고쳐 다시 넣을 수 있고(첫 발송 시각 유지, `order.shipment.update` 기록), 배송 완료 뒤에는 바꾸지 않는다. 주문 상태는 `PAID` 그대로.
  - 발송한(Shipment가 있는) 주문을 환불하면 재고를 되돌리지 않고 배송 기록도 그대로 둔다. 감사 로그 `order.refund`에 `shippedBeforeRefund: true`와 배송 상태를 남긴다. 배송비 환불 금액 규칙은 대표님 결정 대기(지금은 주문 전체 금액 기준 그대로).
  - 배송 완료 `POST /api/seller/orders/{orderId}/deliver`(`ORDER_SHIPPING`, 잠금 중에도 가능): 결제 완료·배송 중(`IN_TRANSIT`)인 주문만 `DELIVERED`·`deliveredAt`(DB 시계)로 바꾸고 아직 없으면 `EARN`을 기록한다. 아니면 `409 not_deliverable`. 주문 행을 잠가 발송·환불과 겹치지 않는다. 감사 로그 `order.deliver`.
  - 자동 처리(`lib/server/orders/delivery.ts`, 정기 실행 연결은 인프라 승인 대기): `autoCompleteDeliveries`는 발송 뒤 `autoDeliverDays`가 지난 배송 중 주문을 배송 완료(`order.auto_deliver`), `autoConfirmPurchases`는 배송 완료 뒤 `autoConfirmDays`가 지난 결제 완료 주문에 `Order.purchaseConfirmedAt`을 남긴다(`order.purchase_confirmed`, 판매자가 확정을 취소한 주문은 배송 완료 대신 취소한 시각 `purchaseUnconfirmedAt`부터 기간을 센다). 주문 상태는 `PAID` 그대로. 멱등이고 한 건 실패해도 나머지는 계속한다(`*_failed` 감사 로그). 후보를 오래된 순(시각, 주문 id) keyset으로 이어 가져와, 실패하거나 그사이 조건이 바뀐 주문은 건너뛰고 처리 건수가 한도(기본 100)에 찰 때까지 다음 후보로 넘어간다(한 번에 한도 × 10건까지 살핀다). 주문마다 트랜잭션 안에서 주문을 잠그고 상태·판매자 설정(켜짐·기간)을 DB 시계로 다시 확인한다.
  - 배송 추적·발송 알림은 아직 없다.

### 4.11 입금 기한·미입금 자동 취소·구매 제한 (PRODUCT_SCOPE 「무통장 입금·구매 제한 기본값」, MASTER 결정)

- `SellerOrderPolicy`(판매자당 1행, 없으면 기본값): autoCancelEnabled(미입금 자동 취소 사용, 기본 켜짐), paymentDueHours(기본 24시간, 1~720시간=30일, 대표님 결정 2026-10-03. 이미 저장된 판매자 설정값은 바꾸지 않음), unpaidRestrictionEnabled(기본 켜짐), paidCancelRestrictionEnabled(기본 꺼짐, PUT에서 빼면 지금 값 유지). `GET·PUT /api/seller/order-policy`(`SHOP_SETTINGS`, 틀리면 `400 invalid_order_policy`, 감사 로그).
  - 자동 배송 완료 `autoDeliverEnabled`·`autoDeliverDays`, 자동 구매 확정 `autoConfirmEnabled`·`autoConfirmDays`(기본 사용·7일, 1~30일). `PUT /api/seller/order-policy`에서 빼고 보내면 지금 값 유지.
- 주문할 때 `Order.paymentDueAt` = 주문 시각 + paymentDueHours. 주문 시각은 판매자 주문 잠금을 잡은 뒤의 `clock_timestamp()`(트랜잭션 시작 시각인 `now()`가 아님). 설정을 바꿔도 이미 만든 주문은 그대로. 이 기능 전에 만든 결제 대기 주문은 마이그레이션(#82)에서 주문 시각 + 10일로 채웠다(당시 기본값, 운영 데이터 없음). 자동 취소를 끈 쇼핑몰의 새 주문은 기한이 없다(이미 기한이 붙은 주문은 그대로 자동 취소 대상). PG 연동 뒤에도 카드 주문에 기한을 그대로 둔다(결제하지 않은 카드 주문이 주문 때 차감한 재고를 계속 잡지 않게, 기반-결제 2단계 판단 — MASTER 확인 대기). 승인 중에 기한이 지나 취소되면 카드 결제는 전액 취소된다.
- 자동 취소 `cancelOverdueOrders`(lib/server/orders/overdue.ts): 기한이 지난 결제 대기 주문을 판매자별 주문 잠금(order_no) 아래에서 `status = PENDING_PAYMENT` 조건으로 취소하고 `autoCancelledAt`, 시스템 상태 이력(reason `payment_overdue`), 감사 로그 `order.auto_cancel`을 남긴다. 재고는 결제 때 빼므로 되돌릴 것이 없다. 여러 번·동시에 돌려도 주문마다 한 번만 취소(멱등). 주문마다 따로 처리해 한 건이 실패해도 나머지는 계속하고, 실패한 건은 감사 로그 `order.auto_cancel_failed`를 남긴 뒤 다음 실행에서 다시 시도한다(결과의 `failed`). 정기 실행 연결은 인프라 승인 대기.
  - 결제 확인(`markOrderPaid`)도 `status = PENDING_PAYMENT` 조건으로 바꿔, 자동 취소와 겹치면 둘 중 하나만 된다.
- 미입금 알림 대상 `listPaymentDueSoon`(대표님 결정 2026-10-03): 알림 시각이 지났고 기한 전인 결제 대기 주문. 알림 시각은 기한 하루 전, 입금 기간(기한 − 주문 시각)이 하루 이하면 1시간 전. 발송 연동 전이라 대상 조회만.
  - 「보냈음」 기록 `OrderNotification`(주문·종류마다 1행, `(orderId, kind)` 유니크, 상태 `PENDING|SENT|FAILED`, 시도 횟수, `lib/server/orders/notifications.ts`): 발송하는 쪽은 `claimPaymentDueSoon`으로 같은 대상 조건의 주문을 먼저 잡고(없으면 넣고 이미 있으면 건너뜀, 동시에 돌려도 한 번만), 보낸 뒤 `markNotificationSent`·`markNotificationFailed`로 결과를 남긴다. 실패했거나 PENDING으로 10분 넘게 멈춘 기록은 시도 3번까지 다시 잡고, SENT는 다시 잡지 않는다. 그사이 입금·취소·기한 지난 주문은 잡지 않는다. 실제 발송(알림톡·문자) 연동과 정기 실행은 아직 없다.
  - 미완료(MASTER 결정 2026-10-04): 광고성 메시지(방송 시작·할인 알림 등)의 야간 발송 제한(21시~다음 날 8시 KST에 보내지 않거나 8시 이후로 미룸, PRODUCT_SCOPE 「야간 광고」)은 첫 광고 발송 기능(방송 시작 알림)을 만들 때 그 발송 경로에 함께 넣는다. 지금은 광고성 메시지를 보내는 경로가 없다.
  - 발송 연동 계약: 이 기록만으로는 공급자 쪽 중복 발송(보냈는데 응답 전에 멈춤)을 다 막지 못한다. 발송 연동은 `claimPaymentDueSoon`이 돌려주는 `idempotencyKey`(= 알림 id, 다시 잡아도 고정)를 공급자 멱등키로 보내야 한다. 멱등키를 지원하지 않는 공급자면 보냈는지 알 수 없는 실패(타임아웃 등)는 `FAILED`가 아니라 확인 필요로 남겨 자동 재시도하지 않는다.
- 자동 구매 제한 `BuyerPurchaseRestriction`: 같은 쇼핑몰에서 기준 시각 뒤 자동 취소가 3회 쌓이면 30일 제한을 만든다(감사 로그 `buyer.purchase_restriction.create`). 기준 시각은 마지막 제한(풀었으면 푼 시각, 아니면 시작 시각)과 자동 제한을 다시 켠 시각(`SellerOrderPolicy.unpaidRestrictionEnabledAt`) 중 늦은 쪽이다. 끄더라도 이미 걸린 제한은 그대로 두고 판매자가 직접 푼다(MASTER 결정). 걸려 있는 제한 = 풀지 않았고 끝나는 시각 전(시작 시각은 보지 않음). 제한 중 새 주문은 `403 purchase_restricted`와 `endsAt`, 풀리는 KST 날짜·시각 안내(「11월 2일 오후 3시부터 다시 주문할 수 있어요」, 초가 있으면 분을 올림해 실제보다 이르게 안내하지 않음). 판매자 목록 `GET /api/seller/purchase-restrictions`, 풀기 `POST /api/seller/purchase-restrictions/{buyerMemberId}/lift`(`MEMBER_POINTS`, 잠금 중에도 가능, 감사 로그, 사유는 200자 이하·글자 검사를 통과해야 하며 아니면 `400 invalid_reason`). 「결제 후 취소 5회 → 30일」(기본 꺼짐, `paidCancelRestrictionEnabled`): 구매자 사정(`refundFault=BUYER`)으로 표시한 환불이 기준 시각 뒤 5회(판매자 사정·미지정은 세지 않음, MASTER 결정. 발송 전 환불도 `fault`를 골라 보낼 수 있음) 쌓이면 30일 제한(`reason=PAID_CANCEL`)을 만든다. 환불 처리(`refundOrder`) 트랜잭션에서 주문 생성과 같은 잠금 아래 센다. 기준 시각은 마지막 제한(사유 무관)과 이 설정을 켠 시각(`paidCancelRestrictionEnabledAt`) 중 늦은 쪽이라 켜기 전 환불은 세지 않는다. 끄더라도 이미 걸린 제한은 그대로 둔다. 다른 제한이 걸려 있어도 기준에 닿으면 새 제한을 만들고(앞 제한이 먼저 끝나도 막힘, 미입금 제한도 같음), 풀기는 걸려 있는 제한을 모두 푼다. 횟수의 기준·사건이 되는 시각(환불·미입금 자동 취소·제한 시작·제한 풀기·설정 켜기)은 모두 판매자별 단조 시계 `sellerEventClock`으로 찍는다: 주문 생성 잠금 아래에서 max(DB 시계, 마지막으로 찍은 시각 + 1ms)를 찍고 `SellerOrderPolicy.lastEventClockAt`에 남긴다. 그래서 같은 판매자 안에서는 찍은 순서가 곧 시각 순서이고, 같은 밀리초라도 「기준 뒤(>)」 비교가 뒤집히지 않는다.
- 주문 생성 횟수 제한: 같은 구매자는 쇼핑몰당 1분에 10건까지(`429 order_rate_limited`). 구매 제한·횟수 제한은 주문 생성과 같은 잠금 아래에서 세므로 동시 주문에도 넘지 않는다.
- 구매자 주문 조회 응답은 `Cache-Control: no-store`. 재고 부족으로 환불 대상인 결제 주문은 `needsRefund: true`와 안내 문구(`ORDER_NOTICES`)만 주고 `stockShortageAt`은 숨긴다. 입금 기한(`paymentDueAt`)도 준다. 폐업한 쇼핑몰이어도 본인 주문 조회는 열린다.

## 5. 주요 흐름 요약

- **로그인**: 해시 검증 → 세션 생성 → 토큰 쿠키. 정지된 판매자의 직원은 로그인 거부.
- **요청 처리**: 쿠키 → 영역별 세션 조회(만료·폐기·주체 정지 확인) → 권한 가드 → `TenantContext` 생성 → 도메인 함수 → 감사 로그 → NOTIFY.
- **결제 완료(카드 승인·무통장 입금 확인이 부르는 `markOrderPaid`)**: 주문 PAID → 전 품목 재고 차감(한 트랜잭션)
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
  - `GET /api/overlay/{token}/state` → `{ version, live, shop: { name, url(공개 쇼핑몰 주소, 요청 주소를 모르면 null) }, opening, waiting, hits(명예의 전당: 지금 방송 HIT 카드 최근 등록 순 10건), orderEvents }`. `orderEvents`는 신규 주문 알림용이다. 방송 중, 방송 시작 뒤 최근 30초에 들어온 주문(취소 제외)을 최근 순으로 10건까지 준다. 주문당 한 건 `{ id(첫 주문대기 항목 id, 주문 id는 안 보냄), kind: FIRST|REPEAT|VIP, nickname, productLabel(첫 품목), quantity(합), moreItems, occurredAt }`. kind는 구매자 등급이 기본 VIP 등급이면 VIP, 이 쇼핑몰에서 더 먼저 결제한 주문이 있으면 REPEAT, 아니면 FIRST다. stream은 지금처럼 version만 보내고, 화면은 version이 바뀌면 state를 다시 받는다(새 주문도 version을 올린다).
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
- 앱 감시 훅(ONQ 단계 6 서버 몫, PR #159 요청, `lib/server/ops/metrics.ts`). 감시는 앱과 같이 죽지 않게 앱 밖 수집기(`scripts/ops/monitor.mjs`)가 하고, 앱은 값만 남긴다.
  - `OpsInstance`(name 기본키, generation, retiredAt, registeredAt)·`OpsHeartbeat`(instance·generation·job 기본키, lastRunAt·lastStatus `done|skipped|failed`·lastError·lastOkAt): 인스턴스 상태의 유일한 기준은 `OpsInstance`다. 프로세스가 시작할 때 `registerInstance`가 그 이름의 행을 잠그고(없으면 만듦) 새 세대 값(uuid)을 쓰며 종료 표시를 비운다(성공할 때까지 5초 간격 재시도, 등록 전에는 정기 실행·heartbeat를 시작하지 않음, 등록 중에 종료 신호가 오면 끝난 뒤 시작하지 않고 새 세대로 바로 종료 표시). 정기 실행(`jobs/scheduler.ts`)은 돌 때마다 작업별 결과와 루프 자체(`scheduler.tick`)를 (인스턴스, 세대, 작업)별로 남기는데, 같은 트랜잭션에서 `OpsInstance`를 FOR SHARE로 읽어 내 세대가 지금 세대일 때만 쓴다(등록과 직렬화). `skipped`는 마지막 실행 시각만 바꾼다. 지표는 인스턴스의 지금 세대 행만 보므로 이전 세대의 늦은 기록·배포로 사라진 작업의 행은 자동으로 빠진다. 종료는 명시 신호로만 본다: SIGTERM·SIGINT를 받으면 새 실행·heartbeat를 막고 진행 중인 실행·등록을 최대 2초 기다린 뒤 `WHERE generation = 내 세대`로만 `retiredAt`을 남긴다(이전 프로세스는 후속 프로세스를 종료 처리하지 못함). 표시가 있는 인스턴스는 지표에서 `retiredHeartbeats`, 없는 인스턴스는 오래돼도 `heartbeats`에 남아 멈춤으로 보인다. 정기 실행 `ops_heartbeat.purge_retired`가 지금 세대가 아닌 행과 표시 뒤 7일 지난 인스턴스·행을 지운다. 인스턴스 이름은 `OPS_INSTANCE_NAME` 또는 호스트 이름. 멈춤 판단은 수집기 몫이다(인프라 세션).
  - `GET /api/admin/ops/metrics`(최고관리자만, `system.manage`): DB `SELECT 1` 지연, 이 DB의 연결 수(활성·유휴·트랜잭션 중 유휴·잠금 대기, max_connections — 풀 사용량을 DB 쪽에서 본 값), heartbeat(`OpsInstance` 기준, 등록했지만 heartbeat가 없는 인스턴스도 `job: null`·`lastStatus: "no_signal"`·`registeredAt`으로 내보내 감시가 경과 시간으로 판단), 작업 큐 적체(`not_measured`, 자동연결 큐가 생기면 넣음), 인프라 사건(열린 사건 = 수집기(source)·key별로 서버가 마지막에 받은(`OpsEvent.seq`) 것이 incident_open, 결과에 source 포함, occurredAt은 표시용, 최근 받은 50개). 공개 `/api/health`에는 넣지 않는다.
  - `OpsEvent`(source·eventId 유니크, kind `incident_open|incident_close|info|warning`, key, severity `info|warning|critical`, message, detail, occurredAt): 수집기가 `POST /api/internal/ops/events`로 쓴다. 인증은 `Authorization: Bearer <OPS_INGEST_TOKEN>`(서버 환경변수, 32자 이상, 없으면 503으로 꺼짐, 틀리면 401, 해시 비교). 브라우저용이 아니라 Origin 검사 대신 토큰을 쓴다. 한 번에 1~50건, 하나라도 틀리거나 occurredAt이 받은 시각보다 5분 넘게 미래면 전체 400, 같은 (source, eventId) 재전송은 건너뛴다. 수집기 전용 DB 계정으로 직접 쓰는 방식은 계정·권한 관리가 늘어 택하지 않았다. 보존: 받은 지 30일(`OPS_EVENT_RETENTION_DAYS`) 지난 사건은 정기 실행 `ops_event.purge_old`가 한 번에 1000건씩 지운다(한 실행에 한 묶음만, 작업 트랜잭션 60초 안에서 끝나게, 밀린 양은 다음 회차가 이어서). (source, key)별 마지막 열림·닫힘은 열린 사건 계산에 필요해 남긴다.

## 9. 확정 결과 (2026-10-02 21:50 KST)

| 번호 | 항목 | 확정 | 결정 |
|---|---|---|---|
| 1 | 운영·CS 세부 권한 경계 | 3.2 표 | MASTER |
| 2 | 판매자 직원 권한 | 고정 역할 대신 권한 항목 10개(3.3, 대표님 결정 2026-10-02로 변경) | 대표님 |
| 3 | 직원이 여러 판매자 소속일 때 | 판매자별 별도 계정 | MASTER |
| 4 | 구매자 로그인 수단 | 아이디+비밀번호, 가입 시 휴대폰 본인확인 필수(2026-10-02 대표님 지시로 변경, 2026-10-03 문자 방식) | MASTER |
| 5 | 재고 차감 시점 | 결제 완료 시. 재고 부족한 늦은 결제는 취소·환불 대상 표시 | 대표님 |
| 6 | 부분 취소·환불 | 이번 단계 미지원 | MASTER |
| 7 | 주문대기 단위 | 주문 품목 1개 = 대기 1건, 수량 표시 | 대표님 |
| 8 | 개봉 완료 되돌리기 | 완료 10초 안, 다른 개봉 중 없을 때만 허용. 기록 필수 | 대표님 |
| 9 | 방송 전 주문 편입 | 방송 시작 시 자동 편입 | 대표님 |
| 10 | RLS 적용 | 이번 단계 미적용, 운영 전 재검토 | MASTER |
| 11 | 회원 등급 | 판매자별 테이블, id로 식별, 기본 5개는 systemKey 표시 | MASTER |

디자인 맞춤 수정(MASTER 검수): 세션 시간(AU-007), 등급 식별 방식. 로그인 실패 잠금은 없음(대표님 결정 2026-10-02, 실패는 감사 로그에 기록).

남은 미정은 8절 [비용] 항목뿐이다.
