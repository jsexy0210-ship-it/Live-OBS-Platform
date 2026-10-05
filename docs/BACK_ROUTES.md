# 화면 Back 경로표 (1단계)

> 대표님 지시(2026-10-05): 「화면 진입 시 Back 기능도 없다. 진입부터 돌아가는 모든 루트를 계산해서 사용성 대폭 늘린다」
> 규칙 정본: `docs/IA.md` 「Back · 상태 보존 규칙」 · 출발점: `docs/UX_AUDIT.md` · 도우미: `lib/client/navigation/`
> 기준: main `7e8290a` 코드를 정적으로 읽어 작성(2026-10-05 KST). 「현재」 칸은 코드 확인 값이며, 실제 렌더·클릭 증거는 2단계 PR마다 붙입니다. 이 문서는 구현하지 않습니다.

## 0. 읽는 법

**들어오는 길 기호**

| 기호 | 뜻 |
|---|---|
| M | 메뉴(GNB·LNB·Drawer·하단 탭) |
| R | 목록 행·버튼 |
| N | 알림 종(`GnbTools`) · 알림 센터 |
| G | 전역 검색(`GnbTools`) |
| H | 홈·대시보드 할 일 카드·안내 링크 |
| F | 폼 저장·결제·가입 같은 흐름의 다음 단계 |
| L | 로그인·가입 성공 뒤 이동 |
| D | 직접 URL·새로고침·즐겨찾기·외부 링크·메일 링크 |

**← 결과** — 「이전」은 앱 안 이전 기록이 있을 때(`router.back()`), 「직접」은 직접 진입·다른 영역에서 왔을 때 부모로 `replace`(IA 1항). 상세가 여러 목록에서 열리는 경우(G·N·H)는 이전 기록으로 돌아가므로 부모는 직접 진입 때만 쓴다.

**현재(코드 확인)**

| 값 | 뜻 |
|---|---|
| 있음 | 진입 즉시 화면 ←(`useSmartBack`)과 이 줄의 복원·확인 항목이 모두 구현됨 |
| 부분 | 일부만 있음(괄호에 빠진 것) |
| 없음 | 화면 ← 없음, 또는 상태 보존 없음 |
| 잘못됨 | 부모 주소 고정 `Link`·`push`처럼 IA 1항과 다르게 동작 |
| 최상위 | 최상위 메뉴 화면이라 화면 ←은 필요 없음. 상태 보존 항목만 판정 |

**복원 상태** — 검색(q)·필터·정렬·페이지 크기·탭은 URL(`useUrlState`), 스크롤은 `useScrollRestore`. 개인정보·서버 계약에 안 맞는 값은 history state.
**미저장** — 「필요」는 `useUnsavedGuard` 대상(입력이 있는 큰 폼). 「—」는 불필요.

**현재 구현 요약(코드 확인, 전체 page.tsx 144개)**
- `useSmartBack` 사용: 마스터 상세 6곳(청구·로그·자동 연결 작업·파트너스·가입 신청·문의), 파트너스 재고 관리(`goList`), 구매자 `ShopBack`(상품·주문 상세). 파트너스 상세·하위 화면은 전부 부모 주소 고정 `Link`.
- URL·스크롤 복원 적용 목록: 파트너스 상품·전체 주문·환불 요청·회원·구매자 문의·배송·교환 반품·리뷰·재고 관리, 마스터 파트너스·가입 신청·청구·로그·문의·공지·PG. 그 밖의 목록·탭은 없음.
- `useUnsavedGuard` 사용: 파트너스 오버레이(`/seller/overlay`)·상품 등록·수정·검색어 동의어.

---

## 0-1. 새 메뉴 구조(DS-NAV) 반영 (MASTER 지시, `docs/IA.md` PR #637 「확정 메뉴 구조」 2026-10-06)

- 새 GNB: 파트너스 = 홈·방송·주문·상품·고객·마케팅·통계·설정, 마스터 = 홈·파트너스·요금·결제·운영·고객지원·설정, 구매자 = 구조 유지. 아래 1~4장의 메뉴 소속(예: 「분석」→「통계」, 정산 그룹, 관리자 그룹, 스토어 그룹)은 이 구조 기준으로 읽는다.
- **부모(fallback) 경로 규칙**: 부모는 「그 화면이 속한 최상위 메뉴 화면의 주소」다. 메뉴 이름·그룹이 바뀌어도 주소가 같으면 표의 부모는 그대로다. 주소가 바뀌거나 탭으로 합쳐지는 화면은 새 주소(탭 쿼리 포함)로 고친다.
- **통합 화면(탭)**: IA는 「통합 9건은 한 화면 탭」, 「통합된 화면의 기존 주소는 새 화면(해당 탭)으로 이동」이라고만 적고 대상 목록은 DS-NAV 보드(캔버스 v275)에 있다. 이 소스는 아직 `design/project`에 없어(현재 main에 DS-NAV 없음) **어떤 화면이 어느 탭이 되는지는 확정하지 못했다**. 정본 동기화 PR이 병합되면 이 표의 해당 행(부모·복원할 상태의 「탭」)을 같은 방식으로 고치고, 2단계 PR은 확정된 행부터 진행한다. 추측으로 부모를 바꾸지 않는다(`BLOCKED: DESIGN_SOURCE_UNRESOLVED`, 정본 확정 전 대상: 파트너스 게시판→고객·프로모션+디자인→마케팅 하위, 마스터 정산 2화면·관리자 3화면).
- **← 버튼 위치·모양**: 디자인 (4)의 셸 보드와 레이아웃 (5) 구현을 따른다. 이 문서는 정하지 않는다.
- **← 동작 확정(MASTER 결정 2026-10-06, A+절충)**: IA 1항 유지 — 앱 안 이전 기록이 있으면 `router.back()`, 없거나 직접·외부 진입이면 이 표의 부모로 `replace`. 부모 값은 경로 줄(breadcrumb) 바로 앞 항목과 일치시킨다. ← 는 메뉴 화면·홈을 뺀 모든 화면에 보이고, 다이얼로그·휴대폰 시트는 ← 없이 자체 X·취소를 쓴다. 위치·크기는 디자인 (4) 안(DS-NAV 「화면 ← 버튼」 절)을 따른다.
- 검수 전담 (5) `session_012JyUS33LLXBeuX7LfdgDTB`(MASTER 통지).

