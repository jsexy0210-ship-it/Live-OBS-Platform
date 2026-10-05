# UI 적용 현황

> 기준: 2026-10-05 KST · 대표님 지시 「전체 UI 현대화 및 디자인 시스템 통합」 · 규격 정본 `docs/DESIGN_PROMPT.md` 「시각 규격 (2026-10-05)」, 토큰 `styles/tokens.css` `--ui-*`
> 담당: 레이아웃 전담. 화면별 정리는 화면 소유 세션과 MASTER 잠금 절차로 진행한다.

## 열 뜻

- **1단계 공통 규격**: 공통 클래스(`.btn` `.inp` `.tbl` `.bdg` `.card` `.modal` `.tab` `.seg` `.chip` `.pg` `.msg` `.toast`, 관리자 `.au-*`)를 쓰는 부분은 1단계 PR로 새 높이·모서리·글자가 자동 적용된다. 화면 CSS가 높이·모서리를 직접 정한 부분은 그대로 남아 있고 「화면별 정리」에서 고친다.
- **화면별 정리**: 대기 → 진행 → 완료. 완료는 그 화면 CSS의 중복·임의 규칙 제거, 모달 공통 부품 전환, 상태 화면 구분, PC·모바일 실측까지 끝난 것만.
- **PC·모바일 확인**: 실제 렌더링(운영 빌드 `next start`, 폐기용 DB, 데모 데이터)으로 확인한 폭. 「미확인」은 아직 보지 않은 것이며 완료가 아니다.
- ★ 대표 화면(2단계): 관리자 로그인 · 방송 대시보드 · 주문 목록 · HIT 카드 · 오버레이 편집기 · 구매자 상품 상세 · 주문서 · 주문 내역. 검수 폭 360/390/768/1024/1280/1440/1920.

## 마스터 관리자

| 화면 | 경로 | 화면 ID | 1단계 공통 규격 | 화면별 정리 | PC·모바일 확인 |
|---|---|---|---|---|---|
| 마스터 관리자 로그인 ★ | `/admin/login` | AU-001 | 자동 반영 | 완료(2단계: 인증 카드 공통 여백·제목 20/28·항목 간격 16, 오류 상태·키보드 시험) | 확인(360·390·768·1024·1280·1440·1920, e2e layout-admin-login) |
| 대시보드 | `/admin` | MA | 자동 반영 | 대기 | 미확인 |
| 관리자 계정 | `/admin/accounts` | MA | 자동 반영 | 대기 | 미확인 |
| 역할 | `/admin/accounts/roles` | MA | 자동 반영 | 대기 | 미확인 |
| 청구·결제 내역 | `/admin/billing/invoices` | MA | 자동 반영 | 대기 | 미확인 |
| 청구 상세 | `/admin/billing/invoices/[paymentId]` | MA | 자동 반영 | 대기 | 미확인 |
| 구독 현황 | `/admin/billing/subscriptions` | MA | 자동 반영 | 대기 | 미확인 |
| 로그 추적 | `/admin/logs` | MA | 자동 반영 | 대기 | 미확인 |
| 로그 상세 | `/admin/logs/[logId]` | MA | 자동 반영 | 대기 | 미확인 |
| 파트너스 목록 | `/admin/partners` | MA | 자동 반영 | 대기 | 미확인 |
| 파트너스 상세 | `/admin/partners/[sellerId]` | MA | 자동 반영 | 대기 | 미확인 |
| 가입 신청 | `/admin/partners/applications` | MA | 자동 반영 | 대기 | 미확인 |
| 가입 신청 상세 | `/admin/partners/applications/[sellerId]` | MA | 자동 반영 | 대기 | 미확인 |
| 브랜딩 | `/admin/settings/branding` | MA | 자동 반영 | 대기 | 미확인 |
| 발송 단가 | `/admin/settings/messages` | MA-086 | 자동 반영 | 대기 | 미확인 |
| 준비 중 화면 | `/admin/[...slug]` | MA | 자동 반영 | 대기 | 미확인 |

## 파트너스 관리자·관리자 인증

