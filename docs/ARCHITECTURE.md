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
5. **마스터 대리 조회**는 읽기 전용 컨텍스트(`{ sellerId, readOnly: true, actor: admin }`)로 판매자 조회 함수를 재사용하고, 변경 함수는 `readOnly`면 거부한다. 진입 시 사유와 함께 감사 로그.
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
- 결제 때 차감의 동시 결제: 재고가 모자라면 늦게 결제된 주문은 `PAID`로 기록하되 `stockShortageAt`을 남겨 「취소·환불 대상」으로 표시하고, 주문대기는 만들지 않는다. 실제 PG 환불 연동은 다음 단계.

### 4.5 주문·주문 품목

- `Order`: id, sellerId, orderNo(판매자별 표시 번호, **(sellerId, orderNo) 유니크**), buyerMemberId, status(`PENDING_PAYMENT | PAID | CANCELLED | REFUNDED`), broadcastNicknameSnapshot, totalAmount, rewardUsedAmount, paymentMethod(`CARD | BANK_TRANSFER | …`), pgProvider, pgTxId, paidAt, stockShortageAt(재고 부족 표시), cancelledAt, refundedAt, createdAt
  - `totalAmount`: 구매자가 실제로 결제한 금액(적립금 사용액을 **뺀 뒤**, 배송비가 생기면 포함). `rewardUsedAmount`: 이 주문에 쓴 적립금.
  - 적립 기준액은 `totalAmount`를 쓰지 않고 「할인 후 상품 금액(주문 품목 단가 × 수량 합)」으로 계산한다. 배송비는 빼고, 적립금으로 낸 금액은 빼지 않는다(대표님 결정 2026-10-03).
- `OrderItem`: id, sellerId, orderId, productId, optionId, productNameSnapshot, optionNameSnapshot, unitPrice, quantity
- `OrderConsent`: id, sellerId, orderId, kind(`OPENED_NO_REFUND`), noticeVersion, agreedAt(DB 시계) — **(orderId, kind) 유니크**. 결제 전 개봉 고지 동의 기록(대표님 결정 2026-10-02, 문구 v2 「개봉하면 단순 변심으로는 취소·환불이 안 돼요. 상품이 설명과 다르거나 잘못 왔으면 환불받을 수 있어요」 2026-10-03 확정).
- 주문 생성(`POST /api/shop/{slug}/orders`, 구매자 세션, 결제 대기까지 — 실제 PG 결제 호출 없음):
  - 동의 필수: `consent.agreed === true`(체크 기본 해제)와 화면이 보여 준 문구 버전(`noticeVersion`)이 지금 버전과 같아야 한다. 아니면 `400 consent_required`·`consent_outdated`, 주문을 만들지 않는다. 동의는 주문과 같은 트랜잭션에 기록.
  - 잠긴 판매자(체험하기·구독 끝)는 `402 shop_unavailable`, 문구 「지금은 쇼핑몰을 이용할 수 없어요」(판매자 사정은 드러내지 않음).
  - 금액은 서버가 계산(단가 = 상품 가격 + 옵션 추가금, 합계 = 단가 × 수량). 본문의 금액·상태 값은 쓰지 않는다. 적립금 사용은 방식이 정해지기 전이라 요청이 오면 `400 reward_use_not_supported`(rewardUsedAmount = 0).
  - 재고는 주문 수량만큼 있는지 확인하고, 주문 때 차감 상품은 이때 뺀다(4.4). 부족하면 `400 out_of_stock`.
  - 단가가 1원 미만(음수 추가금 등)이거나 합계(상품 + 배송비)가 정수 범위(2,147,483,647원)를 넘으면 `400 invalid_amount`, 주문을 만들지 않는다.
  - 배송지 필수(받는 분·연락처·우편번호 5자리·주소, 상세 주소·메모 선택). 틀리면 `400 invalid_shipping_address`. 4.10 참고.
  - 400·402·409 응답은 `{ error, message }`. `message`는 화면에 그대로 보여 줄 문구이고, 사유 코드별 문구는 `lib/server/orders/messages.ts` 한 곳에서만 고친다. 말투는 부르는 API 대상으로 정한다(`lib/server/text/tone.ts`, 대표님 지시 2026-10-04): 파트너스·마스터 관리자 API(`app/api/seller/**`·`app/api/admin/**`)는 합니다체(요청은 「~해 주십시오」), 구매자 쇼핑몰·공개·오버레이 API와 파트너스 가입 신청(`app/api/seller-signup/**`)은 해요체. 같은 사유를 두 쪽이 쓰는 문구표(주문·로그인·본인확인)는 두 벌을 두고, `tests/unit/messageTone.test.ts`가 표의 말투와 경로별 호출을 확인한다.
  - 주문 번호는 판매자별 advisory lock 아래에서 매긴다(동시 주문에도 겹치지 않음). 판매 중(`ON_SALE`)이 아니거나 다른 쇼핑몰 옵션이면 `400 product_unavailable`.
