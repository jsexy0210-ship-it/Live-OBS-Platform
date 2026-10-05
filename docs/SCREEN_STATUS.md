# IA 화면 대비 미구현 화면 목록 (main e4af7f37 기준, 2026-10-05 KST)

기준: `docs/IA.md`의 화면 ID. 묶음 제목 ID(MA-010·020·030·040·050·060·080, SA-010·020·030·040·045·050·110)는 화면이 아니라 메뉴 묶음이라 셈에서 뺐다. IA가 따로 적은 하위 화면 PF-007-1·SA-002-O·SH-022-R은 포함했다. EM(메일)은 대상 밖.

- 구현: 실제 화면·기능이 코드에 있음(부분 구현은 「부분」 표시)
- 자리만: 「준비 중」 화면(마스터 catch-all `/admin/[...slug]` 등) 또는 「준비 중입니다」 비활성 메뉴만 있음
- 남음: 화면·메뉴 자리 모두 없음(서버 API만 있는 경우 포함)

## 요약

| 영역 | 전체 | 구현 | 자리만 | 남음 |
|---|---|---|---|---|
| PF 플랫폼 소개·가입 | 10 | 2 | 0 | 8 |
| AU 공통 인증 | 12 | 7 | 0 | 5 |
| MA 마스터 관리자 | 39 | 13 | 19 | 7 |
| SA 파트너스 관리자 | 68 | 31 | 23 | 14 |
| OV OBS 오버레이 | 8 | 5 | 0 | 3 |
| SH 구매자 쇼핑몰 | 29 | 19 | 0 | 10 |
| 합계 | 166 | 77 | 42 | 47 |

미구현(자리만 + 남음) 합계 89.

## PF