---

## 1. 파트너스 관리자 (`/seller/**`, 로그인 뒤 `(shell)`)

최상위 메뉴 = `components/seller/SellerShell.tsx` MENU의 `href` 있는 항목 + GNB 오른쪽 유틸(공지·도우미·알림).

### 1-1. 최상위 메뉴 화면 (← 불필요, 상태 보존만 판정)

| ID | route | 들어오는 길 | 복원할 상태 | 미저장 | 현재 |
|---|---|---|---|---|---|
| SA-001 | `/seller/broadcast` | M·H·L | 없음(실시간 화면) | — | 최상위 |
| SA-002 / -O | `/seller`, `/seller/home-overlay` | M·L·H | 없음. `/seller`는 `/seller/products`로 307(UX-06, J-2) | — | 최상위 |
| SA-003/004 | `/seller/onboarding` | M(LNB 전용)·H | 없음 | — | 최상위 |
| SA-051 | `/seller/overlay` | M·H | 편집 중 위젯 | 필요 | 부분(링크·새로고침은 막힘, 브라우저 Back 미차단 — UX-05) |
| SA-052 | `/seller/overlay` (URL 영역) | 같은 화면 | — | — | 최상위 |
| SA-053 | `/seller/hit-cards` | M·H | 기간·페이지 | — | 없음(조건 URL 없음) |
| SA-054 | `/seller/broadcasts` | M·H | 기간·페이지 | — | 없음(조건 URL 없음) |
| SA-006 | `/seller/external-shops` | M·H | 없음 | — | 최상위 |
| SA-057 | `/seller/youtube` | M·H | 없음 | — | 최상위 |
| SA-150 | `/seller/automation` | M·H | 없음 | — | 최상위 |
| SA-021 | `/seller/orders` | M·H(오늘 할 일)·N | q·기간·상태·정렬·페이지 크기·스크롤 | — | 있음(URL·스크롤) |
| SA-026 | `/seller/orders/deposits` | M·H·N | 스크롤(탭·검색이 있으면 URL) | — | 부분(스크롤만, 조건 URL 없음) |
| SA-023 | `/seller/orders/refund-requests` | M·H·N | 탭·스크롤 | — | 있음(URL·스크롤) |
| SA-029 | `/seller/returns` | M·H·N | 조건·스크롤 | — | 있음(URL·스크롤) |
| SA-025 | `/seller/shipping` | M·H·N | 탭·검색·스크롤 | — | 있음(URL·스크롤) |
| SA-011 | `/seller/products` | M·H·F(저장 뒤) | q·status·sort·limit·스크롤 | — | 있음(URL·스크롤) |
| SA-012 신규 | `/seller/products/new` | M·H | 입력값(폼) | 필요 | 부분(가드 있음, 저장 뒤 `router.push`라 등록 화면이 기록에 남음) |
| SA-014 | `/seller/products/stock` | M·H·R | q·필터·스크롤 | 변경 N건 입력 중이면 필요 | 있음(`goList`·URL·스크롤, 미저장 확인은 2단계 확인) |
| SA-015 | `/seller/products/categories` | M | 없음 | 편집 중이면 필요 | 부분(가드 없음) |
| SA-016 | `/seller/products/display` | M | 없음 | 순서 편집 중이면 필요 | 부분(가드 없음) |
| SA-017 | `/seller/products/restock-alerts` | M·N | 없음 | — | 최상위 |
| (동의어) | `/seller/products/search-synonyms` | R(상품 목록) | 없음 | 필요 | 부분(가드 있음, 화면 ← 없음 — 메뉴에 없는 화면이라 ← 필요) → 1-2 |
| SA-041 | `/seller/members` | M·H·G | 탭(활동·휴면)·q·스크롤 | — | 있음(URL·스크롤) |
| SA-044 | `/seller/member-grades` | M | 없음 | 등급 편집 중이면 필요 | 부분(가드 없음) |
| SA-043 | `/seller/purchase-restrictions` | M·R(회원 상세) | q·탭 | — | 없음 |
| SA-049 | `/seller/member-messages` | M | 없음 | 작성 중이면 필요 | 부분(가드 없음) |
| SA-031 | `/seller/rewards` | M | 없음 | 정책 편집 중이면 필요 | 부분(가드 없음) |
| SA-033 | `/seller/rewards/balances` | M·R | q·페이지 | — | 없음 |
| SA-032 | `/seller/rewards/ledger` | M | 기간·페이지 | — | 없음 |
| SA-034 | `/seller/rewards/live-payout` | M | 없음 | — | 최상위 |
| SA-046 | `/seller/buyer-inquiries` | M·H·N | 탭·q·스크롤, 상세는 같은 화면 패널(SA-047) | 답변 작성 중이면 필요 | 부분(URL·스크롤 있음, 답변 가드 없음) |
| SA-048 | `/seller/reviews` | M·H·N | 탭·열린 행·스크롤 | 답글 작성 중이면 필요 | 부분(URL·스크롤 있음, 답글 가드 없음) |
| SA-035 | `/seller/coupons` | M | 탭·페이지 | 쿠폰 작성 중이면 필요 | 없음 |
| SA-064 | `/seller/banners` | M | 없음 | 편집 중이면 필요 | 부분(가드 없음) |
| SA-065 | `/seller/banners/popups` | M(배너 · 팝업 안 탭 또는 링크) | 없음 | 편집 중이면 필요 | 부분(가드 없음). 부모가 `/seller/banners`인 하위 탭이면 ← 필요 → 1-2 |
| SA-066 | `/seller/settings/shop-notices` | M | 탭·편집 중 항목 | 필요 | 부분(가드 없음) |
| SA-056 | `/seller/stats` | M·H | 기간·스크롤 | — | 없음(기간 URL 없음) |
| SA-060 | `/seller/settings/shop` | M | 입력값 | 필요 | 부분(가드 없음) |
| SA-061 | `/seller/settings/shipping` | M | 입력값 | 필요 | 부분(가드 없음) |
| SA-063 | `/seller/settings/order` | M | 입력값 | 필요 | 부분(가드 없음) |
| SA-068 | `/seller/settings/member` | M | 입력값 | 필요 | 부분(가드 없음) |
| (공유) | `/seller/settings/share` | M | 입력값 | 필요 | 부분(가드 없음) |
| SA-062 | `/seller/settings/legal` | M | 입력값 | 필요 | 부분(가드 없음) |
| SA-067 | `/seller/settings/seo` | M | 입력값 | 필요 | 부분(가드 없음) |
| SA-080 | `/seller/settings/order-notifications` | M | 입력값 | 필요 | 부분(가드 없음) |
| SA-081 | `/seller/settings/message-balance` | M·H(잔액 부족 안내)·N | 거래 내역 기간·페이지 | 설정 편집 중이면 필요 | 부분(가드 없음) |
| SA-100 | `/seller/staff` | M | 없음 | 직원 폼 입력 중이면 필요 | 부분(가드 없음) |
| SA-090 | `/seller/subscription` | M·H·N | 없음 | — | 최상위 |
| SA-111 | `/seller/notices` | M(유틸)·H·N | 페이지 | — | 최상위(조건 URL 없음) |
| SA-113 | `/seller/inquiries` | H(문의 링크)·N | 페이지·탭 | — | 없음(GNB 메뉴 항목이 아니라 안내 링크로 들어오는 화면이라 ← 필요 여부는 2단계에서 확정) |
| SA-130 | `/seller/notifications` | N(종 → 전체 보기) | 필터·페이지 | — | 최상위(유틸) |
| SA-140 | `/seller/assistant` | M(유틸) | 대화 | — | 최상위 |

