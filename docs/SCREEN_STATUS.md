# IA 화면 대비 구현 현황 (main ed9373a0 기준, 2026-10-05 KST)

기준: `docs/IA.md`의 화면 ID(IA 개편 뒤 추가된 SA-057 유튜브 연결 포함). 묶음 제목 ID(MA-010·020·030·040·050·060·080, SA-010·020·030·040·045·050·110)는 화면이 아니라 메뉴 묶음이라 셈에서 뺐다. 코드(`app/**` 화면 파일·메뉴·화면 ID 주석)를 직접 확인한 값이며 화면을 실행해 본 것은 아니다. 이전 기준(e4af7f37)은 구현 77 · 자리만 42 · 남음 47이었다.

- 구현: 실제 화면·기능이 코드에 있음(부분 구현은 「부분」 표시)
- 자리만: 「준비 중」 화면(마스터 catch-all `/admin/[...slug]`) 또는 「준비 중입니다」 비활성 메뉴·링크만 있음
- 남음: 화면·메뉴 자리 모두 없음(서버 API만 있는 경우 포함)
- 진행 중: 열린 PR이 있는 항목(병합 전이라 위 세 가지 어디에도 반영하지 않고 따로 적는다)

## 요약

| 영역 | 전체 | 구현 | 자리만 | 남음 | 진행 중(미구현 중 열린 PR) |
|---|---|---|---|---|---|
| PF 플랫폼 소개·가입 | 10 | 10 | 0 | 0 | 0 |
| AU 공통 인증 | 12 | 12 | 0 | 0 | 0 |
| MA 마스터 관리자 | 39 | 36 | 3 | 0 | 1 (MA-090) |
| SA 파트너스 관리자 | 69 | 59 | 8 | 2 | 4 (SA-002-O·018·034·120) |
| OV OBS 오버레이 | 8 | 5 | 0 | 3 | 0 |
| SH 구매자 쇼핑몰 | 29 | 21 | 0 | 8 | 0 |
| 합계 | 167 | 143 | 11 | 13 | 5 |

미구현(자리만 + 남음) 합계 24. 이전 기준 대비 구현 +66, 미구현 −65(SA-057이 IA에 추가되어 전체 +1).

## 진행 중 (열린 PR)

미구현 항목
- SA-002-O 오버레이 전용 홈 — #518 (화면)
- SA-018 엑셀 일괄 등록·내보내기 — #462 (초안·작업 중, 서버 모델·서비스만, 화면 없음)
- SA-034 실지급 스위치 — #563 (API만, 화면은 아직)
- SA-120 내 계정 · MA-090 내 계정 — #554 (API만, 화면은 아직)

구현 항목의 보강
- MA-012 파트너스 상세 — #552 (방송 이력·메모·결제 연결·활동 기록 탭, 적립금 탭은 없음)
- SA-011 상품 목록 — #564 (판매 상태·재고 빠른 처리)
- SA-062 법정 고지·약관 — #565 (사업자 정보·고지 탭, 구매자 바닥글 법정 표시)
- MA-002·SA-130 알림 센터 — #557 (상단 알림 종·전역 검색, 진입 링크 연결)
- SH-004 장바구니 — #555 (가격 바뀜·재고 부족 표시)

화면이 아닌 열린 PR: #561(쿠폰 통계 API), #535(리뷰 photoOnly·인기 검색어 제외 API), #559(시험), #560(UX 감사 문서), #562(디자인 보드 요약)

## 자리만