남음
- PF-001 서비스 소개(랜딩) — `/about`에 만든다. `/`는 로그인 유지(대표님 지시 2026-10-04 「첫 화면은 로그인이다」, #232)
- PF-002 기능 안내
- PF-003 요금 안내
- PF-004 자주 묻는 질문
- PF-005 공지사항 목록
- PF-006 공지 상세
- PF-008 이용약관 (가입 폼에 「원문 정해지면 보기」 주석만)
- PF-009 개인정보처리방침

## AU

남음
- AU-005 판매자 승인 대기 안내 (로그인 오류 문구 `seller_pending`과 가입 완료 단계 문구로만 대신함 — 판단 불확실)
- AU-006 이용 정지 안내 (로그인 오류 문구 `seller_suspended`로만 — 판단 불확실)
- AU-007 세션 만료 (401이면 로그인 화면으로 이동만)
- AU-009 페이지 없음(404) (구매자용 `app/(shop)/not-found.tsx`만, 관리자·파트너스는 Next 기본 404 — 판단 불확실)
- AU-010 점검 중

## MA

자리만 (준비 중 화면 / 비활성 링크)
- MA-002 알림 센터 — 상단 유틸 비활성 링크
- MA-090 내 계정 — 상단 유틸 비활성 링크
- MA-013 가입 신청 목록 — `/admin/partners/applications` (ComingSoon. 메뉴엔 ready로 표시되어 있음)
- MA-021 요금제 목록 — `/admin/billing/plans`
- MA-026 환불 요청 목록 — `/admin/billing/refunds`
- MA-031 판매자별 PG 연결 상태·오류 — `/admin/settlement/pg`
- MA-032 구독료 수납 현황 — `/admin/settlement/collection`
- MA-041 실시간 방송 중 판매자 — `/admin/ops/live`
- MA-042 판매자별 주문·오버레이 접속 현황 — `/admin/ops/access`
- MA-043 적립금 실지급 켜진 판매자 목록 — `/admin/ops/rewards`
- MA-100 실시간 감시 — `/admin/ops/monitor`
- MA-110 자동 연결 작업 목록 — `/admin/ops/jobs`
- MA-051 판매자 문의 목록 — `/admin/support/inquiries`
- MA-053 공지사항 목록 — `/admin/support/notices`
- MA-055 도우미 답변 자료 관리 — `/admin/support/assistant`
- MA-081 플랫폼 기본 정책 — `/admin/settings/policy`
- MA-082 알림 채널 설정 — `/admin/settings/notifications`
- MA-083 점검 모드 — `/admin/settings/maintenance`
- MA-084 도우미 설정 — `/admin/settings/assistant`

남음
- MA-014 가입 신청 상세 (승인/반려)
- MA-016 판매자 화면 대리 조회 (서버 권한·로그 이름만 있고 화면 진입 없음)
- MA-022 요금제 등록·수정
- MA-027 환불 처리
- MA-052 문의 상세·답변
- MA-054 공지 작성·수정
- MA-111 자동 연결 작업 상세

## SA

자리만 (「준비 중입니다」 비활성 메뉴, 주소 없음)
- SA-002 파트너스 홈 — `/seller`에서 쇼핑몰 통합 요금제에 홈(오늘 처리할 일 → 오늘 성과 → 방송)을 보여 준다. 메뉴 「홈」은 공통 틀(SellerShell)에 주소가 없어 아직 비활성(레이아웃 담당 확인 필요). 목록 쿼리(status=PAID&shipped=false 등)는 각 목록 화면이 읽을 때까지 필터가 걸리지 않는다
- SA-003 시작하기
- SA-005 쇼핑몰 통합 전환
- SA-006 외부 쇼핑몰 연동 관리
- SA-015 카테고리 관리 (API `/api/seller/categories`는 있음, 화면은 상품 목록 필터에서만 사용)
- SA-016 상품 진열 (API `/api/seller/display`만)
- SA-018 엑셀 일괄 등록·내보내기
- SA-024 현금영수증·세금계산서
- SA-026 입금 확인 (API `/api/seller/payments/deposits`만)
- SA-027 배송·송장 발급
- SA-028 송장 출력·추적
- SA-044 회원 등급
- SA-049 회원 알림 발송
- SA-054 방송 이력
- SA-062 법정 고지·약관
- SA-066 쇼핑몰 공지·자주 묻는 질문 (API `/api/seller/notices`만)
- SA-067 검색 노출
- SA-070 결제(PG) 연결
- SA-080 주문자 알림 설정
- SA-111 공지사항 목록 — 상단 유틸 「공지 · 문의」 비활성
- SA-120 내 계정 — 상단 유틸 비활성
- SA-140 도우미 — `/seller/assistant` 만듦(API·화면, 2026-10-05). 상단 유틸 「도우미」 링크 연결은 공통 파일(SellerShell) 전담 몫
- SA-150 자동 연결 안내

남음
- SA-002-O 오버레이 전용 홈
- SA-004 온보딩
- SA-032 지급·회수 원장 (API `/api/seller/reward-ledger`만)
- SA-033 회원별 잔액
- SA-034 실지급 스위치
- SA-055 방송 상세
- SA-112 공지 상세
- SA-113 내 문의 목록
- SA-114 문의 작성
- SA-115 문의 상세·답변 확인
- SA-130 알림 센터 (상단 유틸에 자리도 없음)
- SA-151 자동 연결 결제
- SA-152 자동 연결 진행
- SA-153 자동 연결 완료

## OV

남음
- OV-000 효과 명세 (공통 연출 기준 문서 성격 — 화면인지 판단 불확실)
- OV-003 HIT 카드 강조 연출 (위젯 종류에 없음)
- OV-007 이벤트 할인 카드 (위젯 종류에 없음)

## SH

자리만: 없음 (`app/(shop)/shop/[slug]/_lib/ComingSoon.tsx`는 정의만 있고 쓰는 곳 없음)

남음
- SH-009 미성년자 주문 제한 안내
- SH-012 비밀번호 찾기 (로그인 화면에 링크 없음)
- SH-023 내 적립금
- SH-024 회원정보 수정
- SH-026 내 문의
- SH-027 배송지 관리
- SH-031 개인정보처리방침
- SH-032 이용약관
- SH-040 쇼핑몰 정지·준비 중 안내 (운영 중 아닌 쇼핑몰은 404 처리)
- SH-041 쇼핑몰 잠금

## 구현 화면 (검증용)

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
- SA-011 상품 목록 — `/seller/products`
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
- AU-005·AU-006: 전용 안내 화면 없이 로그인 오류 문구로만 → 남음으로 셈
- AU-008: 전용 403 화면 없이 화면별 권한 없음 상태 → 구현으로 셈
- AU-009: 구매자 404만 있음 → 남음으로 셈
- SA-013: 편집기 안 미리보기만 → 구현으로 셈
- SH-008: 주문 화면 안 실패 안내만 → 구현으로 셈
- OV-000: 화면이 아닌 연출 명세일 수 있음 → 남음으로 셈
- OV-004: 명예의 전당 위젯만, 「구매 랭킹」 별도 여부 불명 → 구현으로 셈
- 코드 주석 ID 불일치: `/seller/shipping`(주석 SA-027 → 실제 SA-025), `/seller/settings/member`(주석 SA-043 → 실제 SA-068), MA-013 메뉴 ready 표시와 실제 ComingSoon 불일치

## 배정 (2026-10-05 KST MASTER, 대표님 지시 「남은 화면 알아서 배정」)

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