### 1-2. 하위·상세·흐름 화면 (← 필요)

| ID | route | 들어오는 길 | ← 결과 (이전 / 직접 fallback 부모) | 복원할 상태 | 미저장 | 현재 |
|---|---|---|---|---|---|---|
| SA-012 수정 | `/seller/products/[productId]` | R(상품 목록 이름·수정)·G·N | 이전(조건·스크롤 복원) / `/seller/products` | 목록 조건·스크롤 | 필요 | 잘못됨(「취소」·경로 줄·없는 상품 「상품 목록」이 `/seller/products` 고정 Link, UX-03) |
| SA-022 | `/seller/orders/[orderId]` | R·G·N·H·D(메일) | 이전 / `/seller/orders` | 전체 주문 조건·스크롤. 「환불 처리」로 들어오면 환불 창이 열린 채 | 환불 창 사유 입력 중이면 모달 닫기 확인만 | 잘못됨(「주문 목록으로」 고정 Link) |
| SA-042 | `/seller/members/[memberId]` | R·G·N | 이전 / `/seller/members` | 회원 목록 조건·스크롤 | 메모·등급 입력 중이면 필요 | 잘못됨(「회원 목록」 고정 Link) |
| SA-055 | `/seller/broadcasts/[broadcastId]` | R(방송 이력)·H(방송 종료 뒤)·N | 이전 / `/seller/broadcasts` | 방송 이력 조건·스크롤 | — | 잘못됨(「목록」 고정 Link) |
| SA-056 하위 | `/seller/stats/orders`, `/sales`, `/products`, `/members`, `/broadcasts` | R(통계 카드 「자세히」) | 이전 / `/seller/stats` | 통계 기간 | — | 없음(화면 ← 없음) |
| SA-112 | `/seller/notices/[id]` | R·N·H·D | 이전 / `/seller/notices` | 공지 목록 페이지 | — | 잘못됨(「목록으로」 고정 Link) |
| SA-114 | `/seller/inquiries/new` | R(내 문의 「문의하기」)·H·공지 상세 「문의」(`?noticeId=`) | 이전 / `/seller/inquiries` | 쿼리(`noticeId`) | 필요 | 잘못됨(「목록」 Link + 자체 `window.confirm`, 저장 뒤 `router.push`라 작성 화면이 기록에 남음) |
| SA-115 | `/seller/inquiries/[id]` | R·F(작성 뒤)·N·H | 이전 / `/seller/inquiries` | 내 문의 목록 | 답변 작성 중이면 필요 | 잘못됨(고정 Link) |
| SA-151 | `/seller/automation/pay` | M(자동 연결 → 구매)·R | 이전 / `/seller/automation` | — | 결제 폼 입력 중이면 필요 | 잘못됨(「이전」 고정 Link, 성공 뒤 `router.push`) |
| SA-152 | `/seller/automation/[jobId]` | F(결제 뒤)·H·N·D | 이전 / `/seller/automation` | — | — | 없음(화면 ←·진행 중 새로고침 복귀는 서버 상태 기준) |
| SA-153 | `/seller/automation/[jobId]/done` | F(성공 `replace`)·N | 이전 / `/seller/broadcast` | — | — | 부분(성공은 `replace`라 진행 화면이 기록에 안 남음. ← 없음) |
| (동의어) | `/seller/products/search-synonyms` | R(상품 목록) | 이전 / `/seller/products` | 상품 목록 조건 | 필요 | 부분(가드 있음, ← 없음) |
| SA-065 | `/seller/banners/popups` | R(배너 · 팝업 → 이벤트 팝업) | 이전 / `/seller/banners` | — | 필요 | 확인 필요(메뉴 항목 아님, 탭이면 ← 불필요 — 2단계에서 정본 확인) |
| — | `/seller/suspended` | L·D(정지 계정 접근 시) | 로그아웃 또는 문의(AU-006) | — | — | 확인 필요(AU-006, 아래 4장) |