- 입금 기한·자동 취소·구매 제한·주문 횟수 제한: 4.11.
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
  - 환불액(PRODUCT_SCOPE 「반품·교환 배송비」): 발송했거나 개봉한 품목이 있으면 `fault: "BUYER" | "SELLER"`(구매자·판매자 사정)를 꼭 보낸다(없으면 `400 fault_required`). 발송 전은 결제 금액 전부, 발송 후 판매자 사정은 상품 + 처음 배송비, 발송 후 구매자 사정은 상품 − 반품 배송비(처음 배송비 0원이면 × 2, 처음 배송비는 안 돌려줌, 0원 아래로 안 내려감). 구매자 사정이면 개봉한 품목은 빼고 계산한다. 발송 전 주문에 개봉 품목이 있으면 구매자 사정 환불은 `409 opened_items_unshipped`로 막는다(부분 환불 구조 전까지 임시, MASTER 결정 2026-10-03). 판매자 사정은 전액. 거부 응답에는 합니다체 `message`가 붙는다(파트너스 API, 예: 「개봉한 상품이 있습니다. 확인한 뒤 다시 환불해 주십시오」). 반품 배송비는 주문할 때 값(`Order.returnFeeSnapshot`)을 쓴다. 돈으로 돌려주는 환불액은 실제 결제액(`totalAmount`, 적립금을 이미 뺀 금액)을 넘지 않는다. 쓴 적립금을 되돌리는 규칙은 아직 없다(적립금 사용 방식 미정). 결과는 `Order.refundAmount·refundFault·returnFeeDeducted`와 응답·감사 로그에 남는다. 실제 PG 환불 호출은 아직 없다.
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
| `ORDER_FOLLOWUP` | 이미 받은 주문 처리(`/api/seller/orders/**`), 구매 제한(`/api/seller/purchase-restrictions/**`), 회원 조회(`/api/seller/members/**`) | 기능 권한이 하나라도 있을 때(하위 변경 뒤에도 기존 주문 처리). **통합 첫 결제 확정 전 막음** |
| `OVERLAY` | 방송·주문대기·오버레이 토큰·방송 실시간 채널(`/api/seller/broadcast/**`·`queue/**`·`overlay/token`·`stream`) | 오버레이 권한 |
| `STORE_OPERATIONS` | 상품·옵션·재고, 배송비·주문·회원·적립 정책, 공유 미리보기 설정 | 스토어 운영 권한 |
| `EXTERNAL_INTEGRATION` | (아직 경로 없음, 외부 연동 경로가 생기면 지정) | 외부 연동 권한 |

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
| `GET /api/overlay/{token}/state`·`…/version`·`…/stream`(오버레이 공개 주소) | 오버레이 | 오버레이 권한이 없으면 막음(통합 첫 결제 확정 전) |

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
- `SubscriptionPlan`: 정가(`listPrice`)·판매가(`salePrice`), 원 단위 부가세 포함, 청구액은 판매가. 체험 일수 `trialDays`. 플랜 행은 마이그레이션 데이터로 넣는다: `OVERLAY_ONLY` 99,000/69,000원·7일, `INTEGRATED` 249,000/179,000원·0일(`20261004150000_onq_plans`), 이전 전 `STANDARD` 300,000/199,000원은 남겨 두되 신규 가입에 쓰지 않는다. 구독 행이 없을 때 청구·표시 플랜은 판매자 플랜(`sellerPlanOf`). 요금 안내 `GET /api/plans`는 기본 플랜 값과 `plans`(가입할 수 있는 두 플랜)를 준다.
- STANDARD → 통합 이전(`20261004150000_onq_plans` BACKFILL, 결정적): 모든 STANDARD 구독(해지 보관 포함)과 모든 기존 판매자(구독 행 없는 체험 중·잠김 포함)를 `INTEGRATED`로 옮기고 상태·체험 종료일·결제일·유예·재시도·해지 예약은 그대로 둔다. 결제가 이어지는 구독(ACTIVE·PAST_DUE, 해지 예약 기간이 끝나지 않음)에만 이전 전 가격 스냅숏 `SellerSubscription.legacyPrice`(청구 금액과 같은 규칙으로 계산)를 남긴다. `chargeFor`는 스냅숏이 있고 `legacyPriceNoticeSentAt`이 없거나 그 + 30일 전이면 스냅숏 금액을 쓴다(고지 미발송이면 새 가격 청구 0건). 해지 뒤 다시 구독하면 스냅숏을 비운다(그때 플랜 가격). 고지 대상은 `listPlanMigrationNoticeTargets`(최고관리자), 발송 기능이 생기면 보낸 뒤 `legacyPriceNoticeSentAt`을 남긴다. 시험 `tests/integration/planMigration.test.ts`(ONQ_PLAN E1-C).
- 플랜 변경(ONQ 1-C-2, `lib/server/billing/planChange.ts`, `POST /api/seller/subscription/plan { planCode }`, 대표자 전용·잠겨도 열림·`BILLING`): 상위 변경(오버레이 전용 → 통합)은 결제사가 확정한 뒤에만 적용하고 대기·실패·시간 초과면 지금 플랜 그대로(유예 없음). 결제한 기간 중이면 차액 = (새 플랜 금액 − 지금 플랜 금액) × 남은 일수 ÷ 이번 기간 일수(KST 달력 날짜, 결제일 당일 0일·전날 1일, 원 단위 절사, MASTER 결정 2026-10-04, 응답 `remainingDays`)를 `kind = PRORATION` 청구로 결제하고 기간·결제일은 그대로. 체험 중이면 새 플랜 금액을 기간 결제로 바로 내고 확정되면 체험을 끝내고 결제일을 그날로. 유예 중(`PAST_DUE`)이면 밀린 기간의 지금 플랜 금액 + 그 기간 남은 일수 차액을 한 기간 결제로 내고 둘 다 확정된 뒤 ACTIVE·새 플랜. 체험·유예 중 카드가 없으면 409 `card_required`(결제 없이 통합을 열지 않음). 결제한 기간도 체험도 없으면(잠김·첫 결제 전) 결제 없이 플랜만 바꾼다(다음 결제가 새 플랜 금액). 하위 변경은 결제한 기간·유예 중이면 `SellerSubscription.pendingPlanId`에 두고 갱신 결제 직전에 옮겨 그 결제부터 새 금액(환불 없음, 해지 예약 구독은 그대로 해지), 아니면 바로. 지금 플랜을 다시 고르면 예약을 거둔다. 플랜이 바뀌면 이전 전 가격 스냅숏은 끝난다. 청구 종류 `SubscriptionPayment.kind`(`PERIOD`·`PRORATION`)와 확정 때 옮길 `targetPlanId`, 같은 기간 결제 하나 제한(부분 유니크)은 `PERIOD`에만 건다. 사업자·통신판매업 점검 게이트는 ONQ 2단계(MASTER 승인). 런칭 할인 계정당 1회는 위 4.8.0 확정 규칙(`chargeFor`). 시험 `tests/integration/planChange.test.ts`(ONQ_PLAN E1-B).
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
- 신청 때 쇼핑몰·대표자 계정(본인확인 이름)·기본 등급 5개를 만든다. 사업자 정보는 `Seller.businessInfo`(사업자등록번호·상호·대표자명·개업일자·통신판매업 신고번호·국세청·공정위 조회 결과·점검 시각)에 둔다.
- 국세청·공정위 조회는 공급자 인터페이스(`lib/server/sellers/businessCheck.ts`)로만 부른다. `BUSINESS_STATUS_PROVIDER=fake`·`MAIL_ORDER_PROVIDER=fake`를 명시했을 때만 가짜(운영 불가). 그 밖에는 실제 조회 자리이며, 실제 연동 전이거나 키가 없으면 조회 실패로 처리해 자동 승인하지 않는다. 환경변수 이름은 `.env.example`.