MA
- MA-081 플랫폼 기본 정책 — `/admin/settings/policy` (메뉴만, catch-all 준비 중 화면)
- MA-082 알림 채널 설정 — `/admin/settings/notifications` (메뉴만, catch-all 준비 중 화면)
- MA-090 내 계정 — 상단 유틸 비활성 링크 (API #554 진행 중)

SA (「준비 중입니다」 비활성 메뉴·링크)
- SA-005 쇼핑몰 통합 전환
- SA-018 엑셀 일괄 등록·내보내기 (#462 작업 중)
- SA-024 현금영수증·세금계산서 (서버 신청 API는 있음, 화면 없음)
- SA-027 송장 발급
- SA-028 송장 출력·추적
- SA-067 검색 노출
- SA-070 결제(PG) 연결
- SA-120 내 계정 — 상단 유틸 비활성 링크 (API #554 진행 중)

## 남음

SA
- SA-002-O 오버레이 전용 홈 (#518 진행 중)
- SA-034 실지급 스위치 (API #563 진행 중, `/seller/rewards`에 스위치 화면 없음)

OV
- OV-000 효과 명세 (공통 연출 기준 문서 성격 — 화면인지 판단 불확실)
- OV-003 HIT 카드 강조 연출 (위젯 종류에 없음)
- OV-007 이벤트 할인 카드 (위젯 종류에 없음)

SH
- SH-009 미성년자 주문 제한 안내 (주문서 안 한 줄 안내만)
- SH-012 비밀번호 찾기 (구매자 로그인 화면에 링크 없음)
- SH-023 내 적립금 (서버 API만)
- SH-024 회원정보 수정
- SH-026 내 문의
- SH-027 배송지 관리
- SH-040 쇼핑몰 정지·준비 중 안내 (운영 중 아닌 쇼핑몰은 404 처리)
- SH-041 쇼핑몰 잠금

화면은 있으나 진입 링크가 아직 연결되지 않은 것(구현으로 셈): SA-003 시작하기 `/seller/onboarding`, SA-006 외부 쇼핑몰 연동 `/seller/external-shops`, SA-150 자동 연결 `/seller/automation` (파트너스 메뉴가 비활성 항목으로 둠 — 공통 파일 몫), MA-002 알림 센터 `/admin/notifications`·SA-130 `/seller/notifications` (상단 알림 종은 #557 진행 중).

## 구현으로 옮긴 화면 (이전 기준 대비)

PF: PF-001 `/about` · 002 `/features` · 003 `/pricing` · 004 `/faq` · 005 `/notices` · 006 `/notices/[noticeId]` · 008 `/terms` · 009 `/privacy`
AU: AU-005 `/seller/pending` · AU-006 `/seller/suspended` · AU-007 로그인 화면 안 만료 안내(전용 화면 없음, 판단 불확실) · AU-009 공통·마스터·파트너스 404(`NotFoundView`) · AU-010 `/maintenance`
MA: MA-002 `/admin/notifications` · 013 `/admin/partners/applications` · 014 `/admin/partners/applications/[sellerId]` · 016 파트너스 상세 대리 조회 · 021·022 `/admin/billing/plans` · 026·027 `/admin/billing/refunds`(+`[refundId]`) · 031 `/admin/settlement/pg` · 032 `/admin/settlement/collection` · 041 `/admin/ops/live` · 042 `/admin/ops/access` · 043 `/admin/ops/rewards` · 051·052 `/admin/support/inquiries`(+`[inquiryId]`) · 053·054 `/admin/support/notices`(+`new`·`[noticeId]`) · 055 `/admin/support/assistant` · 083 `/admin/settings/maintenance` · 084 `/admin/settings/assistant`(키 반영 전 준비 중 상태 있음) · 100 `/admin/ops/monitor` · 110·111 `/admin/ops/automation`(+`[jobId]`)
SA: SA-001 HIT 카드 창(`HitCardModal`) · 002 홈(`HomeDashboard`) · 003·004 `/seller/onboarding` · 006 `/seller/external-shops` · 015 `/seller/products/categories` · 016 `/seller/products/display` · 026 `/seller/orders/deposits` · 032 `/seller/rewards/ledger` · 033 `/seller/rewards/balances` · 044 `/seller/member-grades` · 049 `/seller/member-messages` · 054·055 `/seller/broadcasts`(+`[broadcastId]`) · 057 `/seller/youtube` · 062 `/seller/settings/legal` · 066 `/seller/settings/shop-notices` · 080 `/seller/settings/order-notifications` · 111·112 `/seller/notices`(+`[id]`) · 113~115 `/seller/inquiries`(+`new`·`[id]`) · 130 `/seller/notifications` · 140 `/seller/assistant` · 150~153 `/seller/automation`(+`pay`·`[jobId]`·`done`)
SH: SH-031 `/shop/[slug]/privacy` · SH-032 `/shop/[slug]/terms`

## 구현 화면 (이전 기준부터 구현이던 것, 검증용)

PF
- PF-007 가입 신청 — `/seller/signup`
- PF-007-1 약관 동의 — `/seller/signup` 1단계

AU
- AU-001 마스터 로그인 — `/admin/login`
- AU-002 파트너스 로그인(대표자·직원 탭) — `/seller/login`
- AU-003 비밀번호 찾기 — `/seller/password-reset`, `/seller/find-id` 전환
- AU-004 비밀번호 재설정 — `NewPasswordForm` (위 두 화면 안)
- AU-011 아이디 찾기 — `/seller/find-id`
- AU-012 직원 첫 로그인 본인확인 — `/seller/identity-link`
- AU-008 권한 없음 — 전용 화면 없이 각 화면 안 권한 없음 상태(AdminShell 「이 화면을 볼 권한이 없습니다」, seller `NoPermission`) — 판단 불확실

MA
- MA-001 통합 대시보드 — `/admin`
- MA-011 파트너스 목록 — `/admin/partners`
- MA-012 파트너스 상세 — `/admin/partners/[sellerId]` (부분: 기본정보·대표자·사업자·구독만, PG·방송 이력·적립금·메모·활동 기록 탭 없음)
- MA-015 이용 정지·해제 — `SuspendDialog` (목록·상세)
- MA-023 구독 현황 — `/admin/billing/subscriptions`
- MA-024 청구·결제 내역 — `/admin/billing/invoices`
- MA-025 청구 상세 — `/admin/billing/invoices/[paymentId]`
- MA-061 관리자 계정 목록 — `/admin/accounts`
- MA-062 계정 추가·수정 — `AccountDialog`
- MA-063 역할별 권한 표 — `/admin/accounts/roles`
- MA-070 로그 추적 — `/admin/logs`
- MA-071 로그 추적 상세 — `/admin/logs/[logId]`
- MA-085 파비콘·공유 카드 — `/admin/settings/branding`

SA
- SA-001 방송 대시보드 — `/seller/broadcast` (HIT 카드 등록 모달 없음: 코드 주석 「서버 API가 아직 없어 두지 않는다」)
- SA-011 상품 목록 — `/seller/products` (빠른 처리: 판매 상태 선택·판매가·옵션 1개 상품 재고를 목록에서 바로 저장하고 토스트 「되돌리기」. 조건은 URL 쿼리와 맞춤)
- SA-012 상품 등록·수정 — `/seller/products/new`, `/seller/products/[productId]`
- SA-013 상품 상세 미리보기 — 상세 편집기 안 「미리보기」 전환만(`ProductDetailEditor`) — 판단 불확실
- SA-014 재고 일괄 수정 — `/seller/products/stock` (CSV·되돌리기 없음)
- SA-021 주문 목록 — `/seller/orders`
- SA-022 주문 상세 — `/seller/orders/[orderId]`
- SA-023 취소·환불 — `RefundModal`
- SA-025 배송 — `/seller/shipping` (코드 주석은 SA-027로 적혀 있으나 내용은 IA의 SA-025 배송)
- SA-029 교환·반품 — `/seller/returns`
- SA-031 적립 정책 — `/seller/rewards` (부분: 지급 시점만)
- SA-035 쿠폰 — `/seller/coupons`
- SA-041 회원 목록 — `/seller/members`
- SA-042 회원 상세 — `/seller/members/[memberId]` (부분: 주문 목록·메모·등급 조정·적립금 지급 없음)
- SA-043 구매 제한 — `/seller/purchase-restrictions` (직접 막기 없음)
- SA-017 재입고 알림 — `/seller/products/restock-alerts` (상품별 대기·발송 수 조회만. 실제 발송은 서버 미연결이라 기록만, 설정 API 없음. 메뉴 href는 레이아웃 전담 몫)
- 검색 유사어 — `/seller/products/search-synonyms` (화면 ID 없음: IA 반영 필요. 서버 #486. 상품 등록·수정 폼의 「검색 키워드」(searchTags)도 같은 PR. 메뉴 href는 레이아웃 전담 몫)
- SA-046 구매자 문의 목록 · SA-047 문의 상세·답변 — `/seller/buyer-inquiries` (상세는 목록 위 창. 「구매자 문의」 메뉴 href 연결은 레이아웃 전담 몫)
- SA-048 상품 리뷰 — `/seller/reviews`
- SA-051 오버레이 편집기 — `/seller/overlay`
- SA-052 오버레이 주소 복사·재발급 — `/seller/overlay`
- SA-053 HIT 카드 이력 — `/seller/hit-cards`
- SA-056 통계 — `/seller/stats` + orders·sales·products·members·broadcasts
- SA-060 쇼핑몰 설정 — `/seller/settings/shop`(로고만), `/seller/settings/share`(공유 미리보기) (부분: 도메인·대표 색·파비콘 없음)
- SA-061 배송비 정책 — `/seller/settings/shipping` (부분)
- SA-063 주문 설정 — `/seller/settings/order`
- SA-064 홈 배너 — `/seller/banners`
- SA-065 이벤트 팝업 — `/seller/banners/popups`
- SA-068 회원 정책 — `/seller/settings/member` (코드 주석은 SA-043, 내용은 재가입 제한)
- SA-090 구독·결제 — `/seller/subscription`
- SA-100 직원 계정·권한 — `/seller/staff`

OV
- OV-001 세로형 9:16 — `/overlay/[token]` (템플릿 기능 있음)
- OV-002 가로형 16:9 — `/overlay/[token]`
- OV-004 구매 랭킹·명예의 전당 — HALL_OF_FAME 위젯 (랭킹 별도 연출은 판단 불확실)
- OV-005 오픈 타이머 — OPEN_TIMER 위젯
- OV-006 연결 끊김·방송 대기 — `OverlayView` 안내

SH
- SH-001 쇼핑몰 홈 — `/shop/[slug]`
- SH-002 상품 목록·검색 — `/shop/[slug]/products`, `/search`
- SH-003 상품 상세 — `/shop/[slug]/products/[productId]`
- SH-004 장바구니 — `/cart`
- SH-005 주문서 — `/checkout` (부분: 적립금·닉네임·받는 방법 없음)
- SH-006 결제 진행 — `OrderPay` (주문 상세 안 결제 수단·결제창)
- SH-007 주문 완료 — `/orders/[orderId]?done=1`
- SH-008 결제 실패 — 주문 화면 안 「결제하지 못했어요」 안내만 — 판단 불확실
- SH-010 로그인 — `/login`
- SH-011 회원가입 — `/signup`
- SH-020 마이페이지 — `/me`
- SH-021 주문 내역 — `/orders`
- SH-022 주문 상세 — `/orders/[orderId]` (부분: 취소 요청·영수증 확인 없음)
- SH-022-R 교환·반품 요청 — `ReturnSection`
- SH-025 알림 설정 — `/me/notifications`
- SH-028 쿠폰함 — `/coupons`
- SH-029 리뷰 쓰기 — `/reviews`, `/reviews/write`
- SH-030 공지·이용안내 — `/help`, `/help/notices/[noticeId]`
- SH-034 찜·최근 본 상품 — `/wishlist` (부분: 최근 본 상품 없음)

## 판단 불확실 모음
- AU-007: 전용 세션 만료 화면은 없고 로그인 화면이 이유를 알려 줌 → 구현으로 셈
- AU-008: 전용 403 화면 없이 화면별 권한 없음 상태 → 구현으로 셈
- SA-013: 편집기 안 미리보기만 → 구현으로 셈
- SH-008: 주문 화면 안 실패 안내만 → 구현으로 셈
- SH-009: 주문서 안 한 줄 안내(`cart-hint`)뿐이고 전용 안내 화면은 없음 → 남음으로 셈
- OV-000: 화면이 아닌 연출 명세일 수 있음 → 남음으로 셈
- OV-004: 명예의 전당 위젯만, 「구매 랭킹」 별도 여부 불명 → 구현으로 셈
- MA-084·SA-140: 화면은 있으나 서버 키 반영 전 「준비 중」 상태로 보임 → 구현으로 셈
- 코드 주석 ID 불일치(이전 기준에서 확인, 이번에 다시 확인하지 않음): `/seller/shipping`(주석 SA-027 → 실제 SA-025), `/seller/settings/member`(주석 SA-043 → 실제 SA-068)

## 배정 (2026-10-05 KST MASTER, 대표님 지시 「남은 화면 알아서 배정」 — 당시 기록, 현재 상태는 위 목록이 정본)

각 세션은 열린 PR 1개 규칙을 지키며 위에서부터 진행한다. 서버 API가 없으면 화면보다 먼저 해당 기반 세션에 계약을 요청한다.

| 담당 세션 | 화면 |
|---|---|
| 화면-마스터 (신설) | MA-013·014, MA-041·042·043·100, MA-026·027, MA-031·032, MA-051~054, MA-081·082·083·002·090·016, MA-012 빠진 탭 |
| 화면-공개 (신설) | PF-001(`/about`, `/`는 로그인 유지)·002·003·004·008·009·005·006, AU-009, AU-010 |
| 화면-파트너스 운영 (신설) | SA-015·016, SA-026, SA-046·047, SA-024·027·028, SA-018·017 |
| 개발 전담 (화면) (3) | 주석 ID 정정(SA-025·SA-068), SA-002·003·004, SA-120·130, SA-111~115, SA-042 빠진 부분, AU-005·006·007 |
| 구매자 쇼핑몰 전담 (2) | SH-023·024·027·026·012, SH-005 닉네임·SH-022 빠진 부분·SH-034, SH-031·032·009, SH-040·041 |
| 화면-설정 (2) | SA-032·033·034, SA-067·062·066, SA-060·061 빠진 항목, SA-070 |
| 화면-방송 (2) | SA-001 HIT 카드 창, SA-054·055, OV-003·007·004, SA-002-O |
| 브랜딩 전담 (2) | MA-021·022 |
| 쇼핑몰 운영 전담 | SA-044·049 (기존 배정) |
| 개발 전담 (기반) (5) | 위 화면용 서버 API: 플랫폼 공지·문의, 가입 신청 상세, 운영 현황, 구독 환불, 기본 정책·알림 채널·점검 모드·알림 센터·대리 조회·온보딩 |
| 자동연결 (세션 비활성) | SA-150~153, MA-110·111 — 자동연결 백엔드 상태 확인 뒤 재배정 |

보류(대표님 결정 필요):
- SA-140·MA-055·MA-084 도우미: 월 1만 원 한도로 시작(대표님 2026-10-05). 모델·단가는 MA-084에서 공식 문서 확인 후 입력, 서버 `GEMINI_API_KEY` 반영 전까지 「준비 중」.
- SA-005 쇼핑몰 통합 전환·SA-006 외부 쇼핑몰 연동: 외부 쇼핑몰 API 범위·비용 미정.