### 1-3. 그 밖

- `/seller/[...slug]`(없는 주소, `notFound`)는 다음 행동이 필요합니다(IA 8항, 5장 BR-13). `/seller/suspended`·`/seller/pending`은 4장.

---

## 2. 마스터 관리자 (`/admin/**`)

최상위 메뉴 = `app/(admin)/admin/_components/menu.ts`의 항목 + GNB 알림.

### 2-1. 최상위 메뉴 화면

| ID | route | 들어오는 길 | 복원할 상태 | 미저장 | 현재 |
|---|---|---|---|---|---|
| MA-001 | `/admin` | M·L | 없음 | — | 최상위 |
| MA-002 | `/admin/notifications` | N | 필터·페이지 | — | 최상위(조건 URL 없음) |
| MA-011 | `/admin/partners` | M·H·G | q·status·plan·스크롤 | — | 있음(URL·스크롤) |
| MA-013 | `/admin/partners/applications` | M·H(가입 대기)·N | 상태 필터·스크롤(처리 뒤 목록 유지) | — | 부분(URL·스크롤 있음, 상세 → 목록은 목록을 다시 엶 — UX 감사 9.3) |
| MA-021/022 | `/admin/billing/plans` | M | 없음 | 요금 편집 다이얼로그는 닫기 확인 | 최상위 |
| MA-023 | `/admin/billing/subscriptions` | M·H | 상태·페이지·q | — | 없음(조건 URL 없음) |
| MA-024 | `/admin/billing/invoices` | M·H·R(파트너스 상세 「청구」: `?sellerId=`) | sellerId·상태·기간·스크롤 | — | 있음(URL·스크롤) |
| MA-026 | `/admin/billing/refunds` | M·H·N | 상태·페이지 | — | 없음(조건 URL 없음) |
| MA-031 | `/admin/settlement/pg` | M | 조건·스크롤 | — | 있음 |
| MA-032 | `/admin/settlement/collection` | M | 조건 | — | 부분(URL 있음, 스크롤 없음) |
| MA-041 | `/admin/ops/live` | M·H | 없음(실시간) | — | 최상위 |
| MA-042 | `/admin/ops/access` | M | 없음 | — | 최상위 |
| MA-043 | `/admin/ops/rewards` | M | q | — | 최상위 |
| MA-100 | `/admin/ops/monitor` | M | 없음 | — | 최상위 |
| MA-110 | `/admin/ops/automation` | M·H | 상태·페이지 | — | 부분(URL 있음, 스크롤 없음). 메뉴 항목은 `/admin/ops/jobs`(미구현 「준비 중」)이고 실제 화면은 `/admin/ops/automation` — 메뉴 경로 불일치, 2단계에서 MASTER 확인 |
| MA-051 | `/admin/support/inquiries` | M·H·N | 상태·q·스크롤 | — | 있음 |
| MA-053 | `/admin/support/notices` | M·F(저장 뒤 `?saved=`) | 상태·페이지·스크롤 | — | 있음(저장 안내 쿼리 `saved`·`stale`는 복원 대상 아님) |
| MA-055 | `/admin/support/assistant` | M | 없음 | 편집 중이면 필요 | 부분(가드 없음) |
| MA-061/062 | `/admin/accounts` | M | q·역할 | 계정 다이얼로그는 닫기 확인 | 최상위(조건 URL 없음) |
| MA-063 | `/admin/accounts/roles` | M | 없음 | — | 최상위 |
| MA-070 | `/admin/logs` | M·H·R(상세에서 필터 링크) | q·기간·유형·스크롤 | — | 있음 |
| MA-082·086 | `/admin/settings/messages` | M | 입력값 | 필요 | 부분(가드 없음) |
| MA-083 | `/admin/settings/maintenance` | M | 입력값 | 필요(켜기 전 확인은 있음) | 부분(가드 없음) |
| MA-084 | `/admin/settings/assistant` | M | 입력값 | 필요 | 부분(가드 없음) |
| MA-085 | `/admin/settings/branding` | M | 입력값 | 필요 | 부분(가드 없음) |
| — | `/admin/settings/vendors` | M | 탭 | 설정 입력 중이면 필요 | 부분(URL 있음, 가드 없음) |
| — | `/admin/account` | 우상단 계정 메뉴 | 없음 | 비밀번호 폼은 필요 | 부분(가드 없음). 메뉴 항목이 아니라 유틸이면 ← 불필요 — 정본 확인 |
| — | `/admin/[...slug]` | D(없는 주소·「준비 중」 메뉴) | 다음 행동 필요(IA 8항) | — | 확인 필요 → 5장 |