| 화면 | 경로 | 화면 ID | 1단계 공통 규격 | 화면별 정리 | PC·모바일 확인 |
|---|---|---|---|---|---|
| 파트너스 로그인 | `/seller/login` | AU-002 | 자동 반영(인증 카드 공통 여백·제목은 2단계에서 함께 바뀜) | 대기 | 확인(1440·390) |
| 아이디 찾기 | `/seller/find-id` | AU-011 | 자동 반영 | 대기 | 미확인 |
| 비밀번호 찾기 | `/seller/password-reset` | AU-003·004 | 자동 반영 | 대기 | 미확인 |
| 본인확인 연결 | `/seller/identity-link` | AU-012 | 자동 반영 | 대기 | 미확인 |
| 파트너스 가입 | `/seller/signup` | PF-007 | 자동 반영 | 대기 | 미확인 |
| 방송 대시보드 ★ | `/seller/broadcast` | SA-001 | 자동 반영 | 대기 | 확인(1440·390) |
| HIT 카드 ★ | `/seller/hit-cards` | SA | 자동 반영 | 대기 | 확인(1440·390) |
| 오버레이 편집기 ★ | `/seller/overlay` | SA-052 | 자동 반영 | 대기 | 확인(1440·390, 편집 캔버스 정리는 2단계) |
| 유튜브 연결 | `/seller/youtube` | SA | 자동 반영 | 대기 | 미확인 |
| 주문 목록 ★ | `/seller/orders` | SA-020 | 자동 반영 | 대기 | 확인(1440·390) |
| 주문 상세 | `/seller/orders/[orderId]` | SA | 자동 반영 | 대기 | 미확인 |
| 교환·반품 | `/seller/returns` | SA | 자동 반영 | 대기 | 미확인 |
| 배송 | `/seller/shipping` | SA | 자동 반영 | 대기 | 미확인 |
| 상품 목록 | `/seller/products` | SA-010 | 자동 반영 | 대기 | 확인(1440·390·360, 휴대폰 검색 상자 한 열) |
| 상품 등록·수정 | `/seller/products/new · [productId]` | SA | 자동 반영 | 대기 | 미확인 |
| 재고 관리 | `/seller/products/stock` | SA | 자동 반영 | 대기 | 미확인 |
| 구매 제한 | `/seller/purchase-restrictions` | SA | 자동 반영 | 대기 | 미확인 |
| 회원 목록·상세 | `/seller/members · [memberId]` | SA | 자동 반영 | 대기 | 미확인 |
| 적립금 | `/seller/rewards` | SA | 자동 반영 | 대기 | 미확인 |
| 상품 리뷰 | `/seller/reviews` | SA | 자동 반영 | 대기 | 미확인 |
| 쿠폰 | `/seller/coupons` | SA | 자동 반영 | 대기 | 미확인 |
| 홈 배너·이벤트 팝업 | `/seller/banners · banners/popups` | SA-064·065 | 자동 반영 | 대기 | 미확인 |
| 통계(6화면) | `/seller/stats/**` | SA | 자동 반영 | 대기 | 미확인 |
| 쇼핑몰 정보·공유·주문·회원·배송 설정 | `/seller/settings/**` | SA-060 등 | 자동 반영 | 대기 | 미확인 |
| 직원 계정 | `/seller/staff` | SA-100 | 자동 반영 | 대기 | 미확인 |
| 구독 | `/seller/subscription` | SA | 자동 반영 | 대기 | 미확인 |

## 구매자 쇼핑몰

| 화면 | 경로 | 화면 ID | 1단계 공통 규격 | 화면별 정리 | PC·모바일 확인 |
|---|---|---|---|---|---|
| 쇼핑몰 홈 | `/shop/[slug]` | SH-001 | 자동 반영 | 대기 | 확인(1440·390, 버튼·입력 없음) |
| 상품 목록·검색 | `/shop/[slug]/products · search` | SH | 자동 반영 | 대기 | 미확인 |
| 상품 상세 ★ | `/shop/[slug]/products/[productId]` | SH | 자동 반영 | 대기 | 확인(1440·390) |
| 장바구니 | `/shop/[slug]/cart` | SH | 자동 반영 | 대기 | 미확인 |
| 주문서 ★ | `/shop/[slug]/checkout` | SH | 자동 반영 | 대기 | 미확인(구매자 로그인 필요, 2단계) |
| 주문 내역·상세 ★ | `/shop/[slug]/orders · [orderId]` | SH | 자동 반영 | 대기 | 미확인(구매자 로그인 필요, 2단계) |
| MY·알림 | `/shop/[slug]/me · me/notifications` | SH | 자동 반영 | 대기 | 미확인 |
| 쿠폰·찜·리뷰 | `/shop/[slug]/coupons · wishlist · reviews` | SH | 자동 반영 | 대기 | 미확인 |
| 고객센터 | `/shop/[slug]/help/**` | SH-030 | 자동 반영 | 대기 | 미확인 |
| 구매자 로그인·가입 | `/shop/[slug]/login · signup` | SH-011 | 자동 반영 | 대기 | 미확인 |