### 4.9 이번 초안에서 뺀 것 (다음 단계)

PG 연결 정보, 구매자 문의·공지, 알림 발송 기록, 도우미 자료, 오버레이 편집 설정, 구매 랭킹. 모두 `sellerId` 범위 규칙을 그대로 따른다.

아래는 스키마를 다시 만들지 않도록 자리만 정해 둔다(이번에 테이블은 만들지 않음, 모두 추가 테이블·추가 컬럼으로 붙인다).

- 현금영수증·세금계산서: 주문별 신청 정보(`OrderReceiptRequest`)와 발행 레코드(`ReceiptIssue`: 종류, 상태 `PENDING | ISSUED | FAILED | CANCELLED`, 연동 결과 키).
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
- 파트너스 회원 목록 `GET /api/seller/members`·상세 `GET /api/seller/members/{id}`(`MEMBER_POINTS`, 잠금 중에도 가능, `lib/server/buyers/sellerMembers.ts`): 탈퇴(`deletedAt`, 분리 보관) 회원은 목록·상세에서 없는 회원(404). 가입 시각·id 내림차순 커서 페이지(limit 기본 50·최대 200, 인덱스 `(sellerId, createdAt)`). gradeId·status(`ACTIVE`·`DORMANT`)·q(방송 닉네임, 이름·휴대폰 끝 4자리는 `CUSTOMER_PII_VIEW`가 있을 때만) 필터. 행: id·broadcastNickname·(name·phone: 개인정보 권한)·grade{id, displayName}·status·marketingConsent·createdAt·lastLoginAt, 응답 `{ members, nextCursor }`. 상세는 행 + orderCount·totalPaid(결제된 주문 금액 − 환불액, 법정 보관 주문 제외)·rewardBalance, 응답 `{ member }`. 이름·휴대폰을 응답에 넣으면 `customer.pii.view`(목록은 회원 id·건수만, 검색어는 남기지 않음).
- `OrderShippingAddress`(주문당 1개, 스냅숏): 받는 분, 연락처(숫자만), 우편번호, 주소, 상세 주소, 메모, 도서산간 여부. 값은 NFKC로 정규화해 저장한다(전각 공백·NBSP는 일반 공백). 제어(Cc)·서식(Cf: 방향 바꿈·폭 없는 공백 등)·짝 없는 서로게이트(Cs)·사용자 정의(Co)·미할당(Cn)·줄·문단 구분(Zl·Zp) 문자가 든 값, 받는 분·주소의 한글 채움 문자(U+115F·U+1160·U+3164·U+FFA0)·점자 빈칸(U+2800), 눈에 보이는 글자가 없는 받는 분·주소는 `400 invalid_shipping_address`(`lib/server/text/clean.ts`, 상품과 같은 규칙). 메모만 이모지용 ZWJ·변형 선택자를 허용하고, 태그 문자는 깃발 시퀀스(U+1F3F4 + 태그 + U+E007F) 안에서만 허용하며, 비문자(U+FDD0–FDEF, 각 평면의 xFFFE·xFFFF)는 거부한다. 또 서버가 모르는 최신 이모지로 주문이 막히지 않게 미할당(Cn) 검사를 하지 않는다. 연락처·우편번호도 NFKC 정규화 뒤 검사한다(전각 숫자 허용). 판매자 주문 조회에서는 `CUSTOMER_PII_VIEW`가 있을 때만 주소를 주고(열람 기록), 없으면 도서산간 여부만 준다.
- `Shipment`(주문당 1개): 택배사 코드(`CJ | HANJIN | LOTTE | LOGEN | EPOST`), 송장번호(영문·숫자 8~30자, 하이픈·공백 제거), 상태, 발송 시각(DB 시계), 배송 완료 시각.
  - `POST /api/seller/orders/{orderId}/ship`(`ORDER_SHIPPING`, 잠금 중에도 가능): 결제 완료(`PAID`) 즉시 발송 주문만 `IN_TRANSIT`로 만든다. 재고 부족(`stockShortageAt`) 주문, 배송지가 없는 주문도 `409 not_shippable`. 배송 중에는 송장을 고쳐 다시 넣을 수 있고(첫 발송 시각 유지, `order.shipment.update` 기록), 배송 완료 뒤에는 바꾸지 않는다. 주문 상태는 `PAID` 그대로.
  - 발송한(Shipment가 있는) 주문을 환불하면 재고를 되돌리지 않고 배송 기록도 그대로 둔다. 감사 로그 `order.refund`에 `shippedBeforeRefund: true`와 배송 상태를 남긴다. 배송비 환불 금액 규칙은 대표님 결정 대기(지금은 주문 전체 금액 기준 그대로).
  - 배송 완료 `POST /api/seller/orders/{orderId}/deliver`(`ORDER_SHIPPING`, 잠금 중에도 가능): 결제 완료·배송 중(`IN_TRANSIT`)인 주문만 `DELIVERED`·`deliveredAt`(DB 시계)로 바꾸고 아직 없으면 `EARN`을 기록한다. 아니면 `409 not_deliverable`. 주문 행을 잠가 발송·환불과 겹치지 않는다. 감사 로그 `order.deliver`.
  - 자동 처리(`lib/server/orders/delivery.ts`, 정기 실행 연결은 인프라 승인 대기): `autoCompleteDeliveries`는 발송 뒤 `autoDeliverDays`가 지난 배송 중 주문을 배송 완료(`order.auto_deliver`), `autoConfirmPurchases`는 배송 완료 뒤 `autoConfirmDays`가 지난 결제 완료 주문에 `Order.purchaseConfirmedAt`을 남긴다(`order.purchase_confirmed`). 주문 상태는 `PAID` 그대로. 멱등이고 한 건 실패해도 나머지는 계속한다(`*_failed` 감사 로그). 후보를 오래된 순(시각, 주문 id) keyset으로 이어 가져와, 실패하거나 그사이 조건이 바뀐 주문은 건너뛰고 처리 건수가 한도(기본 100)에 찰 때까지 다음 후보로 넘어간다(한 번에 한도 × 10건까지 살핀다). 주문마다 트랜잭션 안에서 주문을 잠그고 상태·판매자 설정(켜짐·기간)을 DB 시계로 다시 확인한다.
  - 배송 추적·발송 알림은 아직 없다.