### 2-2. 하위·상세 화면

| ID | route | 들어오는 길 | ← 결과 (이전 / 직접 fallback) | 복원할 상태 | 미저장 | 현재 |
|---|---|---|---|---|---|---|
| MA-012 | `/admin/partners/[sellerId]` | R·G·N·H(청구·환불 상세의 파트너스 링크) | 이전 / `/admin/partners` | 목록 조건·스크롤 | 메모·사유 입력은 모달이라 닫기 확인 | 있음(`useSmartBack`, 탭 URL) |
| MA-014 | `/admin/partners/applications/[sellerId]` | R·N·H | 이전 / `/admin/partners/applications` | 목록 조건·스크롤 | 반려 사유는 모달 | 있음(`useSmartBack`). 처리 뒤 목록 이동 방식(`router` 미사용)은 UX 감사 M1 소관 |
| MA-025 | `/admin/billing/invoices/[paymentId]` | R·G·N·H | 이전 / `/admin/billing/invoices` | 목록 조건·스크롤 | — | 있음 |
| MA-027 | `/admin/billing/refunds/[refundId]` | R·N·H | 이전 / `/admin/billing/refunds` | 목록 조건 | 처리 사유는 폼이라 필요 | 잘못됨(「목록」 고정 Link, `useSmartBack` 없음) |
| MA-052 | `/admin/support/inquiries/[inquiryId]` | R·N·H | 이전 / `/admin/support/inquiries` | 목록 조건·스크롤 | 답변 작성 중이면 필요 | 부분(`useSmartBack` 있음, 답변 가드 미확인) |
| MA-054 신규 | `/admin/support/notices/new` | M·R(목록 「작성」) | 이전 / `/admin/support/notices` | 목록 조건 | 필요 | 잘못됨(저장 `router.push`, ← 없음, 가드 없음) |
| MA-054 수정 | `/admin/support/notices/[noticeId]` | R | 이전 / `/admin/support/notices` | 목록 조건·스크롤 | 필요 | 잘못됨(저장 `router.push`, ← 없음, 가드 없음) |
| MA-071 | `/admin/logs/[logId]` | R·G·N | 이전 / `/admin/logs` | 목록 조건·스크롤 | — | 있음 |
| MA-111 | `/admin/ops/automation/[jobId]` | R·N·H | 이전 / `/admin/ops/automation` | 목록 조건 | — | 있음 |

---

## 3. 구매자 쇼핑몰 (`/shop/[slug]/**`)

최상위 = 하단 탭(홈·상품·장바구니·내 정보)·상단 헤더 메뉴·Drawer의 항목. 아래 「최상위」는 이 기준.