## 공개 화면

| 화면 | 경로 | 화면 ID | 1단계 공통 규격 | 화면별 정리 | PC·모바일 확인 |
|---|---|---|---|---|---|
| 서비스 소개 | `/about` | PF-001 | 자동 반영 | 대기 | 미확인(e2e public-landing 통과만) |

## 오버레이 방송 출력

| 화면 | 경로 | 화면 ID | 1단계 공통 규격 | 화면별 정리 | PC·모바일 확인 |
|---|---|---|---|---|---|
| OBS 오버레이 출력 | `/overlay/[token]` | OV | 적용 안 함(규격상 제외, `lop.css`를 불러오지 않음) | 해당 없음 | 해당 없음 |

## 공통 부품

| 부품 | 파일 | 상태 |
|---|---|---|
| 의미 토큰 | `styles/tokens.css` `--ui-*` | 1단계 완료 |
| 버튼·입력·선택·검색·표·배지·탭·세그먼트·칩·페이지 이동·메뉴·안내·토스트 | `styles/lop.css` | 1단계 완료(크기·모서리·글자·포커스·전환) |
| 관리자 공통(셸 본문·표·검색 상자·표형 폼·목록 머리) | `styles/seller.css` 공통부, `components/admin-ui/*` | 1단계 완료. `PageHead` 경로 중복 제거, `ListHead`에 「불러온 n건」 |
| 공통 모달 | `components/admin-ui/Modal.tsx` | 1단계 기반 완료. 화면별 모달 약 23곳 전환은 2~4단계 |
| 구매자 모달 | `components/shop/ShopModal.tsx` | 모서리·X 크기만 토큰으로 맞춤. 포커스 가둠·배경 스크롤 차단·미저장 확인은 공통 모달로 전환할 때(4단계) |
| 셸 | `components/seller/SellerShell.tsx`, `app/(admin)/admin/_components/AdminShell.tsx` | 대기(열린 PR이 메뉴 줄을 고치는 중이라 1단계에서 제외) |

## 모달 전환 담당(공통 Modal)

| 모달 | 파일 | 담당 |
|---|---|---|
| 발송 단가 변경 창 | `app/(admin)/admin/_components/ValueDialog.tsx` | 완료(1단계, #372) |
| 정지·계정·충전 확인·무상 지급 창 | `app/(admin)/admin/_components/*`, 발송 단가 화면 | 소유 세션 전환(브랜딩 전담 (2)) |
| 환불 창 | `components/seller/RefundModal.tsx` | 소유 세션 전환(개발 전담 (화면) (3)) |
| HIT 카드 등록 창 | `app/(seller)/seller/(shell)/hit-cards/page.tsx` | 소유 세션 전환(화면-방송 (2)) |
| 방송 대시보드 모달 | `components/seller/broadcast/Modals.tsx` | 레이아웃 전담 2단계(잠금 승인) |
| 오버레이 편집기 모달 | `components/seller/OverlayEditor.tsx` | 레이아웃 전담 2단계(잠금 승인) |
| 그 밖의 파트너스 모달 | `feat/admin-modal` 전환분(레이아웃 (2) 인계) | 레이아웃 전담 3단계(화면별 잠금 뒤) |
| 구매자 모달 | `components/shop/ShopModal.tsx` | 레이아웃 전담 4단계(잠금 뒤) |

## 알려진 문제(1단계에서 확인, 고치지 않음)

- 보조 글자색 `--wds-label-assistive`(관리자 `#9ca1aa`)는 흰 바탕 대비 2.6:1로 4.5:1에 못 미친다. 자리 표시(placeholder)·준비 중 메뉴에 쓰인다. 준비 중 메뉴는 비활성 표시라 대비 기준 예외지만, 안내 문구에 쓰인 곳은 2·3단계에서 화면마다 바꾼다(기존 문제).
- 주문 목록 금액 열이 오른쪽 정렬이다(화면 CSS `.r`). 「값 왼쪽 정렬」 규칙과 다르다(기존 문제, 2단계).
- 주문 목록 검색 줄: 검색 입력(40)과 기간·상태 칩(32)의 높이가 다르다(화면 CSS, 2단계).
- 방송 대시보드 휴대폰 폭 요약 칸 왼쪽 세로선이 한 칸에만 보인다(화면 CSS, 2단계).