### 4.11 입금 기한·미입금 자동 취소·구매 제한 (PRODUCT_SCOPE 「무통장 입금·구매 제한 기본값」, MASTER 결정)

- `SellerOrderPolicy`(판매자당 1행, 없으면 기본값): autoCancelEnabled(미입금 자동 취소 사용, 기본 켜짐), paymentDueHours(기본 24시간, 1~720시간=30일, 대표님 결정 2026-10-03. 이미 저장된 판매자 설정값은 바꾸지 않음), unpaidRestrictionEnabled(기본 켜짐), paidCancelRestrictionEnabled(기본 꺼짐, PUT에서 빼면 지금 값 유지). `GET·PUT /api/seller/order-policy`(`SHOP_SETTINGS`, 틀리면 `400 invalid_order_policy`, 감사 로그).
  - 자동 배송 완료 `autoDeliverEnabled`·`autoDeliverDays`, 자동 구매 확정 `autoConfirmEnabled`·`autoConfirmDays`(기본 사용·7일, 1~30일). `PUT /api/seller/order-policy`에서 빼고 보내면 지금 값 유지.
- 주문할 때 `Order.paymentDueAt` = 주문 시각 + paymentDueHours. 주문 시각은 판매자 주문 잠금을 잡은 뒤의 `clock_timestamp()`(트랜잭션 시작 시각인 `now()`가 아님). 설정을 바꿔도 이미 만든 주문은 그대로. 이 기능 전에 만든 결제 대기 주문은 마이그레이션(#82)에서 주문 시각 + 10일로 채웠다(당시 기본값, 운영 데이터 없음). 자동 취소를 끈 쇼핑몰의 새 주문은 기한이 없다(이미 기한이 붙은 주문은 그대로 자동 취소 대상). PG 연동 때 무통장 입금 주문에만 두도록 바꾼다(MASTER 결정).
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