| ID | route | 최상위 | 들어오는 길 | ← 결과 (이전 / 직접 fallback) | 복원할 상태 | 미저장 | 현재 |
|---|---|---|---|---|---|---|---|
| SH-001 | `/shop/[slug]` | ● | M·D·L | — | 스크롤 | — | 최상위 |
| SH-002 | `/shop/[slug]/products`, `/search` | ● | M(헤더 검색·Drawer)·H·D | — | q·sort·카테고리(URL), 스크롤 | — | 부분(q·sort URL 있음, 스크롤 일부 — UX-22) |
| SH-003 | `/shop/[slug]/products/[productId]` | | R·G(헤더 검색)·H·N(재입고 알림 메일)·D | 이전 / `/shop/{slug}/products` | 목록 조건·스크롤 | — | 있음(`ShopBack`) |
| SH-004 | `/shop/[slug]/cart` | ● | M·F(상세 「담기」 토스트) | 이전 / `/shop/{slug}` | 없음 | — | 최상위. 비로그인은 제자리 안내(UX-19) |
| SH-005 | `/shop/[slug]/checkout` | | F(장바구니 「주문하기」·상세 「바로 구매」) | 이전 / `/shop/{slug}/cart` | 입력값(배송지·쿠폰·적립금) | 필요 | 없음(화면 ← 없음, 가드 없음. 모바일 하단 탭이 함께 보임) |
| SH-006/008 | `/shop/[slug]/checkout` (결제·실패) | | F(결제 진행) | 이전 / `/shop/{slug}/cart` | 장바구니·입력값 | 결제 중 이탈 확인(필요) | 없음 |
| SH-007 | `/shop/[slug]/orders/[orderId]?done=1` | | F(결제 완료 `router.push`) | 완료 화면은 「주문 내역」·「쇼핑 계속」, ←는 `/orders`로 replace(결제 화면으로 안 돌아감) | — | — | 부분(`ShopBack` 있으나 결제 완료 뒤 Back이 주문서로 돌아가는지 확인 필요) |
| SH-010 | `/shop/[slug]/login` | | M·L 필요 화면(`next`)·D | 이전 / `/shop/{slug}` | `next` | — | 있음(성공은 `location.replace`). 로그인된 채 진입은 폼이 보임(UX-07 T5, `redirect`로 처리하는지 2단계 확인) |
| SH-011 | `/shop/[slug]/signup` | | 로그인 화면 「회원가입」·F | 이전 / `/shop/{slug}/login` | 입력값 | 필요(약관·본인 확인 포함) | 없음 |
| SH-020 | `/shop/[slug]/me` | ● | M(하단 「내 정보」) | — | 없음 | — | 최상위. 모바일 허브 부족(UX-08) |
| SH-021 | `/shop/[slug]/orders` | | M(Drawer 「주문 조회」·MY 메뉴)·H(메일)·D | 이전 / `/shop/{slug}/me` | 탭(전체·취소·환불)·스크롤 | — | 없음(탭 URL 없음 — UX-10, 화면 ← 없음) |
| SH-022 | `/shop/[slug]/orders/[orderId]` | | R·F·N(메일)·D | 이전 / `/shop/{slug}/orders` | 주문 내역 탭·스크롤 | 교환·반품 시트 입력 중이면 닫기 확인 | 있음(`ShopBack`) |
| SH-022-R | 주문 상세 안 시트 | | R | 시트 닫기(주소 연결 시 Back, IA 4항) | — | 필요 | 확인 필요 |
| SH-025 | `/shop/[slug]/me/notifications` | | R(내 정보)·D(메일 수신 거부) | 이전 / `/shop/{slug}/me` | — | 변경 중이면 필요 | 없음 |
| SH-028 | `/shop/[slug]/coupons` | | R(내 정보·결제 화면 「쿠폰」) | 이전 / `/shop/{slug}/me` | — | — | 없음(비로그인 제자리 안내) |
| SH-029 | `/shop/[slug]/reviews` | | R(내 정보·주문 상세) | 이전 / `/shop/{slug}/me` | 탭·스크롤 | — | 없음 |
| SH-029 | `/shop/[slug]/reviews/write` | | R(주문 상세·내 리뷰 「작성」) | 이전 / `/shop/{slug}/reviews` | 쿼리(주문·상품) | 필요(사진·글) | 없음 |
| SH-034 | `/shop/[slug]/wishlist` | | R(Drawer·내 정보) | 이전 / `/shop/{slug}/me` | 탭(찜·최근 본)·스크롤 | — | 없음(비로그인 제자리 안내) |
| SH-030 | `/shop/[slug]/help` | ● | M(Drawer·푸터)·H | — | 탭(공지·이용안내·FAQ) | — | 최상위(탭 URL 확인 필요) |
| SH-030 | `/shop/[slug]/help/notices/[noticeId]` | | R·N·D | 이전 / `/shop/{slug}/help` | 도움말 탭·스크롤 | — | 없음 |
| SH-031 | `/shop/[slug]/privacy` | | M(푸터)·F(회원가입 동의 링크)·D | 이전 / `/shop/{slug}` | — | — | 없음 |
| SH-032 | `/shop/[slug]/terms` | | M(푸터)·F(회원가입 동의 링크)·D | 이전 / `/shop/{slug}` | — | — | 없음 |
| (없는 상품·주문) | 상품·주문 `notFound()` | | D | 다음 행동 필요(IA 8항) | — | — | 잘못됨(쇼핑몰 단위 안내 — UX-12, 「주문 내역으로」 없음 — UX-21) |

---

## 4. 공개·인증 전 화면

최상위 = 플랫폼 공개 GNB(소개·기능·요금·FAQ·공지) · 로그인·가입 입구.

| ID | route | 최상위 | 들어오는 길 | ← 결과 (이전 / 직접 fallback) | 복원할 상태 | 미저장 | 현재 |
|---|---|---|---|---|---|---|---|
| PF-001 | `/about` | ● | M·D | — | — | — | 최상위 |
| PF-002 | `/features` | ● | M·D | — | — | — | 최상위 |
| PF-003 | `/pricing` | ● | M·D·H(가입 흐름) | — | — | — | 최상위 |
| PF-004 | `/faq` | ● | M·D | — | 펼침 항목(선택) | — | 최상위 |
| PF-005 | `/notices` | ● | M·D·N(메일) | — | 페이지 | — | 최상위(조건 URL 확인 필요) |
| PF-006 | `/notices/[noticeId]` | | R·D(메일) | 이전 / `/notices` | 목록 페이지 | — | 없음 |
| PF-008 | `/terms` | | M(푸터)·F(가입 동의 링크) | 이전 / `/about` | — | — | 없음 |
| PF-009 | `/privacy` | | M(푸터)·F(가입 동의 링크) | 이전 / `/about` | — | — | 없음 |
| PF-007 | `/seller/signup` (+약관 단계) | | M(「파트너스 가입」)·D | 이전 / `/about` | 입력값·단계 | 필요(입력 중 이탈) | 없음 |
| AU-002 | `/seller/login` | | M·D·세션 만료·L | — | `next`(쿼리 유지) | — | 있음(성공 `replace`). 쿼리 유실(UX-14), 로그인 상태 진입 시 폼 표시(UX-23) |
| AU-001 | `/admin/login` | | D·세션 만료 | — | `next` | — | 있음(성공 `replace`). 같은 쿼리·`../` 문제(UX-14·24) |
| AU-003/004 | `/seller/password-reset` | | 로그인 「비밀번호 찾기」·D(메일 링크) | 이전 / `/seller/login` | — | 입력 중이면 필요 | 없음 |
| AU-011 | `/seller/find-id` | | 로그인 「아이디 찾기」 | 이전 / `/seller/login` | — | — | 없음 |
| AU-012 | `/seller/identity-link` | | L(직원 첫 로그인) | 이전 없음 → 로그인 / `/seller/login` | `next` | — | 없음. 연결 전에는 앱 화면으로 못 돌아가므로 「로그인으로」 필요 |
| AU-005 | `/seller/pending` | | L(가입 직후·승인 전 로그인) | — | — | — | 확인 필요(다음 행동: 로그아웃·문의) |
| AU-006 | `/seller/suspended` | | L·D(정지된 계정) | — | — | — | 확인 필요(다음 행동: 문의·로그아웃) |
| AU-007 | `/seller/login?reason=expired` | | 세션 만료 | — | `next` | — | 있음 |
| AU-008 | 권한 없음(403) | | D·M | 이전 / 그 영역 첫 화면 | — | — | 없음(IA 8항: 다음 행동 필요 — UX-16) |
| AU-009 | 없는 주소(404) | | D | 이전 / 그 영역 첫 화면 | — | — | 없음(루트 `not-found` 없음 — UX-13) |
| AU-010 | `/maintenance` | | 점검 중 전 영역 리다이렉트 | — | 원래 가려던 주소 | — | 확인 필요(점검 해제 뒤 돌아갈 곳) |
| OV-000~007 | `/overlay/[token]` | ● | 방송 소프트웨어 | 해당 없음 — Back·← 없음(OBS 브라우저 소스, 사용자 조작 없음) | — | — | 해당 없음 |

---

## 5. 끊긴 길과 우선순위

「끊긴 길」 = 돌아갈 곳이 없음 · 로그인으로 돌아감 · 다른 쇼핑몰 맥락으로 감 · 상태 유실. 아래 목록이 완료 기준의 「끊긴 길 0」 대상입니다.

### P1 — 돈·권한·데이터에 닿거나 매일 쓰는 흐름이 끊김

| ID | 끊긴 길 | 화면 | 종류 | 2단계 묶음 |
|---|---|---|---|---|
| BR-01 | 상세 「목록/취소/주문 목록으로」가 부모 주소 고정 push → 목록 조건·스크롤 유실 | 상품 수정, 주문 상세, 회원 상세, 방송 상세, 공지 상세, 내 문의 상세·작성 | 상태 유실 | 파트너스 |
| BR-02 | 파트너스 하위 화면에 화면 ← 없음 | 통계 하위 5곳, 자동 연결 3곳, 재고·동의어 일부 | 돌아갈 곳 없음 | 파트너스 |
| BR-03 | 상품 등록·수정·검색어 동의어·설정 폼 이탈 보호 없음(링크·Back·새로고침이 같은 확인 필요) | 상품 등록(저장 뒤 push)·수정, 설정 9곳, 회원 등급, 쿠폰, 배너·팝업, 직원 | 상태 유실(입력값) | 파트너스(큰 폼) |
| BR-04 | 마스터 환불 처리·공지 작성·수정에 ← 없음·고정 Link·저장 뒤 push | 환불 상세, 공지 작성·수정 | 돌아갈 곳 없음·상태 유실 | 마스터 |
| BR-05 | 구매자 주문서·결제·회원가입에 ← 없음 | 주문서, 결제 단계, 가입 | 돌아갈 곳 없음 | 구매자 |
| BR-06 | 구매자 MY 하위(주문 내역·쿠폰·리뷰·찜·알림 설정)에 ← 없음, 주문 내역 탭 URL 없음 | SH-021·025·028·029·034 | 돌아갈 곳 없음·상태 유실 | 구매자 |
| BR-07 | 구매자 로그인된 채 `/login` 진입 시 폼 표시, 보호 화면에서 오는 Back | SH-010 | 로그인으로 돌아감 | 구매자 |
| BR-08 | 오버레이 편집기 브라우저 Back 미차단(UX-05) | SA-051 | 상태 유실 | 파트너스(공통 가드 도우미 변경은 레이아웃 (5)) |

### P2

| ID | 끊긴 길 | 화면 | 종류 | 2단계 묶음 |
|---|---|---|---|---|
| BR-09 | 비로그인 `next`에 쿼리 유실(`/seller/products?status=ON_SALE` → 로그인 뒤 쿼리 없음), 마스터 `../` 허용 | 로그인·셸 `api.ts` | 상태 유실 | 인증·공개 + 공통 도우미(레이아웃 (5)) |
| BR-10 | 목록·탭 조건 URL 없음 | 파트너스: 입금 확인·회원 알림·구매 제한·회원별 잔액·적립금 원장·쿠폰·통계 기간·방송 이력·HIT 카드 이력·알림 센터·내 문의·공지. 마스터: 구독 현황·환불 요청·계정·알림 센터. 구매자: 주문 내역 탭·내 리뷰·찜 탭·도움말 탭 | 상태 유실 | 각 묶음 |
| BR-11 | 스크롤 복원 없음 | 마스터 PG 수납·자동 연결 작업, 회원·교환 반품 외 URL만 있는 목록 | 상태 유실 | 각 묶음 |
| BR-12 | 공개·인증 화면에 ← 없음 | 약관·개인정보·가입·비밀번호 찾기·아이디 찾기·공지 상세·정본 AU-005·006·012 | 돌아갈 곳 없음 | 인증·공개 |
| BR-13 | 권한 없음·요금제 제한·없는 대상·404 화면에 다음 행동 없음(IA 8항) | AU-008·009, 파트너스 NoPermission, 마스터 NoAccess, 구매자 상품·주문 없음 | 돌아갈 곳 없음 | 인증·공개(+구매자) |
| BR-14 | Drawer·모바일 시트가 Back으로 닫히지 않음(UX-11) | 파트너스 Drawer, 구매자 Drawer | 상태 유실 | 레이아웃 (5) 소관 — MASTER 보고 |
| BR-15 | 결제 완료 화면에서 Back이 주문서로 돌아갈 수 있음 | SH-007 | 상태 유실(재결제 위험) | 구매자 |
| BR-16 | 점검·정지·승인 대기 화면의 다음 행동 불명 | AU-005·006·010 | 돌아갈 곳 없음 | 인증·공개 |

### 소관 밖(MASTER 보고 필요)

- 공통 도우미(`lib/client/navigation/**`) 변경이 필요한 항목: 브라우저 Back 미차단 확장(BR-08), `sanitizeNext`의 쿼리 보존(BR-09), Drawer·시트 popstate(BR-14).
- 공통 셸·`components/admin-ui/**`(예: 권한 없음 공통 컴포넌트·경로 줄 ←): 레이아웃 (5) 전담.
- 메뉴 항목 `/admin/ops/jobs`(준비 중)와 실제 화면 `/admin/ops/automation` 불일치(2-1 MA-110) — `menu.ts` 변경이므로 소유 세션 확인 필요.

---

## 6. 2단계 PR 묶음 (순서)

각 PR은 화면 묶음 1개, 올리기 전 최신 main 머지, diff는 Back·상태 보존 연결 부분만.

1. **파트너스 관리자** — BR-01·02·03·10·11(파트너스 부분). 상세·하위 화면 ← + `useSmartBack(parent)`, 목록 `useUrlState`·`useScrollRestore`, 큰 폼 `useUnsavedGuard`.
2. **마스터 관리자** — BR-04·10·11(마스터 부분).
3. **구매자 쇼핑몰** — BR-05·06·07·13(쇼핑몰 부분)·15.
4. **인증·공개** — BR-09·12·13·16.
5. (소관 밖 항목은 MASTER 결정 뒤 해당 전담이 반영.)

**ID 규칙**: BR-nn은 이 문서 안의 식별자이며 `docs/UX_AUDIT.md` UX-nn과 별개입니다. 같은 문제는 괄호에 UX 번호를 적었습니다.

## 7. 확인하지 못한 것

- 이 문서의 「현재」는 코드를 읽은 값입니다. 직접 URL 진입 / 목록 → 상세 → ← / 브라우저 Back 실제 클릭 증거는 2단계 PR에서 화면별로 붙입니다.
- 「확인 필요」로 적은 칸(파트너스 `/seller/suspended`·배너 팝업·마스터 `account`·구매자 주문 완료·도움말 탭·공지 URL 등)은 2단계 착수 때 코드·정본을 열어 확정하고 이 표를 고칩니다.
- 화면 ← 버튼의 모양·위치는 디자인 정본(`design/SCREEN_MAP.md`)에 별도 규격이 없으면 기존 `useSmartBack` 사용 화면(`ShopBack`, 마스터 상세)을 그대로 따릅니다.

## 8. 2단계 진행 기록

각 PR에서 「있음」으로 바뀐 화면(위 표의 「현재」 칸은 이 기록이 우선합니다). 직접 URL / 목록 → 상세 → ← / 브라우저 Back 증거는 `tests/e2e/seller-back-routes.spec.ts` 등 PR 본문에 적습니다.

| PR | 묶음 | 있음으로 바뀐 화면 | 남은 것(같은 묶음) |
|---|---|---|---|
| 파트너스 1 | 파트너스 관리자 | SA-022 주문 상세 · SA-042 회원 상세 · SA-055 방송 상세 · SA-112 공지 상세 · SA-113~115 내 문의(작성은 미저장 확인·저장 뒤 replace) · SA-012 상품 등록·수정(취소 ←·저장·삭제 뒤 replace) · SA-056 통계 하위 5곳(← + 기간·단위·비교 URL) · SA-151~153 자동 연결 · 검색 유사어 | 목록 조건 URL(입금 확인·회원 알림·구매 제한·잔액·원장·쿠폰·방송 이력·HIT 카드·알림 센터·내 문의·공지) · 설정·편집 폼 미저장 확인(설정 9곳·회원 등급·쿠폰·배너·직원) · SA-047 · 로그인 `next` 쿼리(인증 묶음) |

