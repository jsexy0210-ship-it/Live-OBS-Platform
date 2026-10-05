# 쉬운 말 · 확인 창 · 표 규칙 전수 감사 (2026-10-06 KST)

대표님 지시(2026-10-06, 문서 PR #627 `docs/DESIGN_PROMPT.md` 「쉬운 말」「확인 창 필수」「표 클릭 제목 열 위치」「표 겹침·정렬 전수 수정」) 전수 감사입니다. **이 문서는 감사 결과만 담으며 화면 코드는 고치지 않았습니다.** 고치는 일은 아래 소유 세션이 합니다.

## 1. 기준과 방법

- ① 쉬운 말: 어려운 업무·개발 용어, 영어·약어·코드값, 뜻이 둘인 문장, 무슨 일이 생기는지 모르는 버튼, 해결 방법 없는 오류 문구
- ② 확인 창 필수: 저장·삭제·변경·상태 변경·일괄 처리인데 확인 창 없이 바로 서버로 가는 곳(조회·검색·필터·정렬·이동 제외)
- ③ 표 클릭 제목 열: 눌러서 들어가는 제목·이름 열이 맨 왼쪽 첫 열(체크 칸 다음)·왼쪽 정렬이 아닌 곳(상품 열 제외)
- ④ 표 겹침·가운데 정렬 누락

- **①②는 코드 점검**(영역별 4개 묶음으로 화면 파일·컴포넌트를 읽고 문구·변경 호출(POST·PUT·PATCH·DELETE)을 찾음, 약 300개 파일). 화면을 눌러 본 것이 아니라 코드에 있는 문구와 흐름 기준입니다. 서버가 내려 주는 오류 `message`는 구매자·인증 일부만 확인했습니다.
- **③④는 화면 측정**: 최신 main(`e373f4ce`) 빌드 + 폐기 DB 데모 시드에서 로그인해 메뉴·첫 상세 화면 약 100개를 1440·390 폭으로 열고 표의 첫 열·링크 열·정렬·칸 넘침·겹침을 측정했습니다. 시드에 데이터가 없는 목록, 표(table)가 아닌 카드·행 목록(리뷰·문의·공지 등), 오류·빈 화면 상태, 시험 서버(`test.on-aircue.com`, 비밀번호를 받지 못함)는 **미확인**입니다.

## 2. 요약 (소유 세션별 건수)

| 소유 세션 | ① 쉬운 말 | ② 확인 창 | ③ 제목 열 | ④ 표 겹침·정렬 | 비고 |
|---|---|---|---|---|---|
| 레이아웃 전담 (5) (`session_017WgBx8FtCk7jBgmCL4id5V`) | 16 | 2 | 0 | 0 |  |
| 화면-마스터 (2) (`session_01745GgCnQxQhtnpCd5Pv88w`) | 69 | 28 | 7 | 3 |  |
| 화면-파트너스 운영 (3) (`session_016P8zSbRmKFuuWC9krz69jq`) | 46 | 25 | 1 | 6 |  |
| 쇼핑몰 운영 전담 (2) (`session_01WDkrYfwDz7o3oD8f2PeSvP`) | 15 | 16 | 2 | 1 | 보관 상태 — MASTER 재배정 필요 |
| 화면-설정 (2) (`session_014yzgBefSGaxVp7o6eBETzb`) | 42 | 20 | 1 | 2 |  |
| 화면-방송 (2) (`session_01LEN2yPC22mYAT7r16f4RJ6`) | 34 | 19 | 1 | 4 |  |
| 통계 전담 (2) (`session_01GPhc7Kd9oq7YFPv4Tar4ZX`) | 11 | 1 | 0 | 0 | 보관 상태 — MASTER 재배정 필요 |
| 도우미 전담 (2) (`session_01179Trx8rmw3gteLPm2YqPm`) | 1 | 1 | 0 | 0 |  |
| 개발 전담 (화면) (3) (`session_01BwVsBQrQRL49RsUn9ejKYw`) | 32 | 20 | 0 | 0 |  |
| 구매자 쇼핑몰 전담 (2) (`session_01KEhmqBBhjTGfGfHyRzEFcy`) | 32 | 29 | 0 | 0 |  |
| 화면-공개 (2) (`session_01VWVPemvkt3eicZ8fDRLSAR`) | 9 | 0 | 0 | 0 | 보관 상태 — MASTER 재배정 필요 |
| 개발 전담 (기반) (6) (`session_014TjcA8RirjWptikziBwasM`) | 11 | 0 | 0 | 0 | 서버 응답 문구 |
| **합계** | **318** | **161** | **12** | **16** | |

※ 같은 문제가 반복되는 곳은 표에서 「외 N곳」으로 묶었습니다(파일:줄 모두 적음). 실제 고칠 곳은 건수보다 많습니다.

## 3. 적용 순서 · 의존

1. ① 쉬운 말은 각 소유 세션이 바로 고칠 수 있습니다. 문구 안은 「고칠 문장」 열의 제안이며, **용어 확정이 필요한 것은 4절**을 먼저 정한 뒤 한 번에 바꿉니다.
2. **②③④는 공통 부품이 필요합니다**: 공용 확인 창(ConfirmDialog)과 공통 표 규칙(제목 열 위치·왼쪽 정렬, 가운데 정렬, 말줄임·툴팁, 모바일 카드형)은 레이아웃 (5)(`session_017WgBx8FtCk7jBgmCL4id5V`)의 공통 부품 PR이 병합된 뒤 각 화면에 적용합니다. 그 전에 화면마다 따로 만들지 않습니다.
3. 방송 중 빠른 조작(개봉 시작·완료, 타이머, 순서 이동)은 확인 창이 방송 흐름을 끊을 수 있어 대표님 판단이 필요합니다(4절).

## 4. 판단 필요 · 정책 불일치

- 「주문대기」: `DESIGN_PROMPT.md`가 정한 공식 용어인데 쉬운 말 기준에는 어렵다는 지적이 있습니다. 유지할지 정해 주십시오(안: 「방송 주문 목록」).
- 「HIT 카드」·「플랜(이용권)」 등 대체어: 확정 뒤 한 번에 바꿉니다(안: 「당첨 카드」, 「이용권」).
- 방송 중 빠른 조작에 확인 창을 붙일지: 「확인 창 필수 — 예외 없음」과 방송 진행 속도가 충돌합니다. 권고: 방송 중 개봉 시작·완료는 예외로 두고 취소·되돌리기·방송 종료만 확인.
- 주문 표의 클릭 제목 열: 새 규칙은 「주문번호」를 첫 열 왼쪽 정렬로 두라고 하고, 기존 「표 정렬」 규칙은 주문번호를 가운데로 둡니다. 어느 쪽인지 디자인 확정이 필요합니다.
- 「판매자」 표기가 파트너스 관리자 화면에 남은 곳: 발송 비용 안내문 본문 3곳과 정본 `docs/terms/SELLER_MESSAGE_FEE_NOTICE.md`, 반품 「판매자 사정」(`returns/page.tsx`), 상품 폼 「판매자별 순번」(`ProductForm.tsx`), 마스터 자동 연결 상세(`ops/automation/[jobId]/page.tsx:100`). 파트너스 관리자 화면에서는 「파트너스」로 씁니다.
- 메뉴 이름과 화면 제목 불일치(「배송 설정」/「배송비 정책」, 「공유 설정」/「공유 미리보기」), 검색 노출 화면 안내문이 없는 기능(공유 설정의 이미지·파비콘 올리기)을 가리킴, 알림 화면 안내문이 실제 알림 종류(입금 확인·결제 완료·재고 없음·반품 요청)를 다 말하지 않음.
- 동작 이상: 마스터 메뉴 「자동 연결 작업」 주소가 틀려 「준비 중입니다」가 뜸(`app/(admin)/admin/_components/menu.ts:45`, 실제 화면은 `/admin/ops/automation`), 마스터 상단 「내 계정」이 눌리지 않음(`AdminShell.tsx:89`, 내 계정 화면은 이미 있음).
- 공개 화면 푸터·이용약관에 `[플랫폼 상호]`·`[확정 전]` 자리표시자가 그대로 보임(구매자·공개 묶음 참고).

## 5. 소유 세션별 항목

### 레이아웃 전담 (5) — `session_017WgBx8FtCk7jBgmCL4id5V`

**① 쉬운 말 (16)**

| 화면ID | 경로 | 현재 문구 | 문제 유형 | 고칠 문장 | 파일:줄 |
|---|---|---|---|---|---|
| 공통(메뉴) | /admin 메뉴·화면 제목 | 「PG 연결 상태」(메뉴·화면 제목), 대시보드 「PG 연결 오류」, 파트너스 상세 버튼 「PG 연결 상태」 | 영어·약어 | 「카드 결제 연결 상태」, 「카드 결제 연결 오류」 | app/(admin)/admin/_components/menu.ts:33; app/(admin)/admin/(shell)/settlement/pg/page.tsx:67,69,97; app/(admin)/admin/(shell)/page.tsx:98; app/(admin)/admin/_components/PartnerTabs.tsx:339 |
| 공통(메뉴) | /admin 메뉴 | 대분류 「정산」, 메뉴 「구독료 수납」, 화면 안 「수납 금액」「수납 매출」「수납률」 | 어려운 말 | 「구독료 받은 내역」, 「받은 구독료」, 「구독료 받은 비율」 | app/(admin)/admin/_components/menu.ts:31,34; app/(admin)/admin/(shell)/settlement/collection/page.tsx:57,116; app/(admin)/admin/(shell)/page.tsx:266-267,272 |
| 공통(메뉴) | /admin 메뉴 | 「주문·오버레이 접속」「적립금 실지급 파트너스」「실시간 감시」「외부 서비스 연동」「역할별 권한」 | 어려운 말 | 「오늘 주문과 방송 화면 연결」, 「적립금을 실제로 주는 파트너스」, 「서버 상태 보기」, 「연결한 외부 서비스」, 「역할별로 할 수 있는 일」 | app/(admin)/admin/_components/menu.ts:42,43,44,62,76 (화면 제목 app/(admin)/admin/(shell)/ops/access/page.tsx:54, app/(admin)/admin/(shell)/ops/rewards/page.tsx:31, app/(admin)/admin/(shell)/ops/monitor/page.tsx:35) |
| 공통(메뉴) | /admin 메뉴 | 「파비콘·공유 카드」(메뉴), 화면 제목 「파비콘 · 공유 카드」 | 영어·약어 | 「브라우저 탭 아이콘·공유 미리보기」 | app/(admin)/admin/_components/menu.ts:77; app/(admin)/admin/(shell)/settings/branding/page.tsx:78 |
| 공통(메뉴) | /admin 메뉴 | 「플랫폼 기본 정책」「알림 채널」「발송 단가」 | 어려운 말 | 「서비스 기본 규칙」, 「알림 보내는 방법」, 「메일·문자 1건 요금」 (앞의 둘은 화면이 없어 「준비 중입니다」만 보임) | app/(admin)/admin/_components/menu.ts:70,71,74 |
| 공통(메뉴) | /admin 메뉴「자동 연결 작업」 | 메뉴를 누르면 「준비 중입니다」가 나옴(실제 화면 주소는 /admin/ops/automation인데 메뉴 주소는 /admin/ops/jobs) | 모호(동작) | 메뉴 주소를 실제 화면으로 맞춥니다. 화면이 열리기 전까지는 「자동 연결 작업은 곧 열립니다.」 | app/(admin)/admin/_components/menu.ts:45; app/(admin)/admin/(shell)/[...slug]/page.tsx:7-9 |
| 공통(상단) | 상단 「내 계정」 | 「내 계정」 버튼이 흐리게 눌리지 않고 마우스를 올리면 「준비 중입니다」(MA-090 화면은 이미 있음) | 모호(동작) | 눌러서 /admin/account로 이동하게 하고 「내 계정」 | app/(admin)/admin/_components/AdminShell.tsx:89-91 |
| 공통(상단) | 상단 검색·알림 | 검색 버튼 이름 「빠른 찾기」인데 창 이름은 「전체 검색」, 항목 묶음 「자동 작업」, 안내 「파트너스 · 주문번호 · 결제번호 · 문의 · 작업」 | 뜻 둘 | 「전체 검색」으로 통일, 「자동 연결 작업」, 「파트너스 · 주문번호 · 결제번호 · 문의 · 자동 연결 작업」 | components/admin-ui/GnbTools.tsx:57,59,91,98 |
| 공통(권한) | 권한 없는 메뉴 직접 접속 | 「이 화면을 볼 권한이 없습니다」 | 어려운 말, 오류에 해결 방법 없음 | 「이 계정으로는 볼 수 없는 화면입니다. 필요하면 최고관리자에게 요청해 주십시오.」 | app/(admin)/admin/_components/AdminShell.tsx:203 |
| 공통 | 모든 목록 화면 오류 | 「주문을 불러오지 못했습니다」「상품을 불러오지 못했습니다」「카테고리를 불러오지 못했습니다」 등 제목 + 「다시 시도」 | 오류에 해결 방법 없음(무엇이 안 됐는지는 있으나 원인·다음 행동 없음) | {대상}을 불러오지 못했습니다. 인터넷 연결을 확인하고 「다시 시도」를 눌러 주십시오. 계속되면 고객 문의로 알려 주십시오. | components/seller/States.tsx:19-28 (공통 부품) · app/(seller)/seller/(shell)/orders/page.tsx:209 · app/(seller)/seller/(shell)/orders/[orderId]/page.tsx:69 · app/(seller)/seller/(shell)/orders/deposits/page.tsx:113 · app/(seller)/seller/(shell)/products/page.tsx:446 · app/(seller)/seller/(shell)/products/stock/page.tsx:320 · app/(seller)/seller/(shell)/products/categories/page.tsx:200 · app/(seller)/seller/(shell)/products/search-synonyms/page.tsx:124 · app/(seller)/seller/(shell)/products/restock-alerts/page.tsx:47 · app/(seller)/seller/(shell)/products/display/page.tsx:60 · app/(seller)/seller/(shell)/products/[productId]/page.tsx:48 · app/(seller)/seller/(shell)/shipping/page.tsx:230 · app/(seller)/seller/(shell)/members/page.tsx:143 · app/(seller)/seller/(shell)/members/[memberId]/page.tsx:62 · app/(seller)/seller/(shell)/rewards/page.tsx:69 · app/(seller)/seller/(shell)/rewards/ledger/page.tsx:106 · app/(seller)/seller/(shell)/rewards/balances/page.tsx:103 · app/(seller)/seller/(shell)/rewards/live-payout/page.tsx:61 · app/(seller)/seller/(shell)/buyer-inquiries/page.tsx:166 · app/(seller)/seller/(shell)/purchase-restrictions/page.tsx:141 · app/(seller)/seller/(shell)/banners/_shared/ui.tsx:374 |
| SA-001 | /seller/broadcast | 「이용 기간 만료(402)」「NoPermission 필요한 권한: 방송 진행」 | 어려운 말(권한) | 「이 기능을 쓸 수 없는 계정입니다. 대표자에게 「방송 진행」을 열어 달라고 요청해 주십시오」 | components/seller/States.tsx:43; app/(seller)/seller/(shell)/broadcast/page.tsx:25,328,341 |
| (메뉴) | 파트너스 관리자 상단·왼쪽 메뉴 | 「오버레이 편집기」「HIT 카드 이력」「외부 쇼핑몰 연동」「자동 연결」「결제(PG) 연결」「주문자 알림」「발송·이용 충전」「구독 · 결제」「쇼핑몰 통합 전환」「법정 고지 · 약관」「검색 노출」「공유 설정」「회원 정책」「직원 계정」「분석 › 통계」, 상단 「공지 · 문의」「도우미」 | 어려운 말/영어·약어(OBS·PG·HIT·연동) | 「방송 화면 꾸미기」「당첨 카드 기록」「다른 쇼핑몰 이어 쓰기」「OBS 자동 설정」「카드 결제 연결」「주문 알림 설정」「문자·메일 발송 충전금」「이용권 · 결제」「쇼핑몰 기능 열기」「법적 안내 · 이용약관」「검색에 보이기」「공유 문구 설정」「회원 규칙」「직원 관리」 | components/seller/SellerShell.tsx:39-40,43,46,123-126 |
| (메뉴) | 상단 「내 계정」·준비 안 된 메뉴 | 「준비 중입니다」(툴팁), 「내 계정」「송장 발급」등 흐린 메뉴 | 모호(언제 되는지 모름) | 「아직 사용할 수 없는 메뉴입니다」 | components/seller/SellerShell.tsx:59,399-400,468 |
| (ID 없음) | 안내 화면(요금제 없음) | 「지금 요금제에서 사용할 수 없는 기능입니다」「구독료 첫 결제가 확정되면 사용할 수 있습니다」「쇼핑몰 통합 요금제에서 사용할 수 있습니다」「요금제는 구독 · 결제에서 바꿀 수 있습니다」「요금제 변경은 대표자에게 요청해 주십시오」「{메뉴} 화면으로 이동」 | 어려운 말(요금제·확정) | 「지금 이용 중인 이용권에서는 쓸 수 없는 기능입니다」「첫 구독료가 결제되면 사용할 수 있습니다」「쇼핑몰까지 쓰는 이용권(통합 이용권)에서 쓸 수 있습니다」「이용권은 「이용권 · 결제」에서 바꿀 수 있습니다」「이용권 변경은 대표자에게 요청해 주십시오」 | components/seller/SellerShell.tsx:496-497,504 |
| (ID 없음) | 화면 위 안내 띠 | 「체험이 N일 남았습니다 / 체험이 끝나기 전에 구독하면 그대로 이어서 사용할 수 있습니다」「구독료 결제가 되지 않았습니다 / 결제 카드를 확인해 주십시오. 며칠 안에 결제되지 않으면 새 판매가 중지됩니다」「이용 기간이 끝났습니다 / 지금은 상품 등록·수정과 새 판매가 중지되어 있습니다.」 | 뜻 둘(「며칠」이 몇 일인지 모름)/어려운 말 | 「구독료가 결제되지 않았습니다. 결제 카드를 확인해 주십시오. N월 N일까지 결제되지 않으면 새 주문을 받을 수 없습니다」(날짜를 서버 값으로 표시) | components/seller/SellerShell.tsx:560,568 |
| (ID 없음) | 공통 틀 오류 | 「화면을 불러오지 못했습니다」「다시 시도」「로그아웃하지 못했습니다. 다시 시도해 주십시오」 | 오류에 해결 방법 없음 | 「화면을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 「다시 시도」를 눌러 주십시오」「로그아웃하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오」 | components/seller/SellerShell.tsx:362,364,448 |

**② 확인 창 (2)**

| 화면ID | 경로 | 행동 | 현재 동작 | 확인 창 문구 안 | 위험도 | 파일:줄 |
|---|---|---|---|---|---|---|
| (ID 없음) | 모든 화면 상단 | 「로그아웃」 | 누르면 바로 POST /api/admin/auth/logout | 제목 「로그아웃하시겠습니까?」 / 「이 기기에서 마스터 관리자 로그인이 끝납니다.」 / [취소] [로그아웃] | 보통 | app/(admin)/admin/_components/AdminShell.tsx:52-57,92-94 |
| (ID 없음) | 상단 「로그아웃」 | 누르면 바로 POST /api/seller/auth/logout | 「로그아웃하시겠습니까?」/「다시 로그인해야 이 화면을 쓸 수 있습니다」/[취소][로그아웃] | 보통 | components/seller/SellerShell.tsx:351,353,403 |

### 화면-마스터 (2) — `session_01745GgCnQxQhtnpCd5Pv88w`

**① 쉬운 말 (69)**

| 화면ID | 경로 | 현재 문구 | 문제 유형 | 고칠 문장 | 파일:줄 |
|---|---|---|---|---|---|
| 공통(오류) | 모든 화면 오류 | `failMessage` 기본 「잠시 후 다시 시도해 주십시오.」 — 무엇이 안 됐는지 없음. 403이면 어떤 화면이든 「최고관리자만 변경할 수 있습니다.」(운영·CS 권한 부족에도 같은 말), 413 「파일이 너무 큽니다.」 | 오류에 해결 방법 없음 | 「저장하지 못했습니다. 잠시 후 다시 시도해 주십시오. 계속 안 되면 개발 담당에게 알려 주십시오.」, 「이 계정으로는 할 수 없는 작업입니다. 최고관리자에게 요청해 주십시오.」, 「파일이 너무 큽니다. 용량을 줄여 다시 올려 주십시오.」 | app/(admin)/admin/_components/api.ts:28-35 (이 함수를 쓰는 곳: 대부분의 화면) |
| 공통(오류) | 이용 정지·가입 반려·환불 거절 창 | 「처리하지 못했습니다. 잠시 후 다시 시도해 주십시오.」 외 2곳 | 오류에 해결 방법 없음 | 「이용 정지를 하지 못했습니다. 잠시 후 다시 시도해 주십시오.」(행동 이름을 넣어 구분: 정지 해제/가입 반려/환불 거절) | app/(admin)/admin/_components/SuspendDialog.tsx:50; app/(admin)/admin/_components/RejectApplicationDialog.tsx:30; app/(admin)/admin/(shell)/billing/refunds/[refundId]/page.tsx:36 |
| 공통(표) | 여러 표의 열 이름 | 열 이름 「작업」「관리」(눌러서 무엇을 하는 열인지 알 수 없음) | 모호한 버튼 | 「바꾸기」 / 「처리」 대신 버튼마다 동사 이름(「정지」「수정」「상세」) | app/(admin)/admin/(shell)/billing/plans/page.tsx:65; app/(admin)/admin/(shell)/accounts/page.tsx:62; app/(admin)/admin/(shell)/support/assistant/page.tsx:446; app/(admin)/admin/(shell)/settings/messages/page.tsx:115; app/(admin)/admin/(shell)/partners/page.tsx:492; app/(admin)/admin/(shell)/billing/refunds/page.tsx:90 외 6곳(app/(admin)/admin/(shell)/partners/applications/page.tsx:128, app/(admin)/admin/(shell)/settlement/pg/page.tsx:118, app/(admin)/admin/(shell)/ops/live/page.tsx:79, app/(admin)/admin/(shell)/ops/access/page.tsx:108, app/(admin)/admin/(shell)/ops/rewards/page.tsx:69, app/(admin)/admin/(shell)/support/inquiries/page.tsx:110) |
| 공통(목록) | 목록 쇼핑몰 칸 | 쇼핑몰 이름 옆 「· {주소 약칭}」(예: 「· myshop」)이 이름 없이 붙어 있음 | 뜻 둘 | 「쇼핑몰 주소: myshop」처럼 이름을 붙이거나 숨깁니다 | app/(admin)/admin/(shell)/partners/page.tsx:147; app/(admin)/admin/(shell)/partners/applications/page.tsx:142; app/(admin)/admin/(shell)/billing/subscriptions/page.tsx:161; app/(admin)/admin/(shell)/ops/live/page.tsx:88; app/(admin)/admin/(shell)/ops/access/page.tsx:117; app/(admin)/admin/(shell)/ops/rewards/page.tsx:76 |
| AU-001 | /admin/login | 「플랫폼 운영 계정으로 로그인해 주십시오.」 | 어려운 말 | 「마스터 관리자 계정으로 로그인해 주십시오.」 | app/(admin)/admin/login/page.tsx:41 |
| MA-001 | /admin | 「가입 승인 대기」「PG 연결 오류」「심각 장애」「자동 연결 실패」(오늘 처리할 일 칸) | 어려운 말, 영어·약어 | 「가입 신청 처리 대기」, 「카드 결제 연결 오류」, 「바로 확인할 문제」, 「자동 연결 실패」 | app/(admin)/admin/(shell)/page.tsx:94-100 |
| MA-001 | /admin | 「순매출」「비중」「수납 매출」「수납률」「체험」「결제 처리 중」 | 어려운 말 | 「환불을 뺀 매출」, 「전체에서 차지하는 비율」, 「받은 구독료」, 「구독료 받은 비율」, 「무료 체험 중」, 「결제 진행 중」 | app/(admin)/admin/(shell)/page.tsx:227-228,266-267,331,333 |
| MA-001 | /admin | 파트너스 칸 「승인 대기」 | 어려운 말 | 「가입 신청 중」 | app/(admin)/admin/(shell)/page.tsx:320 |
| MA-011 | /admin/partners | 상태 「승인 대기」 | 어려운 말 | 「가입 신청 중」 | app/(admin)/admin/_components/partners.ts:49 (app/(admin)/admin/(shell)/partners/page.tsx:447-451 필터·표시) |
| MA-012 | /admin/partners/[id] | 「계정 상태」 칸에 서버 값이 그대로(예: ACTIVE) | 코드값 | 「이용 중」「정지」처럼 한글 이름으로 바꿔 표시 | app/(admin)/admin/(shell)/partners/[sellerId]/page.tsx:198 |
| MA-012 | /admin/partners/[id] | 「대리 조회」(버튼·창 제목)「대리 조회 끝내기」「파트너스 화면 열기」 | 어려운 말 | 「이 파트너스 화면 대신 보기」, 「대신 보기 끝내기」, 「파트너스 화면 열기」 | app/(admin)/admin/(shell)/partners/[sellerId]/page.tsx:110,145; app/(admin)/admin/_components/ImpersonateDialog.tsx:51,74 |
| MA-012 | /admin/partners/[id] 구독 칸 | 「구독 요금제」「변경 예정 요금제」「연체 유예」「결제 재시도」「기간 끝에 해지」 | 어려운 말 | 「이용 중인 요금제」, 「바뀔 요금제」, 「결제 못 한 뒤 기다려 주는 날짜」, 「결제를 다시 시도한 횟수」, 「이용 기간이 끝나면 해지」 | app/(admin)/admin/(shell)/partners/[sellerId]/page.tsx:221-227 (같은 말: app/(admin)/admin/(shell)/billing/subscriptions/page.tsx:151,173) |
| MA-012 | /admin/partners/[id] 결제 연결 탭 | 「마지막 성공」「24시간 실패」「취소 대기」「취소 실패」 | 뜻 둘 | 「마지막으로 결제된 때」, 「최근 24시간 결제 실패」, 「결제 취소 대기」, 「결제 취소 실패」 | app/(admin)/admin/_components/PartnerTabs.tsx:319-330 외 app/(admin)/admin/(shell)/settlement/pg/page.tsx:112-117 |
| MA-012 | /admin/partners/[id] 방송 이력 탭 | 표 머리 「조회」(조회 버튼과 같은 말, 무엇의 수인지 알 수 없음) | 뜻 둘 | (무엇을 세는 값인지 확인 뒤) 예: 「당첨 카드 수」 | app/(admin)/admin/_components/PartnerTabs.tsx:107 |
| MA-012 | /admin/partners/[id] 탭 | 탭 이름 「결제 연결」「활동 기록」 | 어려운 말 | 「카드 결제 연결」, 「활동 기록(로그 추적)」 | app/(admin)/admin/_components/PartnerTabs.tsx:18-19 |
| MA-012 | /admin/partners/[id] 발송 잔액 | 「발송 잔액」「무상 지급」「차감 N통」「이벤트·보상용으로 지급하며 환불 대상이 아닙니다. 유료 잔액보다 나중에 차감됩니다.」「이미 지급된 요청입니다.」 | 어려운 말, 뜻 둘 | 「메일·문자 충전 잔액」, 「무료로 넣어 주기」, 「잔액에서 빠진 N통」, 「이벤트·보상으로 넣는 잔액입니다. 환불되지 않습니다.」 + 「돈 낸 잔액을 먼저 쓰고, 이 잔액은 나중에 씁니다.」(두 문장으로 나눔), 「같은 요청이 이미 처리되어 다시 넣지 않았습니다.」 | app/(admin)/admin/_components/MessageBalanceSection.tsx:56,114,119,141,154 |
| MA-012 | 무상 지급 창 버튼 | 「지급」 | 모호한 버튼 | 「잔액 넣기」 | app/(admin)/admin/_components/MessageBalanceSection.tsx:85 |
| MA-013 | /admin/partners/applications | 「승인 대기 N일째」 | 어려운 말 | 「N일째 기다리는 중」 | app/(admin)/admin/(shell)/partners/applications/page.tsx:38 |
| MA-013 | /admin/partners/applications | 표 머리 「확인」, 배지 「확인 필요 1」(1이 무슨 수인지 모름), 「이상 없음」 | 뜻 둘 | 「점검 결과」, 「확인할 것 1건」, 「확인할 것 없음」 | app/(admin)/admin/(shell)/partners/applications/page.tsx:127,165,172 |
| MA-013 | /admin/partners/applications | 버튼 「검토」, 창 제목 「{쇼핑몰} 확인 필요」, 버튼 「확인 뒤 승인」 | 모호한 버튼 | 「확인할 내용 보기」, 「{쇼핑몰} 가입 신청에서 확인할 것」, 「확인했습니다. 승인」 | app/(admin)/admin/(shell)/partners/applications/page.tsx:196,244,276 |
| MA-013 | /admin/partners/applications | 「{쇼핑몰} 승인에 실패했습니다. 행은 그대로입니다. 잠시 후 다시 시도해 주십시오.」 | 어려운 말 | 「{쇼핑몰} 승인을 하지 못했습니다. 목록은 바뀌지 않았습니다. 잠시 후 다시 시도해 주십시오.」 | app/(admin)/admin/(shell)/partners/applications/page.tsx:94 |
| MA-014 | /admin/partners/applications/[id] | 「자동 점검」「걸린 항목이 없습니다.」「통신판매업 조회」 칸에 서버 값 그대로 | 어려운 말, 코드값 | 「자동으로 확인한 결과」, 「문제가 된 항목이 없습니다.」, 「통신판매업 조회 결과」(한글 이름으로 바꿔 표시) | app/(admin)/admin/(shell)/partners/applications/[sellerId]/page.tsx:162,172,207 |
| MA-021 | /admin/billing/plans | 표 머리 「체험 본인확인」「월 거래 메일 제공량」「변경 후 제공량」, 안내 「월 제공량은 …남아도 다음 달로 넘어가지 않습니다. 제공량을 넘는 메일은 파트너스의 발송 잔액에서 차감됩니다.」 | 어려운 말 | 「체험 중 휴대폰 본인확인」, 「월 주문·배송 안내 메일 무료 수량」, 「바뀔 무료 수량」, 「무료 수량은 한 달 단위(한국 시간)이며 남아도 다음 달로 넘어가지 않습니다.」 + 「무료 수량을 넘는 메일은 파트너스의 충전 잔액에서 빠집니다.」 | app/(admin)/admin/(shell)/billing/plans/page.tsx:59-63,109 |
| MA-022 | /admin/billing/plans | 버튼 「제공량 변경」 | 모호한 버튼 | 「월 무료 메일 수량 변경」 | app/(admin)/admin/(shell)/billing/plans/page.tsx:96 |
| MA-022 | 가격 변경 창 | 「정가는 판매가 이상, 두 금액 모두 1원 이상 100,000,000원 이하의 정수여야 합니다.」 | 어려운 말 | 「정가는 판매가보다 낮을 수 없습니다. 두 금액 모두 1원 이상 1억 원 이하 숫자로 입력해 주십시오.」 | app/(admin)/admin/_components/PlanPriceDialog.tsx:12 |
| MA-022 | 체험 한도·월 제공량·단가 창 | 「0 이상 10,000,000 이하의 정수로 입력해 주십시오.」, 칸 이름 「적용 예정 시각」 | 어려운 말 | 「0 이상 10,000,000 이하 숫자만 입력해 주십시오.」, 「바뀌는 시각」 | app/(admin)/admin/_components/PlanTrialDialog.tsx:54; app/(admin)/admin/_components/ValueDialog.tsx:66,69 |
| MA-023 | /admin/billing/subscriptions | 표 머리 「이용 상태」와 「구독 상태」가 따로 있음(체험·이용 중·연체 vs 이용 중·연체·해지), 「연체 유예」, 「재시도 N회」, 「결제 처리 중」 | 뜻 둘 | 「이용 단계」와 「결제 상태」로 구분하거나 한 칸으로 합칩니다. 「결제 못 한 뒤 기다려 주는 날짜」, 「결제 N번 다시 시도」, 「결제 진행 중」 | app/(admin)/admin/(shell)/billing/subscriptions/page.tsx:18,144,150,151,173 |
| MA-025 | /admin/billing/invoices/[id] | 「결제 번호」(서버 거래 번호 그대로), 「실패 사유」(서버 문구 그대로), 「런칭 할인」, 「청구 방식」 | 코드값, 영어·약어 | 「카드사 거래 번호」, 「결제 실패 이유」(서버 문구를 한글로 바꿔 표시), 「오픈 기념 할인」, 「청구 방법: 자동으로 청구 / 직접 결제」 | app/(admin)/admin/(shell)/billing/invoices/[paymentId]/page.tsx:80,86,87,94 |
| MA-026 | /admin/billing/refunds | 상태 「승인 대기」, 열 「출처」(값 「시스템」「관리자」), 버튼 「처리」 | 어려운 말, 모호한 버튼 | 「처리 대기」, 「요청한 곳」(「자동 요청」「관리자 요청」), 「환불 처리하기」(진행 중·실패 건) / 「보기」 | app/(admin)/admin/_components/refunds.ts:29,35; app/(admin)/admin/(shell)/billing/refunds/page.tsx:89,112 |
| MA-027 | /admin/billing/refunds/[id] | 「승인하면 결제 공급자에 결제 취소를 바로 요청합니다. 요청한 뒤에는 되돌릴 수 없습니다.」 | 어려운 말 | 「승인하면 카드 결제 취소를 바로 요청합니다. 요청한 뒤에는 되돌릴 수 없습니다.」 | app/(admin)/admin/(shell)/billing/refunds/[refundId]/page.tsx:224 |
| MA-027 | /admin/billing/refunds/[id] | 버튼 「승인 · 환불 실행」「다시 승인 · 환불 실행」, 「처리 의견」 | 모호한 버튼 | 「환불 승인하고 카드 결제 취소」, 「다시 승인하고 카드 결제 취소」, 「처리 메모」 | app/(admin)/admin/(shell)/billing/refunds/[refundId]/page.tsx:200,227,236 |
| MA-027 | /admin/billing/refunds/[id] | 「결제 취소에 실패했습니다. {서버 실패 문구 그대로}」, 알림 「결제 취소 요청을 보냈습니다. 결과를 확인하지 못했습니다. 다시 승인하면 같은 환불로 한 번만 처리합니다.」 | 오류에 해결 방법 없음, 코드값 | 「카드 결제 취소가 안 됐습니다. 이유: {한글 이유}. 잠시 뒤 「다시 승인」을 눌러 주십시오.」, 「취소 요청은 보냈지만 결과를 아직 모릅니다. 「다시 승인」을 눌러도 같은 환불은 한 번만 처리됩니다.」 | app/(admin)/admin/(shell)/billing/refunds/[refundId]/page.tsx:135-136,184 |
| MA-031 | /admin/settlement/pg | 「나이스페이」「시험 모드」「실결제」「결제사 연결 정보가 설정되어 있지 않습니다. 플랫폼 정책에서 확인해 주십시오.」 | 영어·약어, 오류에 해결 방법 없음 | 「테스트 결제」「실제 결제」, 「카드 결제 연결 정보가 아직 입력되지 않았습니다. 개발 담당에게 입력을 요청해 주십시오.」(링크 대상 「플랫폼 정책」 화면은 아직 준비 중) | app/(admin)/admin/(shell)/settlement/pg/page.tsx:74,76,85 |
| MA-031 | /admin/settlement/pg | 「실패 사유」 칸과 괄호 안 「({실패 문구})」에 서버 문구 그대로 | 코드값 | 한글로 바꾼 실패 이유 | app/(admin)/admin/(shell)/settlement/pg/page.tsx:81,132 |
| MA-032 | /admin/settlement/collection | 칸 「재시도 중」「연체」「유예」(곳 수), 이름 「구독료 수납」, 링크 「구독 현황(연체·유예)」 | 어려운 말 | 「결제 다시 시도 중」, 「결제 못 한 곳」, 「결제 기다려 주는 중」 | app/(admin)/admin/(shell)/settlement/collection/page.tsx:47-49,57,100 |
| MA-041 | /admin/ops/live | 「문제 있음만」「오버레이 접속 안 됨」「갱신 끊김」「10초마다 갱신」, 열 「대기」「개봉 중」 | 어려운 말, 뜻 둘 | 「방송 화면이 연결되지 않은 방송만」, 「방송 화면 연결 안 됨」, 「자동 새로고침 멈춤」, 「10초마다 새로고침」, 「대기 주문」「개봉 진행 중」 | app/(admin)/admin/(shell)/ops/live/page.tsx:28,36,44,73-74; app/(admin)/admin/_components/ops.ts:9 |
| MA-042 | /admin/ops/access | 「오버레이 접속 중」「오버레이 접속 안 됨」「마지막 접속」 | 어려운 말 | 「방송 화면 연결 중」「방송 화면 연결 안 됨」「마지막 연결」 | app/(admin)/admin/(shell)/ops/access/page.tsx:61,82,107 |
| MA-043 | /admin/ops/rewards | 화면 이름 「적립금 실지급 파트너스」, 열 「적립 시점」 | 어려운 말 | 「적립금을 실제로 주는 파트너스」, 「적립금을 주는 때」 | app/(admin)/admin/(shell)/ops/rewards/page.tsx:31,66 |
| MA-100 | /admin/ops/monitor | 「웹훅 지연: 측정 안 함 — 받은 기록을 저장하지 않습니다」 | 영어·약어 | 이 칸을 빼거나 「외부 알림 수신 지연: 확인하지 않음」 | app/(admin)/admin/(shell)/ops/monitor/page.tsx:73 |
| MA-100 | /admin/ops/monitor | 「앱 서버」「정기 실행」「심각도」「장애 · 이상 목록」「멈춤 N · 신호 없음 N」「결제 확인 대기」 | 어려운 말, 영어·약어 | 「서비스 서버」, 「자동으로 도는 작업」, 「얼마나 급한지」, 「문제 목록」, 「멈춘 서버 N · 응답 없는 서버 N」, 「결제 결과 확인 대기」 | app/(admin)/admin/(shell)/ops/monitor/page.tsx:20,69-72,88,90 |
| MA-100 | /admin/ops/monitor | 문제 목록 「대상」 열에 내부 키(`e.key`), 「내용」에 서버 문구 그대로 | 코드값 | 한글 이름으로 바꾼 대상(예: 「주문 결제 확인」)과 한글 내용 | app/(admin)/admin/(shell)/ops/monitor/page.tsx:120-121 |
| MA-100 | /admin/ops/monitor | 「자동 조치 기록」의 「조치」(`a.action`)·「대상」(`a.targetType`) 열에 내부 값 그대로, 「정기 실행」의 「작업」(`j.job`)·「오류」(`j.lastError`) 열에 내부 값 그대로 | 코드값 | 로그 추적(C/auditLogs.ts)처럼 한글 이름 표를 만들어 표시 | app/(admin)/admin/(shell)/ops/monitor/page.tsx:154-155,215,222 |
| MA-110 | /admin/ops/automation | 「고객 확인 대기」 아래 「실행 자리를 잡지 않습니다」, 「오늘 모델 비용」, 「진행 중」「대기」(단위 없는 숫자) | 어려운 말, 영어·약어 | 「고객이 할 일을 기다리는 중입니다」, 「오늘 AI 사용 비용」, 「진행 중 N건」「대기 N건」 | app/(admin)/admin/(shell)/ops/automation/page.tsx:63-67 |
| MA-110 | /admin/ops/automation | 「이번 달 모델 비용 한도(…원)에 닿아 새 자동 연결 접수와 판단 호출을 멈췄습니다. 다음 달 1일(KST)에 다시 열립니다」 | 어려운 말, 영어·약어 | 「이번 달 AI 사용 비용이 한도(…원)에 닿아 새 자동 연결 신청을 받지 않습니다. 다음 달 1일 0시(한국 시간)에 다시 받습니다.」 | app/(admin)/admin/(shell)/ops/automation/page.tsx:78 |
| MA-110 | /admin/ops/automation | 「결제 상태와 작업 상태는 따로 둡니다 · 결제가 확인되지 않으면 작업은 시작하지 않습니다」 | 뜻 둘 | 「결제가 확인되어야 작업을 시작합니다.」(한 문장) | app/(admin)/admin/(shell)/ops/automation/page.tsx:113 |
| MA-110·111 | 자동 연결 작업 상태 | 「검증 중」「정리 필요」「고객 확인 대기」, 결제 「결제 확인 중」「결제 확인」(둘이 비슷함) | 어려운 말, 뜻 둘 | 「결과 확인 중」, 「직접 정리 필요」, 「고객이 할 일 기다림」, 「결제 확인 중」「결제 완료」 | app/(admin)/admin/_components/automation.ts:6,7,11,14,15 |
| MA-111 | /admin/ops/automation/[id] | 「사유 코드 {서버 값}」「고객 확인: {서버 값}」「환불 사유 {서버 값}」 | 코드값 | 한글로 바꾼 이유·할 일 | app/(admin)/admin/(shell)/ops/automation/[jobId]/page.tsx:95,119,121 |
| MA-111 | /admin/ops/automation/[id] | 「쇼핑몰 앱 · 웹훅 · OBS 소스를 사람이 정리한 뒤 닫습니다. 닫으면 실패로 끝나고 결제는 환불 대기로 넘어갑니다(판매자가 취소한 작업은 취소로 닫습니다).」 | 어려운 말, 영어·약어, 뜻 둘 | 「외부 쇼핑몰에 남은 연결과 OBS 설정을 직접 지운 뒤 닫아 주십시오.」 + 「닫으면 이 작업은 실패로 끝나고, 결제는 환불 대기로 바뀝니다.」 + 「파트너스가 취소한 작업은 「취소」로 닫힙니다.」(「판매자」는 화면 용어 규칙상 「파트너스」) | app/(admin)/admin/(shell)/ops/automation/[jobId]/page.tsx:100 |
| MA-111 | /admin/ops/automation/[id] | 「상태 전이 기록」「이전」「이후」「현재 단계 · 결제 · 비용」「판단 모델 호출 N회 · 비용 / 작업 상한」「테스트 표시 확인 전」, 알림 「정리 필요 작업을 닫았습니다」 | 어려운 말, 영어·약어 | 「진행 기록」「바뀌기 전」「바뀐 뒤」, 「지금 단계 · 결제 · 비용」, 「AI 호출 N회 · 비용 N원 (한 작업 최대 N원)」, 「테스트 주문 확인 전」, 「정리 필요 작업을 닫았습니다.」 | app/(admin)/admin/(shell)/ops/automation/[jobId]/page.tsx:65,107,108,118,122,123 |
| MA-051·052 | 문의 상세 | 대화 작성자 이름 「플랫폼 · 이름」 | 어려운 말 | 「운영팀 · 이름」 | app/(admin)/admin/(shell)/support/inquiries/[inquiryId]/page.tsx:146 |
| MA-054 | 공지 작성·수정 | 대상 선택 「파트너스 관리자 + 공개」「공개 공지 (로그인 없이 열람)」, 버튼 「게시」 | 어려운 말, 모호한 버튼 | 「파트너스 관리자와 일반 방문자」, 「로그인 없이 누구나 볼 수 있는 공지」, 「지금 게시하기」(「임시 저장하기」와 구분) | app/(admin)/admin/_components/NoticeForm.tsx:89,121-126 |
| MA-055 | /admin/support/assistant | 「공개 자료만 넣어 주십시오. 파트너스 개인정보·주문 데이터는 넣지 않습니다. 게시한 자료만 답변 근거로 쓰입니다.」, 체크 「게시」, 알림 「지웠습니다.」「지우지 못했습니다.」 | 뜻 둘, 모호한 버튼, 오류에 해결 방법 없음 | 「공개해도 되는 자료만 넣어 주십시오.」 + 「파트너스 개인정보와 주문 정보는 넣지 마십시오.」 + 「「게시」를 켠 자료만 도우미가 답할 때 씁니다.」, 체크 「도우미 답변에 사용(게시)」, 「자료를 지우지 못했습니다. 잠시 후 다시 시도해 주십시오.」 | app/(admin)/admin/(shell)/support/assistant/page.tsx:60,81,88 |
| MA-055 | /admin/support/assistant | 「이 자료를 지우시겠습니까?」(어떤 자료인지 없음) | 모호한 버튼 | 「「{자료 제목}」을(를) 지우시겠습니까?」 | app/(admin)/admin/(shell)/support/assistant/page.tsx:58 |
| MA-062 | 계정 추가·수정 창 | 「입력한 내용을 확인해 주십시오.」 | 오류에 해결 방법 없음 | 「이메일 형식과 이름(50자 이하)을 확인해 주십시오.」 | app/(admin)/admin/_components/AccountDialog.tsx:11 |
| MA-063 | /admin/accounts/roles | 화면 이름·표 머리 「역할별 권한」「권한」, 항목 「시스템 설정」「전체 조회」「기타 권한」 | 어려운 말 | 「역할별로 할 수 있는 일」, 「할 수 있는 일」, 「서비스 설정 바꾸기」, 「모든 화면 보기」, 「그 밖의 기능」 | app/(admin)/admin/(shell)/accounts/roles/page.tsx:35,44; app/(admin)/admin/_components/accounts.ts:20,27 |
| MA-070·071 | /admin/logs, 로그 상세 | 바뀐 값 표의 항목 이름이 목록에 없으면 영어 키가 그대로(「항목」), 값이 글자·JSON 그대로, 「접속 주소」, 「브라우저」(기기 문자열 그대로) | 코드값, 영어·약어 | 항목 이름 표를 넓히고 모르는 값은 「알 수 없는 항목」, 「접속한 기기: 윈도우 크롬」처럼 풀어서 표시 | app/(admin)/admin/_components/auditLogs.ts:104-113; app/(admin)/admin/(shell)/logs/[logId]/page.tsx:36-38,68-69 |
| MA-083 | /admin/settings/maintenance | 버튼 「변경 저장」 | 모호한 버튼 | 「점검 안내 변경 저장」 | app/(admin)/admin/(shell)/settings/maintenance/page.tsx:163 |
| MA-084 | /admin/settings/assistant | 「API 키」, 「설정되지 않음 (서버 환경변수. 없으면 파트너스에게 「준비 중」으로 보입니다)」 | 영어·약어, 어려운 말 | 「도우미 연결 키」, 「아직 입력되지 않았습니다. 개발 담당이 입력하기 전에는 파트너스 화면에 「준비 중」으로 보입니다.」 | app/(admin)/admin/(shell)/settings/assistant/page.tsx:76-77 |
| MA-084 | /admin/settings/assistant | 칸 「모델 이름」「입력 단가(100만 토큰당 원)」「출력 단가(100만 토큰당 원)」「월 한도(원, 플랫폼 전체)」, 예시 「예: gemini-2.5-flash-lite」, 안내 「…100만 토큰당 원입니다. …1,450원/$로 환산하면…」 | 영어·약어, 어려운 말 | 「AI 종류」, 「질문 글자 비용」「답변 글자 비용」(100만 글자 단위 설명은 한 줄 도움말로), 「한 달 사용 한도(원, 전체 합계)」, 안내는 한 문장씩 나눠 쓰고 달러 환산 설명은 삭제 | app/(admin)/admin/(shell)/settings/assistant/page.tsx:12,88,90 |
| MA-084 | /admin/settings/assistant | 버튼 「켜기」「끄기」, 「저장」 | 모호한 버튼 | 「도우미 켜기」「도우미 끄기」, 「도우미 설정 저장」 | app/(admin)/admin/(shell)/settings/assistant/page.tsx:71,97 |
| MA-085 | /admin/settings/branding | 「파비콘」「공유 카드」「PNG 파일만 올릴 수 있습니다. 256KB까지 업로드할 수 있으며 512×512 등 정사각형 이미지를 권장합니다.」, 「1200×630」 | 영어·약어 | 「탭 아이콘(파비콘)」, 「공유 미리보기 카드」, 「PNG 파일만 올릴 수 있습니다. 용량은 256KB 이하이고, 가로와 세로가 같은 그림(예: 512×512)이 좋습니다.」 | app/(admin)/admin/(shell)/settings/branding/page.tsx:277-279,343,386,412 |
| MA-085 | /admin/settings/branding | 경로 줄 「사이트 설정 › 파비콘 · 공유 카드」(메뉴 이름은 「설정」) | 뜻 둘 | 「설정 › 파비콘·공유 카드」로 메뉴와 같게 | app/(admin)/admin/(shell)/settings/branding/page.tsx:76 |
| MA-086 | /admin/settings/messages | 「충전」(소제목)「충전을 켰습니다.」, 버튼 「충전 켜기/끄기」, 「채널별 단가」「채널」, 「플랫폼 메일 무료 한도」, 버튼 「변경」, 「한도는 0 이상의 정수로 입력해 주십시오.」 | 어려운 말, 모호한 버튼 | 「파트너스 선불 충전 사용」「사용을 켰습니다.」, 「종류별 1건 요금」「종류」, 「서비스 전체 무료 메일 한도」, 「요금 변경」, 「한도는 0 이상의 숫자로 입력해 주십시오.」 | app/(admin)/admin/(shell)/settings/messages/page.tsx:56,66,88,96,105,111,128,141 |
| MA-086 | 발송 요금 종류 이름 | 「거래 메일(월 제공량 초과분)」「송장 발급」「송장 라벨」 | 어려운 말 | 「주문·배송 안내 메일(무료 수량을 넘은 것)」 | app/(admin)/admin/_components/messageFees.ts:32,39-40 |
| MA-087 | /admin/settings/vendors | 「결제·PG」「API·개발 편의」「정산주기」「에스크로」「정기결제」「반품 연동」「테스트 환경 제공」「조회 링크만 제공」「점수 가중치 편집」「ONQ 점수」「항목 (가중치)」 | 영어·약어, 어려운 말 | 「카드 결제」, 「연결하기 쉬운 정도」, 「정산 받는 주기」, 「안전결제(에스크로)」, 「자동 반복 결제」, 「반품 자동 연결」, 「테스트 기능 있음」, 「조회 링크만 제공」, 「점수 비중 바꾸기」, 「종합 점수」, 「평가 항목(비중)」 | app/(admin)/admin/_components/vendors.ts:27,35,37,48-62; app/(admin)/admin/(shell)/settings/vendors/page.tsx:116,175,226 |
| MA-087 | /admin/settings/vendors | 목록에 없는 항목 이름은 영어 키가 그대로 나옴 | 코드값 | 모르는 항목은 「이름 없는 항목」 | app/(admin)/admin/_components/vendors.ts:46; app/(admin)/admin/(shell)/settings/vendors/page.tsx:166,444 |
| MA-087 | /admin/settings/vendors | 버튼 「선택」「선택됨」, 확인 창 문구 「…결제는 플랫폼 결제대행사 키 하나로 받습니다.」 | 모호한 버튼, 어려운 말 | 「사용 업체로 선택」「사용 중」, 「…결제는 ONQ가 계약한 결제대행사 한 곳으로 받습니다.」 | app/(admin)/admin/(shell)/settings/vendors/page.tsx:187,265 |
| MA-087 | /admin/settings/vendors | 「로고: PNG · 256KB 이하 · 가로·세로 16~600px · 업체 공식 배포본만 올려 주십시오.」 | 영어·약어 | 「로고 파일: PNG, 용량 256KB 이하, 가로·세로 16~600 사이. 업체가 공식으로 배포한 로고만 올려 주십시오.」 | app/(admin)/admin/(shell)/settings/vendors/page.tsx:220 |
| MA-090 | /admin/account | 알림 「비밀번호를 바꿨습니다. 다른 곳 N건은 로그아웃했습니다.」 | 뜻 둘 | 「비밀번호를 바꿨습니다. 다른 기기 N대는 로그아웃했습니다.」 | app/(admin)/admin/(shell)/account/page.tsx:125 |

**② 확인 창 (28)**

| 화면ID | 경로 | 행동 | 현재 동작 | 확인 창 문구 안 | 위험도 | 파일:줄 |
|---|---|---|---|---|---|---|
| MA-013 | /admin/partners/applications | 「승인」(목록 줄 버튼) | 누르면 바로 POST /api/admin/sellers/{id}/approve. 파일 위 설명에도 「확인 창 없이 바로」라고 적혀 있음 | 제목 「가입을 승인하시겠습니까?」 / 「{쇼핑몰}이 파트너스로 승인되어 바로 쇼핑몰을 열 수 있습니다.」 / [취소] [가입 승인] | 위험 | app/(admin)/admin/(shell)/partners/applications/page.tsx:80-95,187-189 (설명 줄 16) |
| MA-014 | /admin/partners/applications/[id] | 「승인」(상세 위 버튼) | 누르면 바로 POST …/approve 후 다음 신청 건으로 자동 이동 | 위와 같음. 「승인하면 다음 가입 신청으로 넘어갑니다.」를 한 줄 덧붙임 | 위험 | app/(admin)/admin/(shell)/partners/applications/[sellerId]/page.tsx:83-93,112-114 |
| MA-027 | /admin/billing/refunds/[id] | 「승인 · 환불 실행」「다시 승인 · 환불 실행」 | 같은 화면의 체크 「내용을 확인했고 환불을 승인합니다」만 켜면 바로 POST …/approve(카드 결제 취소). 별도 확인 창 없음 | 제목 「환불을 승인하시겠습니까?」 / 「{쇼핑몰}에 {금액}원을 카드 결제 취소로 돌려줍니다. 요청한 뒤에는 되돌릴 수 없습니다.」 / 금액 재입력 칸 / [취소] [환불 승인] (위험 색) | 매우 위험 | app/(admin)/admin/(shell)/billing/refunds/[refundId]/page.tsx:119-146,229-237 |
| MA-012 | /admin/partners/[id] 발송 잔액 | 「지급」(무상 지급 창) | 창에서 금액·사유를 쓰고 누르면 바로 POST …/message-balance | 제목 「무상 잔액을 넣으시겠습니까?」 / 「{쇼핑몰}에 {금액}원이 바로 들어가며 환불되지 않습니다.」 / 금액 재입력 / [취소] [잔액 넣기] | 매우 위험 | app/(admin)/admin/_components/MessageBalanceSection.tsx:37-47,84-86 |
| MA-022 | /admin/billing/plans | 「저장」(체험 한도 변경 창) | 누르면 바로 POST …/trial-limits(체험 중인 모든 파트너스에 바로 적용) | 제목 「체험 한도를 바꾸시겠습니까?」 / 「{요금제} 체험 중인 파트너스 전체에 바로 적용됩니다. 알림톡·문자 N건, 본인확인 N건, 저장 N MB」 / [취소] [한도 변경] | 위험 | app/(admin)/admin/_components/PlanTrialDialog.tsx:26-35,68-70 |
| MA-022 | /admin/billing/plans | 「저장」(월 제공량 변경 창) | 누르면 바로 POST …/mail-quota | 제목 「월 무료 메일 수량을 바꾸시겠습니까?」 / 「{요금제}의 월 무료 수량이 N통에서 N통으로 바뀌고, 넘는 메일은 파트너스 잔액에서 빠집니다. 적용 시각: {시각 또는 바로}」 / [취소] [수량 변경] | 위험 | app/(admin)/admin/_components/ValueDialog.tsx:39-48,83-85 (열리는 곳 app/(admin)/admin/(shell)/billing/plans/page.tsx:133-149) |
| MA-086 | /admin/settings/messages | 「저장」(단가 변경 창) | 같은 ValueDialog로 누르면 바로 POST /api/admin/message-prices/{종류} | 제목 「{종류} 요금을 바꾸시겠습니까?」 / 「1건 요금이 N원에서 N원으로 바뀌어 파트너스 충전 잔액에서 이 금액이 빠집니다. 적용 시각: {시각 또는 바로}」 / 금액 재입력 / [취소] [요금 변경] | 매우 위험 | app/(admin)/admin/_components/ValueDialog.tsx:39-48,83-85 (열리는 곳 app/(admin)/admin/(shell)/settings/messages/page.tsx:184-199) |
| MA-086 | /admin/settings/messages | 「한도 저장」 | 누르면 바로 PUT /api/admin/message-settings(하루·월 무료 메일 한도) | 제목 「무료 메일 한도를 바꾸시겠습니까?」 / 「하루 N통, 한 달 N통으로 바뀌고 넘는 메일은 발송이 멈춥니다.」 / [취소] [한도 변경] | 위험 | app/(admin)/admin/(shell)/settings/messages/page.tsx:60-72,173-175 |
| MA-084 | /admin/settings/assistant | 「켜기」「끄기」 | 누르면 바로 PUT /api/admin/assistant/settings(도우미 켬·끔) | 제목 「도우미를 켜시겠습니까?」(끄기는 「…끄시겠습니까?」) / 「켜면 파트너스가 질문할 때마다 AI 사용 비용이 생깁니다(월 한도 {금액}원).」 / 「끄면 파트너스 화면에서 도우미가 사라집니다.」 / [취소] [도우미 켜기] | 위험 | app/(admin)/admin/(shell)/settings/assistant/page.tsx:35-47,70-72 |
| MA-084 | /admin/settings/assistant | 「저장」(AI 종류·단가·월 한도·하루 질문 수) | 누르면 바로 PUT …/assistant/settings | 제목 「도우미 설정을 저장하시겠습니까?」 / 「월 한도 N원, 파트너스별 하루 N번으로 바뀝니다. 한도에 닿으면 도우미가 멈춥니다.」 / 한도 금액 재입력 / [취소] [설정 저장] | 매우 위험 | app/(admin)/admin/(shell)/settings/assistant/page.tsx:35-52,97 |
| MA-083 | /admin/settings/maintenance | 「변경 저장」(점검 중 문구·시간 수정) | 누르면 바로 PUT …/settings/maintenance(이미 켜진 점검의 안내 문구·시각이 파트너스·방문자에게 바로 바뀜). 「점검 켜기/끄기」는 확인 창이 있음 | 제목 「점검 안내를 바꾸시겠습니까?」 / 「파트너스 관리자·쇼핑몰·가입 신청 화면에 보이는 안내 문구와 시간이 바로 바뀝니다.」 / [취소] [안내 변경] | 위험 | app/(admin)/admin/(shell)/settings/maintenance/page.tsx:66-93,163 |
| MA-085 | /admin/settings/branding | 「파비콘 변경」 | 누르면 바로 PUT …/branding/{대상}/favicon(마스터 관리자 또는 모든 파트너스 관리자 화면의 탭 아이콘) | 제목 「탭 아이콘을 바꾸시겠습니까?」 / 「{마스터 관리자 / 모든 파트너스 관리자} 화면의 탭 아이콘이 새 이미지로 바뀝니다.」 / [취소] [아이콘 변경] | 위험 | app/(admin)/admin/(shell)/settings/branding/page.tsx:184-194,313-315 |
| MA-085 | /admin/settings/branding | 「공유 카드 저장」 | 누르면 바로 PUT …/branding/{대상}(제목·설명) 후 PUT/DELETE …/og-image(이미지). 「제목으로 생성」으로 바꾼 경우 올린 이미지가 DELETE로 지워짐 | 제목 「공유 카드를 저장하시겠습니까?」 / 「{대상} 화면의 공유 미리보기가 바뀝니다.」(이미지가 지워지면 「올려 둔 이미지는 삭제됩니다.」 추가) / [취소] [카드 저장] | 위험 | app/(admin)/admin/(shell)/settings/branding/page.tsx:227-256,466-468 |
| MA-087 | /admin/settings/vendors | 「저장」(점수 가중치 편집 창) | 누르면 바로 PUT /api/admin/service-vendor-categories/{분야}(모든 업체 점수 다시 계산) | 제목 「점수 비중을 저장하시겠습니까?」 / 「{분야} 업체 점수가 모두 다시 계산됩니다. 합계 100점.」 / [취소] [비중 저장] | 위험 | app/(admin)/admin/(shell)/settings/vendors/page.tsx:79,383-385 |
| MA-087 | /admin/settings/vendors | 「저장」(업체 등록·수정 창, 「사용」 체크 포함) | 누르면 바로 POST /api/admin/service-vendors 또는 PATCH …/{id}. 「사용」을 끄면 그 업체를 고를 수 없게 됨 | 제목 「업체 정보를 저장하시겠습니까?」(「사용」을 끈 경우 「이 업체는 더 이상 선택할 수 없게 됩니다.」 추가) / [취소] [업체 저장] | 보통 | app/(admin)/admin/(shell)/settings/vendors/page.tsx:302-306,406-417,479-481 |
| MA-087 | /admin/settings/vendors | 「로고 올리기」「로고 바꾸기」 | 파일을 고르는 순간 바로 PUT …/service-vendors/{id}/logo(고른 파일 확인 단계 없음) | 제목 「로고를 올리시겠습니까?」 / 「{업체} 로고가 이 파일로 바뀝니다.」 / [취소] [로고 올리기] | 보통 | app/(admin)/admin/(shell)/settings/vendors/page.tsx:81-91,258 |
| MA-087 | /admin/settings/vendors | 「로고 삭제」 | 누르면 바로 DELETE …/service-vendors/{id}/logo | 제목 「로고를 삭제하시겠습니까?」 / 「{업체} 로고가 지워지고 업체 이름 첫 글자가 보입니다.」 / [취소] [로고 삭제](위험 색) | 보통 | app/(admin)/admin/(shell)/settings/vendors/page.tsx:92-99,209-211 |
| MA-054 | /admin/support/notices/new, /[id] | 「게시」(공지 작성·수정 폼) | 누르면 바로 POST /api/admin/platform-notices(또는 PUT …/{id}) 후 파트너스·방문자에게 공개 | 제목 「공지를 게시하시겠습니까?」 / 「「{제목}」이 {대상}에게 바로 보입니다.」 / [취소] [지금 게시] | 위험 | app/(admin)/admin/_components/NoticeForm.tsx:27-40,121-123 |
| MA-054 | /admin/support/notices/new, /[id] | 「임시 저장」 | 누르면 바로 POST/PUT …/platform-notices(공개하지 않고 저장) | 제목 「임시 저장하시겠습니까?」 / 「아직 공개되지 않고 목록에만 남습니다.」 / [취소] [임시 저장] | 보통 | app/(admin)/admin/_components/NoticeForm.tsx:27-40,124-126 |
| MA-052 | /admin/support/inquiries/[id] | 「답변 보내기」 | 누르면 바로 POST …/platform-inquiries/{id}/reply(파트너스에게 전달, 취소 방법 없음). 「문의 종료」는 확인 창이 있음 | 제목 「답변을 보내시겠습니까?」 / 「{쇼핑몰}에 이 답변이 바로 전달되며 보낸 뒤에는 고칠 수 없습니다.」 / [취소] [답변 보내기] | 위험 | app/(admin)/admin/(shell)/support/inquiries/[inquiryId]/page.tsx:89-102,178-181 |
| MA-055 | /admin/support/assistant | 「저장」(자료 추가·수정, 「게시」 체크 포함) | 누르면 바로 POST /api/admin/assistant/docs 또는 PUT …/{id}. 「게시」를 켜면 도우미 답변에 바로 쓰임 | 제목 「자료를 저장하시겠습니까?」 / 「게시를 켜면 도우미가 파트너스 질문에 이 자료로 바로 답합니다.」 / [취소] [자료 저장] | 위험 | app/(admin)/admin/(shell)/support/assistant/page.tsx:41-56,92 |
| MA-055 | /admin/support/assistant | 「삭제」 | `window.confirm("이 자료를 지우시겠습니까?")`(브라우저 기본 창)만 거침. 공통 확인 창 부품이 아니고 어떤 자료인지·결과 설명 없음 | 공통 확인 창으로 교체: 「「{제목}」을(를) 삭제하시겠습니까?」 / 「삭제하면 도우미가 이 자료로 답하지 않습니다.」 / [취소] [자료 삭제] | 보통 | app/(admin)/admin/(shell)/support/assistant/page.tsx:57-62,95 |
| MA-062 | /admin/accounts | 「추가」(관리자 계정 추가 창) | 누르면 바로 POST /api/admin/admins(로그인할 수 있는 마스터 관리자 계정이 생김) | 제목 「관리자 계정을 추가하시겠습니까?」 / 「{이름}({이메일})이 {역할}로 추가되어 바로 로그인할 수 있습니다.」 / [취소] [계정 추가] | 위험 | app/(admin)/admin/_components/AccountDialog.tsx:35-50,126-128 |
| MA-062 | /admin/accounts | 「저장」(관리자 계정 수정 창: 이름·역할·상태) | 누르면 바로 PATCH /api/admin/admins/{id}. 상태를 「정지」로 바꾸면 그 계정이 바로 로그아웃됨 | 제목 「관리자 계정을 바꾸시겠습니까?」 / 변경 내용 한 줄씩(예: 「역할: 운영 → 조회 전용」, 「상태: 이용 중 → 정지, 로그인이 바로 끝납니다」) / [취소] [변경 저장](정지는 위험 색) | 위험 | app/(admin)/admin/_components/AccountDialog.tsx:35-50,126-128 |
| MA-090 | /admin/account | 「비밀번호 변경」 | 누르면 바로 POST /api/admin/me/password(체크가 켜져 있으면 다른 기기도 모두 로그아웃) | 제목 「비밀번호를 바꾸시겠습니까?」 / 「다른 기기에서 로그인한 곳은 모두 로그아웃됩니다.」(체크를 껐으면 이 줄 생략) / [취소] [비밀번호 변경] | 위험 | app/(admin)/admin/(shell)/account/page.tsx:114-130,176-178 |
| MA-111 | /admin/ops/automation/[id] | 「정리 완료로 닫기」 | 누르면 바로 POST /api/automation/admin/jobs/{id}/cleanup(작업이 실패로 끝나고 결제가 환불 대기로 넘어감) | 제목 「정리 필요 작업을 닫으시겠습니까?」 / 「이 작업은 실패로 끝나고 결제는 환불 대기로 바뀝니다. 되돌릴 수 없습니다.」 / 「정리한 내용: {입력한 메모}」 / [취소] [작업 닫기] | 매우 위험 | app/(admin)/admin/(shell)/ops/automation/[jobId]/page.tsx:59-67,102 |
| MA-012 | /admin/partners/[id] | 「대리 조회 끝내기」 | 누르면 바로 DELETE /api/admin/impersonation | 제목 「대신 보기를 끝내시겠습니까?」 / 「{쇼핑몰} 화면을 더 이상 볼 수 없습니다. 필요하면 사유를 쓰고 다시 시작해야 합니다.」 / [취소] [대신 보기 끝내기] | 보통 | app/(admin)/admin/(shell)/partners/[sellerId]/page.tsx:70-80,144-146 |
| MA-012 | /admin/partners/[id] 메모 탭 | 「메모 남기기」 | 누르면 바로 POST …/sellers/{id}/notes(메모 삭제는 확인 창이 있음) | 제목 「메모를 남기시겠습니까?」 / 「관리자끼리만 보이고 파트너스에게는 보이지 않습니다.」 / [취소] [메모 남기기] | 보통 | app/(admin)/admin/_components/PartnerTabs.tsx:174-186,227-229 |

**③ 클릭 제목 열 (7)**

| 화면ID | 경로 | 열 | 현재 | 고칠 안 |
|---|---|---|---|---|
| MA-023 | /admin/billing/subscriptions | 쇼핑몰 | 맨 왼쪽 첫 열이지만 가운데 정렬 | 왼쪽 정렬(공통 표 규칙의 제목 열 클래스) |
| MA-011 | /admin/partners | 쇼핑몰 | 맨 왼쪽 첫 열이지만 가운데 정렬 | 왼쪽 정렬 |
| MA-070 | /admin/logs | 쇼핑몰(링크) | 링크가 5번째 열, 첫 열은 「기록 시각」 | 눌러서 들어가는 열을 맨 왼쪽으로(예: 「쇼핑몰」을 첫 열로, 「상세」는 유지) — 로그 표는 시각 중심이라 판단 필요 |
| MA-042 | /admin/ops/access | 파트너스 | 파트너스 이름은 글자뿐이고 링크는 오른쪽 「관리」 열 | 파트너스 이름 열을 첫 열 왼쪽 정렬 링크로 |
| MA-041 | /admin/ops/live | 파트너스 | 같음 | 같음 |
| MA-043 | /admin/ops/rewards | 파트너스 | 같음 | 같음 |
| MA-001 | /admin(대시보드 순위 표) | 쇼핑몰 | 링크 열이 2번째(첫 열은 「순위」) | 순위 열이 순번이면 허용, 아니면 이름 열을 첫 열로 — 판단 필요 |

**④ 표 겹침·정렬 (3)**

| 화면ID | 경로 | 현재 | 고칠 안 |
|---|---|---|---|
| MA-013 | /admin/partners/applications (1440) | 「확인」 열(「이상 없음」·「확인 필요」 배지)이 왼쪽 정렬 | 배지 열은 가운데 |
| MA-023 | /admin/billing/subscriptions (390) | 화면 가로 스크롤(너비 485 > 390) | 넘치는 칸 줄바꿈·말줄임 |
| (표 공통) | /admin, accounts, accounts/roles, billing/plans(1440도), subscriptions, logs, ops/access, ops/live, ops/rewards, partners, partners/applications, settings/messages (390) | 표가 칸 안에서 가로 스크롤(카드형 아님) | ADMIN_OPS_UX 원칙 10(모바일 카드형)에 따라 카드형 전환 — 공통 부품 PR 뒤 |

### 화면-파트너스 운영 (3) — `session_016P8zSbRmKFuuWC9krz69jq`

**① 쉬운 말 (46)**

| 화면ID | 경로 | 현재 문구 | 문제 유형 | 고칠 문장 | 파일:줄 |
|---|---|---|---|---|---|
| SA-021 | /seller/orders | 「결제 완료된 주문만 주문대기에 올라갑니다. 미결제 주문은 「결제 대기」로 표시됩니다.」 | 어려운 말(내부 이름 「주문대기」) | 결제가 끝난 주문만 방송 주문 목록에 들어갑니다. 아직 결제하지 않은 주문은 「결제 대기」로 보입니다. | app/(seller)/seller/(shell)/orders/page.tsx:131 (같은 말 외 5곳: app/(seller)/seller/(shell)/orders/deposits/page.tsx:96, :120, :215 · components/seller/ProductForm.tsx:46 「방송 주문대기에 바로 표시됩니다」 · app/(seller)/seller/(shell)/products/page.tsx:599 「쇼핑몰과 주문대기에서 바로 빠집니다」 · components/seller/ProductForm.tsx:985 · components/seller/RefundModal.tsx:171 「그사이 주문대기가 변경되었습니다」) |
| SA-021 | /seller/orders | 버튼 「적용」(상태 고르기 창) | 모호한 버튼 | 이 상태로 보기 | app/(seller)/seller/(shell)/orders/page.tsx:190 |
| SA-022 | /seller/orders/[id] | 「주문번호 {번호} · 응대 · 검색할 때만 사용합니다」 | 뜻 둘/모호 | 주문번호 {번호} · 구매자 문의에 답하거나 주문을 찾을 때만 씁니다. | app/(seller)/seller/(shell)/orders/[orderId]/page.tsx:109 |
| SA-022 | /seller/orders/[id] | 「옵션 {이름} · 수량 {n}」 | 어려운 말(옵션) | 선택 항목 {이름} · 수량 {n}개 | app/(seller)/seller/(shell)/orders/[orderId]/page.tsx:122 |
| SA-022 | /seller/orders/[id] | 「사유 주체」(환불 정보 항목) | 어려운 말 | 누구 사정인지 | app/(seller)/seller/(shell)/orders/[orderId]/page.tsx:170 |
| SA-022 | /seller/orders/[id] | 「도서산간」 / 「추가 배송비 지역입니다」 | 어려운 말 | 섬·산간 지역 / 섬·산간 지역이라 추가 배송비가 붙습니다. | app/(seller)/seller/(shell)/orders/[orderId]/page.tsx:226-227 (외 1곳: app/(seller)/seller/(shell)/shipping/page.tsx:344) |
| SA-022 | /seller/orders/[id] | 「연락처·주소는 열람 시 열람 기록이 남습니다.」 | 어려운 말 | 연락처와 주소를 보면 누가 언제 봤는지 기록됩니다. | app/(seller)/seller/(shell)/orders/[orderId]/page.tsx:239 |
| SA-022 | /seller/orders/[id] | 「닉네임과 주문 내용만 표시됩니다」 | 뜻 모호(왜 안 보이는지·어떻게 하면 되는지 없음) | 개인정보를 볼 수 있는 사람이 아니어서 닉네임과 주문 내용만 보입니다. 필요하면 대표자에게 허용을 요청해 주십시오. | app/(seller)/seller/(shell)/orders/[orderId]/page.tsx:201 |
| SA-022 | /seller/orders/[id] | 송장 칸에 택배사가 알 수 없는 값이면 코드(CJ·HANJIN 등)가 그대로 나옴 「{courierName(코드)} {송장번호}」 | 코드값 | 택배사를 알 수 없으면 「택배사 확인 필요 {송장번호}」로 표시합니다. | app/(seller)/seller/(shell)/orders/[orderId]/page.tsx:22, :231 |
| SA-023 | 환불 창(주문 상세) · /seller/orders/refund-requests · /seller/returns | 「사유 주체」(라디오 제목), 「사유 주체를 선택하면 표시됩니다」, 「이 사유 주체로는 환불할 수 없는 주문입니다」 | 어려운 말 | 누구 사정인지 / 누구 사정인지 고르면 금액이 보입니다. / 이 사정으로는 환불할 수 없는 주문입니다. | components/seller/RefundModal.tsx:280, :344 · app/(seller)/seller/(shell)/orders/refund-requests/page.tsx:360, :394 · app/(seller)/seller/(shell)/returns/page.tsx:392, :486 |
| SA-023 | 환불 창 · 환불 요청 처리 | 「구매자 사정만 결제 후 취소 횟수에 포함됩니다 · 선택하지 않으면 환불할 수 없습니다」 | 뜻 둘/모호 | 구매자 사정으로 환불하면 이 구매자의 결제 후 취소 횟수가 1회 늘어납니다. 둘 중 하나를 꼭 골라 주십시오. | components/seller/RefundModal.tsx:293 · app/(seller)/seller/(shell)/orders/refund-requests/page.tsx:383 |
| SA-023 | 환불 창 · 환불 요청 처리 | 체크칸 「위 금액으로 환불합니다. 승인 취소 후 되돌릴 수 없습니다.」 | 어려운 말(「승인 취소」)/뜻 모호 | 위 금액으로 환불합니다. 환불한 뒤에는 되돌릴 수 없습니다. | components/seller/RefundModal.tsx:394 · app/(seller)/seller/(shell)/orders/refund-requests/page.tsx:406 |
| SA-023 | 환불 창 | 「원결제 카드 승인 취소」(환불 수단) / 「카드 승인 취소」 | 어려운 말 | 결제한 카드로 취소 | components/seller/RefundModal.tsx:365, :196 |
| SA-023 | 환불 창 | 「{금액} · 수동 확인 필요」「지급 대기분 취소」「지급한 적립금에서 회수」(적립 회수 줄) | 어려운 말 | {금액} · 직접 확인해 주십시오 / 아직 주지 않은 적립금 취소 / 이미 준 적립금 되찾기 | components/seller/RefundModal.tsx:358 (같은 말 외 2곳: app/(seller)/seller/(shell)/reviews/page.tsx:234, :375 「적립금 수동 회수 필요」→「리뷰 적립금 {금액}을 직접 되찾아야 합니다」) |
| SA-023 | 환불 창 | 「발송 전에 개봉한 상품이 있어 구매자 사정으로는 환불할 수 없습니다. 개봉한 상품을 보낸 뒤 처리해 주십시오」 | 뜻 모호 | 개봉한 상품이 있어 구매자 사정으로는 환불할 수 없습니다. 상품을 먼저 보낸 뒤 다시 처리해 주십시오. | components/seller/RefundModal.tsx:377 |
| SA-023 | 환불 창 | 상태 「개봉 대기」「· 전체 수량만」 | 어려운 말 | 개봉 순서 대기 / · 일부만 환불 불가(전부 환불만 가능) | components/seller/RefundModal.tsx:263-264 |
| SA-023 | 환불 창 | 「그사이 주문대기가 변경되었습니다. 다시 눌러 주십시오」 | 어려운 말+해결 방법 부족 | 그사이 주문 정보가 바뀌었습니다. 화면을 다시 연 뒤 한 번 더 눌러 주십시오. | components/seller/RefundModal.tsx:171 |
| SA-026 | /seller/orders/deposits | 「stock_shortage → 재고가 부족해 확인하지 못했습니다」「카드 결제가 진행 중인 주문입니다」「입금 확인할 수 없는 주문입니다」 | 오류에 해결 방법 없음 | 재고가 부족해 입금 확인을 하지 못했습니다. 재고를 늘린 뒤 다시 눌러 주십시오. / 카드 결제가 진행 중입니다. 잠시 뒤 다시 확인해 주십시오. / 입금 확인을 할 수 없는 주문입니다. 주문 상세에서 상태를 확인해 주십시오. | app/(seller)/seller/(shell)/orders/deposits/page.tsx:24-26 |
| SA-023 | /seller/orders/refund-requests · /seller/returns · /seller/shipping 외 | 「환불 요청 처리는 대표자나 주문 · 배송 권한이 있는 직원만 할 수 있습니다.」 등 「…권한이 있는 직원에게 요청해 주십시오」 | 어려운 말(권한) | 보기만 할 수 있습니다. 바꾸려면 대표자에게 「주문·배송」 허용을 요청해 주십시오. | app/(seller)/seller/(shell)/orders/refund-requests/page.tsx:187 (외 14곳: app/(seller)/seller/(shell)/returns/page.tsx:188 · app/(seller)/seller/(shell)/reviews/page.tsx:162 · app/(seller)/seller/(shell)/member-grades/page.tsx:164 · app/(seller)/seller/(shell)/member-messages/page.tsx:122 · app/(seller)/seller/(shell)/coupons/page.tsx:204 · app/(seller)/seller/(shell)/banners/page.tsx:147 · app/(seller)/seller/(shell)/banners/popups/page.tsx:172 · app/(seller)/seller/(shell)/buyer-inquiries/page.tsx:130 · app/(seller)/seller/(shell)/products/search-synonyms/page.tsx:113 · app/(seller)/seller/(shell)/shipping/page.tsx:346 · components/seller/members/MemberOrders.tsx:46 · app/(seller)/seller/(shell)/members/[memberId]/page.tsx:111 · components/seller/States.tsx:47-48 「이 기능은 권한이 필요합니다 / 필요한 권한: {need}」 · components/seller/api.ts:77 · components/seller/RefundModal.tsx:169 · app/(seller)/seller/(shell)/banners/_shared/ui.tsx:371) |
| 공통 | 저장·처리 실패 알림 | 「저장하지 못했습니다」「옵션을 추가하지 못했습니다」「이미지를 올리지 못했습니다」「상세 페이지를 저장하지 못했습니다」「바꾸지 못했습니다」「처리하지 못했습니다. 잠시 뒤 다시 시도해 주십시오」「삭제하지 못했습니다」 | 오류에 해결 방법 없음(무엇을·왜·어떻게가 없음) | {무엇}을 저장하지 못했습니다. 입력한 내용은 그대로 있으니 잠시 뒤 다시 눌러 주십시오. 계속되면 입력값(글자 수·특수문자)을 확인해 주십시오. | components/seller/ProductForm.tsx:262, :276, :291, :310, :324, :329, :427, :446, :491, :500, :512, :967, :973 · components/seller/ProductQuick.tsx:33, :100, :146 · app/(seller)/seller/(shell)/shipping/page.tsx:119 · app/(seller)/seller/(shell)/returns/page.tsx:245 · app/(seller)/seller/(shell)/coupons/page.tsx:173, :183, :481, :709 · app/(seller)/seller/(shell)/reviews/page.tsx:135, :310, :324, :457 · app/(seller)/seller/(shell)/banners/page.tsx:102, :113, :261 · app/(seller)/seller/(shell)/banners/popups/page.tsx:139, :150, :296 · app/(seller)/seller/(shell)/products/categories/page.tsx:92, :103, :120, :131 · app/(seller)/seller/(shell)/products/search-synonyms/page.tsx:85(「표시된 묶음을 확인해 주십시오」→「빨간 글씨로 표시된 묶음을 고쳐 주십시오」) · components/seller/display/CategoryOrder.tsx:33 · components/seller/display/HomeSections.tsx:42 · components/seller/display/ListOptions.tsx:15 · components/seller/display/Recommended.tsx:25 · app/(seller)/seller/(shell)/member-messages/page.tsx:97, :313, :410, :433 · app/(seller)/seller/(shell)/member-grades/page.tsx:118, :131, :483, :493 · components/seller/members/MemberGradeAdjust.tsx:33 · components/seller/members/MemberMemo.tsx:35 · app/(seller)/seller/(shell)/rewards/page.tsx:46 · app/(seller)/seller/(shell)/rewards/live-payout/page.tsx:42 · app/(seller)/seller/(shell)/orders/refund-requests/page.tsx:352, :260, :270 |
| SA-011 | /seller/products | 검색 칸 제목 「재고 차감」, 값 「결제하면 차감」「주문하면 바로 차감」 | 어려운 말(재고 차감) | 재고가 줄어드는 때 / 결제하면 줄임 / 주문하면 바로 줄임 | app/(seller)/seller/(shell)/products/page.tsx:37-42, :347 · components/seller/ProductForm.tsx:723-735 (「재고 차감 기준」) |
| SA-012 | /seller/products/new · [id] | 「기본은 결제하면 차감입니다 · 「주문하면 바로 차감」은 선착순·한정 판매에 적합합니다 · {재고 되돌림 문장}」 | 어려운 말 + 뜻 여럿 | 기본은 결제가 끝나면 재고가 줄어듭니다. 「주문하면 바로 줄임」은 먼저 주문한 사람이 사는 한정 판매에 알맞습니다. 취소·환불했을 때 재고가 돌아오는지는 「주문 설정」을 따릅니다. | components/seller/ProductForm.tsx:191-194, :726-727 |
| SA-011 | /seller/products · 상품 폼 · 재고 관리 · 환불 | 「옵션」(상품명 · 옵션명, 옵션 N, + 옵션 추가, 옵션명, 옵션이 없습니다, 옵션 더 불러오기 등) | 어려운 말(옵션) | 선택 항목(색상·크기 등) / + 선택 항목 추가 / 선택 항목 이름 | app/(seller)/seller/(shell)/products/page.tsx:109, :320 · components/seller/ProductForm.tsx:96-108, :747-807 · app/(seller)/seller/(shell)/products/stock/page.tsx:303, :331, :494, :503, :514 · app/(seller)/seller/(shell)/orders/[orderId]/page.tsx:122 · app/(seller)/seller/(shell)/returns/page.tsx:293 · components/seller/RefundModal.tsx:93 · app/(seller)/seller/(shell)/orders/refund-requests/page.tsx:323 |
| SA-011 | /seller/products | 「노출 상태」 「노출 / 비노출」(검색 칸) · 「쇼핑몰 노출」 · 「노출 · 판매」 · 「노출 페이지」 | 어려운 말(노출) | 쇼핑몰에 보임 / 안 보임 · 쇼핑몰에 보이기 · 보이는 페이지 | app/(seller)/seller/(shell)/products/page.tsx:32-36, :346 · app/(seller)/seller/(shell)/products/categories/page.tsx:218, :234 · components/seller/ProductForm.tsx:813 · app/(seller)/seller/(shell)/banners/page.tsx:308 · app/(seller)/seller/(shell)/banners/popups/page.tsx:375, :399 |
| SA-011 | /seller/products | 일괄 버튼 「선택 판매 중」「선택 숨김」「선택 삭제」 | 모호한 버튼 | 선택한 상품 판매 중으로 바꾸기 / 선택한 상품 숨기기 / 선택한 상품 삭제하기 | app/(seller)/seller/(shell)/products/page.tsx:399-406 |
| SA-011 | /seller/products | 건너뜀 사유 「판매할 옵션이 없음」「처리할 수 없음」 | 어려운 말 + 해결 방법 없음 | 판매할 수 있는 선택 항목이 없음(상품 수정에서 추가해 주십시오) / 바꿀 수 없는 상품임 | app/(seller)/seller/(shell)/products/page.tsx:98, :233 |
| SA-012 | 상품 폼 | 「목록에서 잘 보이려면 50자 이내가 좋습니다 · 공백 포함 최대 100자 · 쇼핑몰과 오버레이에 그대로 표시됩니다」 | 뜻 여럿/영어성 용어 | 최대 100자까지 쓸 수 있습니다. 50자 안쪽이면 목록에서 더 잘 보입니다. 쇼핑몰과 방송 화면에 그대로 나옵니다. | components/seller/ProductForm.tsx:571 |
| SA-012 | 상품 폼 | 상품 코드 「등록하면 판매자별 순번으로 자동 매겨집니다」 | 용어 위반(「판매자」는 파트너스 관리자 화면에서 금지)+어려운 말 | 등록하면 상품마다 번호가 자동으로 붙습니다. 이 번호는 내 쇼핑몰 안에서만 씁니다. | components/seller/ProductForm.tsx:606 |
| SA-012 | 상품 폼 | 이미지 안내 「대표 이미지 1장 + 추가 이미지 N장 = 최대 N장 · 첫 번째가 대표 이미지(목록 · 공유 카드 · 오버레이) · 끌어서 순서 변경, ‹ › 로도 …」 / 상세 「이미지 블록은 가로 860px 권장」「글·이미지 블록은 최대 N개」 | 뜻 여럿·어려운 말(공유 카드·오버레이·블록·px) | 이미지는 최대 N장입니다. 맨 앞 이미지가 대표 이미지로 쓰입니다. 끌어서 순서를 바꿀 수 있습니다. / 상세 이미지는 가로 860픽셀을 권장합니다. 글·이미지는 합쳐서 N개까지 넣을 수 있습니다. | components/seller/ProductImages.tsx:224 · components/seller/ProductDetailEditor.tsx:66, :71, :191 |
| SA-012 | 카테고리 고르기 창 | 버튼 「적용」 | 모호한 버튼 | 고른 카테고리 넣기 | components/seller/ProductCategoryPicker.tsx:109 |
| SA-014 | /seller/products/stock | 「옵션마다 변경할 재고를 입력하고 한 번에 적용하거나, 사유와 함께 빼고 더합니다.」 | 뜻 둘/어려운 말 | 선택 항목마다 바꿀 재고를 적어 한꺼번에 저장하거나, 이유를 적고 재고를 줄이거나 늘립니다. | app/(seller)/seller/(shell)/products/stock/page.tsx:303 |
| SA-014 | /seller/products/stock | 버튼 「변경 N건 적용」「적용」(확인 창) · 「한꺼번에 적기」 · 「적용하기 전에는 반영되지 않습니다」 | 모호한 버튼/어려운 말 | 재고 N건 저장 · 재고 N건 변경 · 선택한 항목에 한꺼번에 더하기 · 저장하기 전에는 쇼핑몰에 반영되지 않습니다 | app/(seller)/seller/(shell)/products/stock/page.tsx:274, :354-355, :503, :597 |
| SA-015 | /seller/products/categories | 「대분류는 쇼핑몰 상단 메뉴, 하위는 그 아래 목록 · 칩이 됩니다 · 대분류를 끄면 … · 순서는 같은 대분류 안에서만 … · 상품은 대분류와 하위 어느 쪽이든 고를 수 있습니다.」(한 문장에 뜻 5개, 「칩」) | 뜻 여럿/어려운 말 | 큰 카테고리는 쇼핑몰 맨 위 메뉴에, 작은 카테고리는 그 아래 버튼으로 보입니다. 큰 카테고리를 끄면 그 아래 작은 카테고리도 함께 안 보입니다. 순서는 같은 큰 카테고리 안에서만 바꿀 수 있고, 바꾼 뒤 「순서 저장」을 눌러야 합니다. | app/(seller)/seller/(shell)/products/categories/page.tsx:286, :311, :344 |
| (ID 없음) 검색 유사어 | /seller/products/search-synonyms | 화면 이름 「검색 유사어」 · 「같은 뜻의 말을 쉼표로 묶어 두면 어느 말로 검색해도 서로의 상품이 나옵니다.」 · 「되돌리기」 | 어려운 말/뜻 모호 | 비슷한 말 검색 / 뜻이 같은 말을 쉼표로 적어 두면 구매자가 어느 말로 검색해도 같은 상품이 나옵니다. / 저장 전 상태로 되돌리기 | app/(seller)/seller/(shell)/products/search-synonyms/page.tsx:99, :102, :128, :172 (같은 말: components/seller/ProductForm.tsx:602 「검색 키워드」는 유지) |
| SA-017 | /seller/products/restock-alerts | 「지금은 알림 발송이 연결되지 않아 발송 기록만 남습니다.」 · 표 머리 「대기」「발송 대기」「발송」 | 어려운 말(연결)/뜻 모호(대기 vs 발송 대기) | 지금은 구매자에게 알림이 실제로 나가지 않고, 보낸 기록만 남습니다. / 알림 신청 · 보낼 예정 · 보냄 | app/(seller)/seller/(shell)/products/restock-alerts/page.tsx:41, :63-65 |
| SA-016 | /seller/products/display | 「HIT 카드가 나온 상품 · 자동」(진열 영역 기준) | 영어·약어 | 최고 등급 카드가 나온 상품 · 자동 (「HIT」가 가리키는 등급 이름 확인 후 확정) | components/seller/display/types.ts:25 |
| SA-016 | /seller/products/display | 버튼 「정렬 · 옵션 저장」 | 어려운 말(옵션) | 정렬 설정 저장 | components/seller/display/ListOptions.tsx:33 (같은 말: :15 「진열 옵션을 저장하지 못했습니다」「진열 옵션을 저장했습니다」:17) |
| SA-025 | /seller/shipping | 알림 「3건 송장 저장 · 2건 실패」(완료 표시 없음, 원인 없음) | 뜻 모호/해결 방법 없음 | 3건 송장을 저장했습니다 · 2건은 저장하지 못했습니다. 아래 빨간 글씨를 확인해 주십시오. | app/(seller)/seller/(shell)/shipping/page.tsx:124 |
| SA-025 | /seller/shipping | 버튼 「배송 완료 처리 (N)」 | 모호한 버튼 | 배송 완료로 바꾸기 (N건) | app/(seller)/seller/(shell)/shipping/page.tsx:222 |
| SA-029 | /seller/returns | 「검수 중」「검수 결과」「검수 메모」「검수 결과 저장」「수거 · 검수 중」 | 어려운 말(검수) | 상품 확인 중 / 상품 확인 결과 / 확인 메모 / 상품 확인 결과 저장 / 수거 · 확인 중 | app/(seller)/seller/(shell)/returns/page.tsx:63, :78, :116, :131, :313, :433, :443, :547 |
| SA-029 | /seller/returns | 「구매자 교환 · 반품 신청 확인 · 접수 · 수거 · 검수 · 환불 · 교환 발송」 | 뜻 모호(단어 나열) | 구매자가 신청한 교환·반품을 처리하는 화면입니다. 접수 → 수거 → 상품 확인 → 환불 또는 교환 상품 발송 순서로 진행합니다. | app/(seller)/seller/(shell)/returns/page.tsx:116 |
| SA-029 | /seller/returns | 「판매자 사정」「구매자 사정 (반품 배송비 차감)」 | 용어 위반(「판매자」→「파트너스」) | 파트너스 사정 | app/(seller)/seller/(shell)/returns/page.tsx:275, :397 |
| SA-029 | /seller/returns | 버튼 「접수」「입고 확인」「환불」「교환 발송」 | 모호한 버튼 | 신청 접수하기 / 상품 도착 확인 / {금액} 환불하기 / 교환 상품 발송 완료 | app/(seller)/seller/(shell)/returns/page.tsx:536, :542, :579, :584 |
| SA-029 | /seller/returns | 「요청 가능 기간은 배송 완료 뒤 7일 안(불량 · 오배송은 기간과 상관없이 접수) · 개봉한 상품은 단순 변심으로 신청할 수 없음 · 처음 낸 배송비가 0원이면 반품 배송비를 왕복으로 뺍니다」 / 「…자동 구매 확정에서 제외」 | 뜻 여럿/어려운 말 | 배송 완료 뒤 7일 안에 신청할 수 있습니다. 불량·다른 상품이 온 경우는 기간과 상관없이 받습니다. 개봉한 상품은 단순 변심으로 신청할 수 없습니다. 처음 낸 배송비가 0원이면 반품 배송비 왕복분을 환불에서 뺍니다. 진행 중인 신청이 있는 주문은 자동 구매 확정이 되지 않습니다. | app/(seller)/seller/(shell)/returns/page.tsx:191-192 |
| SA-029 | /seller/returns | 「재고 조정에서 직접 맞춰 주십시오」 | 내부 이름(메뉴 이름과 다름) | 재고 관리에서 직접 맞춰 주십시오. | app/(seller)/seller/(shell)/returns/page.tsx:368 |
| 공통 | 배너·구매 제한 등 잠금 안내 | 「지금 요금제에서 사용할 수 없는 기능입니다 / 쇼핑몰 통합 요금제에서 사용할 수 있습니다」「쇼핑몰 운영이 포함된 요금제에서…」 | 어려운 말(요금제=플랜) | 지금 이용 중인 상품에서는 쓸 수 없는 기능입니다. 「쇼핑몰 통합」으로 바꾸면 쓸 수 있습니다. | app/(seller)/seller/(shell)/purchase-restrictions/page.tsx:135-136, :210 · app/(seller)/seller/(shell)/banners/_shared/ui.tsx:373 |

**② 확인 창 (25)**

| 화면ID | 경로 | 행동 | 현재 동작 | 확인 창 문구 안 | 위험도 | 파일:줄 |
|---|---|---|---|---|---|---|
| SA-023 | 주문 상세 환불 창 | 「{금액} 환불 실행」 | 부분: 체크칸 「위 금액으로 환불합니다」만 켜면 누르는 즉시 POST /api/seller/orders/{id}/refund (실제 환불) | 「{금액}을 환불하시겠습니까?」 / {구매자 닉네임} 주문 {상품요약}을 {금액} 환불합니다. 환불한 뒤에는 되돌릴 수 없습니다. / [취소] [환불하기](위험 색) | 매우 위험 | components/seller/RefundModal.tsx:151-157, :427 (POST :126) |
| SA-023 | /seller/orders/refund-requests | 「승인하고 환불」 | 부분: 체크칸 동의만 있고 누르면 바로 POST …/refund-requests/{id}/approve (실제 환불) | 「환불 요청을 승인하시겠습니까?」 / {닉네임} 주문 {금액} 환불을 승인합니다. 승인하면 바로 환불되고 되돌릴 수 없습니다. / [취소] [승인하고 환불](위험 색) | 매우 위험 | app/(seller)/seller/(shell)/orders/refund-requests/page.tsx:243-261, :439 |
| SA-029 | /seller/returns | 「환불」(반품 검수 뒤) | 누르면 바로 POST …/returns/{id}/refund (실제 환불) | 「{금액}을 환불하시겠습니까?」 / 반품 상품 확인이 끝난 신청입니다. {금액}을 환불하고 되돌릴 수 없습니다. / [취소] [환불하기](위험 색) | 매우 위험 | app/(seller)/seller/(shell)/returns/page.tsx:240-241, :571-579 |
| SA-029 | /seller/returns | 「접수」 | 누르면 바로 POST …/accept (구매자에게 접수 알림·수거 시작) | 「신청을 접수하시겠습니까?」 / 누구 사정({선택값})으로 접수하고 수거 방법은 {선택값}입니다. 구매자에게 알림이 갑니다. / [취소] [신청 접수하기] | 위험 | app/(seller)/seller/(shell)/returns/page.tsx:535 (act :240) |
| SA-029 | /seller/returns | 「입고 확인」 | 누르면 바로 POST …/receive | 「상품이 도착했는지 확인하시겠습니까?」 / 반품 상품을 받은 것으로 바꾸고 상품 확인 단계로 넘어갑니다. / [취소] [도착 확인] | 보통 | app/(seller)/seller/(shell)/returns/page.tsx:541 |
| SA-029 | /seller/returns | 「검수 결과 저장」 | 누르면 바로 POST …/inspect (재고 되돌리기 포함) | 「상품 확인 결과를 저장하시겠습니까?」 / 결과 {이상 없음/훼손/누락}, 재고 되돌리기 {예/아니오}로 저장합니다. 저장 뒤 환불 또는 반송 단계로 넘어갑니다. / [취소] [결과 저장] | 위험 | app/(seller)/seller/(shell)/returns/page.tsx:546 |
| SA-029 | /seller/returns | 「재입고 뒤 발송」「환불로 전환」 | 누르면 바로 POST …/hold, …/convert | 「환불로 바꾸시겠습니까?」 / 교환 대신 반품 환불로 바꿉니다. 바꾼 뒤에는 교환 상품을 보낼 수 없습니다. / [취소] [환불로 바꾸기] (보류도 같은 방식의 확인) | 위험 | app/(seller)/seller/(shell)/returns/page.tsx:563, :567 |
| SA-029 | /seller/returns | 「교환 발송」 | 누르면 바로 POST …/exchange (송장 번호 전달) | 「교환 상품 발송을 완료 처리하시겠습니까?」 / {택배사} {송장번호}로 발송한 것으로 기록하고 구매자에게 알립니다. / [취소] [발송 완료] | 위험 | app/(seller)/seller/(shell)/returns/page.tsx:583 |
| SA-025 | /seller/shipping | 「송장 저장 (N)」 | 누르면 바로 POST /api/seller/shipments (여러 건, 구매자 발송 알림) | 「송장 N건을 저장하시겠습니까?」 / 택배사·송장번호를 저장하고 해당 주문을 「배송 중」으로 바꿉니다. 구매자에게 알림이 갑니다. / [취소] [송장 저장] | 위험 | app/(seller)/seller/(shell)/shipping/page.tsx:149-159, :215 (POST :138) |
| SA-025 | /seller/shipping | 「배송 완료 처리 (N)」 | 누르면 바로 POST /api/seller/shipments/deliver (여러 건) | 「N건을 배송 완료로 바꾸시겠습니까?」 / 선택한 주문을 배송 완료로 바꿉니다. 구매자에게 알림이 가고 리뷰 작성이 열립니다. / [취소] [배송 완료로 바꾸기] | 위험 | app/(seller)/seller/(shell)/shipping/page.tsx:161-162, :221-222 |
| SA-011 | /seller/products | 「선택 판매 중」「선택 숨김」 | 누르면 바로 POST /api/seller/products/bulk(status). 실행 뒤 8초 「되돌리기」 알림만 있음 | 「선택한 상품 N개를 {판매 중으로/숨김으로} 바꾸시겠습니까?」 / 쇼핑몰에 바로 반영됩니다. / [취소] [바꾸기] | 위험 | app/(seller)/seller/(shell)/products/page.tsx:246-256, :399-404 |
| SA-011 | /seller/products | 목록 행 판매 상태 선택(판매 중/품절/숨김) | 고르는 즉시 PATCH /api/seller/products/{id} {status}. 토스트 「되돌리기」만 있음 | 「「{상품명}」 상태를 {상태}(으)로 바꾸시겠습니까?」 / 쇼핑몰에 바로 반영됩니다. / [취소] [바꾸기] | 위험 | components/seller/ProductQuick.tsx:28-41, :43 (되돌리기 PATCH :36) |
| SA-011 | /seller/products | 목록 행 재고 칸(입력 후 칸 밖 클릭·Enter) | 칸을 벗어나는 즉시 PATCH …/options/{id} {stock}. 토스트 「되돌리기」만 있음 | 「「{상품명}」 재고를 {n}개로 바꾸시겠습니까?」 / 현재 {m}개에서 {n}개로 바뀌고 쇼핑몰에 바로 반영됩니다. / [취소] [재고 바꾸기] | 위험 | components/seller/ProductQuick.tsx:62-101, :111 |
| SA-011 | /seller/products | 목록 행 판매가 칸(입력 후 칸 밖 클릭·Enter) | 칸을 벗어나는 즉시 PATCH /api/seller/products/{id} {price} | 「「{상품명}」 판매가를 {금액}으로 바꾸시겠습니까?」 / {이전 금액}에서 {새 금액}으로 바뀌고 쇼핑몰에 바로 반영됩니다. / [취소] [판매가 바꾸기] | 매우 위험 | components/seller/ProductQuick.tsx:133-155, :173 |
| SA-012 | /seller/products/new · [id] | 「저장」「등록」「임시 저장」 | 누르면 바로 POST /api/seller/products 또는 PATCH …/{id}(+선택 항목 추가·삭제·이미지 삭제·상세 PUT·카테고리 PUT) | 「상품을 {저장/등록}하시겠습니까?」 / {상품명}의 가격·재고·판매 상태 변경이 쇼핑몰에 바로 반영됩니다. (삭제한 선택 항목·이미지가 있으면 개수 표시) / [취소] [저장] | 위험 | components/seller/ProductForm.tsx:372-392, :405-525, :534-543 |
| SA-014 | /seller/products/stock | 「빼기 · 더하기」 창의 「{n}개 빼기/더하기」 | 입력 창에서 누르면 바로 POST(재고 변경, 이력 기록) | 「재고를 {n}개 {줄이시겠습니까/늘리시겠습니까}?」 / {상품 · 선택 항목}: 지금 {m}개 → {결과}개. 사유 「{사유}」가 기록됩니다. / [취소] [{n}개 빼기] | 보통 | app/(seller)/seller/(shell)/products/stock/page.tsx:674-683, :744 |
| SA-015 | /seller/products/categories | 「쇼핑몰 노출」 체크칸 | 체크를 바꾸는 즉시 PATCH /api/seller/categories/{id} {visible} (큰 카테고리를 끄면 아래 카테고리도 안 보임) | 「「{이름}」을 쇼핑몰에서 {숨기시겠습니까/보이시겠습니까}?」 / 아래 작은 카테고리 {n}개도 함께 {숨겨집니다/보입니다}. / [취소] [숨기기/보이기] | 위험 | app/(seller)/seller/(shell)/products/categories/page.tsx:101-103, :234, :261 |
| SA-015 | /seller/products/categories | 「순서 저장」 / 이름 변경 「저장」 / 「추가」 | 누르면 바로 PUT …/categories/order, PATCH …/{id} {name}, POST …/categories | 「카테고리 순서를 저장하시겠습니까?」 / 쇼핑몰 메뉴 순서가 바로 바뀝니다. (이름 변경: 「이름을 「{새 이름}」으로 바꾸시겠습니까?」 상품·메뉴 이름이 함께 바뀝니다.) / [취소] [저장] | 위험(순서·이름) / 보통(추가) | app/(seller)/seller/(shell)/products/categories/page.tsx:84-99, :111-124, :164, :350 |
| (ID 없음) | /seller/products/search-synonyms | 「저장」 | 누르면 바로 PUT /api/seller/shop-search/synonyms | 「비슷한 말 {n}묶음을 저장하시겠습니까?」 / 저장하면 쇼핑몰 검색에 바로 적용됩니다. / [취소] [저장] | 보통 | app/(seller)/seller/(shell)/products/search-synonyms/page.tsx:80-94, :105 |
| SA-016 | /seller/products/display | 「영역 저장」 | 누르면 바로 PUT /api/seller/display/sections | 「홈 진열 영역을 저장하시겠습니까?」 / 쇼핑몰 홈에 바로 반영됩니다. / [취소] [저장] | 위험 | components/seller/display/HomeSections.tsx:40, :52 |
| SA-016 | /seller/products/display | 「추천 상품 저장」 | 누르면 바로 PUT /api/seller/display/recommended | 「추천 상품 {n}개를 저장하시겠습니까?」 / 홈 추천 영역에 바로 반영됩니다. / [취소] [저장] | 위험 | components/seller/display/Recommended.tsx:23, :41 |
| SA-016 | /seller/products/display | 「정렬 · 옵션 저장」 | 누르면 바로 PUT /api/seller/display/settings | 「목록 정렬 설정을 저장하시겠습니까?」 / 쇼핑몰 상품 목록의 기본 정렬과 품절 표시가 바로 바뀝니다. / [취소] [저장] | 위험 | components/seller/display/ListOptions.tsx:13, :32 |
| SA-016 | /seller/products/display | 「순서 저장」(카테고리별 진열) | 누르면 바로 PUT /api/seller/categories/{id}/products | 「카테고리 안 상품 순서를 저장하시겠습니까?」 / 쇼핑몰에 바로 반영됩니다. / [취소] [저장] | 위험 | components/seller/display/CategoryOrder.tsx:29, :43 |
| SA-047 | /seller/buyer-inquiries | 「답변 저장」 | 누르면 바로 PUT …/inquiries/{id}/answer (구매자에게 공개) | 「답변을 저장하시겠습니까?」 / 구매자에게 답변이 보이고 문의가 「답변 완료」가 됩니다. / [취소] [답변 저장] | 보통 | app/(seller)/seller/(shell)/buyer-inquiries/page.tsx:243, :299 |
| SA-047 | /seller/buyer-inquiries | 「답변 지우기」 | 누르면 바로 PUT …/answer {answer:null} | 「답변을 지우시겠습니까?」 / 구매자에게 보이던 답변이 사라지고 문의가 「답변 대기」로 돌아갑니다. / [취소] [답변 지우기](위험 색) | 위험 | app/(seller)/seller/(shell)/buyer-inquiries/page.tsx:243, :294 |

**③ 클릭 제목 열 (1)**

| 화면ID | 경로 | 열 | 현재 | 고칠 안 |
|---|---|---|---|---|
| SA-021 | /seller/orders | (접수 시각 열이 링크) | 눌러서 들어가는 열이 「접수 시각」이고 가운데 정렬(주문번호·제목 열 없음) | 첫 열을 「주문번호 · 접수 시각」 왼쪽 정렬 링크로 — 주문번호는 새 규칙에서 클릭 제목 열 목록에 있음. 기존 「표 정렬」 규칙(주문번호 가운데)과 충돌하므로 디자인 확정 필요 |

**④ 표 겹침·정렬 (6)**

| 화면ID | 경로 | 현재 | 고칠 안 |
|---|---|---|---|
| SA-021 | /seller/orders (1440) | 「상품」 칸 긴 이름이 잘림(말줄임·툴팁 여부 확인 필요) | 말줄임(…) + 툴팁 확인 |
| SA-021 | /seller/orders (390) | 표가 화면 밖으로 나감 | 모바일 카드형 |
| SA-011 | /seller/products (1440) | 「재고」 열 칸이 숨김 넘침으로 측정(내용 잘림 여부 확인 필요) | 칸 폭·말줄임 확인 |
| SA-014 | /seller/products/stock (390) | 「현재」「차이」「상태」 열이 왼쪽 정렬이고 「차이」 칸이 표 밖으로 나감 | 가운데 정렬 규칙 적용, 칸 폭 조정 |
| SA-026 | /seller/orders/deposits (390) | 표가 가로 스크롤 | 모바일 카드형 |
| SA-016 | /seller/products/display (390) | 표가 가로 스크롤 | 모바일 카드형 |

### 쇼핑몰 운영 전담 (2) — `session_01WDkrYfwDz7o3oD8f2PeSvP` (보관 상태 — MASTER 재배정 필요)

**① 쉬운 말 (15)**

| 화면ID | 경로 | 현재 문구 | 문제 유형 | 고칠 문장 | 파일:줄 |
|---|---|---|---|---|---|
| SA-044 | /seller/member-grades | 「지금 재산정」「다음 재산정」「자동 재산정」「재산정 주기」「재산정 완료 · 승급 N명 · 강등 N명」 및 「승급」「강등」「수동 고정」 | 어려운 말 | 등급 다시 계산하기 / 다음 계산 / 자동으로 등급 다시 계산 / 계산 주기 / 등급 올림 · 등급 내림 / 직접 고정 | app/(seller)/seller/(shell)/member-grades/page.tsx:150, :182, :186-193, :198, :299, :317, :327, :425, :437 (외 components/seller/members/MemberGradeAdjust.tsx:37, :70 「고정 (자동 재산정에서 제외)」→「등급 고정 (자동 계산에서 빼기)」) |
| SA-044 | /seller/member-grades | 긴 안내 「기준 금액은 높은 등급일수록 커야 합니다 · 첫 등급은 0원 · 등급은 10개까지 · 높은 등급부터 판정해 하나만 적용 · 적립률은 적립 정책에서 수정」 외 2곳 | 뜻 여럿 | 문장을 나눕니다. 예: 기준 금액은 높은 등급일수록 커야 합니다. 첫 등급은 0원입니다. 등급은 10개까지 만들 수 있습니다. 구매 금액이 기준을 넘는 가장 높은 등급 하나만 적용됩니다. | app/(seller)/seller/(shell)/member-grades/page.tsx:245, :250, :301, :337 |
| SA-044 | /seller/member-grades · 회원 상세 | 버튼 「적용」(수동 조정) · 「등급 적용」 | 모호한 버튼 | 이 등급으로 바꾸기 | app/(seller)/seller/(shell)/member-grades/page.tsx:542 · components/seller/members/MemberGradeAdjust.tsx:92 |
| SA-049 | /seller/member-messages | 「실제 발송 채널(알림톡 · 문자 · 메일)이 아직 연결되지 않아 발송 기록만 남습니다. 충전 잔액은 차감되지 않으며, 채널이 정해지면 같은 기록으로 발송합니다.」 | 어려운 말(채널·연결) | 아직 알림톡·문자·메일이 실제로 나가지 않고 보낸 기록만 남습니다. 충전 잔액은 줄지 않습니다. | app/(seller)/seller/(shell)/member-messages/page.tsx:116 (같은 말: :290 「열람 · 클릭 집계는 실제 발송 채널이 정해지면 표시됩니다」, :569, :586) |
| SA-049 | /seller/member-messages | 「광고성」「정보성 (배송 · 주문 · 약관 안내)」 | 어려운 말 | 광고 메시지 / 안내 메시지 (배송 · 주문 · 약관 안내) | app/(seller)/seller/(shell)/member-messages/page.tsx:187, :461 |
| SA-049 | /seller/member-messages | 「예약 시각 (KST)」「사용 기간 (KST)」「게시 기간 (KST)」 | 영어·약어 | 예약 시각 (한국 시간) / 사용 기간 (한국 시간) / 게시 기간 (한국 시간) | app/(seller)/seller/(shell)/member-messages/page.tsx:344, :550 · app/(seller)/seller/(shell)/coupons/page.tsx:588 · app/(seller)/seller/(shell)/banners/_shared/ui.tsx:51 |
| SA-049 | /seller/member-messages | 입력칸 힌트 「구매자에게 보이는 문구 (해요체)」 / 「구매자에게 보이는 글 · 해요체 · 40자」 / 「90자를 넘으면 긴 문자」 | 어려운 말(해요체·긴 문자) | 구매자에게 보이는 글입니다. 「~해요」 말투로 써 주십시오. / 90자를 넘으면 문자 요금이 더 드는 긴 문자로 나갑니다. | app/(seller)/seller/(shell)/member-messages/page.tsx:556-557 · app/(seller)/seller/(shell)/banners/popups/page.tsx:353, :361 |
| SA-035 | /seller/coupons | 「주문당 쿠폰 1장 · 1인 1장 · 전체 취소면 쿠폰 복구, 부분 취소면 복구 없음 · 발급 중지는 이미 받은 쿠폰에 영향 없음 · 발급 · 수정 · 중지는 로그 추적에 남음」 | 뜻 여럿 | 주문 한 건에 쿠폰 1장만 쓸 수 있고, 한 사람이 1장만 받을 수 있습니다. 주문 전체를 취소하면 쿠폰이 돌아오고, 일부만 취소하면 돌아오지 않습니다. 발급을 중지해도 이미 받은 쿠폰은 그대로 쓸 수 있습니다. | app/(seller)/seller/(shell)/coupons/page.tsx:362 |
| SA-048 | /seller/reviews | 「0원이면 지급하지 않습니다 · 공개될 때 지급, 숨김 · 삭제 때 회수 · 적립금 실지급이 꺼져 있으면 예정으로 보관」 | 어려운 말+뜻 여럿 | 0원이면 주지 않습니다. 리뷰가 공개되면 적립금을 주고, 숨기거나 삭제하면 되찾습니다. 「실제 지급」이 꺼져 있으면 지급 예정으로만 남습니다. | app/(seller)/seller/(shell)/reviews/page.tsx:503 |
| SA-048 | /seller/reviews | 「상품 리뷰에 「판매자」 이름으로 공개」 | 용어 확인 필요(구매자 화면 이름은 「판매자」가 맞으나, 관리자 안내문이 판매자를 그대로 씀) | 상품 리뷰에 답글이 공개됩니다. 구매자에게는 「판매자」 이름으로 보입니다. | app/(seller)/seller/(shell)/reviews/page.tsx:389 |
| SA-064/065 | /seller/banners · /seller/banners/popups | 「제목 (대체 텍스트)」 | 어려운 말 | 제목 (이미지가 안 보일 때 대신 나오는 글) | app/(seller)/seller/(shell)/banners/page.tsx:288 · app/(seller)/seller/(shell)/banners/popups/page.tsx:350 |
| SA-064/065 | 배너·팝업 폼 | 「서버 시각 기준 자동 게시·숨김」 | 어려운 말(서버) | 비우면 바로 보입니다. 종료를 비우면 계속 보입니다. 시작·종료 시각이 되면 자동으로 보이고 숨겨집니다. | app/(seller)/seller/(shell)/banners/_shared/ui.tsx:57 |
| SA-064/065 | 배너·팝업 폼 | 「쇼핑몰 안 경로(/로 시작) 또는 http(s) 주소만 입력할 수 있습니다」「/products/상품 주소 또는 https://」「쇼핑몰 안 경로는 쇼핑몰 주소 뒤에 붙음」 | 영어·약어·뜻 모호 | 쇼핑몰 안 페이지는 /로 시작하게, 다른 사이트는 https://로 시작하게 적어 주십시오. | app/(seller)/seller/(shell)/banners/_shared/ui.tsx:287, :294, :296 |
| SA-064/065 | 배너·팝업 이미지 올리기 | 「8비트(일반) PNG로 저장해 주십시오. 16비트 PNG는 올릴 수 없습니다」「이미지 가로·세로는 100~2000px, 전체 1920×1080 화소 이하여야 합니다」「이미지 데이터가 너무 큽니다…」 | 어려운 말/영어 | 이미지를 일반 PNG로 다시 저장해 올려 주십시오. / 가로·세로는 100~2000픽셀, 크기는 1920×1080 이하여야 합니다. 크기를 줄여 다시 올려 주십시오. | app/(seller)/seller/(shell)/banners/_shared/ui.tsx:67, :69-70, :154 |
| SA-043 | /seller/purchase-restrictions · 회원 상세 | 「직접 제한을 걸거나 풀면 그 시점부터 미입금 자동 취소 횟수를 새로 셉니다」「자동 제한 횟수는 지금부터 새로 셉니다」 | 뜻 모호 | 제한을 걸거나 풀면, 입금하지 않아 자동 취소된 횟수를 그때부터 다시 0회로 셉니다. | components/seller/members/MemberRestriction.tsx:121, :157 · app/(seller)/seller/(shell)/purchase-restrictions/page.tsx:222 |

**② 확인 창 (16)**

| 화면ID | 경로 | 행동 | 현재 동작 | 확인 창 문구 안 | 위험도 | 파일:줄 |
|---|---|---|---|---|---|---|
| SA-042 | /seller/members/[id] | 「메모 저장」 | 누르면 바로 PUT /api/seller/members/{id}/memo (비우면 메모 삭제) | 「메모를 저장하시겠습니까?」(비운 경우 「메모를 지우시겠습니까?」) / 이 회원의 메모가 바뀝니다. / [취소] [메모 저장] | 보통 | components/seller/members/MemberMemo.tsx:33, :60, :87 |
| SA-042 | /seller/members/[id] | 「등급 적용」 | 누르면 바로 PUT /api/seller/member-grades/members/{id} | 「{닉네임} 등급을 {등급}으로 바꾸시겠습니까?」 / 등급 혜택과 적립률이 바로 바뀝니다. 「고정」을 켜면 자동 계산에서 빠집니다. / [취소] [등급 바꾸기] | 위험 | components/seller/members/MemberGradeAdjust.tsx:26-38, :51, :92 |
| SA-044 | /seller/member-grades | 「저장」(기준 금액·혜택·자동 계산 설정) | 누르면 바로 PUT /api/seller/member-grades | 「회원 등급 설정을 저장하시겠습니까?」 / 등급 기준 금액과 혜택이 바뀝니다. 다음 계산부터 회원 등급에 반영됩니다. / [취소] [저장] | 위험 | app/(seller)/seller/(shell)/member-grades/page.tsx:111-128, :153 |
| SA-044 | /seller/member-grades | 「추가」(새 등급) / 「적용」(수동 조정) | 누르면 바로 POST /api/seller/member-grades, PUT …/members/{id} | 「등급 「{이름}」을 추가하시겠습니까?」 / 「{닉네임} 등급을 {등급}으로 바꾸시겠습니까?」 / [취소] [추가] [등급 바꾸기] | 위험 | app/(seller)/seller/(shell)/member-grades/page.tsx:135, :239, :491, :541 |
| SA-049 | /seller/member-messages | 「취소」(예약 취소) | 누르면 바로 POST …/member-messages/{id}/cancel | 「예약을 취소하시겠습니까?」 / 「{제목}」 {시각} 발송 예약이 취소되고 되돌릴 수 없습니다. / [닫기] [예약 취소](위험 색) | 위험 | app/(seller)/seller/(shell)/member-messages/page.tsx:94-98, :205 |
| SA-049 | /seller/member-messages | 「저장」(예약 수정) | 누르면 바로 PUT …/member-messages/{id} | 「예약 내용을 저장하시겠습니까?」 / 제목·문구·발송 시각이 바뀝니다. / [취소] [저장] | 보통 | app/(seller)/seller/(shell)/member-messages/page.tsx:309-313, :356 |
| SA-035 | /seller/coupons | 「저장」(쿠폰 만들기·수정) | 누르면 바로 POST /api/seller/coupons 또는 PUT …/{id} | 「쿠폰을 저장하시겠습니까?」 / 「{쿠폰 이름}」 {혜택}이 {시작 시각}부터 발급됩니다. 발급된 쿠폰은 혜택·발급 방식을 바꿀 수 없습니다. / [취소] [저장] | 위험 | app/(seller)/seller/(shell)/coupons/page.tsx:479-482, :689 |
| SA-035 | /seller/coupons | 「다시 발급」 | 누르면 바로 PATCH …/coupons/{id} {isActive:true} | 「쿠폰 발급을 다시 시작하시겠습니까?」 / 「{이름}」을 구매자가 다시 받을 수 있게 됩니다. / [취소] [다시 발급] | 위험 | app/(seller)/seller/(shell)/coupons/page.tsx:168-173, :340 |
| SA-035 | /seller/coupons | 「{N}명에게 지급」(직접 지급 창) | 창에서 누르면 바로 POST …/coupons/{id}/grant (회원 쿠폰함에 즉시 지급) | 「{N}명에게 쿠폰을 지급하시겠습니까?」 / 선택한 등급 회원 {N}명의 쿠폰함에 「{이름}」이 바로 들어가고 되돌릴 수 없습니다. / [취소] [쿠폰 지급] | 매우 위험 | app/(seller)/seller/(shell)/coupons/page.tsx:705-710, :745 |
| SA-048 | /seller/reviews | 「공개」「다시 공개」 | 누르면 바로 POST …/reviews/{id}/publish (리뷰 적립금 지급이 함께 일어날 수 있음) | 「이 리뷰를 공개하시겠습니까?」 / 상품 리뷰와 별점 평균에 반영되고 리뷰 적립금 {금액}이 지급됩니다. / [취소] [리뷰 공개] | 위험 | app/(seller)/seller/(shell)/reviews/page.tsx:319-325, :429 |
| SA-048 | /seller/reviews | 「답글 저장」 | 누르면 바로 PUT …/reviews/{id}/reply (구매자에게 공개) | 「답글을 저장하시겠습니까?」 / 답글이 상품 리뷰에 바로 공개됩니다. (비워서 지우는 경우 「답글을 지우시겠습니까?」) / [취소] [답글 저장] | 보통 | app/(seller)/seller/(shell)/reviews/page.tsx:433 |
| SA-048 | /seller/reviews | 「저장」(리뷰 설정) | 누르면 바로 PUT /api/seller/reviews/policy | 「리뷰 설정을 저장하시겠습니까?」 / 공개 방식·리뷰 적립금·작성 기간·금지어가 바뀌고 새 리뷰부터 적용됩니다. / [취소] [저장] | 위험 | app/(seller)/seller/(shell)/reviews/page.tsx:455, :520 |
| SA-064 | /seller/banners | 순서 바꾸기(▲ ▼ 버튼·끌어서 놓기) | 누르는 즉시 PUT …/banners/reorder (홈 슬라이드 순서가 바로 바뀜) | 「배너 순서를 바꾸시겠습니까?」 / 쇼핑몰 홈 슬라이드 순서가 바로 바뀝니다. / [취소] [순서 바꾸기] (▲ ▼ 눌러 모은 뒤 「순서 저장」 한 번으로 바꾸는 방식도 가능) | 위험 | app/(seller)/seller/(shell)/banners/page.tsx:99-105, :172-179 |
| SA-064 | /seller/banners | 「저장」(배너 추가·수정) | 누르면 바로 POST …/banners 또는 PUT …/{id} (홈에 바로 반영) | 「배너를 저장하시겠습니까?」 / 「{제목}」이 쇼핑몰 홈에 바로 반영됩니다. / [취소] [저장] | 위험 | app/(seller)/seller/(shell)/banners/page.tsx:254-262, :344 |
| SA-065 | /seller/banners/popups | 순서 바꾸기(▲ ▼·끌어서 놓기) | 누르는 즉시 PUT …/popups/reorder | 「팝업 순서를 바꾸시겠습니까?」 / 쇼핑몰에 뜨는 팝업의 우선순위가 바로 바뀝니다. / [취소] [순서 바꾸기] | 위험 | app/(seller)/seller/(shell)/banners/popups/page.tsx:135-141, :197-204 |
| SA-065 | /seller/banners/popups | 「저장」(팝업 추가·수정) | 누르면 바로 POST …/popups 또는 PUT …/{id} | 「팝업을 저장하시겠습니까?」 / 「{제목}」이 쇼핑몰에 바로 반영됩니다. / [취소] [저장] | 위험 | app/(seller)/seller/(shell)/banners/popups/page.tsx:294-297, :435 |

**③ 클릭 제목 열 (2)**

| 화면ID | 경로 | 열 | 현재 | 고칠 안 |
|---|---|---|---|---|
| SA-041 | /seller/members | 방송 닉네임 | 맨 왼쪽 첫 열이지만 가운데 정렬 | 왼쪽 정렬(회원명) |
| SA-042 | /seller/members/[memberId] 주문 표 | (「상세」 링크 열) | 제목 열 없이 맨 오른쪽 「상세」만 링크 | 주문 번호·상품을 첫 열 링크로 |

**④ 표 겹침·정렬 (1)**

| 화면ID | 경로 | 현재 | 고칠 안 |
|---|---|---|---|
| SA-041·042 | /seller/members(+상세) (390) | 표가 가로 스크롤 | 모바일 카드형 |

### 화면-설정 (2) — `session_014yzgBefSGaxVp7o6eBETzb`

**① 쉬운 말 (42)**

| 화면ID | 경로 | 현재 문구 | 문제 유형 | 고칠 문장 | 파일:줄 |
|---|---|---|---|---|---|
| SA-031 | /seller/rewards/ledger | 화면 이름 「적립금 지급·회수 원장」「적립금 원장」「원장을 더 불러오지 못했습니다」 | 어려운 말(원장) | 적립금 지급·회수 내역 / 내역을 더 불러오지 못했습니다. 다시 눌러 주십시오 | app/(seller)/seller/(shell)/rewards/ledger/page.tsx:75, :82, :84 |
| (ID 없음) 적립금 실지급 | /seller/rewards/live-payout | 「실지급」「실지급 켜기 / 끄기」「실지급을 켰습니다」 | 어려운 말 | 실제 지급 / 실제 지급 켜기·끄기 | app/(seller)/seller/(shell)/rewards/live-payout/page.tsx:44, :51, :53, :74, :91, :105 |
| SA-060 | /seller/settings/shop | 「이용 기간 종료」「지금 요금제에서 사용할 수 없는 기능」「로고를 올리지 못했습니다」「로고를 지우지 못했습니다」「변경 권한이 없습니다」「8비트 PNG · 2MB 이하 · 정사각형 512 × 512px 이상(1440px까지) · 끌어다 놓아도 됨」「로고를 바꿨습니다 · 쇼핑몰에 바로 반영」 | 어려운 말/영어·약어/오류에 해결 방법 없음 | 「이용 기간이 끝났습니다. 구독하면 다시 쓸 수 있습니다」「지금 이용권에서는 쓸 수 없는 기능입니다」「로고를 올리지 못했습니다. PNG 파일인지, 2MB 이하인지 확인한 뒤 다시 올려 주십시오」「로고를 지우지 못했습니다. 잠시 뒤 다시 눌러 주십시오」「이 계정은 로고를 바꿀 수 없습니다. 대표자에게 요청해 주십시오」「PNG 파일 · 2MB 이하 · 가로세로 같은 크기 512px 이상 1440px 이하 · 끌어다 놓아도 됩니다」 | app/(seller)/seller/(shell)/settings/shop/page.tsx:57,61,72,96,98,147 |
| SA-068 | /seller/settings/member | 「탈퇴한 사람의 재가입 막기」「제한 기간」「켜면 가입할 때 「재가입 제한 정보 보관」 동의를 따로 받습니다. 이미 가입한 회원은 가입할 때 동의한 기간까지만 적용됩니다. 끄면 보관하던 탈퇴 회원 정보는 바로 삭제합니다.」「회원이 동의를 철회할 수 있는 화면이 준비되면 켤 수 있습니다」「저장하지 못했습니다. 잠시 후 다시 시도해 주십시오」「저장할 수 없습니다.」 | 뜻 둘(긴 한 문장에 규칙 셋)/어려운 말(철회)/오류에 해결 방법 없음 | 「이 기능을 켜면 가입할 때 「탈퇴 기록 보관」에 동의를 따로 받습니다.」「이미 가입한 회원은 가입할 때 동의한 기간까지만 막습니다.」「이 기능을 끄면 보관하던 탈퇴 회원 기록이 바로 지워집니다.」(세 문장으로 나눔), 「저장하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오」 | app/(seller)/seller/(shell)/settings/member/page.tsx:53,92,98,102,114,121-122,133 |
| SA-080 | /seller/settings/order-notifications | 「거래 메일」「제공량」「소진」「미발송」「차감」「단가」「발송·이용 충전금」「알림톡 · 문자 / 발신 프로필·발신번호 등록과 이벤트별 문구 설정은 준비 중입니다」「거래 메일이라 수신 거부 없이 보냅니다」「제공량을 넘긴 거래 메일 · 대량 메일 · 문자 · 알림톡은 잔액에서 건당 차감합니다 · 잔액이 부족하면 보내지 않고 미발송으로 남깁니다 · 단가는 발송·이용 충전에서 봅니다」 | 어려운 말/뜻 둘(한 줄에 규칙 셋) | 「주문·배송 안내 메일」「매달 무료로 보낼 수 있는 수」「다 씀」「보내지 못함」「빠짐(잔액에서 빠져나감)」「한 통 가격」「문자·메일 충전금」「카카오 알림톡 · 문자 / 아직 쓸 수 없습니다」「주문·배송 안내 메일은 법으로 정해진 안내라 받는 사람이 거부할 수 없습니다」「매달 무료 수를 넘은 안내 메일과 광고 메일·문자·알림톡은 충전금에서 한 건씩 빠집니다. 충전금이 모자라면 보내지 않고 「보내지 못함」으로 남습니다. 한 건 가격은 「문자·메일 충전」에서 확인합니다」 | app/(seller)/seller/(shell)/settings/order-notifications/page.tsx:69,75,80,111-112,119,127,129 |
| SA-080 | /seller/settings/order-notifications | 「발송·이용 충전금이 부족해 알림 N건을 보내지 못했습니다. 주문·배송 처리는 그대로 진행됐습니다. 거래 메일은 제공량이 남아 있으면 잔액과 상관없이 계속 보냅니다.」「이번 달 거래 메일 제공량을 다 써서 지금부터는 발송·이용 충전금에서 건당 차감합니다. 잔액 N원」 | 뜻 둘/어려운 말/해결 방법 없음 | 「충전금이 모자라 알림 N건을 보내지 못했습니다. 주문과 배송은 그대로 처리됐습니다. 충전하려면 「문자·메일 충전」으로 가십시오.」「이번 달 무료 안내 메일을 다 써서 지금부터는 충전금에서 한 통씩 빠집니다. 남은 충전금 N원」 | app/(seller)/seller/(shell)/settings/order-notifications/page.tsx:69,75,112,119 |
| SA-060 | /seller/settings/share | 「공유 미리보기」「쇼핑몰 주소를 메신저나 검색에 공유할 때 표시되는 제목과 설명을 설정합니다.」「공유 화면 미리보기」「공유한 곳에서 미리보기를 잠시 저장해 두므로 변경 내용이 늦게 반영될 수 있습니다. 카드 이미지는 쇼핑몰 이름으로 만듭니다.」「사용할 수 없는 문자가 있습니다」「줄바꿈 없이 입력해 주십시오」「저장하지 못했습니다. 잠시 후 다시 시도해 주십시오」 | 어려운 말/오류에 해결 방법 없음 | 「공유 문구」「쇼핑몰 주소를 메신저에 보낼 때 보이는 제목과 설명을 정합니다.」「공유했을 때 보이는 모습」「메신저는 한 번 본 모습을 잠시 기억하므로, 바꾼 내용이 바로 보이지 않을 수 있습니다. 이미지는 쇼핑몰 이름으로 자동으로 만들어집니다.」「쓸 수 없는 글자가 들어 있습니다. 해당 글자를 지워 주십시오」「저장하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오」 | app/(seller)/seller/(shell)/settings/share/page.tsx:22,68,71,79,89-90,103,158 |
| SA-066 | /seller/settings/shop-notices | 「공지·자주 묻는 질문」「홈 고정」「쇼핑몰 홈 상단에 고정 (공개한 공지 1개)」「분류 (선택)」「홈 고정은 공개한 공지 1개만 할 수 있고, 새로 고정하면 이전 고정은 풀립니다.」「구매자 쇼핑몰에 보이는 글입니다. 공개로 둔 글만 구매자에게 보이고, 바꾸면 바로 반영됩니다.」버튼 「추가」「저장」「수정」「위로」「아래로」「삭제」 | 어려운 말(고정·반영)/모호한 버튼 | 「자주 묻는 질문」, 「쇼핑몰 맨 위 고정」「쇼핑몰 첫 화면 맨 위에 고정 (공개한 공지 중 1개만)」「묶음 이름 (선택)」「맨 위 고정은 공지 1개만 됩니다. 새 공지를 고정하면 예전 공지는 고정이 풀립니다.」「구매자 쇼핑몰에 보이는 글입니다. 「공개」로 둔 글만 보이고, 저장하면 바로 바뀝니다.」, 버튼 「공지 등록하기」「질문 등록하기」「수정 내용 저장하기」「한 칸 위로」「한 칸 아래로」「공지 지우기」 | app/(seller)/seller/(shell)/settings/shop-notices/page.tsx:128,131,140,177,214,238,255 |
| SA-066 | /seller/settings/shop-notices | 「저장하지 못했습니다. 잠시 후 다시 시도해 주십시오」「삭제하지 못했습니다. 잠시 후 다시 시도해 주십시오」「순서를 바꾸지 못했습니다. 잠시 후 다시 시도해 주십시오」「목록을 불러오지 못했습니다」 | 오류에 해결 방법 없음 | 「저장하지 못했습니다. 인터넷 연결을 확인한 뒤 「저장」을 다시 눌러 주십시오. 계속되면 문의해 주십시오」(삭제·순서도 같은 형식) | app/(seller)/seller/(shell)/settings/shop-notices/page.tsx:92,104,119,153 |
| SA-067 | /seller/settings/seo | 「검색 노출」「사이트맵」「사이트맵 제공」「검색 제목/설명」「상품 페이지 규칙」「상품 제목 규칙」「{상품명}, {쇼핑몰}만 쓸 수 있습니다」「검색 사이트 소유 확인」「구글 확인 코드 / 구글 서치 콘솔이 알려 주는 메타 태그의 content 값만 입력합니다」「영문, 숫자, -, _ 만 입력할 수 있습니다」「끄면 검색 사이트에 쇼핑몰이 나오지 않도록 요청합니다 · 이미 나온 결과가 사라지기까지는 시간이 걸립니다」 | 어려운 말/영어·약어(메타 태그·content·서치 콘솔·SEO) | 「검색 사이트에 쇼핑몰 보이기」「상품 목록 안내 파일(사이트맵)」「상품 주소를 검색 사이트에 알려 주기」「검색 결과에 보일 제목/설명」「상품 페이지 문구 틀」「상품 제목 틀」「틀 안에는 {상품명}과 {쇼핑몰}만 넣을 수 있습니다」「내 쇼핑몰임을 검색 사이트에 알리기」「구글에서 받은 확인 코드 / 구글에서 안내하는 확인 코드만 붙여 넣어 주십시오」「영어, 숫자, -, _ 만 쓸 수 있습니다」「끄면 검색 사이트에 쇼핑몰이 나오지 않도록 요청합니다. 이미 나온 결과가 사라지기까지 시간이 걸릴 수 있습니다」 | app/(seller)/seller/(shell)/settings/seo/page.tsx:53,59,122,139,141,149,161,182 |
| SA-067 | /seller/settings/seo | 「파비콘과 공유 카드 이미지는 「공유 설정」에서 바꿉니다.」 | 영어·약어(파비콘)/뜻 틀림(공유 화면에는 이미지·파비콘 올리기가 없음) | 이 문장 삭제 또는 「공유 문구는 「공유 문구 설정」에서 바꿉니다.」 | app/(seller)/seller/(shell)/settings/seo/page.tsx:226 |
| SA-063 | /seller/settings/order | 「미입금 주문 자동 취소」「입금 기한」「미입금 주문 막기」「결제 후 취소 주문 막기」「재고 되돌리기」「재고 차감 기준」「자동 배송 완료」「자동 구매 확정」「송장 1건 조회당 N원이 발송·이용 충전금에서 차감됩니다」 | 어려운 말(구매 확정·차감) | 「입금이 없는 주문 자동 취소」「입금해야 하는 시간」「입금하지 않는 구매자 주문 막기」「결제 후 자주 취소하는 구매자 주문 막기」「취소하면 재고 다시 채우기」「재고를 줄이는 때」「배송 중인 주문을 자동으로 배송 완료로 바꾸기」「구매자가 누르지 않아도 구매 완료로 바꾸기」「송장 1건을 조회할 때마다 N원이 충전금에서 빠집니다」 | app/(seller)/seller/(shell)/settings/order/page.tsx:28,96,210,231,253,267,271,292 |
| SA-063 | /seller/settings/order | 「아직 자동으로 취소되지 않습니다. 정해 둔 설정은 저장되고, 자동 취소가 시작되면 그대로 적용됩니다. 그 전까지는 기한이 지난 주문을 직접 취소해 주십시오.」「아직 자동 취소가 시작되지 않아 주문 막기도 시작되지 않았습니다. …」「아직 자동으로 바뀌지 않습니다. …」 | 뜻 둘/어려운 말 | 「지금은 자동으로 취소되지 않습니다. 설정은 저장해 두면 자동 취소가 시작될 때 그대로 적용됩니다. 그때까지는 기한이 지난 주문을 직접 취소해 주십시오.」 | app/(seller)/seller/(shell)/settings/order/page.tsx:207,287,304 |
| SA-063 | /seller/settings/order | 「같은 구매자의 주문이 입금 기한을 넘겨 3번 자동 취소되면 30일 동안 새 주문을 받지 않습니다」「결제 후 구매자 사정으로 5번 취소하면 30일 동안 주문을 막습니다 · 켠 뒤부터 집계합니다」「꺼도 이미 막힌 구매자는 그대로입니다. 풀어 주려면 구매 제한 화면에서 해제합니다. 파트너스 사정으로 환불한 주문은 집계하지 않습니다.」 | 뜻 둘/어려운 말(집계) | 「같은 구매자가 입금하지 않아 3번 자동 취소되면 30일 동안 새 주문을 받지 않습니다」「결제한 뒤 구매자가 5번 취소하면 30일 동안 주문을 받지 않습니다. 켠 뒤의 취소부터 셉니다」「꺼도 이미 막힌 구매자는 계속 막혀 있습니다. 풀려면 「구매 제한」 화면에서 직접 풀어 주십시오. 파트너스 사정으로 환불한 주문은 세지 않습니다.」 | app/(seller)/seller/(shell)/settings/order/page.tsx:267,274-275,283 |
| SA-063 | /seller/settings/order | 「기간을 입력해 주십시오」「숫자만 입력해 주십시오」「1이상으로 입력해 주십시오 · 자동 취소를 끄려면 위 스위치를 꺼 주십시오」「입금 기한은 30일(720시간)까지 정할 수 있습니다」「저장할 수 없습니다.」「저장하지 못했습니다. 잠시 후 다시 시도해 주십시오」 | 오류에 해결 방법 없음(마지막) | 「저장하지 못했습니다. 인터넷 연결을 확인한 뒤 「저장」을 다시 눌러 주십시오」 | app/(seller)/seller/(shell)/settings/order/page.tsx:31,33,96,139,199 |
| SA-063 | /seller/settings/order | 「구매자 화면 미리보기 · 주문서 · 무통장 입금: 「주문 후 N시간 안에 입금하면 주문대기에 올라가요」」 | 어려운 말(주문대기)/말투(해요체는 미리보기 인용이라 허용) | 「주문 후 N시간 안에 입금하면 방송 주문 순서에 올라가요」 | app/(seller)/seller/(shell)/settings/order/page.tsx:355 |
| SA-061 | /seller/settings/shipping | 「배송비 정책」(화면 제목)과 왼쪽 메뉴 「배송 설정」이 다름, 「제주·도서산간 추가 배송비」「편도」「왕복」「무료 배송 기준 / 이상 주문이면 배송비 0원」「받는 방법 / 바로 받기 · 보관 후 받기(준비 중)」「발송 기한」「기본 택배사」, 알 수 없는 받는 방법은 서버 코드(`m`)가 그대로 표시됨 | 어려운 말/코드값/뜻 둘 | 메뉴와 제목을 「배송비 설정」으로 통일, 「제주·섬·산간 지역 추가 배송비」「반품 배송비 (가는 길 한 번 분)」「교환 배송비 (오고 가는 두 번 분)」「이 금액 이상 주문하면 배송비 0원」「상품 받는 방법」「발송해야 하는 날 수」「기본으로 보이는 택배사」, 알 수 없는 값은 「확인 필요」 | app/(seller)/seller/(shell)/settings/shipping/page.tsx:51,99,159,200,202,213,255,257; components/seller/SellerShell.tsx:121 |
| SA-061 | /seller/settings/shipping | 「단순 변심일 때만 받습니다. 상품 불량 · 오배송은 파트너스가 부담합니다. 반품하면 처음 낸 배송비는 돌려주지 않고 반품 배송비를 빼고 환불합니다. 무료 배송 주문(배송비 0원)은 반품 배송비 × 2를 뺍니다. 도서산간 추가 배송비를 낸 주문은 한 번만 뺍니다. 교환 배송비는 교환 접수가 열리면 적용됩니다.」 | 뜻 둘(규칙 6개가 한 덩어리)/어려운 말(오배송·접수) | 문장을 나눠 「구매자가 마음이 바뀌어 반품할 때만 반품 배송비를 받습니다.」「상품이 불량이거나 잘못 보낸 경우는 파트너스가 부담합니다.」「반품하면 처음 낸 배송비는 돌려주지 않고, 반품 배송비를 뺀 금액을 환불합니다.」「무료 배송 주문은 반품 배송비의 2배를 뺍니다.」 | app/(seller)/seller/(shell)/settings/shipping/page.tsx:279 |
| SA-061 | /seller/settings/shipping | 「금액을 입력해 주십시오」「숫자만 입력해 주십시오」「N원까지 정할 수 있습니다」「저장하지 못했습니다. 잠시 후 다시 시도해 주십시오」「배송비 정책을 저장했습니다 · 다음 주문부터 적용됩니다」 | 오류에 해결 방법 없음(마지막) | 「저장하지 못했습니다. 인터넷 연결을 확인한 뒤 「저장」을 다시 눌러 주십시오」 | app/(seller)/seller/(shell)/settings/shipping/page.tsx:42,44,53,99,155,159 |
| SA-062 | /seller/settings/legal | 「법정 고지 · 약관」「시행일」「구매안전서비스」「에스크로」「소비자피해보상보험」「확인 주소는 https로 시작하는 주소만 입력할 수 있습니다」「호스팅 제공 / ONQ가 자동으로 표시합니다」「통신판매업 신고번호」「입점 신청 정보」「글자 그대로 표시됩니다 · 표·서식은 지원하지 않습니다」「구매자 화면 / 입력한 내용이 구매자 쇼핑몰 바닥글 링크에 그대로 표시됩니다 · 저장한 뒤에 반영」 | 어려운 말/영어·약어(https·ONQ·에스크로) | 「법적 안내 · 이용약관」「시작하는 날」「결제 안전 서비스」「에스크로(결제 대금을 맡아 주는 서비스)」「소비자 피해 보상 보험」「확인 주소는 https://로 시작하는 주소만 쓸 수 있습니다」「쇼핑몰 제공 / 쇼핑몰 맨 아래에 플랫폼 이름이 자동으로 나옵니다」「통신판매업 신고번호」「처음 신청할 때 받은 정보」「쓴 글이 그대로 보입니다. 표나 글자 꾸미기는 쓸 수 없습니다」「구매자 쇼핑몰 맨 아래 링크에 쓴 글이 그대로 보입니다. 저장해야 바뀝니다」 | app/(seller)/seller/(shell)/settings/legal/page.tsx:147,193-194,219,327,332,348,350 |
| SA-062 | /seller/settings/legal | 「게시하려면 본문을 입력해 주십시오」「게시하려면 시행일을 입력해 주십시오」「구매자에게 게시」「게시 전 · 구매자에게는 준비 중으로 표시」「저장하면 구매자 화면에 바로 표시됩니다」「최신 내용 불러오기」「저장하지 못했습니다. 잠시 후 다시 시도해 주십시오」 | 어려운 말(게시)/오류에 해결 방법 없음(마지막) | 「공개하려면 본문을 써 주십시오」「공개하려면 시작하는 날을 정해 주십시오」「구매자에게 공개」「아직 공개 안 함 · 구매자에게는 「준비 중」으로 보입니다」「저장하면 구매자 화면에 바로 보입니다」「다른 곳에서 먼저 저장했습니다. 「최신 내용 불러오기」를 누른 뒤 다시 고쳐 주십시오」「저장하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오」 | app/(seller)/seller/(shell)/settings/legal/page.tsx:78-79,92,125,134,168-169,269 |
| SA-081 | /seller/settings/message-balance | 「[확정 전]」(단가 자리에 그대로 표시), 「{{...}}」 대체값 | 코드값(내부 자리표시자) | 단가가 정해지지 않았을 때는 「가격 확정 전」 또는 「준비 중」으로 표시 | app/(seller)/seller/(shell)/settings/message-balance/page.tsx:46; components/seller/messageFeeNotice.ts:2 |
| SA-081 | /seller/settings/message-balance | 「문자(SMS·LMS)」「긴 문자」「알림톡」「구매자 휴대폰 본인인증」「송장 발급·송장 라벨 API」「현금영수증·전자세금계산서 API」「LMS 단가」 | 영어·약어/어려운 말 | 「문자(짧은 문자·긴 문자)」「카카오 알림톡」「구매자 휴대폰 본인 확인」「송장 발급·송장 라벨 (택배사 프로그램 연결)」「현금영수증·전자세금계산서 발급」 | app/(seller)/seller/(shell)/settings/message-balance/page.tsx:51,138,148,151,160-161 |
| SA-081 | /seller/settings/message-balance | 「유료 잔액」「무상 잔액」「잔액 부족 미발송」「이월되지 않습니다」「차감」「복원」「처리 중」「선불」「직접 충전한 금액 · 환불 신청 가능」「이벤트·보상 지급 · 환불 안 됨 · 유료를 먼저 차감」 | 어려운 말 | 「직접 충전한 금액」「무료로 받은 금액」「충전금이 모자라 보내지 못한 건수」「다음 달로 넘어가지 않습니다」「빠짐」「되돌림」「확인 중」「미리 충전한 금액에서만 빠집니다」「직접 충전한 금액은 환불을 신청할 수 있습니다」「이벤트·보상으로 받은 금액은 환불되지 않으며 직접 충전한 금액이 먼저 빠집니다」 | app/(seller)/seller/(shell)/settings/message-balance/page.tsx:61,270,275,280,285,352,442-443 |
| SA-081 | /seller/settings/message-balance | 「충전 기능을 준비하고 있습니다. 발송 비용 안내의 단가와 조건이 확정되고 법률 검토가 끝나면 열립니다. 지금은 잔액과 사용 내역만 볼 수 있습니다.」 | 어려운 말/내부 사정 노출(법률 검토) | 「충전은 아직 열리지 않았습니다. 가격이 정해지면 열립니다. 지금은 남은 금액과 사용 내역만 볼 수 있습니다.」 | app/(seller)/seller/(shell)/settings/message-balance/page.tsx:247 |
| SA-081 | /seller/settings/message-balance | 「발송 비용 안내 · 선불 충전 방식 · 차감 기준 · 환불 · 판매자 책임 · 단가 변경 · 동의 (2~7절)」「5. 판매자 책임 …판매자가 부담합니다」(안내문 서식 본문 3곳) 「정보통신망법 제50조」「부가가치세 포함/별도」 | 용어 규칙 위반(「판매자」→「파트너스」)/어려운 말 | 「발송 비용 안내 · 선불 충전 · 빠지는 기준 · 환불 · 파트너스 책임 · 가격 변경 · 동의」, 본문의 「판매자」를 「파트너스」로 변경(정본 docs/terms/SELLER_MESSAGE_FEE_NOTICE.md도 함께) | app/(seller)/seller/(shell)/settings/message-balance/page.tsx:192,406; components/seller/messageFeeNotice.ts:50 |
| SA-081 | /seller/settings/message-balance | 「잔액이 기준 아래로 내려가면 알려 드립니다 · 0원이면 알리지 않습니다 · 잔액이 모자라면 그 건은 보내지 않고 「잔액 부족 미발송」으로 기록합니다」「기준 저장」 | 뜻 둘(규칙 셋)/모호한 버튼 | 「남은 금액이 이 금액보다 적어지면 알려 드립니다. 0원으로 두면 알리지 않습니다.」(다음 문장은 따로) 「이 금액으로 저장」 | app/(seller)/seller/(shell)/settings/message-balance/page.tsx:352,366 |
| SA-081 | /seller/settings/message-balance | 「충전 금액은 1,000원에서 100만 원 사이, 1,000원 단위로 입력해 주십시오」「결제 결과를 확인하고 있습니다. 잠시 뒤 「충전하기」를 다시 눌러 같은 금액으로 결과를 확인해 주십시오」「충전하지 못했습니다. 잠시 후 다시 시도해 주십시오」「안내 내용이 바뀌었습니다. 새로 고친 뒤 다시 확인해 주십시오」「동의를 저장하지 못했습니다. 잠시 후 다시 시도해 주십시오」 | 오류에 해결 방법 없음(뒤 2개) / 뜻 둘(결제 확인) | 「충전하지 못했습니다. 카드는 결제되지 않았습니다. 잠시 뒤 「충전하기」를 다시 눌러 주십시오」(결제 여부를 반드시 함께 안내), 「결제가 끝났는지 확인하는 중입니다. 1~2분 뒤 「충전하기」를 눌러 결과를 확인해 주십시오. 중복으로 결제되지 않습니다」 | app/(seller)/seller/(shell)/settings/message-balance/page.tsx:188,200,216,233,374 |
| SA-081 | /seller/settings/message-balance | 「동의」「발송 비용 안내를 확인했고 동의합니다」「동의 버전 N · 저장 · 다음 충전부터는 체크를 다시 받지 않습니다(안내가 바뀌면 다시 받습니다)」「동의 버전」 | 어려운 말/뜻 둘 | 「동의 확인」「동의한 날 N월 N일 · 다음 충전부터는 다시 묻지 않습니다. 안내가 바뀌면 다시 동의를 받습니다」 | app/(seller)/seller/(shell)/settings/message-balance/page.tsx:373,387 |
| SA-090 | /seller/subscription | 「구독 · 결제」「요금제, 결제 카드, 청구 내역을 관리합니다.」「내 요금제」「플랜 변경」「이미 이용 중인 플랜입니다」「해지 예정」「결제 확인 기한」「결제 실패」「자동결제」「차액」「남은 이용 기간의 차액을 등록한 카드로 바로 결제합니다. 차액이 없으면 결제 없이 바로 바뀝니다.」 | 어려운 말(플랜·요금제·차액·해지·자동결제·유예) | 「이용권 · 결제」「이용권, 결제 카드, 결제 내역을 관리합니다.」「내 이용권」「이용권 바꾸기」「이미 쓰고 있는 이용권입니다」「해지 신청됨(○월 ○일까지 이용)」「결제 마감일」「결제되지 않음」「매달 자동 결제」「남은 기간만큼 더 내는 금액」「이용권을 올리면 남은 기간에 대해 더 내야 하는 금액을 등록한 카드로 바로 결제합니다. 더 낼 금액이 없으면 결제 없이 바로 바뀝니다.」 | app/(seller)/seller/(shell)/subscription/page.tsx:54,59,82,97,113,115,117-118 |
| SA-090 | /seller/subscription | 「결제를 처리하고 있습니다. 잠시 후 다시 확인해 주십시오」「결제는 되었지만 구독에 반영되지 않았습니다. 문의하기로 알려 주십시오」「카드를 등록할 수 없습니다. 다른 카드로 다시 시도해 주십시오」「처리하지 못했습니다.」「결제 결과를 확인하고 있습니다. 잠시 후 이 화면에서 다시 확인해 주십시오」 | 뜻 둘/오류에 해결 방법 없음(「처리하지 못했습니다」 + 서버 기본 문구) | 「결제가 아직 끝나지 않았습니다. 1~2분 뒤 「다시 확인」을 눌러 주십시오. 카드는 중복으로 결제되지 않습니다」「결제는 되었지만 이용 상태가 바뀌지 않았습니다. 「공지 · 문의」에서 문의해 주십시오. 결제한 금액은 확인해 드립니다」 | app/(seller)/seller/(shell)/subscription/page.tsx:48,50-51,56,58,187,225,287 |
| SA-090 | /seller/subscription | 「테스트 카드로 변경」「테스트 카드 등록」「카드 자동결제만 지원합니다. 매달 결제일에 등록한 카드로 결제됩니다.」「카드 등록은 준비 중입니다.」「플랜 변경 / 변경 / 변경 예정 / 변경 취소」「해지」(버튼) | 모호한 버튼 | 「결제 카드 등록하기」「결제 카드 바꾸기」「카드만 쓸 수 있습니다. 매달 결제일에 이 카드로 자동 결제됩니다.」「이 이용권으로 바꾸기」「바뀔 예정」「바꾸기 취소하기」「구독 해지하기」 | app/(seller)/seller/(shell)/subscription/page.tsx:390,394,403 |
| SA-090 | /seller/subscription | 청구 내역 「청구일」「이용 기간」「확인 중」「영수증」「보기」 | 어려운 말 | 「결제일」「이용한 기간」「결제 확인 중」「영수증 보기」 | components/seller/subscription/PaymentHistory.tsx:17,42 |
| SA-090 | /seller/subscription | 확인 창 문구 「「{플랜}」으로 변경하시겠습니까?」+「다음 결제일부터 적용됩니다. 그 전까지는 지금 플랜을 그대로 이용합니다.」「결제 금액을 확인하지 못했습니다. 닫고 다시 시도해 주십시오」「금액이 바뀌었습니다. 다시 확인해 주십시오.」버튼 「등록」「변경」「해지」 | 모호한 버튼 | 버튼 「이용권 바꾸기」「카드 등록하기」「구독 해지하기」 | app/(seller)/seller/(shell)/subscription/page.tsx:80,433,475,477,479 |
| SA-100 | /seller/staff | 권한 이름·설명 「오버레이 편집 / 오버레이 설정 · URL」「고객 정보 보기」「주문·배송 / 주문 처리 · 입금 확인 · 송장」「영수증·세금계산서」「매출 보기 / 홈 매출 · 정산 금액」「쇼핑몰 설정 / 쇼핑몰 · 배송비 · 법정 고지 · 알림」「결제(PG) 연결」「적립금 실지급」「묶음」「운영 전체」「방송만」 | 어려운 말/영어·약어(URL·PG) | 「방송 화면 꾸미기 / 방송 화면 꾸미기와 주소 만들기」「고객 개인정보 보기 / 고객 이름·연락처·주소를 볼 수 있음」「주문·배송 / 주문 처리, 입금 확인, 송장 입력」「매출 보기 / 홈 매출과 정산 금액」「카드 결제 연결」「적립금 실제 지급」「한 번에 고르기」「모든 운영 업무」「방송 업무만」 | components/seller/StaffForms.tsx:26,29,33,37 |
| SA-100 | /seller/staff | 「켜진 권한」「대표자 · 모든 권한」「활성/비활성」「휴대폰 미등록 · 본인확인 연결됨 / 본인확인 전」「계정 연결 / 본인확인 전」「비밀번호 재설정」(버튼)「×」(비활성화 버튼, 글자 없음)「이름 · 이메일」 | 어려운 말(권한·본인확인)/모호한 버튼(×) | 「허용한 업무」「대표자 · 모든 업무」「사용 중/사용 중지」「휴대폰 번호 없음 · 휴대폰 확인 완료 / 휴대폰 확인 전」「직원 계정 사용 중지」(글자가 있는 버튼) | app/(seller)/seller/(shell)/staff/page.tsx:147-148,161,183,208-209; components/seller/StaffForms.tsx:380 |
| SA-100 | /seller/staff | 「대표자가 직접 계정을 만들고 권한을 항목별로 설정합니다. 직원은 파트너스 로그인으로 접속해 허용된 메뉴만 사용합니다.」「결제(PG) 연결 · 구독 · 직원 관리 · 적립금 실지급은 대표자만 할 수 있습니다. 직원에게는 메뉴가 표시되지 않습니다.」「권한 변경은 즉시 적용됩니다. 직원이 로그인 중이면 다음 화면부터 반영됩니다. 변경 기록은 로그 추적에 남습니다.」 | 어려운 말/영어·약어 | 「대표자가 직접 직원 계정을 만들고 직원마다 할 수 있는 업무를 정합니다. 직원은 파트너스 로그인으로 들어와 허용된 메뉴만 쓸 수 있습니다.」「카드 결제 연결, 구독, 직원 관리, 적립금 실제 지급은 대표자만 할 수 있습니다. 직원에게는 이 메뉴가 보이지 않습니다.」「바꾼 내용은 바로 적용됩니다. 직원이 로그인해 있으면 다음 화면부터 바뀝니다. 바꾼 기록은 「로그 추적」에 남습니다.」 | app/(seller)/seller/(shell)/staff/page.tsx:116,228-229 |
| SA-100 | /seller/staff | 「계정이 즉시 생성됩니다 · 메일 초대는 없습니다」「이메일 (로그인 아이디)」「초기 비밀번호」「8자 이상 · 직원에게 직접 전달해 주십시오」「계정 생성」「생성 중」「직원이 아이디 · 비밀번호를 찾을 때 본인확인에 사용합니다」「이메일과 초기 비밀번호를 직원에게 직접 전달해 주십시오」 | 어려운 말/모호한 버튼 | 「직원 계정이 바로 만들어집니다. 초대 메일은 가지 않습니다」「직원이 로그인에 쓸 이메일」「처음 쓸 비밀번호」「직원 계정 만들기」「직원이 아이디나 비밀번호를 잊었을 때 본인 확인에 씁니다」 | app/(seller)/seller/(shell)/staff/page.tsx:232,313,382,414,418,423,429 |
| SA-100 | /seller/staff | 「생성 여부를 확인하지 못했습니다. 목록에서 확인하고, 있으면 비밀번호를 재설정해 주십시오. 같은 값으로 재전송해 성공하면 생성이 확정됩니다」「계정이 생성되었을 수 있습니다.」「같은 값으로 재전송」「새로 입력」「이전 계정 생성 요청이 처리되었을 수 있습니다. 목록에서 확인한 뒤 입력해 주십시오」「같은 이메일의 계정이 이미 있습니다. 이전 요청으로 생성된 계정인지는 확인할 수 없습니다…」 | 어려운 말(생성 확정·재전송)/뜻 둘 | 「계정이 만들어졌는지 확인하지 못했습니다. 아래 목록에 이 직원이 있는지 확인해 주십시오. 있으면 비밀번호를 다시 정해 주십시오. 없으면 「같은 내용으로 다시 만들기」를 눌러 주십시오」「같은 내용으로 다시 만들기」「처음부터 다시 입력」 | app/(seller)/seller/(shell)/staff/page.tsx:244,305,313,387,391,394; components/seller/StaffForms.tsx:198 |
| SA-100 | /seller/staff (수정 창) | 「정보 · 권한 수정」「번호를 바꾸면 직원이 본인확인을 다시 해야 합니다. 저장하면 연결만 해제됩니다. 다시 연결하기 전까지는 아이디 · 비밀번호를 스스로 찾을 수 없으며, 다른 메뉴는 그대로 사용합니다.」「저장되었을 수 있습니다.」「같은 값으로 재저장」「확인」「아직 반영이 확인되지 않았습니다. 처리 중일 수 있으니 잠시 후 「확인」을 누르거나 같은 값으로 재전송해 주십시오」「목록을 읽지 못해 결과를 확인하지 못했습니다. 잠시 후 「확인」을 눌러 주십시오」「저장」 | 어려운 말/모호한 버튼(「확인」「저장」) | 「직원 정보·허용 업무 바꾸기」「번호를 바꾸면 직원이 휴대폰 확인을 다시 해야 합니다. 다시 확인하기 전에는 아이디·비밀번호를 스스로 찾을 수 없습니다. 다른 메뉴는 그대로 쓸 수 있습니다.」「저장됐는지 확인하지 못했습니다.」「저장 결과 확인하기」「같은 내용으로 다시 저장」「아직 저장됐는지 알 수 없습니다. 잠시 뒤 「저장 결과 확인하기」를 눌러 주십시오」, 버튼 「변경 내용 저장」 | components/seller/StaffForms.tsx:198-199,280,288,293,332 |
| SA-100 | /seller/staff (비밀번호 창) | 「재설정」(버튼)「같은 비밀번호로 재전송」「비밀번호가 변경되었을 수 있습니다.」「결과를 확인하지 못했습니다. 같은 비밀번호로 재전송해 주십시오」「변경하면 {이름}의 다른 기기 로그인이 모두 해제됩니다.」 | 모호한 버튼/어려운 말 | 버튼 「새 비밀번호로 바꾸기」「같은 비밀번호로 다시 보내기」「비밀번호가 바뀌었는지 확인하지 못했습니다. 같은 비밀번호로 다시 보내 주십시오」「바꾸면 이 직원이 다른 기기에서 로그인해 둔 상태가 모두 풀립니다」 | components/seller/StaffForms.tsx:199,375,385 |
| SA-100 | /seller/staff (비활성화 창) | 「비활성화」(버튼)「즉시 로그아웃되며 다시 로그인할 수 없습니다. 처리 기록은 로그 추적에 남습니다.」「비활성화되었을 수 있습니다.」「재전송」 | 어려운 말/모호한 버튼 | 버튼 「직원 계정 사용 중지」, 「바로 로그아웃되고 다시 로그인할 수 없습니다. 사용 중지 기록은 「로그 추적」에 남습니다」, 「재전송」→「다시 보내기」 | components/seller/StaffForms.tsx:431,456,459,462,464,467,480 |

**② 확인 창 (20)**

| 화면ID | 경로 | 행동 | 현재 동작 | 확인 창 문구 안 | 위험도 | 파일:줄 |
|---|---|---|---|---|---|---|
| SA-031 | /seller/rewards | 「저장」(지급 시점) | 누르면 바로 PUT /api/seller/reward-policy | 「적립금 지급 시점을 바꾸시겠습니까?」 / 저장한 뒤 결제되는 주문부터 {결제하면 바로/배송 완료 후} 지급됩니다. / [취소] [저장] | 위험 | app/(seller)/seller/(shell)/rewards/page.tsx:44, :74, :110 |
| (ID 없음) | /seller/rewards/live-payout | 「실지급 끄기」 | 누르면 바로 PUT /api/seller/reward-live-payout {enabled:false} | 「실제 지급을 끄시겠습니까?」 / 끈 뒤 새로 생기는 적립은 테스트 기록으로만 남고 구매자 잔액은 늘지 않습니다. / [취소] [실제 지급 끄기](위험 색) | 위험 | app/(seller)/seller/(shell)/rewards/live-payout/page.tsx:38, :90 |
| SA-060 | /seller/settings/shop | 로고 올리기 / 바꾸기 (파일 고르기·끌어다 놓기) | 파일을 고르거나 놓으면 바로 PUT /shop-content/logo (구매자 쇼핑몰에 즉시 반영, 끌어다 놓기는 실수로 놓을 수 있음) | 「로고를 바꾸시겠습니까?」/「고른 이미지가 구매자 쇼핑몰 맨 위에 바로 표시됩니다」/[취소][로고 바꾸기] | 위험(구매자 화면에 즉시 노출) | app/(seller)/seller/(shell)/settings/shop/page.tsx:41,50,133 |
| SA-060 | /seller/settings/shop | 지우기 (로고) | 누르면 바로 DELETE /shop-content/logo | 「로고를 지우시겠습니까?」/「쇼핑몰 이름 첫 글자가 대신 표시됩니다. 지운 로고는 되돌릴 수 없습니다」/[취소][로고 지우기] | 위험 | app/(seller)/seller/(shell)/settings/shop/page.tsx:64,69,161 |
| SA-068 | /seller/settings/member | 저장 (재가입 막기 켜기/끄기·기간) | 스위치와 기간은 화면 안에서만 바뀌고 「저장」을 누르면 바로 PUT /member-policy (확인 창 없음). 끄고 저장하면 보관하던 탈퇴 회원 정보가 바로 삭제됨 | 켤 때 「재가입 막기를 켜시겠습니까?」/「탈퇴한 사람은 {기간} 동안 다시 가입할 수 없습니다」/[취소][켜기], 끌 때 「재가입 막기를 끄시겠습니까?」/「보관하던 탈퇴 회원 기록이 바로 지워지며 되돌릴 수 없습니다」/[취소][끄기] | 매우 위험(끌 때 데이터 삭제) | app/(seller)/seller/(shell)/settings/member/page.tsx:47,51,138 |
| SA-060 | /seller/settings/share | 저장 (상단 「저장」·오른쪽 「저장」 2곳) | 누르면 바로 PUT /share-preview (확인 없음, 구매자가 공유한 링크 모습이 바뀜) | 「공유 문구를 저장하시겠습니까?」/「제목·설명이 바뀌고 앞으로 공유하는 링크에 표시됩니다」/[취소][저장] | 보통 | app/(seller)/seller/(shell)/settings/share/page.tsx:59,63,82,177 |
| SA-066 | /seller/settings/shop-notices | 공지·질문 추가/수정 창 「추가」「저장」 | 입력 창에서 누르면 바로 POST/PUT /notices (공개로 두면 구매자 쇼핑몰에 즉시 노출, 확인 단계 없음) | 「공지를 등록하시겠습니까?」(공개일 때)/「구매자 쇼핑몰에 바로 보입니다」/[취소][공지 등록하기] | 위험(구매자 화면에 즉시 노출) | app/(seller)/seller/(shell)/settings/shop-notices/page.tsx:81,89,263 |
| SA-066 | /seller/settings/shop-notices | 질문 순서 「위로」「아래로」 | 누를 때마다 바로 PUT /notices/faq-order (구매자 화면 순서가 바로 바뀜) | 「질문 순서를 바꾸시겠습니까?」/「「{질문}」을 한 칸 {위/아래}로 옮기고 구매자 쇼핑몰에 바로 반영됩니다」/[취소][순서 바꾸기] | 보통 | app/(seller)/seller/(shell)/settings/shop-notices/page.tsx:110,116,189,192 |
| SA-067 | /seller/settings/seo | 저장 (검색 노출 켜기·제목·설명·규칙·확인 코드 변경) | 「저장」을 누르면 바로 PUT /seo (검색 노출을 끌 때만 확인 창 있음, 나머지 변경은 확인 없음) | 「검색 노출 설정을 저장하시겠습니까?」/「바꾼 N개 항목이 검색 사이트에 보이는 정보로 반영됩니다」/[취소][저장] | 보통 | app/(seller)/seller/(shell)/settings/seo/page.tsx:112,124,229 |
| SA-063 | /seller/settings/order | 저장 (자동 취소·입금 기한·주문 막기·재고 되돌리기·자동 배송 완료·자동 구매 확정 스위치와 기간) | 스위치·숫자는 화면에서만 바뀌고 「저장」을 누르면 바로 PUT /order-policy (확인 창 없음) | 「주문 설정을 저장하시겠습니까?」/「바뀐 항목: {변경 항목 목록}. 저장한 뒤 들어오는 주문부터 적용됩니다」/[취소][저장] | 위험(결제·재고·구매 제한에 영향) | app/(seller)/seller/(shell)/settings/order/page.tsx:118,137,385 |
| SA-061 | /seller/settings/shipping | 저장 (배송비 방식·금액·발송 기한·기본 택배사) | 「저장」을 누르면 바로 PUT /shipping-policy (확인 창 없음, 구매자 주문서 금액에 영향) | 「배송비 설정을 저장하시겠습니까?」/「{배송비 요약} 으로 바뀌고 다음 주문부터 구매자에게 적용됩니다」/[취소][저장] | 위험(구매자 결제 금액에 영향) | app/(seller)/seller/(shell)/settings/shipping/page.tsx:146,153,354 |
| SA-062 | /seller/settings/legal | 저장 (이용약관·개인정보처리방침, 「구매자에게 게시」 스위치 포함) | 「저장」을 누르면 바로 PUT /shop-legal/{kind} (게시를 켜고 저장하면 구매자 화면에 바로 공개, 확인 창 없음) | 게시를 켜는 저장: 「{이용약관}을 구매자에게 공개하시겠습니까?」/「시행일 {날짜}부터 쇼핑몰 맨 아래 링크에 쓴 글이 그대로 보입니다」/[취소][공개하기], 게시를 끄는 저장: 「공개를 멈추시겠습니까?」/「구매자에게는 「준비 중」으로 보입니다」 | 매우 위험(법적 고지가 구매자에게 노출) | app/(seller)/seller/(shell)/settings/legal/page.tsx:81,88,175,258 |
| SA-062 | /seller/settings/legal | 저장 (사업자 정보·고지: 주소·고객센터·구매안전서비스·미성년자 안내) | 「저장」을 누르면 바로 PUT /shop-legal-notice (구매자 쇼핑몰 바닥글에 반영) | 「사업자 정보·고지를 저장하시겠습니까?」/「쇼핑몰 맨 아래에 보이는 주소·고객센터·결제 안전 서비스 안내가 바뀝니다」/[취소][저장] | 위험 | app/(seller)/seller/(shell)/settings/legal/page.tsx:265,394 |
| SA-081 | /seller/settings/message-balance | 기준 저장 (잔액 부족 알림 기준) | 누르면 바로 PUT /message-balance {lowBalanceThreshold} | 「알림 기준을 바꾸시겠습니까?」/「남은 금액이 {금액}원보다 적어지면 알려 드립니다」/[취소][기준 저장] | 보통 | app/(seller)/seller/(shell)/settings/message-balance/page.tsx:170,174,366 |
| SA-081 | /seller/settings/message-balance | 「발송 비용 안내를 확인했고 동의합니다」 체크박스 | 체크하는 순간 바로 POST /message-balance/consent (동의 기록이 서버에 남음, 확인 창 없음) | 「발송 비용 안내에 동의하시겠습니까?」/「동의한 안내 버전과 시각이 저장됩니다」/[취소][동의] | 위험(법적 동의 기록) | app/(seller)/seller/(shell)/settings/message-balance/page.tsx:181,184,387 |
| SA-090 | /seller/subscription | 플랜 「변경 취소」(변경 예정 안내 줄) | 누르면 바로 POST /subscription/plan (현재 플랜으로 되돌림, 확인 창 없음) | 「이용권 바꾸기를 취소하시겠습니까?」/「○월 ○일에 「{예정 이용권}」으로 바뀌는 예약이 없어지고 지금 이용권을 계속 씁니다」/[취소][바꾸기 취소하기] | 보통 | app/(seller)/seller/(shell)/subscription/page.tsx:207,376 |
| SA-090 | /seller/subscription | 테스트 카드 등록·변경 (결제·해지 취소가 일어나지 않는 경우) | 확인 문구(note)가 없으면 확인 창 없이 바로 POST /subscription/card | 「결제 카드를 등록하시겠습니까?」/「등록한 카드로 매달 자동 결제됩니다」/[취소][카드 등록하기] | 보통(테스트 서버 한정) | app/(seller)/seller/(shell)/subscription/page.tsx:180,184,258,394 |
| SA-100 | /seller/staff | 직원 추가 「계정 생성」 | 입력 후 누르면 바로 POST /api/seller/staff (계정이 즉시 만들어지고 권한이 켜짐, 확인 창 없음) | 「직원 계정을 만드시겠습니까?」/「{이름} 계정이 바로 만들어지고 선택한 업무({권한 목록})를 할 수 있게 됩니다. 이메일과 처음 쓸 비밀번호를 직접 전달해 주십시오」/[취소][직원 계정 만들기] | 위험(권한 부여) | app/(seller)/seller/(shell)/staff/page.tsx:313,318,335,429 |
| SA-100 | /seller/staff | 수정 창 「저장」 (이름·휴대폰·권한 변경) | 입력 창에서 누르면 바로 PATCH /staff/{id} 와 POST /staff/{id}/permissions (확인 질문 없음. 권한은 즉시 적용, 휴대폰을 바꾸면 본인확인 연결이 풀림) | 「{이름} 직원 정보를 바꾸시겠습니까?」/「바뀌는 업무 허용: {추가/해제 목록}. 휴대폰 번호를 바꾸면 직원이 본인 확인을 다시 해야 합니다. 바로 적용됩니다」/[취소][변경 내용 저장] | 위험(권한 변경) | components/seller/StaffForms.tsx:236,241,252,350 |
| SA-100 | /seller/staff | 권한 묶음 「방송만」「운영 전체」 | 화면 안에서 체크만 바꿈(서버 호출 없음) → 대상 아님 | (표 제외 대상) | - | components/seller/StaffForms.tsx:35,103 |

**③ 클릭 제목 열 (1)**

| 화면ID | 경로 | 열 | 현재 | 고칠 안 |
|---|---|---|---|---|
| SA-033 | /seller/rewards/balances | 회원 | 맨 왼쪽 첫 열이지만 가운데 정렬 | 왼쪽 정렬(회원명) |

**④ 표 겹침·정렬 (2)**

| 화면ID | 경로 | 현재 | 고칠 안 |
|---|---|---|---|
| SA-033 | /seller/rewards/balances (390) | 표가 가로 스크롤 | 모바일 카드형 |
| SA-100 | /seller/staff (390) | 표가 가로 스크롤 | 모바일 카드형 |

### 화면-방송 (2) — `session_01LEN2yPC22mYAT7r16f4RJ6`

**① 쉬운 말 (34)**

| 화면ID | 경로 | 현재 문구 | 문제 유형 | 고칠 문장 | 파일:줄 |
|---|---|---|---|---|---|
| SA-001 | /seller/broadcast | 「HIT 카드 등록」(버튼), 「HIT」(요약 칸), HIT 카드 등록 창 제목·버튼 | 영어·약어 | 「당첨 카드 기록」「당첨 카드 기록하기」 (또는 쇼핑몰에서 쓰는 카드 이름으로 통일) | app/(seller)/seller/(shell)/broadcast/page.tsx:316,593; components/seller/broadcast/HitCardModal.tsx:54,99 |
| SA-001 | /seller/broadcast | 「OBS 브라우저 소스에 넣는 주소는 발급할 때 한 번만 보입니다. 잃어버리면 다시 발급해 주십시오.」 | 어려운 말 | 「방송 화면 주소는 만들 때 한 번만 보여 드립니다. 잃어버리면 새로 만들어 주십시오. 새로 만들면 예전 주소는 쓸 수 없습니다.」 | app/(seller)/seller/(shell)/broadcast/page.tsx:579 |
| SA-001 | /seller/broadcast | 「오버레이 주소」「오버레이 주소 발급」「오버레이」(제목) | 어려운 말 | 「방송 화면 주소」「방송 화면 주소 만들기」「방송 화면」 | app/(seller)/seller/(shell)/broadcast/page.tsx:320,577,581,629 |
| SA-001 | /seller/broadcast | 「현재 플랜에서 제공하지 않는 기능입니다」 | 어려운 말 + 오류에 해결 방법 없음 | 「지금 이용 중인 이용권에는 이 기능이 없습니다. 구독 화면에서 이용권을 바꾸면 사용할 수 있습니다.」 | app/(seller)/seller/(shell)/broadcast/page.tsx:338 |
| SA-001 | /seller/broadcast | 「유튜브 채팅 수집」「켬 · 주문대기에 채팅 확인 여부를 표시만 합니다」「끔 · 기본은 끔입니다」 | 어려운 말/뜻 둘 | 「유튜브 채팅 가져오기」「켜짐 · 주문한 사람이 채팅했는지 주문대기 표에 표시합니다. 주문에는 영향이 없습니다」「꺼짐 · 채팅을 가져오지 않습니다」 | app/(seller)/seller/(shell)/broadcast/page.tsx:414,416,639 |
| SA-001 | /seller/broadcast | 채팅 켜기 창 버튼 「닫기」「켜기」 | 모호한 버튼 | 「취소」「채팅 가져오기 켜기」 | app/(seller)/seller/(shell)/broadcast/page.tsx:647,650 |
| SA-001 | /seller/broadcast | 「유튜브 방송을 연결하면 채팅을 모을 수 있습니다」「유튜브 연결」 | 어려운 말 | 「유튜브 방송을 이어 두면 채팅을 가져올 수 있습니다」「유튜브 이어 두기」 | app/(seller)/seller/(shell)/broadcast/page.tsx:420,422 |
| SA-001 | /seller/broadcast | 「채팅 확인됨 · 마지막 …」「채팅 없음」 | 뜻 둘(채팅이 정말 없는지, 확인 못 한 것인지) | 「채팅함 · 마지막 채팅 시각 …」「채팅 기록 없음」 | app/(seller)/seller/(shell)/broadcast/page.tsx:665 |
| SA-001 | /seller/broadcast | 표 머리글 「접수」「관리」「구매자 · 상품」, 버튼 「타이머」「취소」(무엇을 취소하는지 모름), 「완료 / 취소」 | 모호한 버튼 | 「주문 시각」「조작」, 「타이머 정하기」「주문대기에서 빼기」「완료 / 뺀 주문」 | app/(seller)/seller/(shell)/broadcast/page.tsx:363,478,539 |
| SA-001 | /seller/broadcast | 타이머 창 제목 「타이머 설정」, 버튼 「저장」, 「끄기」, 「타이머를 끕니다」「…동안 카운트다운합니다」 | 모호한 버튼/영어 | 제목 「개봉 시간 알림을 정하시겠습니까?」 버튼 「이 시간으로 정하기」, 칩 「알림 끄기」, 「…부터 남은 시간을 거꾸로 셉니다」 | components/seller/broadcast/Modals.tsx:100,131 |
| SA-001 | /seller/broadcast | 「최신 주문대기를 불러오지 못했습니다. 다시 불러오기 전까지 변경할 수 없습니다.」 | 문제는 있으나 OK(해결 방법 있음) – 「주문대기」 줄임 표현 | 현행 유지 가능 (「주문대기 목록」으로 표기 통일) | app/(seller)/seller/(shell)/broadcast/page.tsx:351 |
| SA-001 | /seller/broadcast | 방송 종료 창 「방송 종료」(버튼)·「남은 대기 N건은 다음 방송으로 넘어갑니다」, 「닫기」 | 모호한 버튼 | 버튼 「방송 끝내기」·「취소」 | components/seller/broadcast/Modals.tsx:44 |
| SA-001 | /seller/broadcast | HIT 등록 창 「대상 주문」「직접 입력」「메모 (파트너스만)」 | 어려운 말 | 「카드를 받은 주문」「닉네임 직접 쓰기」「메모 (나만 보임)」 | components/seller/broadcast/HitCardModal.tsx:60,68,86 |
| SA-054 | /seller/broadcasts | 「HIT」(표 머리글), 「현재 플랜에서 제공하지 않는 기능입니다」, 「완료 / 취소」, 「조회 기간의 시작일이 끝일보다 늦습니다」 | 영어·약어 / 어려운 말(플랜) | 「당첨 카드」, 「지금 이용권에는 이 기능이 없습니다. 구독 화면에서 이용권을 바꿔 주십시오」, 「시작일을 끝일보다 앞 날짜로 바꿔 주십시오」 | app/(seller)/seller/(shell)/broadcasts/page.tsx:65,100,126 |
| SA-055 | /seller/broadcasts/{id} | 「HIT 카드 N장」「이 방송에서 등록한 HIT 카드가 없습니다」「HIT」, 「외부 주문」, 「외부 쇼핑몰 주문은 금액·결제 정보를 가져오지 않아 이 표에 보이지 않습니다.」, 「탈퇴 등으로 분리 보관된 주문은 목록에 보이지 않아…」 | 영어·약어 / 어려운 말 | 「당첨 카드 N장」「이 방송에서 기록한 당첨 카드가 없습니다」, 「다른 쇼핑몰 주문」, 「다른 쇼핑몰에서 들어온 주문은 금액과 결제 내용을 알 수 없어 이 표에 보이지 않습니다.」, 「탈퇴한 구매자의 주문은 목록에 보이지 않아 위 주문 수보다 적게 보일 수 있습니다.」 | app/(seller)/seller/(shell)/broadcasts/[broadcastId]/page.tsx:182,269,278,310; components/seller/broadcast/SourceBadge.tsx:9 |
| SA-053 | /seller/hit-cards | 「HIT 카드 이력」「HIT 카드 등록」「방송 중 「HIT 카드 등록」으로 추가해 주십시오」「HIT 카드를 해제하시겠습니까?」「오버레이에서도 바로 사라집니다.」 버튼 「해제」 | 영어·약어/어려운 말/모호한 버튼 | 「당첨 카드 기록」「당첨 카드 기록하기」「방송 대시보드에서 「당첨 카드 기록하기」로 추가해 주십시오」「이 당첨 카드를 지우시겠습니까?」「방송 화면에서도 바로 사라집니다. 지운 카드는 되살릴 수 없습니다.」 버튼 「카드 지우기」 | app/(seller)/seller/(shell)/hit-cards/page.tsx:101,109,112-113,117,149,157,225 |
| SA-052 | /seller/overlay | 「오버레이 편집기」「OBS 「브라우저 소스」에 오버레이 주소를 넣으면 주문대기와 개봉 중인 주문이 방송 화면에 표시됩니다.」「OBS 브라우저 소스 너비 1080 · 높이 1920」「세로 9:16」 | 어려운 말/영어·약어 | 「방송 화면 꾸미기」「방송 프로그램(OBS)의 「브라우저 소스」 칸에 아래 주소를 붙여 넣으면 주문 순서와 개봉 중인 주문이 방송 화면에 나옵니다.」「방송 프로그램 설정값 너비 1080 · 높이 1920」 | app/(seller)/seller/(shell)/overlay/page.tsx:22,69,73-74,132 |
| SA-052 | /seller/overlay | 「주소 발급」「다시 발급」「발급」(확인 창 버튼) 「닫기」, 「주소는 발급할 때 한 번만 보입니다. 다시 발급하면 이전 주소는 바로 끊깁니다.」「새 주소를 발급했습니다」 | 어려운 말/모호한 버튼 | 「주소 만들기」「주소 새로 만들기」, 확인 창 버튼 「주소 새로 만들기」「취소」, 「주소는 만들 때 한 번만 보입니다. 새로 만들면 이전 주소는 바로 쓸 수 없게 됩니다.」「새 주소를 만들었습니다」 | app/(seller)/seller/(shell)/overlay/page.tsx:44,104,107,113,173 |
| SA-052 | /seller/overlay | 「발급 결과를 확인하지 못했습니다. 이전 주소가 이미 끊겼을 수 있습니다. 방송 전에 다시 발급해 OBS 주소를 바꿔 주십시오.」「이 주소는 지금만 볼 수 있습니다. OBS에 넣은 뒤 잃어버리면 재발급해 주십시오.」 | 어려운 말/뜻 둘 | 「새 주소를 만들었는지 확인하지 못했습니다. 이전 주소를 쓸 수 없을 수 있으니 방송 전에 주소를 새로 만들어 방송 프로그램(OBS)에 다시 넣어 주십시오.」「이 주소는 지금만 볼 수 있습니다. 방송 프로그램에 넣어 두십시오. 잃어버리면 새로 만들어 주십시오.」 | app/(seller)/seller/(shell)/overlay/page.tsx:113,125 |
| SA-051 | /seller/overlay (편집기) | 「화면 편집」「위젯」「배치 화면」「격자 스냅」「가림 가이드」「오버레이 배치 화면. 위젯을 고른 뒤 방향키로 1px…」「SW×SH 기준 · 끌어서 옮기고 모서리로 크기를 바꿉니다 · Shift 모서리는 비율 유지」「위치 · 크기 (%)」「투명도」「문구 틀」「글꼴」 | 어려운 말/영어·약어 | 「방송 화면 꾸미기」「꾸미는 칸(글상자·카드)」「미리보기 화면」「칸 맞추기(눈금에 붙이기)」「가려지는 곳 표시」「미리보기 화면입니다. 칸을 고른 뒤 방향키로 한 칸씩, Shift와 함께 누르면 열 칸씩 옮깁니다」「끌어서 옮기고 모서리를 끌어 크기를 바꿉니다. Shift를 누르고 모서리를 끌면 가로세로 비율이 그대로입니다」「위치와 크기(화면 대비 %)」「배경 진하기」「문구 모양」 | components/seller/OverlayEditor.tsx:79,82,605,661,665,707,759,764 |
| SA-051 | /seller/overlay (편집기) | 버튼 「저장하기」「내 템플릿으로 저장」「적용」「삭제」「닫기」「초기화」「바꾸기」「실제 크기 미리보기」「되돌리기」「다시 실행」 | 모호한 버튼 | 「방송 화면에 저장하기」「지금 배치를 내 템플릿으로 저장」「이 템플릿으로 바꾸기」「템플릿 지우기」「취소」「처음 배치로 되돌리기」「비율 바꾸기」「실제 크기로 보기」「방금 작업 취소」「취소한 작업 다시 하기」 | components/seller/OverlayEditor.tsx:537,559,615,621,624,627,630,882 |
| SA-051 | /seller/overlay (편집기) | 「「…」 템플릿 기본값으로 되돌리시겠습니까?」+「…위치 · 크기 · 색 · 효과가 모두 처음으로 돌아갑니다 · 다른 비율은 그대로입니다 · 되돌리기로 다시 가져올 수 있습니다.」 | 뜻 둘(「되돌리기」가 두 가지 뜻) | 「「…」 템플릿으로 바꾸시겠습니까?」「지금 비율의 위치·크기·색·효과가 이 템플릿 값으로 바뀝니다. 다른 비율은 그대로입니다. 저장하기 전까지는 「방금 작업 취소」로 되돌릴 수 있습니다.」 | components/seller/OverlayEditor.tsx:536-537 |
| SA-051 | /seller/overlay (편집기) | 「다른 창에서 세로 9:16 레이아웃을 먼저 저장했습니다」「최신 내용을 불러온 뒤 다시 바꿔 주십시오 · 지금 바꾼 내용은 내 템플릿으로 남겨 둘 수 있습니다」「내 변경을 템플릿으로 저장」「최신 내용 불러오기」, 「내 템플릿은 20개까지입니다. 하나를 지우면 저장할 수 있습니다」 | 어려운 말(레이아웃) | 「다른 창에서 먼저 저장해서 저장하지 못했습니다. 「최신 내용 불러오기」를 누른 뒤 다시 바꿔 주십시오. 지금 바꾼 내용은 「내 템플릿으로 저장」으로 남겨 둘 수 있습니다.」 | components/seller/OverlayEditor.tsx:639,643,646,811 |
| SA-051 | /seller/overlay (편집기) | 「편집기를 불러오지 못했습니다. 잠시 후 다시 시도해 주십시오.」 | 오류에 해결 방법 없음(원인 불명) | 「편집기를 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 「다시 시도」를 눌러 주십시오.」 | components/seller/OverlayEditor.tsx:592 |
| SA-051 | /seller/overlay (편집기) | 「저장했습니다 · 방송 화면에 바로 반영됩니다」「저장 안 한 변경 N개」「저장하지 않은 변경 N개가 있습니다. 나가면 바뀐 내용이 사라집니다. 나가시겠습니까?」 | 어려운 말(반영) | 「저장했습니다. 방송 화면이 바로 바뀝니다」(현행 유지 가능) | components/seller/OverlayEditor.tsx:293,530,570,609 |
| SA-051 | /seller/overlay (편집기) | 속성 입력 「서서히/아래에서/왼쪽에서/뒤집기」「나타나는 효과」「흐르는 시간」「빛 번짐」「기본」(되돌리기 버튼) | 모호한 버튼 | 「기본」→「처음 값으로」 | components/seller/OverlayEditor.tsx:67-68,73 |
| SA-057 | /seller/youtube | 「유튜브 연결을 준비하고 있습니다. 플랫폼 키가 등록되면 열립니다. 지금은 연결과 채팅 수집을 쓸 수 없습니다.」「서비스 준비 중」 | 어려운 말(플랫폼 키)/해결 방법 없음 | 「유튜브 연결은 아직 준비 중입니다. 준비가 끝나면 이 화면에서 바로 쓸 수 있습니다. 지금은 유튜브 연결과 채팅 가져오기를 쓸 수 없습니다.」「준비 중」 | app/(seller)/seller/(shell)/youtube/page.tsx:158,170 |
| SA-057 | /seller/youtube | 「유튜브 연결」「연결됨」「연결 안 됨」「채널 주소를 넣고 연결해 주십시오」「연결 해제」「방송 연결 해제」「채널 변경」「변경」「연결」(버튼) 「@핸들 또는 /channel/UC… 주소」(입력 안내) | 어려운 말/모호한 버튼/영어·약어 | 「유튜브 이어 두기」「이어짐」「이어지지 않음」「내 유튜브 채널 주소를 넣고 「채널 이어 두기」를 눌러 주십시오」「유튜브 이어 둔 것 풀기」「방송 이어 둔 것 풀기」「다른 채널로 바꾸기」「채널 바꾸기」「채널 이어 두기」, 입력 안내 「예: @내채널이름 또는 유튜브 채널 주소」 | app/(seller)/seller/(shell)/youtube/page.tsx:118,121,126,151,158,162,180-181 |
| SA-057 | /seller/youtube | 「채널 주소」「방송 주소」「라이브 방송 주소 (선택)」「지금 방송 찾기」「방송을 찾아 연결했습니다」「비우고 채널만 연결해도 진행 중인 공개 방송을 자동으로 찾습니다」 | 뜻 둘/모호한 버튼 | 「지금 하는 방송 찾아서 이어 두기」「방송 주소를 비워 두고 채널만 이어 둬도 지금 하고 있는 공개 방송을 자동으로 찾아 줍니다」 | app/(seller)/seller/(shell)/youtube/page.tsx:181,188,215,237,263,265,269-270 |
| SA-057 | /seller/youtube | 「채팅 수집」「이 방송에서 채팅 수집 켬」「채팅 수집 기본값」「새로 연결하는 방송은 채팅 수집 켬으로 시작」「기본은 꺼짐입니다. 이미 연결된 방송은 그대로이고, 방송마다 켜고 끌 수 있습니다.」「새 방송은 채팅 수집을 켠 채로 시작합니다」 | 어려운 말/뜻 둘 | 「유튜브 채팅 가져오기」「이 방송에서 채팅 가져오기 켜기」「채팅 가져오기 처음 설정」「새로 이어 두는 방송은 채팅 가져오기를 켠 채로 시작」「처음에는 꺼져 있습니다. 이미 이어 둔 방송에는 영향이 없으며, 방송마다 켜고 끌 수 있습니다.」 | app/(seller)/seller/(shell)/youtube/page.tsx:43-44,158,285,296,298,310,317 |
| SA-057 | /seller/youtube | 「수집 현황 (2026-10)」「이번 달 수집한 채팅」「보관 중인 채팅」「오늘 무료 사용량 N% · 넘으면 내일까지 일시 중지합니다」「이번 달 무료 사용량」「보관 채팅 지금 삭제」「보관 채팅을 모두 삭제하시겠습니까?」 버튼 「삭제」「바꾸기」「해제」 | 어려운 말/모호한 버튼 | 「채팅 가져오기 현황 (2026년 10월)」「이번 달 가져온 채팅」「저장해 둔 채팅」「오늘 쓸 수 있는 무료 분량 중 N% 사용 · 다 쓰면 내일까지 쉽니다」「이번 달 무료 분량 중 N% 사용」「저장해 둔 채팅 지금 지우기」, 확인 버튼 「채팅 지우기」「채널 바꾸기」「이어 둔 것 풀기」 | app/(seller)/seller/(shell)/youtube/page.tsx:347,349,351,353,359,375,384 |
| SA-057 | /seller/youtube | 「오늘 이 쇼핑몰의 무료 사용량을 모두 써서 채팅 수집이 멈췄습니다. … 주문 처리와 오버레이는 그대로입니다.」「플랫폼 전체 무료 사용량이 차서 …」 (채팅 상태 문구 chatStatus.ts도 같음) | 어려운 말 | 「오늘 쓸 수 있는 무료 분량을 다 써서 채팅 가져오기가 멈췄습니다. 내일 자동으로 다시 시작합니다. 주문 처리와 방송 화면에는 영향이 없습니다.」「서비스 전체의 무료 분량이 다 차서 …」 | app/(seller)/seller/(shell)/youtube/page.tsx:43-44; components/seller/broadcast/chatStatus.ts:11-12 |
| SA-057 | /seller/youtube | 「공개 방송만 지원합니다. 비공개·일부 공개 방송의 채팅은 가져올 수 없습니다.」 | OK(쉬운 말) | 현행 유지 | app/(seller)/seller/(shell)/youtube/page.tsx:337 |
| (공통) | 방송 이력·홈 방송 표 | 「시간」 칸에 「1:05」처럼 단위 없이 표시, 날짜 「10/6 21:30」 | 단위 없음 | 「1시간 5분」「10월 6일 21:30」 | components/seller/broadcast/history.ts:10-17; app/(seller)/seller/(shell)/broadcasts/page.tsx:141; components/seller/home/HomeDashboard.tsx:196 |

**② 확인 창 (19)**

| 화면ID | 경로 | 행동 | 현재 동작 | 확인 창 문구 안 | 위험도 | 파일:줄 |
|---|---|---|---|---|---|---|
| SA-001 | /seller/broadcast | 개봉 시작 (버튼·Ctrl+Enter) — 방송 중 빠른 조작 | 누르면 바로 POST /api/seller/queue/{id}/start | 제목 「개봉을 시작하시겠습니까?」 / 「{닉네임} · {상품}을 개봉 중으로 바꿉니다」 / [취소][개봉 시작]. 방송 중 빠른 조작이라 「다시 묻지 않기」 또는 한 번 누름 확인 옵션 제안 | 보통 | app/(seller)/seller/(shell)/broadcast/page.tsx:243,275,453 |
| SA-001 | /seller/broadcast | 개봉 완료 (버튼·Ctrl+Enter) — 방송 중 빠른 조작 | 누르면 바로 POST …/complete | 「개봉을 완료하시겠습니까?」/「완료하면 최근 완료로 옮겨지고 다음 순서가 대기합니다. 10초 안에는 되돌릴 수 있습니다」/[취소][개봉 완료] | 보통 | app/(seller)/seller/(shell)/broadcast/page.tsx:243,443,719 |
| SA-001 | /seller/broadcast | 되돌리기 (최근 완료 표) — 방송 중 빠른 조작 | 누르면 바로 POST …/revert | 「완료를 되돌리시겠습니까?」/「이 주문이 다시 개봉 중으로 돌아갑니다」/[취소][되돌리기] | 보통 | app/(seller)/seller/(shell)/broadcast/page.tsx:559,560 |
| SA-001 | /seller/broadcast | 타이머 +30초 단축키 Ctrl+↑ — 방송 중 빠른 조작 | 키를 누르면 바로 POST …/timer | 확인 창 대신 토스트로 알리고 되돌리기 제공, 또는 「타이머를 30초 늘리시겠습니까?」 | 보통 | app/(seller)/seller/(shell)/broadcast/page.tsx:248,282 |
| SA-001 | /seller/broadcast | 순서 ↑ ↓ (대기 표) — 방송 중 빠른 조작 | 누를 때마다 바로 POST /queue/reorder | 「순서를 바꾸시겠습니까?」/「{닉네임}을 {n}번째로 옮깁니다」/[취소][순서 바꾸기] | 보통 | app/(seller)/seller/(shell)/broadcast/page.tsx:252,504,507 |
| SA-001 | /seller/broadcast | 방송 시작 (제목 입력 폼 제출) | 누르면 바로 POST /broadcast/start | 「방송을 시작하시겠습니까?」/「지금부터 방송 중으로 바뀌고 주문대기가 이 순서대로 들어갑니다」/[취소][방송 시작] | 위험 | app/(seller)/seller/(shell)/broadcast/page.tsx:390,398 |
| SA-001 | /seller/broadcast | 유튜브 채팅 수집 끄기 (체크박스) | 체크 해제하면 바로 PUT /youtube/live/chat (켜기만 확인 창 있음) | 「유튜브 채팅 가져오기를 끄시겠습니까?」/「주문대기 표의 채팅 표시가 사라집니다」/[취소][끄기] | 보통 | app/(seller)/seller/(shell)/broadcast/page.tsx:169,412 |
| SA-001 | /seller/broadcast | 타이머 정하기 창 「저장」 | 입력 창에서 저장하면 바로 POST …/timer (확인 질문 없는 입력 창) | 현행 입력 창을 확인 창 형식(「타이머를 {시간}으로 정하시겠습니까?」)으로 바꿈 | 보통 | components/seller/broadcast/Modals.tsx:87,106; app/(seller)/seller/(shell)/broadcast/page.tsx:8,248,656 |
| SA-001 | /seller/broadcast | HIT 카드 등록 창 「HIT 카드 등록」 | 입력 창에서 제출하면 바로 POST /hit-cards (확인 단계 없음) | 「당첨 카드를 기록하시겠습니까?」/「{카드명}을 {닉네임} 주문에 기록하고 방송 화면에 바로 띄웁니다」/[취소][기록하기] | 위험(방송 화면에 바로 노출) | components/seller/broadcast/HitCardModal.tsx:28,32,54,99 |
| SA-052 | /seller/overlay | 주소 복사 (버튼) — 시작하기 단계 완료 기록 | 복사하면 바로 POST /api/seller/onboarding {action: overlay_url_copied} (화면에 안 보이는 자동 기록) | 사용자 눈에 보이는 변경이 아니므로 확인 창 불필요 — 단 「복사만 하는데 서버에 기록한다」는 점을 목록에 명시 | 보통 | app/(seller)/seller/(shell)/overlay/page.tsx:56,61 |
| SA-053 | /seller/hit-cards | HIT 카드 등록 (창의 「HIT 카드 등록」) | 입력 창 제출 시 바로 POST /hit-cards | 「당첨 카드를 기록하시겠습니까?」/「{카드명}을 {닉네임}에게 기록하고 방송 화면에 바로 띄웁니다」/[취소][기록하기] | 위험 | components/seller/broadcast/HitCardModal.tsx:32; app/(seller)/seller/(shell)/hit-cards/page.tsx:55,116,211 |
| SA-051 | /seller/overlay (편집기) | 저장하기 (버튼) | 누르면 바로 PUT /api/seller/overlay/layout (방송 화면에 즉시 반영, 확인 단계 없음) | 「방송 화면에 저장하시겠습니까?」/「바꾼 N곳이 지금 나가는 방송 화면(세로/가로)에 바로 반영됩니다」/[취소][저장하기] | 위험(방송 화면에 즉시 노출) | components/seller/OverlayEditor.tsx:520,523,630 |
| SA-051 | /seller/overlay (편집기) | 내 템플릿으로 저장 (이름 입력 창 「저장」) | 이름 입력 후 「저장」을 누르면 바로 POST /overlay/templates (입력 창이 전부, 확인 질문 없음) | 현행 입력 창에 확인 문구 추가: 「이 배치를 「{이름}」 템플릿으로 저장하시겠습니까?」/「지금 {세로/가로} 배치가 내 템플릿(N/20)에 추가됩니다」/[취소][템플릿 저장] | 보통 | components/seller/OverlayEditor.tsx:546,550,627,882 |
| SA-051 | /seller/overlay (편집기) | 위젯 보이기 체크(켜기/끄기), 속성 값 변경 | 화면 안에서 초안만 바꿈(서버 호출 없음, 저장하기 때 서버 전송) → 확인 창 불필요 | (표 제외 대상: 서버로 가지 않음) | - | components/seller/OverlayEditor.tsx:329 |
| SA-057 | /seller/youtube | 채널 연결 (「연결」) / 채널 변경 (「변경」, 연결된 방송이 없을 때) | 누르면 바로 PUT /youtube/channel (연결된 방송이 있을 때만 확인 창) | 「이 채널을 이어 두시겠습니까?」/「{입력한 채널 주소}의 방송을 자동으로 찾아 이어 둡니다」/[취소][채널 이어 두기] (바꿀 때는 「채널을 바꾸시겠습니까?」) | 보통 | app/(seller)/seller/(shell)/youtube/page.tsx:211,219,401 |
| SA-057 | /seller/youtube | 방송 연결 (「연결」) | 누르면 바로 PUT /youtube/live | 「이 방송을 이어 두시겠습니까?」/「{방송 주소} 방송이 이 쇼핑몰의 방송으로 이어집니다」/[취소][방송 이어 두기] | 보통 | app/(seller)/seller/(shell)/youtube/page.tsx:259 |
| SA-057 | /seller/youtube | 지금 방송 찾기 (버튼) | 누르면 바로 POST /youtube/live/find | 「지금 하는 방송을 찾아 이어 두시겠습니까?」/「채널에서 진행 중인 공개 방송을 찾아 자동으로 이어 둡니다」/[취소][찾기] | 보통 | app/(seller)/seller/(shell)/youtube/page.tsx:269 |
| SA-057 | /seller/youtube | 이 방송에서 채팅 수집 켬/끔 (체크박스) | 체크하면 바로 PUT /youtube/live/chat (방송 대시보드는 켤 때 보관 안내 확인 창이 있는데 이 화면은 없음) | 켤 때 「채팅 가져오기를 켜시겠습니까?」/보관 안내 문구 표시/[취소][켜기], 끌 때 「채팅 가져오기를 끄시겠습니까?」 | 보통 | app/(seller)/seller/(shell)/youtube/page.tsx:296 |
| SA-057 | /seller/youtube | 채팅 수집 기본값 (체크박스) | 체크하면 바로 PUT /youtube/settings | 「새 방송의 채팅 가져오기를 처음부터 켜시겠습니까?」/「앞으로 새로 이어 두는 방송에 적용됩니다. 이미 이어 둔 방송은 그대로입니다」/[취소][바꾸기] | 보통 | app/(seller)/seller/(shell)/youtube/page.tsx:326 |

**③ 클릭 제목 열 (1)**

| 화면ID | 경로 | 열 | 현재 | 고칠 안 |
|---|---|---|---|---|
| SA-054 | /seller/broadcasts | 제목 | 링크 열이 2번째(첫 열은 「일시」) | 제목을 첫 열 왼쪽으로, 일시는 뒤로 |

**④ 표 겹침·정렬 (4)**

| 화면ID | 경로 | 현재 | 고칠 안 |
|---|---|---|---|
| SA-001 | /seller/broadcast (390) | 「대기」 표: 머리글 「구매자 · 상품」이 겹쳐 글자가 뭉개지고 행 관리 버튼(↑ ↓ …)이 카드 오른쪽에서 잘림(캡처 `docs/design-gap/SA-001-live-orders-390.png`) | 칸 폭 재배분 또는 카드형으로 전환(버튼 2개 + 더보기) |
| SA-001 | /seller/broadcast (1440·390) | 「구매자 · 상품」·「결과」 칸 내용이 칸 폭보다 길어 잘림(자동 측정) | 말줄임(…) + 툴팁, 최소 높이 유지 |
| SA-057 | /seller/youtube (390) | 화면 가로 스크롤(너비 404 > 390) | 넘치는 요소를 줄바꿈·폭 제한 |
| SA-054·055 | /seller/broadcasts(+상세) (390) | 표가 칸 안에서 가로 스크롤 | 모바일 카드형 또는 열 줄이기 |

### 통계 전담 (2) — `session_01GPhc7Kd9oq7YFPv4Tar4ZX` (보관 상태 — MASTER 재배정 필요)

**① 쉬운 말 (11)**

| 화면ID | 경로 | 현재 문구 | 문제 유형 | 고칠 문장 | 파일:줄 |
|---|---|---|---|---|---|
| SA-056 | /seller/stats (요약) | 「매출 (결제 기준)」「주문당 평균」「취소 · 환불」「방문자 / 준비 중 / 방문 집계 연동 뒤 제공」「직전 기간 대비」「직전 기간과 같음」「직전 기간 —」 | 어려운 말(연동) | 「결제된 매출」「주문 1건당 평균 금액」「취소·환불 건수」「방문자 / 아직 볼 수 없습니다 / 방문자 수를 모으면 보여 드립니다」「바로 앞 기간보다」「바로 앞 기간과 같습니다」 | app/(seller)/seller/(shell)/stats/page.tsx:44,47,51,122,128,131; components/seller/stats/parts.tsx:13,16,20 |
| SA-056 | /seller/stats (요약) | 「매출 · 주문 · 회원 통계를 볼 수 있는 권한(매출 보기)이 있는 계정에만 보입니다. 날짜는 한국 시간 기준입니다. 직전 기간은 …입니다.」 | 어려운 말(권한)/뜻 둘 | 「이 화면은 「매출 보기」를 허용받은 계정에만 보입니다. 날짜는 한국 시간 기준입니다. 비교하는 바로 앞 기간은 …입니다.」 | app/(seller)/seller/(shell)/stats/page.tsx:93,119 |
| SA-056 | /seller/stats (요약) | 「방송 매출」「방송 시간 일반 주문」「방송 외 주문」「방송 시작 ~ 종료(방송 매출), 종료 뒤 2시간(방송 시간 일반 주문), 그 밖(방송 외 주문)으로 나눈 값이며 합계는 위 매출과 같습니다. 시청자 수는 준비 중입니다.」 | 뜻 둘/긴 문장 | 「방송 중 들어온 주문」「방송이 끝난 뒤 2시간 안에 들어온 주문」「그 밖의 주문」, 설명 「방송 중에 들어온 주문, 방송이 끝나고 2시간 안에 들어온 주문, 그 밖의 주문으로 나눈 금액입니다. 세 가지를 더하면 위 매출과 같습니다.」 | app/(seller)/seller/(shell)/stats/page.tsx:83,108-110,187; app/(seller)/seller/(shell)/stats/broadcasts/page.tsx:31-32,40,50,84,97 |
| SA-056 | /seller/stats (요약) | 「구매 회원 · 재구매율 · 신규 · 기존 매출」「적립금 지급 · 회수 · 사용 (매출의 N%) · 소멸」「결제 → 발송 평균 · 미입금 자동 취소」「교환 · 반품 · 리뷰 · 문의 준비 중」「신규 = 그 기간에 첫 결제한 회원 · 적립금은 처리가 끝난 시각 기준」 | 어려운 말/뜻 둘 | 「같은 사람이 다시 산 비율」「처음 산 회원 / 이전에 산 적 있는 회원의 매출」「적립금 준 금액 · 도로 거둔 금액 · 쓴 금액 · 기간이 지나 없어진 금액」「결제부터 발송까지 걸린 시간 · 입금이 없어 자동 취소된 주문」「아직 볼 수 없습니다」「처음 산 회원 = 이 기간에 처음 결제한 회원」 | app/(seller)/seller/(shell)/stats/page.tsx:263,270 |
| SA-056 | /seller/stats/* (공통 틀) | 「조회」(버튼)「묶음 단위 일/주/월」「엑셀 내려받기」「직접 입력은 최대 12개월까지 가능합니다」「종료일은 시작일 이후여야 합니다」「시작일과 종료일을 입력해 주십시오」 | 모호한 버튼/어려운 말(묶음 단위) | 「기간 보기」「합계를 나누는 단위 일/주/월」「엑셀 파일로 받기」「날짜를 직접 정할 때는 최대 12개월까지 볼 수 있습니다. 기간을 줄여 주십시오」「종료일을 시작일과 같거나 뒤 날짜로 바꿔 주십시오」 | components/seller/stats/StatsFrame.tsx:85-87,107,202 |
| SA-056 | /seller/stats/* (공통 틀) | 「현재 플랜에서 제공하지 않는 기능입니다 / 쇼핑몰 통합 플랜에서 통계를 볼 수 있습니다」「통계 조회 권한이 필요합니다 / 대표자에게 「매출 보기」 권한 요청이 필요합니다」「통계를 불러오지 못했습니다 / 잠시 뒤 다시 시도해 주십시오」「조회할 수 없는 기간입니다」 | 어려운 말(플랜·권한)/오류 원인 없음 | 「지금 이용권에서는 통계를 볼 수 없습니다 / 쇼핑몰까지 쓰는 이용권에서 볼 수 있습니다」「통계를 볼 수 없는 계정입니다 / 대표자에게 「매출 보기」를 허용해 달라고 요청해 주십시오」「통계를 불러오지 못했습니다 / 인터넷 연결을 확인한 뒤 「다시 시도」를 눌러 주십시오」 | components/seller/stats/StatsFrame.tsx:196,198,202-203 |
| SA-056 | /seller/stats/sales | 「순매출」「판매액(할인 전)」「결제액」「환불액」「결제 수단별」「주문 시각(KST) 기준, 결제된 주문의 금액입니다」 및 알 수 없는 결제 수단은 서버 코드(`m.method`)가 그대로 표시됨 | 어려운 말/영어·약어(KST)/코드값 | 「실제 매출(환불 뺀 금액)」「할인 전 판매 금액」「결제 금액」「환불 금액」「결제 방법별」「주문한 시각(한국 시간) 기준, 결제된 주문의 금액입니다」, 알 수 없는 결제 수단은 「기타」로 표시 | app/(seller)/seller/(shell)/stats/sales/page.tsx:39,60,96 |
| SA-056 | /seller/stats/orders | 「객단가」「취소 / 환불」「주문 시각(KST) 기준 집계입니다. 비교 기간은 바로 앞 같은 일수입니다.」「결제액은 결제된 주문(환불 포함)의 금액, 순매출은 결제액에서 환불액을 뺀 값입니다. 취소는 결제 전 취소, 환불은 결제 뒤 환불입니다.」 | 어려운 말 | 「주문 1건당 평균 금액」「결제 전 취소 / 결제 후 환불」「주문한 시각(한국 시간) 기준입니다. 비교는 바로 앞 같은 일수의 기간과 합니다.」 | app/(seller)/seller/(shell)/stats/orders/page.tsx:37,83 |
| SA-056 | /seller/stats/products | 「판매 상태 판매 중/품절/숨김」「안 팔린 상품 … 임시 저장 상품 제외」「지금 판매 상태 기준」, 알 수 없는 상태는 서버 코드(`p.status`)가 그대로 표시됨 | 코드값 | 알 수 없는 상태는 「확인 필요」로 표시, 「임시 저장 상품은 빼고 센 값입니다」 | app/(seller)/seller/(shell)/stats/products/page.tsx:42 |
| SA-056 | /seller/stats/members | 「재구매율」「구매 회원」「탈퇴」「재구매율은 기간 중 구매 회원 가운데 기간 끝까지 결제 주문이 2건 이상인 회원의 비율입니다. 기간별 구매 회원은 묶음마다 따로 세어 합계와 다를 수 있습니다.」 | 어려운 말/뜻 둘 | 「다시 산 회원 비율」「산 회원 중에서 이 기간에 2번 이상 결제한 회원의 비율입니다. 기간별 숫자를 더하면 합계와 다를 수 있습니다(같은 사람이 여러 기간에 나올 수 있기 때문입니다)」 | app/(seller)/seller/(shell)/stats/members/page.tsx:22,28,35-36,47,63 |
| SA-056 | /seller/stats/broadcasts | 「방송 순매출」「시청자 → 주문 전환 / 준비 중 / 시청 데이터 연동 뒤 제공」「시청자 수 / 준비 중」「└ 방송 시간 일반 주문」 | 어려운 말(연동·전환)/약어 | 「방송에서 번 실제 매출」「시청자 중 주문한 비율 / 아직 볼 수 없습니다」「방송이 끝난 뒤 2시간 안의 주문」 | app/(seller)/seller/(shell)/stats/broadcasts/page.tsx:49,51,84,97 |

**② 확인 창 (1)**

| 화면ID | 경로 | 행동 | 현재 동작 | 확인 창 문구 안 | 위험도 | 파일:줄 |
|---|---|---|---|---|---|---|
| SA-056 | /seller/stats/* | 엑셀 내려받기 | 서버 변경 없음(화면 자료를 CSV로 내려받음) → 확인 창 불필요 | (대상 아님: 조회·내보내기) | - | components/seller/stats/StatsFrame.tsx:107; app/(seller)/seller/(shell)/stats/page.tsx:77 |

### 도우미 전담 (2) — `session_01179Trx8rmw3gteLPm2YqPm`

**① 쉬운 말 (1)**

| 화면ID | 경로 | 현재 문구 | 문제 유형 | 고칠 문장 | 파일:줄 |
|---|---|---|---|---|---|
| SA-140 | /seller/assistant | 「도우미는 준비 중입니다 / 사용법이 막히면 문의하기로 남겨 주십시오.」「플랫폼 사용법만 답합니다. 주문·설정 변경은 하지 않으며, 개인정보는 입력하지 마십시오. 오늘 남은 질문 N회」「질문하기」「도우미가 답하지 못했습니다. 잠시 뒤 다시 시도해 주십시오」 | 어려운 말(플랫폼)/뜻 둘 | 「도우미는 아직 준비 중입니다 / 사용법이 어려우면 「문의하기」로 남겨 주십시오.」「사용 방법만 알려 드립니다. 주문이나 설정을 대신 바꾸지는 않습니다. 이름·전화번호 같은 개인정보는 쓰지 마십시오. 오늘 남은 질문 N번」「도우미에게 질문하기」 | app/(seller)/seller/(shell)/assistant/page.tsx:41,57,63-64,69 |

**② 확인 창 (1)**

| 화면ID | 경로 | 행동 | 현재 동작 | 확인 창 문구 안 | 위험도 | 파일:줄 |
|---|---|---|---|---|---|---|
| SA-140 | /seller/assistant | 질문하기 | 누르면 바로 POST /api/seller/assistant (하루 질문 횟수가 줄어듦, 확인 단계 없음) | 「질문을 보내시겠습니까?」/「오늘 남은 질문 N번 중 1번을 씁니다」/[취소][질문하기] — 변경이 사용 횟수뿐이라 확인 창 면제 후보 | 보통 | app/(seller)/seller/(shell)/assistant/page.tsx:28,34 |

### 개발 전담 (화면) (3) — `session_01BwVsBQrQRL49RsUn9ejKYw`

**① 쉬운 말 (32)**

| 화면ID | 경로 | 현재 문구 | 문제 유형 | 고칠 문장 | 파일:줄 |
|---|---|---|---|---|---|
| 공통(모든 화면) | api 실패 기본 문구 | 「잠시 후 다시 시도해 주십시오」「이 기능은 권한이 필요합니다. 대표자에게 요청해 주십시오」「찾을 수 없습니다. 이미 삭제되었을 수 있습니다」 | 오류에 해결 방법 없음/어려운 말(권한) | 「저장하지 못했습니다. 잠시 뒤 다시 눌러 주십시오. 계속되면 문의해 주십시오」「이 계정은 이 일을 할 수 없습니다. 대표자에게 허용해 달라고 요청해 주십시오」「찾을 수 없습니다. 이미 지워졌을 수 있습니다. 목록으로 돌아가 확인해 주십시오」 (무엇이 안 됐는지는 각 화면이 fallback으로 넘겨야 함) | components/seller/api.ts:75-79,92-100 (모든 화면의 오류 안내가 이 값을 씀) |
| SA-002-O | /seller/home-overlay | 「오늘 처리할 일」「주문대기」「방송 상태」「오늘 방송 성과」「HIT」「오버레이 편집기」「유튜브 연결」「스토어 기능」「상품·주문·고객·쿠폰은 통합 구독에서 사용할 수 있습니다. 지금 이용 중인 외부 쇼핑몰은 그대로 연동됩니다.」「구독 보기」 | 영어·약어/어려운 말(연동·통합 구독) | 「당첨 카드」「방송 화면 꾸미기」「유튜브 이어 두기」「쇼핑몰 기능」「상품·주문·고객·쿠폰은 쇼핑몰까지 쓰는 이용권(통합 구독)에서 쓸 수 있습니다. 지금 쓰는 다른 쇼핑몰은 계속 이어서 쓸 수 있습니다.」「이용권 보기」 | components/seller/home/OverlayHome.tsx:47-48,50-51,56,77,82,112 |
| SA-002 | /seller (홈) | 「시작하기 2/6 완료」「이어서 하기」「닫기」「닫지 못했습니다. 다시 시도해 주십시오」 | 모호한 버튼/오류에 해결 방법 없음 | 「이어서 하기」「시작하기 안내 숨기기」「안내를 숨기지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오」 | components/seller/home/HomeDashboard.tsx:95,97 |
| SA-002 | /seller (홈) | 「입금 확인」「배송 준비」「반품 요청」「문의 답변」「재고 없음」「재고 적음」 — 목록에 없는 항목은 서버 코드(`t.key`)가 그대로 표시됨 | 코드값 | 「입금 확인 필요」「배송 준비 필요」「반품 요청 답변 필요」「문의 답변 필요」「품절 상품」「재고 부족 상품」, 알 수 없는 항목은 「확인할 일」로 표시 | components/seller/home/HomeDashboard.tsx:30-35 |
| SA-002 | /seller (홈) | 「매출(결제 기준)」「주문당 평균」「취소 · 환불」「확인할 수 있는 처리할 일이 없습니다」 | 어려운 말/뜻 둘 | 「결제된 매출」「주문 1건당 평균 금액」「취소·환불 건수」「오늘 처리할 일이 없습니다」 | components/seller/home/HomeDashboard.tsx:117,147,149,151 |
| SA-111 | /seller/notices | 「공지 · 문의」「공지사항」「점검 / 정책 / 기능 / 일반」(분류)「고정」「게시일」「등록된 공지가 없습니다 / 점검·정책·기능 안내가 올라오면 여기에 표시됩니다.」「더 불러오기」 | 어려운 말(게시·고정) | 「플랫폼 공지」「공지」「점검 / 운영 규칙 / 새 기능 / 일반」「맨 위 고정」「올린 날」「더 보기」 | app/(seller)/seller/(shell)/notices/page.tsx:44,47,62,98; components/seller/platformNotice.ts:5-8 |
| SA-112 | /seller/notices/{id} | 「게시 … · 발송 화면 공지」(알 수 없는 발송 채널은 서버 코드(`c`)가 그대로 표시됨)「삭제되었거나 볼 수 없는 공지입니다.」「관련 문의하기」 | 코드값/어려운 말(발송) | 「올린 날 … · 보인 곳: 화면 공지」, 알 수 없는 채널은 「기타」로 표시, 「이 공지로 문의하기」 | app/(seller)/seller/(shell)/notices/[id]/page.tsx:48,75 |
| SA-113 | /seller/inquiries | 「문의하기」「내 문의」「유형 / 작성자 / 상태 / 마지막 글」「새 답변」「답변 대기 / 답변 완료 / 종료」「보낸 문의가 없습니다 / 궁금한 점이나 오류는 「문의하기」로 보내 주십시오.」「결제 · 구독」「오류 신고」 | 어려운 말(구독) | 「결제 · 이용권」「오류 알리기」「문의 종류」 외 현행 유지 | app/(seller)/seller/(shell)/inquiries/page.tsx:51,63-64,87; components/seller/platformInquiry.ts:5 |
| SA-114 | /seller/inquiries/new | 「문의를 보내지 못했습니다. 잠시 후 다시 시도해 주십시오」「사진을 올리지 못했습니다. 다시 시도해 주십시오」「작성 중인 내용이 사라집니다. 나가시겠습니까?」「사진은 N장까지 붙일 수 있습니다」「JPG · PNG · WEBP, 5MB 이하」「사진 첨부」「문의 보내기」 | 오류에 해결 방법 없음/영어·약어(JPG·PNG·WEBP·MB) | 「문의를 보내지 못했습니다. 쓴 내용은 그대로 남아 있으니 인터넷 연결을 확인한 뒤 「문의 보내기」를 다시 눌러 주십시오」「사진을 올리지 못했습니다. 사진 형식(JPG, PNG, WEBP)과 크기(5MB 이하)를 확인한 뒤 다시 올려 주십시오」 | app/(seller)/seller/(shell)/inquiries/new/page.tsx:42,53,114; components/seller/InquiryAttach.tsx:27,52,55 |
| SA-115 | /seller/inquiries/{id} | 「보내지 못했습니다. 잠시 후 다시 시도해 주십시오」「추가 문의」「추가 문의 보내기」「종료된 문의입니다. 이어서 문의하시려면 새 문의로 보내 주십시오.」 | 오류에 해결 방법 없음 | 「추가 문의를 보내지 못했습니다. 쓴 내용은 그대로 남아 있으니 다시 눌러 주십시오」 | app/(seller)/seller/(shell)/inquiries/[id]/page.tsx:45,125,141,156 |
| SA-130 | /seller/notifications | 「알림」「입금 확인」「재고 없음」「반품·교환」「문의 답변」「공지」(알림 종류)「새 공지(최근 14일)와 내 문의에 달린 플랫폼 답변이 보입니다. 누르면 해당 화면으로 갑니다.」「안 읽음 N건」「새 알림」 | 어려운 말(알림 종류가 실제로는 6가지인데 안내문은 2가지만 설명) | 「새 공지(최근 14일), 문의 답변, 입금 확인 요청, 결제 완료, 품절, 반품·교환 요청이 보입니다. 누르면 해당 화면으로 갑니다.」「읽지 않은 알림 N건」 | app/(seller)/seller/(shell)/notifications/page.tsx:20-21,23-24,56,64-65,88 |
| AU-006 | /seller/suspended | 「이용이 정지되었습니다」「새 판매와 방송, 상품·설정 변경은 멈춰 있습니다. 이미 받은 주문의 처리(배송·환불·구매자 문의)는 계속할 수 있습니다.」「정지를 풀려면 「공지 · 문의」에서 문의해 주십시오.」「주문 처리」「문의하기」 | (문제 적음) 점검 결과: 쉬운 말로 되어 있음 | 현행 유지 가능. 「정지 사유는 플랫폼이 알려 드립니다」 한 줄 추가 권장 | app/(seller)/seller/(shell)/suspended/page.tsx:14,16-17,20,23 |
| SA-150 | /seller/automation | 「자동 연결」「외부 쇼핑몰과 OBS 오버레이, 대신 연결해 드립니다」「외부 쇼핑몰 앱 설치 · 웹훅 연결」「OBS 오버레이 설치 · 브라우저 소스 등록」「주문 표시 · 오버레이 디자인 기본 설정」「테스트 주문 이벤트로 실제 표시 검증」「직접 해 주셔야 하는 일 … 2단계 인증 · 보안문자 · 방송용 PC에 OBS 연결 도구 설치(OBS 28 이상) … 완전 무인은 아닙니다.」 | 어려운 말/영어·약어(OBS·웹훅·오버레이·브라우저 소스) | 「자동 설정(대신 해 드립니다)」「다른 쇼핑몰과 방송 프로그램(OBS)을 대신 이어 드립니다」「다른 쇼핑몰에 우리 앱을 설치하고 주문 알림을 받도록 연결」「방송 프로그램에 방송 화면 넣기」「주문이 나오는 방송 화면 기본 설정」「테스트 주문을 보내 실제로 화면에 나오는지 확인」「직접 하셔야 하는 일: 쇼핑몰 관리자 로그인 · 문자 인증 · 그림 속 글자 입력 · 방송용 컴퓨터에 연결 프로그램 설치. 이 단계에서는 멈추고 알려 드리며, 마치면 자동으로 이어 갑니다. 전부 자동은 아닙니다.」 | app/(seller)/seller/(shell)/automation/page.tsx:17-20,42,50,52,59 |
| SA-150 | /seller/automation | 「확인하기」(버튼)「주소로 자동 연결할 수 있는 쇼핑몰인지 먼저 확인합니다 · 확인되면 결제할 수 있습니다」「N원 결제하고 시작」「직접 설정하기 (무료)」「이번 달 자동 연결 접수를 잠시 멈췄습니다. 다음 달에 다시 신청해 주십시오」「아직 자동 연결할 수 없는 쇼핑몰입니다」「환불 · 재설치」(안내문 전체) | 모호한 버튼/뜻 둘 | 「연결 가능한지 확인하기」「입력한 주소의 쇼핑몰을 자동으로 이어 줄 수 있는지 확인합니다. 가능하면 결제로 넘어갑니다」「N원 결제하고 자동 설정 시작하기」 | app/(seller)/seller/(shell)/automation/page.tsx:42,88,112,115,122,146 |
| SA-150 | /seller/automation | 「테스트 주문이 오버레이에 표시되지 않고 지원으로도 해결되지 않으면 전액 환불해 드립니다. 연결을 시작한 뒤에는 단순 변심으로 환불할 수 없습니다. 완료 뒤 N일 동안 같은 쇼핑몰 · 같은 PC는 무료로 재설치해 드립니다. 그 밖의 재설치는 33,000원(부가세 포함)입니다.」 | 뜻 둘(규칙 4개가 한 덩어리) | 규칙별로 줄을 나눠 「설정이 끝났는데 테스트 주문이 방송 화면에 나오지 않고, 도움을 받아도 해결되지 않으면 전액 환불합니다.」「설정을 시작한 뒤에는 마음이 바뀌어도 환불되지 않습니다.」「끝난 뒤 N일 안에 같은 쇼핑몰·같은 컴퓨터에 다시 설치하는 것은 무료입니다.」「그 밖의 다시 설치는 33,000원(부가세 포함)입니다.」 | app/(seller)/seller/(shell)/automation/page.tsx:90 |
| SA-151 | /seller/automation/pay | 「로그인 · 2단계 인증 · 권한 승인 · 도구 설치는 제가 직접 합니다.」등 동의 5개 「확인해 주십시오 · 필수 5개」「다섯 가지를 확인하면 결제할 수 있습니다 · 동의한 시각과 문구 버전을 기록합니다」「결제가 서버에서 확인된 뒤에 작업이 시작됩니다」「카드」「구독에 쓰는 카드」「N원 결제하기」「이전」 | 어려운 말(서버·권한 승인·문구 버전)/영어·약어 | 「로그인·문자 인증·앱 설치 허용·연결 프로그램 설치는 제가 직접 합니다.」, 「결제가 확인된 뒤에 작업을 시작합니다」「동의한 시각이 기록됩니다」「결제 카드: 이용권에 등록한 카드」「이전 화면으로」 | app/(seller)/seller/(shell)/automation/pay/page.tsx:14,68,71,76,84 |
| SA-151 | /seller/automation/pay | 오류 「결제할 카드가 없습니다. 구독 · 결제에서 카드를 등록해 주십시오」「결제되지 않았습니다. 카드사에서 승인을 거절했을 수 있습니다 · 카드를 확인한 뒤 다시 시도해 주십시오」「안내 내용이 바뀌었습니다. 새로 고친 뒤 다시 확인해 주십시오」 | (대체로 양호) 「구독 · 결제」 이름 변경에 맞춰 수정 | 「결제 카드가 없습니다. 「이용권 · 결제」에서 카드를 등록한 뒤 다시 와 주십시오」 | app/(seller)/seller/(shell)/automation/pay/page.tsx:21-22,24-26 |
| SA-152 | /seller/automation/{id} | 진행 상태 「결제 확인 중 / 대기 중 / 실행 중 / 검증 중 / 고객 확인 필요 / 실패 / 취소 / 정리 중」「외부 쇼핑몰 연결 · 주문 알림 연결 · OBS 오버레이 설치 · 주문 표시 설정 · 테스트 검증」「지금 해 주실 일」「ONQ 앱 설치 권한을 승인해 주십시오」「방송용 PC에 OBS 연결 도구를 설치해 주십시오」「이어서 진행하기」「바꾼 설정을 정리하고 있습니다. 담당자가 정리를 마치면 결과를 알려 드립니다」 | 어려운 말/영어·약어(OBS·ONQ·PC·고객) | 「결제 확인 중 / 순서 기다리는 중 / 설정하는 중 / 확인하는 중 / 직접 해 주셔야 함 / 실패 / 취소됨 / 되돌리는 중」「다른 쇼핑몰 이어 주기 · 주문 알림 연결 · 방송 프로그램에 방송 화면 넣기 · 주문 표시 설정 · 테스트 확인」「지금 해 주실 일」「쇼핑몰에서 앱 설치를 허용해 주십시오」「방송용 컴퓨터에 연결 프로그램을 설치해 주십시오」「바꾼 설정을 원래대로 되돌리고 있습니다. 끝나면 알려 드립니다」 | app/(seller)/seller/(shell)/automation/[jobId]/page.tsx:105,108,110,115; components/seller/automation/common.ts:24,34-35 |
| SA-152 | /seller/automation/{id} | 실패 사유 「자동 연결을 끝내지 못했습니다」(알 수 없는 코드)「이번 달 자동 연결 처리 한도에 닿아 멈췄습니다」「방송용 PC가 다른 작업 중입니다」「처리 시간이 너무 길어 멈췄습니다」「정해진 시간 안에 시작하지 못했습니다」 | 오류에 해결 방법 없음/어려운 말 | 각 문구 뒤에 해결 방법 추가: 「자동 연결을 끝내지 못했습니다. 「자동 연결 다시 하기」를 누르거나 직접 설정을 이용해 주십시오」「이번 달 자동 설정 접수 한도를 넘어 멈췄습니다. 다음 달에 다시 신청하거나 직접 설정을 이용해 주십시오」 | components/seller/automation/common.ts:41-42,44-47,50 |
| SA-152 | /seller/automation/{id} | 「환불 요청」「자동 연결 다시 하기」「직접 설정 시작」「연결 취소하기」「취소하기」「계속 진행」「N원은 결제한 카드로 환불됩니다 · 카드사 기준 3~5영업일」「연결을 시작한 뒤라 환불되지 않습니다 · 결제 전에 동의하신 내용입니다」 | 모호한 버튼(「취소하기」「환불 요청」)/어려운 말(영업일) | 「N원 환불 요청하기」「자동 설정 다시 하기」「직접 설정하러 가기」「자동 설정 그만두기」버튼 「그만두기」「계속 진행하기」 | app/(seller)/seller/(shell)/automation/[jobId]/page.tsx:85,123,127-129,140,143-144 |
| SA-153 | /seller/automation/{id}/done | 「완료 · 작동 확인」「완료 설정 확인」「OBS 장면에 「ONQ 주문대기」 소스가 켜져 있는지 확인해 주십시오 · 쇼핑몰 앱 권한을 바꾸면 연결이 끊길 수 있습니다 · 오버레이 색 · 위치는 오버레이 편집기에서 바꿉니다」「방송 대시보드로」「오버레이 편집기」 | 어려운 말/영어·약어(OBS·소스·장면) | 「설정 완료 · 화면에 나오는 것까지 확인했습니다」「끝난 뒤 확인할 것」「방송 프로그램(OBS)에서 「ONQ 주문대기」가 켜져 있는지 확인해 주십시오. 쇼핑몰에서 앱 허용을 바꾸면 연결이 끊길 수 있습니다. 방송 화면의 색과 위치는 「방송 화면 꾸미기」에서 바꿉니다」 | app/(seller)/seller/(shell)/automation/[jobId]/done/page.tsx:45,53,56-57,61 |
| SA-003·004 | /seller/onboarding | 「쇼핑몰 통합 / 오버레이 전용」(갈래 이름)「구독 결제」「오버레이 설정」「오버레이 주소 복사」「오버레이 편집기에서 주소를 발급해 복사한 뒤 OBS 「브라우저 소스」에 넣습니다.」「외부 쇼핑몰 연동」「주문 설정 / 입금 기한·자동 취소 같은 주문 정책을 저장합니다.」「진행 차례 / 대기」「이어서 하기」「시작하기 닫기」「다시 열기」「표시할 시작 단계가 없습니다 / 계정에 맞는 시작 안내가 없습니다」「처리하지 못했습니다. 잠시 후 다시 시도해 주십시오」 알 수 없는 단계는 서버 코드(`s.key`)가 그대로 표시됨 | 어려운 말/코드값/오류에 해결 방법 없음 | 「쇼핑몰까지 쓰기 / 방송 화면만 쓰기」「이용권 결제」「방송 화면 꾸미기」「방송 화면 주소 복사」「방송 화면 꾸미기에서 주소를 만들어 복사한 뒤, 방송 프로그램(OBS)의 「브라우저 소스」 칸에 붙여 넣습니다.」「다른 쇼핑몰 이어 쓰기」「주문 규칙 / 입금해야 하는 시간과 자동 취소 같은 주문 규칙을 저장합니다.」「지금 할 차례 / 기다리는 중」「안내 숨기기」「다시 보이기」「안내를 바꾸지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오」, 알 수 없는 단계는 「확인할 일」 | app/(seller)/seller/(shell)/onboarding/page.tsx:19,23-25,54,80,107,119 |
| SA-006 | /seller/external-shops | 「외부 쇼핑몰 연동」「쇼핑몰 추가 연결」「확인하기」(버튼, 실제로는 연결 시작)「연결됨 / 다시 연결 필요 / 해제 대기 / 해제됨」「권한이 끊겨 이벤트가 멈췄습니다 · 다시 연결하면 바로 이어집니다」「연결을 끊고 있습니다 · 쇼핑몰 응답을 기다리는 중 · 주문은 받지 않습니다」「마지막 이벤트」「주문 이벤트를 받고 있습니다」「인증 / 앱 권한」 | 어려운 말(이벤트·권한)/모호한 버튼(확인하기 = 연결 시작) | 「다른 쇼핑몰 이어 쓰기」「쇼핑몰 더 이어 두기」「이 주소로 연결 시작하기」「이어짐 / 다시 이어야 함 / 끊는 중 / 끊어짐」「허용이 풀려 주문 알림이 멈췄습니다 · 다시 이으면 바로 이어집니다」「이어진 쇼핑몰의 주문이 들어오고 있습니다」「마지막으로 받은 주문 알림」 | app/(seller)/seller/(shell)/external-shops/page.tsx:23-25,87,94,97,101,121 |
| SA-006 | /seller/external-shops | 「쇼핑몰에서 연결을 허용하지 않았습니다. 다시 시도해 주십시오」「연결 요청이 만료됐거나 맞지 않습니다. 처음부터 다시 연결해 주십시오」「쇼핑몰 인증을 마치지 못했습니다. 잠시 후 다시 연결해 주십시오」「연결하지 못했습니다. 다시 시도해 주십시오」(코드 모르는 오류)「해제하지 못했습니다. 잠시 후 다시 시도해 주십시오」「다시 시도」(버튼) | 모호한 버튼(「다시 시도」=해제 다시 요청)/오류 | 「다시 시도」→「해제 다시 요청하기」, 「연결하지 못했습니다. 입력한 쇼핑몰 주소가 맞는지 확인한 뒤 다시 눌러 주십시오」 | app/(seller)/seller/(shell)/external-shops/page.tsx:30-31,33,65,86,148 |
| AU-002 | /seller/login | 「쇼핑몰 운영과 방송 주문대기를 한곳에서 관리합니다.」「쇼핑몰 주소」(입력칸, 예: byulbit)「이 이메일로 사용하는 쇼핑몰이 여러 곳입니다. 로그인할 쇼핑몰 주소를 입력해 주십시오」「로그인하지 못했습니다. 잠시 후 다시 시도해 주십시오」「직원 탭으로 / 대표자 탭으로」「아이디/비밀번호 찾기」 | 어려운 말(쇼핑몰 주소=영문 이름이라는 설명 없음)/오류에 해결 방법 없음 | 「쇼핑몰 주소(가입할 때 정한 영문 이름)」「이 이메일로 쓰는 쇼핑몰이 여러 곳입니다. 가입할 때 정한 쇼핑몰 주소(영문)를 입력해 주십시오」「로그인하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오」「직원으로 로그인하기 / 대표자로 로그인하기」 | app/(seller)/seller/(shell)/login/page.tsx:97,126,188,190,203-204,212 |
| AU-005 | /seller/pending | 「가입 승인을 기다리고 있습니다」「신청하신 내용을 확인하고 있습니다. 승인되면 알려 드립니다. 승인되기 전에는 로그인할 수 없습니다.」 | 어려운 말(승인)/뜻 둘(얼마나 걸리는지·어디로 알려 주는지 없음) | 「가입 신청을 확인하고 있습니다」「신청하신 내용을 확인하고 있습니다. 확인이 끝나면 가입한 이메일로 알려 드립니다. 그 전에는 로그인할 수 없습니다.」 | app/(seller)/seller/(shell)/pending/page.tsx:9-10 |
| PF-007 | /seller/signup | 「파트너스 가입 신청」「대표자 본인확인을 하고 사업자 정보를 적으면 바로 점검해요.」「개업일」「통신판매업 신고번호 / 없으면 신고 후 신청해 주세요」「쇼핑몰 주소 / 영문 소문자 · 숫자 · 하이픈(-) 3~30자 · 구매자가 쇼핑몰에 들어올 때 써요」「국세청 사업자 조회를 아직 하지 못했어요」「사업자 정보가 국세청 기록과 달라요」「확인이 필요한 항목이 있어 살펴본 뒤 승인 결과를 알려 드려요」「쓸 수 없는 주소예요. 다른 주소를 정해 주세요」「입력한 정보를 다시 확인해 주세요」 | 어려운 말(승인·조회)/오류에 해결 방법 없음(「입력한 정보를 다시 확인해 주세요」 어느 칸인지 없음) | 「대표자 본인 확인을 하고 사업자 정보를 적으면 바로 확인해요.」「영문 소문자·숫자·하이픈(-)으로 3~30자. 구매자가 쇼핑몰 주소창에 쓰는 이름이에요」「국세청 조회가 아직 안 끝났어요. 잠시 뒤 확인해요」「입력한 사업자 정보가 국세청 기록과 달라요. 사업자등록증을 보고 다시 확인해 주세요」「빨간 글씨가 있는 칸을 다시 확인해 주세요」 | app/(seller)/seller/(shell)/signup/PartnersSignupForm.tsx:29-30,33,125,185,192,213-214 |
| AU-003 | /seller/password-reset | 「비밀번호 찾기」「가입한 이메일과 쇼핑몰 주소를 입력하고 휴대폰 본인확인을 하면 바로 새 비밀번호를 정할 수 있습니다.」「이메일 · 쇼핑몰 주소와 대표자 본인인지 확인해 주십시오.」「등록된 직원 정보와 맞지 않습니다. 대표자에게 문의해 주십시오」「본인확인 결과를 확인하고 있습니다. 잠시 후 다시 눌러 주십시오」「다시 확인」 | 어려운 말(본인확인·재설정)/뜻 둘 | 「가입한 이메일과 쇼핑몰 주소를 입력하고 휴대폰으로 본인 확인을 하면 새 비밀번호를 정할 수 있습니다.」「입력한 이메일과 쇼핑몰 주소가 맞는지, 대표자 본인 명의의 휴대폰인지 확인해 주십시오.」「본인 확인 결과를 기다리는 중입니다. 잠시 뒤 「결과 다시 확인하기」를 눌러 주십시오」 | app/(seller)/seller/(shell)/password-reset/page.tsx:72-73,79,101,104,125 |
| AU-011 | /seller/find-id | 「아이디 찾기」「휴대폰 본인확인을 하면 가입한 로그인 이메일을 알려 드립니다.」「가입한 계정을 찾았습니다」「맞는 계정이 없습니다」「입력한 정보와 맞는 대표자 계정이 없습니다.」「본인확인 재시도」「선택한 계정 비밀번호 변경」「확인 중」 | 어려운 말(본인확인)/모호한 버튼(「본인확인 재시도」「확인 중」) | 「이메일(아이디) 찾기」「「본인확인 다시 하기」」「선택한 계정의 비밀번호 바꾸기」「확인하는 중」 | app/(seller)/seller/(shell)/find-id/page.tsx:99,126,132-133,190,195 |
| AU-004 | 비밀번호 새로 정하기(찾기 화면 안) | 「새 비밀번호」「새 비밀번호 확인」「8자 이상」「위에 입력한 비밀번호와 다릅니다」「변경하면 다른 기기의 로그인은 모두 해제됩니다」「비밀번호 변경」「변경하지 못했습니다. 잠시 후 다시 시도해 주십시오」「새 비밀번호로 로그인해 보십시오. 되지 않으면 다시 변경해 주십시오」「비밀번호가 이미 변경되었을 수 있습니다.」「처음부터 다시 찾기」 | 오류에 해결 방법 없음(마지막)/뜻 둘(변경됐을 수 있음) | 「변경하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오」「비밀번호가 바뀌었는지 확인하지 못했습니다. 방금 정한 새 비밀번호로 로그인해 보십시오. 로그인이 안 되면 다시 바꿔 주십시오」 | components/seller/NewPasswordForm.tsx:38,58-59,68,75,102,131,153 |
| AU-012 | /seller/identity-link | 「본인확인으로 계정 연결」「처음 로그인할 때 한 번만 합니다. 대표자가 등록한 직원 정보와 맞는지 휴대폰 본인확인으로 확인합니다.」「대표자가 등록한 직원 정보와 맞지 않습니다. 이름이나 휴대폰 번호가 다릅니다.」「본인확인 결과는 저장하지 않았습니다」「나중에 하기」「계속」「본인확인 재시도」「연결 결과를 확인하지 못했습니다. 다시 눌러 주십시오」「연결하지 못했습니다. 잠시 후 다시 시도해 주십시오」 | 어려운 말(연결·본인확인)/오류에 해결 방법 없음/모호한 버튼(「계속」) | 「휴대폰 확인으로 내 계정 확인하기」「처음 로그인할 때 한 번만 합니다. 대표자가 등록한 직원 정보와 내 휴대폰 정보가 같은지 확인합니다.」「대표자가 등록한 정보와 다릅니다. 이름이나 휴대폰 번호가 다릅니다. 대표자에게 정보를 고쳐 달라고 요청해 주십시오」「나중에 하기」「업무 화면으로 가기」「휴대폰 확인 다시 하기」「확인하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오」 | app/(seller)/seller/(shell)/identity-link/page.tsx:86,99,116,143,145,158,177,180 |
| AU-001~004·011·012 | 본인확인 공통 (IdentityCheck) | 「통신사 / 알뜰폰 (SKT망)」「내·외국인」「인증번호 받기」「인증번호 다시 받기」「정보 다시 입력」「확인」(6자리 확인 버튼)「다시 확인」「본인확인 약관에 모두 동의합니다」「본인확인 서비스 준비 중입니다. 휴대폰 본인확인을 연결하고 있습니다. 준비되면 바로 …」「오늘은 본인확인을 더 할 수 없습니다. 내일 다시 시도해 주십시오」「테스트 모드입니다. 인증번호 000000을 입력해 주십시오.」 | 모호한 버튼(「확인」)/어려운 말 | 「인증번호 문자 받기」「인증번호 다시 받기」「정보 다시 쓰기」「인증번호 확인하기」「본인확인 결과 다시 보기」「본인확인 이용 약관에 모두 동의합니다」「본인 확인 서비스를 준비하는 중입니다. 준비가 끝나면 바로 쓸 수 있습니다」 | components/seller/IdentityCheck.tsx:27,31,40,45,50,55,274,320; components/seller/PartnersAuth.tsx:80; components/seller/TestModeNotice.tsx:37-38 |

**② 확인 창 (20)**

| 화면ID | 경로 | 행동 | 현재 동작 | 확인 창 문구 안 | 위험도 | 파일:줄 |
|---|---|---|---|---|---|---|
| SA-002 | /seller (홈) | 시작하기 「닫기」 | 누르면 바로 POST /api/seller/onboarding {action: dismiss} | 「시작하기 안내를 숨기시겠습니까?」/「홈에서 시작하기 안내가 사라집니다. 시작하기 화면에서 다시 열 수 있습니다」/[취소][숨기기] | 보통 | components/seller/home/HomeDashboard.tsx:84,85 |
| SA-114 | /seller/inquiries/new | 문의 보내기 | 누르면 바로 POST /platform-inquiries (보낸 문의는 지울 수 없음, 확인 창 없음) | 「문의를 보내시겠습니까?」/「보낸 뒤에는 수정하거나 지울 수 없습니다. 답변은 「내 문의」에서 확인합니다」/[취소][문의 보내기] | 보통 | app/(seller)/seller/(shell)/inquiries/new/page.tsx:33,37,114 |
| SA-115 | /seller/inquiries/{id} | 추가 문의 보내기 | 누르면 바로 POST /platform-inquiries/{id}/messages (상태가 「답변 대기」로 바뀜) | 「추가 문의를 보내시겠습니까?」/「보낸 뒤에는 수정할 수 없고 문의가 다시 「답변 대기」가 됩니다」/[취소][추가 문의 보내기] | 보통 | app/(seller)/seller/(shell)/inquiries/[id]/page.tsx:37,41,156 |
| SA-114·115 | 문의 작성·상세 | 사진 첨부 (파일 고르는 즉시 업로드) | 고르면 바로 POST /platform-inquiries/images (서버에 사진 저장, 확인 없음; 「×」로 빼도 서버 파일은 남을 수 있음) | 「사진 N장을 올리시겠습니까?」 또는 올린 뒤 「사진을 올렸습니다」 알림 (낮은 위험이라 확인 창 면제 후보) | 보통 | components/seller/InquiryAttach.tsx:15,25,52 |
| SA-130 | /seller/notifications | 알림 화면 열기 (자동 읽음 처리) | 화면을 열면 클릭 없이 자동으로 POST /notifications/read (알림이 읽음으로 바뀜) | 사용자 행동 없는 자동 기록이므로 확인 창 불필요 — 단 「읽음 처리됨」 안내 권장 | 보통 | app/(seller)/seller/(shell)/notifications/page.tsx:36 |
| SA-150 | /seller/automation | 확인하기 (쇼핑몰 주소 확인) | POST /api/automation/check — 조회 성격(서버 상태 변경 없음) | (대상 아님: 조회) | - | app/(seller)/seller/(shell)/automation/page.tsx:36,40 |
| SA-151 | /seller/automation/pay | N원 결제하기 | 체크 5개를 모두 켜고 누르면 바로 POST /api/automation/purchase (카드로 110,000원 실제 결제, 별도 확인 창 없음) | 「110,000원을 결제하시겠습니까?」/「등록된 카드({카드})로 110,000원(부가세 포함)이 바로 결제되고 자동 설정이 시작됩니다. 시작한 뒤에는 마음이 바뀌어도 환불되지 않습니다」/[취소][110,000원 결제하기] | 매우 위험(실제 결제) | app/(seller)/seller/(shell)/automation/pay/page.tsx:45,48,103 |
| SA-152 | /seller/automation/{id} | 이어서 진행하기 | 누르면 바로 POST …/resume | 「이어서 진행하시겠습니까?」/「직접 해 주실 일을 마쳤다면 자동 설정을 다시 시작합니다」/[취소][이어서 진행하기] | 보통 | app/(seller)/seller/(shell)/automation/[jobId]/page.tsx:48,108,110 |
| SA-152 | /seller/automation/{id} | 환불 요청 | 누르면 바로 POST …/refund-request (환불 요청이 접수됨) | 「N원 환불을 요청하시겠습니까?」/「결제한 카드로 환불되며 카드사 기준 3~5영업일 걸립니다. 요청한 뒤에는 되돌릴 수 없습니다」/[취소][환불 요청하기] | 위험(결제) | app/(seller)/seller/(shell)/automation/[jobId]/page.tsx:127 |
| SA-152 | /seller/automation/{id} | 연결 취소하기 → 「취소하기」 | 화면 안 확인 문구(역할 alertdialog)는 있음 → 확인 단계 있음(통과). 단 공통 확인 창(Modal)이 아니라 화면 속 줄이라 공통 확인 창으로 교체 필요 | 현행 문구를 공통 확인 창으로 이전 | 위험 | app/(seller)/seller/(shell)/automation/[jobId]/page.tsx:85,134,143 |
| SA-003·004 | /seller/onboarding | 시작하기 닫기 / 다시 열기 | 누르면 바로 POST /onboarding {action: dismiss | reopen} | 「시작하기 안내를 숨기시겠습니까?」/「홈에서 시작하기 안내가 사라집니다. 이 화면에서 다시 열 수 있습니다」/[취소][숨기기] (다시 열기도 같은 형식) | 보통 | app/(seller)/seller/(shell)/onboarding/page.tsx:50,118,150 |
| SA-006 | /seller/external-shops | 확인하기 (쇼핑몰 추가 연결) | 누르면 바로 POST /external-shops (연결 요청을 만들고 곧바로 다른 사이트의 로그인·승인 화면으로 이동) | 「이 쇼핑몰을 연결하시겠습니까?」/「{입력한 주소}의 쇼핑몰 관리자 로그인 화면으로 이동합니다. 로그인하고 앱 설치를 허용하면 연결됩니다」/[취소][연결 시작하기] | 보통 | app/(seller)/seller/(shell)/external-shops/page.tsx:70,121 |
| SA-006 | /seller/external-shops | 다시 연결 | 누르면 바로 POST /external-shops {connectionId} 뒤 다른 사이트로 이동 | 「{쇼핑몰} 연결을 다시 하시겠습니까?」/「쇼핑몰 관리자 화면으로 이동해 앱 허용을 다시 받습니다」/[취소][다시 연결하기] | 보통 | app/(seller)/seller/(shell)/external-shops/page.tsx:70,147 |
| SA-006 | /seller/external-shops | 다시 시도 (해제 대기 상태) | 누르면 바로 DELETE /external-shops/{id} | 「연결 해제를 다시 요청하시겠습니까?」/「이 쇼핑몰의 주문 알림이 더 들어오지 않습니다」/[취소][해제 다시 요청하기] | 위험 | app/(seller)/seller/(shell)/external-shops/page.tsx:81,148 |
| AU-001·PF-007 | /seller/signup | 신청하기 (가입 신청) | 입력 후 누르면 바로 POST /api/seller-signup/apply (계정과 쇼핑몰이 만들어짐, 약관 동의 체크만 있고 확인 창 없음) | 「입력한 내용으로 가입을 신청하시겠습니까?」/「상호 {상호}, 쇼핑몰 주소 {주소}로 신청합니다. 신청한 뒤에는 쇼핑몰 주소를 바꿀 수 없습니다」/[취소][신청하기] | 위험(계정·쇼핑몰 생성, 주소 변경 불가) | app/(seller)/seller/(shell)/signup/PartnersSignupForm.tsx:133,144,419 |
| AU-003·011·012·PF-007 | 본인확인 공통 | 인증번호 받기 / 인증번호 다시 받기 / 확인 | 누르면 바로 POST …/start·resend·confirm (문자 발송, 하루 횟수 한도, 마스터 관리자 부담 비용 발생). 약관 동의 체크가 있으나 확인 창은 없음 | 「인증번호를 문자로 보내시겠습니까?」/「{휴대폰 뒤 4자리} 번호로 문자 1건을 보냅니다. 하루 보낼 수 있는 횟수가 정해져 있습니다」/[취소][문자 받기] (다시 받기도 같은 문구) | 보통(문자 비용·횟수 한도) | components/seller/IdentityCheck.tsx:150,181,202,320,360 |
| AU-004 | 비밀번호 새로 정하기 | 비밀번호 변경 | 새 비밀번호를 두 번 입력하면 바로 POST /password-reset/complete (다른 기기 로그인이 모두 풀림, 확인 창 없음. 두 번 입력은 확인 역할) | 「비밀번호를 바꾸시겠습니까?」/「바꾸면 다른 기기의 로그인이 모두 풀립니다」/[취소][비밀번호 변경] | 위험(모든 기기 로그아웃) | components/seller/NewPasswordForm.tsx:34,44,155 |
| AU-011 | /seller/find-id | 선택한 계정 비밀번호 변경 | 누르면 바로 POST /find-id/reset (고른 계정의 재설정 권한을 받고 본인확인이 소진됨, 확인 창 없음) | 「{쇼핑몰} · {이메일} 계정의 비밀번호를 바꾸시겠습니까?」/「다음 화면에서 새 비밀번호를 정합니다. 이 본인확인은 한 번만 쓸 수 있습니다」/[취소][비밀번호 바꾸기] | 보통 | app/(seller)/seller/(shell)/find-id/page.tsx:83,87,190 |
| AU-012 | /seller/identity-link | 본인확인 완료 직후 계정 연결 | 본인확인을 마치면 클릭 없이 자동으로 POST /me/identity/link (직원 계정에 휴대폰이 연결됨) | 「이 휴대폰으로 내 계정을 연결하시겠습니까?」/「연결하면 아이디·비밀번호를 직접 찾을 수 있습니다」/[나중에 하기][연결하기] | 보통 | app/(seller)/seller/(shell)/identity-link/page.tsx:64,67 |
| AU-002 | /seller/login | 로그인 | POST /api/seller/auth/login — 본인이 직접 하는 로그인이라 확인 창 불필요(대상 아님) | (대상 아님) | - | app/(seller)/seller/(shell)/login/page.tsx:71 |

### 구매자 쇼핑몰 전담 (2) — `session_01KEhmqBBhjTGfGfHyRzEFcy`

**① 쉬운 말 (32)**

| 화면ID | 경로 | 현재 문구 | 문제 유형 | 고칠 문장 | 파일:줄 |
|---|---|---|---|---|---|
| SH-011 회원가입 | /shop/[slug]/signup | 「보관 항목: 본인확인 식별값(CI)을 바꾼 값」 | 영어·약어 | 보관 항목: 본인 확인 때 받은 정보를 알아볼 수 없는 값으로 바꾼 것 | components/shop/SignupForm.tsx:619 |
| SH-011 | /shop/[slug]/signup | 「본인확인 약관에 모두 동의해요」 (같은 화면에 「필수 약관에 모두 동의해요」도 있어 어떤 약관인지 모름) | 뜻 둘 | 위 내용에 모두 동의하고 본인 확인을 시작해요 | components/shop/SignupForm.tsx:637 (비교 597) |
| SH-011 | /shop/[slug]/signup | 인증번호 입력 옆 버튼 「확인」 | 모호한 버튼 | 인증번호 확인하기 | components/shop/SignupForm.tsx:692 |
| SH-011 | /shop/[slug]/signup | 본인확인 완료 줄의 버튼 「다시 확인」 | 모호한 버튼 | 본인 확인 다시 하기 | components/shop/SignupForm.tsx:483 |
| SH-011 | /shop/[slug]/signup | 「아직 필요해요 · {…}」 | 뜻 둘 | 아직 입력하지 않은 것: {…} | components/shop/SignupForm.tsx:662, 801 |
| SH-004 장바구니 | /shop/[slug]/cart | 「처리하지 못했어요. 잠시 뒤 다시 해 주세요」 (수량 변경·삭제·되돌리기 공통, 무엇이 안 됐는지 모름) | 오류에 해결 방법 없음 | 수량을 바꾸지 못했어요. 잠시 뒤 다시 눌러 주세요 (삭제는 「상품을 빼지 못했어요…」로 동작별 분리) 외 3곳(C/ProductDetail.tsx:93 재입고 알림, C/returns/ReturnSection.tsx:149 교환·반품) | components/shop/CartView.tsx:116 |
| SH-004 | /shop/[slug]/cart | 가격이 바뀐 줄의 버튼 「확인」 | 모호한 버튼 | 바뀐 가격 확인했어요 | components/shop/CartView.tsx:294 |
| SH-004 | /shop/[slug]/cart | 「방송 중 주문은 결제가 끝난 순서대로 열어요 · 품절 상품은 주문에서 자동으로 빠져요」 (「열어요」가 무엇을 여는지 모름) | 뜻 둘 | 방송 중 주문은 결제가 끝난 순서대로 방송에서 상품을 열어 드려요. 품절 상품은 주문에서 자동으로 빠져요 | components/shop/CartView.tsx:371 |
| SH-002 상품 상세 / SH-001 목록 | /shop/[slug]/products, 상품 상세, 찜 | 「SOLD OUT」(화면에 그려지는 영어 라벨. 읽어 주는 이름만 「품절」) | 영어·약어 | 품절 | components/shop/ProductDetail.tsx:185, components/shop/ProductCard.tsx:39 |
| SH-002 | 상품 상세 | 하단 버튼 「장바구니」 (누르면 담긴다는 말이 없음) | 모호한 버튼 | 장바구니에 담기 | components/shop/ProductDetail.tsx:295 |
| SH-002 | 상품 상세 | 버튼 「구매하기」 (실제로는 장바구니에 먼저 담고 주문서로 이동. 장바구니에 남는 줄 모름) | 뜻 둘 | 바로 주문하기 (눌렀을 때 장바구니에도 담기는 점을 확인 창·안내에 한 줄 표기) | components/shop/ProductDetail.tsx:305, 122-130 |
| SH-005 주문서 | /shop/[slug]/checkout | 「최종 결제 금액은 쿠폰·적립금을 뺀 금액이에요. 주문할 때 서버가 한 번 더 계산해요.」 | 어려운 말(서버) | 최종 결제 금액은 쿠폰과 적립금을 뺀 금액이에요. 주문하는 순간 금액을 한 번 더 확인해요 | components/shop/CheckoutView.tsx:442 |
| SH-005 | /shop/[slug]/checkout | 「주문하면 결제 대기 상태로 접수되고, 다음 화면에서 고른 결제 수단으로 결제해요.」 | 어려운 말(결제 대기·수단) | 주문하면 먼저 접수돼요. 아직 결제는 되지 않아요. 다음 화면에서 고른 방법으로 결제해 주세요 | components/shop/CheckoutView.tsx:463 |
| SH-005 | /shop/[slug]/checkout | 「카드 결제는 결제 창에서 카드사 인증을 거쳐요. … 현금영수증 · 세금계산서는 무통장 입금을 고르면 신청할 수 있어요.」 | 어려운 말 | 카드 결제는 결제 창에서 카드 정보를 확인해요. 주문하면 다음 화면에서 고른 방법으로 결제해요. 현금영수증과 세금계산서는 무통장 입금을 고르면 신청할 수 있어요 | components/shop/CheckoutView.tsx:402 |
| SH-005 | /shop/[slug]/checkout | 「만 19세 미만이 법정대리인 동의 없이 주문하면 본인이나 법정대리인이 취소할 수 있어요. 나이는 휴대폰 본인확인 생년월일로 확인해요.」 | 어려운 말 | 만 19세 미만이 보호자 동의 없이 주문하면 본인이나 보호자가 취소할 수 있어요. 나이는 가입할 때 확인한 생년월일로 알아봐요 | components/shop/CheckoutView.tsx:454 |
| SH-005 | /shop/[slug]/checkout | 「(필수) {consent.text}」 아래 「주문 내용 확인에 동의해 주세요」 (무엇에 동의하는지 모름) | 뜻 둘 | 주문 내용을 확인했어요에 체크해 주세요 (체크 항목 이름도 같게) | components/shop/CheckoutView.tsx:446, 451 |
| SH-006 주문 상세 | /shop/[slug]/orders/[orderId] | 「결제하지 못했어요. 다시 시도해 주세요.」 | 오류에 해결 방법 없음 | 결제가 되지 않았어요. 아래에서 결제 방법을 골라 다시 결제해 주세요 | components/shop/OrderView.tsx:36 |
| SH-006 / SH-007 주문 내역 | 주문 상세·내역 | 주문 상태 「결제 대기」「취소됨」「환불됨」 (대기는 업무 말) | 어려운 말 | 결제 전 / 취소했어요 / 환불했어요 | components/shop/OrderView.tsx:40, components/shop/OrdersView.tsx:36, 48-50 |
| SH-006 | 주문 상세 결제 영역 | 「결제 창을 열지 못했어요. {e.errorMsg}」 (결제 대행사가 준 문구가 그대로 붙음. 영어·코드가 섞일 수 있음) | 영어·약어 / 오류에 해결 방법 없음 | 결제 창을 열지 못했어요. 잠시 뒤 다시 눌러 주세요. 계속 안 되면 판매자에게 문의해 주세요 | components/shop/OrderPay.tsx:74 |
| SH-006 | 주문 상세 취소 요청 | 「요청 철회」 버튼, 「요청을 철회했어요」「철회했어요」「신청 철회」 | 어려운 말(철회) | 취소 요청 거두기 / 요청을 거뒀어요 / 신청 거두기 | components/shop/returns/RefundRequestSection.tsx:46, 74, components/shop/returns/ReturnSection.tsx:62, 184 |
| SH-006 | 주문 상세 취소 요청 | 「개봉이 시작되면 취소할 수 없어요」「개봉 전까지만 취소할 수 있어요」 (같은 화면 교환·반품에서는 「개봉한 상품」이 열어 본 상품을 뜻함) | 뜻 둘 | 방송에서 상품을 열기 시작하면 취소할 수 없어요 / 방송에서 상품을 열기 전까지만 취소할 수 있어요 (교환·반품의 「개봉」은 「포장을 뜯은 상품」으로 구분) | components/shop/returns/RefundRequestSection.tsx:86, 155, components/shop/returns/ReturnSection.tsx:306, 341 |
| SH-006 | 주문 상세 교환·반품 | 「상품을 받았어요 · 검수하고 있어요」「검수를 마치고 처리하고 있어요」「처리하고 있어요」 | 어려운 말(검수)·뜻 둘 | 상품을 받았어요 · 상태를 확인하고 있어요 / 확인을 마치고 환불을 준비하고 있어요 | components/shop/returns/ReturnSection.tsx:55-56 |
| SH-006 | 교환·반품 신청 창 | 라디오 「교환 (골라서 같은 상품으로)」 | 뜻 둘 | 교환 (같은 상품으로 다시 받기) | components/shop/returns/ReturnSection.tsx:282 |
| SH-006 | 교환·반품 신청 창 | 버튼 중 진행 표시 「처리 중」 | 모호한 버튼 | 신청하고 있어요 | components/shop/returns/ReturnSection.tsx:272 |
| SH-006 | 교환·반품 | 「사진을 올리지 못했어요」 | 오류에 해결 방법 없음 | 사진을 올리지 못했어요. 다른 사진으로 다시 올려 주세요 | components/shop/returns/ReturnSection.tsx:240 |
| SH-009 리뷰 | 리뷰 쓰기 | 「10자 이상 써 주시면 올릴 수 있어요」 | (말투) 「주시면」 높임이 어색 | 10자 이상 써야 올릴 수 있어요 | components/shop/ReviewWrite.tsx:192 |
| SH-010 문의 | 상품 상세 문의 | 「🔒 비밀글입니다」 (구매자 화면인데 합니다체) | 말투 | 🔒 비밀글이에요 | components/shop/ProductInquiries.tsx:85 |
| SH-012 알림 설정 | /shop/[slug]/me/notifications | 「마케팅 정보 받기」「마케팅 정보 수신에 동의했어요 · 처리일」「마케팅 정보 수신 동의 (선택)」 | 어려운 말(마케팅·수신) | 이벤트·할인 소식 받기 / 이벤트·할인 소식 받기에 동의했어요 · 동의한 날 / 이벤트·할인 소식 받기 (선택) | components/shop/MarketingConsent.tsx:62-64, 136, 185 외 1곳(components/shop/SignupForm.tsx:628) |
| SH-008 쿠폰함 | /shop/[slug]/coupons | 입력창 옆 버튼 「등록」, 목록 버튼 「받기」 | 모호한 버튼 | 쿠폰 코드 등록하기 / 쿠폰 받기 | components/shop/CouponBox.tsx:170, 235 |
| SH-002 | 상품 상세 쿠폰 줄 | 쿠폰 받기 실패 시 메시지가 없으면 「이미 받은 쿠폰이에요」(연결이 끊겨도 이 문구가 나와 사실과 다름) | 뜻 둘(틀린 안내) | 쿠폰을 받지 못했어요. 잠시 뒤 다시 눌러 주세요 | components/shop/CouponRow.tsx:30 |
| 공통 | 여러 화면 | 「다시 시도」 버튼 (구매자 화면에서 어려운 말, 무엇을 다시 하는지 모름) | 어려운 말 / 모호한 버튼 | 다시 불러오기 (페이지 전체를 새로 여는 곳은 「페이지 다시 열기」) | components/shop/CartView.tsx:203 외 12곳(components/shop/OrdersView.tsx:101, components/shop/WishlistView.tsx:65, components/shop/HelpView.tsx:44·147, components/shop/ReviewWrite.tsx:110, components/shop/ReviewMine.tsx:92, components/shop/MarketingConsent.tsx:107, components/shop/CouponBox.tsx:142, components/shop/ProductReviews.tsx:62, components/shop/ProductInquiries.tsx:69, components/shop/SignupForm.tsx:464, components/public/Notices.tsx:33, components/public/RetryButton.tsx:6) |
| 푸터(전 화면) | 쇼핑몰 하단 | 「구매안전서비스 · 에스크로 가입 · {업체}」「호스팅 제공」 | 어려운 말 | 구매 안전 서비스 · 결제한 돈을 안전하게 보관해 주는 서비스에 가입했어요 · {업체} (법정 표기라 괄호 설명만 추가) | components/shop/footNotice.ts:10, 20-22 |

**② 확인 창 (29)**

| 화면ID | 경로 | 행동 | 현재 동작 | 확인 창 문구 안 | 위험도 | 파일:줄 |
|---|---|---|---|---|---|---|
| SH-005 주문서 | /shop/[slug]/checkout | 「주문하기」 | 누르면 바로 POST /orders(주문 생성, 재고·쿠폰·적립금 사용), 이어서 DELETE /cart(주문한 줄 제거) | 「주문할까요?」 / 「N개 상품, 최종 {금액}을 주문해요. 쿠폰·적립금이 이 주문에 쓰여요. 결제는 다음 화면에서 해요.」 / [취소] [주문하기] | 위험 | components/shop/CheckoutView.tsx:460 → 202, 216 |
| SH-006 주문 상세 | /shop/[slug]/orders/[orderId] | 「{금액} 결제하기」 | 누르면 바로 POST 결제 시작(카드 결제 창 열기). 결제 창 자체가 마지막 확인 역할 | 「{금액}을 결제할까요?」 / 「카드 결제 창이 열려요. 결제하면 주문이 접수돼요.」 / [취소] [결제하기] | 위험 | components/shop/OrderPay.tsx:129 → 57 |
| SH-006 | 주문 상세 | 「무통장 입금 안내 받기」 | 누르면 바로 POST /bank-transfer(결제 방법이 무통장으로 정해지고 입금 기한 시작) | 「무통장 입금으로 할까요?」 / 「입금 계좌가 나와요. 기한 안에 입금하지 않으면 주문이 자동으로 취소돼요.」 / [취소] [입금 안내 받기] | 보통 | components/shop/OrderPay.tsx:129 → 50 |
| SH-006 | 주문 상세 | 「요청 철회」(취소 요청) | 누르면 바로 POST …/{id}/cancel | 「취소 요청을 거둘까요?」 / 「주문은 그대로 이어져요. 다시 취소하려면 새로 요청해야 해요.」 / [아니요] [요청 거두기] | 보통 | components/shop/returns/RefundRequestSection.tsx:74 → 45 |
| SH-006 | 주문 상세 | 「신청하기」(교환·반품 신청 창) | 입력 창 안에서 누르면 바로 POST(신청 접수, 환불 계좌 전달). 창 제목은 「교환 · 반품 신청」뿐이고 「~할까요?」 확인 없음 | 「반품을 신청할까요?」(교환이면 「교환을 신청할까요?」) / 「{상품} {N}개를 {방법}으로 신청해요. 판매자가 확인하면 알려 드려요.」 / [취소] [신청하기] | 위험 | components/shop/returns/ReturnSection.tsx:271 → 257 |
| SH-006 | 주문 상세 | 「신청 철회」 | 누르면 바로 POST …/cancel | 「신청을 거둘까요?」 / 「교환·반품 신청이 끝나요. 다시 하려면 새로 신청해야 해요.」 / [아니요] [신청 거두기] | 보통 | components/shop/returns/ReturnSection.tsx:184 → 147 |
| SH-006 | 주문 상세 | 「송장 저장」 | 누르면 바로 POST …/ship-back(보낸 송장을 판매자에게 전달) | 「보낸 송장을 남길까요?」 / 「{택배사} {송장번호}를 판매자에게 알려요.」 / [취소] [남기기] | 보통 | components/shop/returns/ReturnSection.tsx:176 → 147 |
| SH-004 장바구니 | /shop/[slug]/cart | 「삭제」(한 줄) | 누르면 바로 DELETE /cart/{id}. 되돌리기 링크는 있음 | 「이 상품을 뺄까요?」 / 「장바구니에서만 빠져요.」 / [취소] [빼기] | 보통 | components/shop/CartView.tsx:318 → 134 |
| SH-004 | 장바구니 | 「품절 상품 삭제」 | 누르면 바로 DELETE /cart(품절 줄 전체) | 「품절 상품 N개를 뺄까요?」 / 「장바구니에서만 빠져요.」 / [취소] [빼기] | 보통 | components/shop/CartView.tsx:331 → 143 |
| SH-004 | 장바구니 | 수량 「−」「+」, 「{N}개로 줄이기」 | 누를 때마다 바로 PATCH /cart/{id} | (가벼운 쇼핑 행동) 확인 창 대신 「수량을 {N}개로 바꿨어요」 안내와 되돌리기. 필요하면 「수량을 바꿀까요?」 / 「{상품}을 {N}개로 바꿔요.」 / [취소] [바꾸기] | 가벼운 쇼핑 행동 | components/shop/CartView.tsx:304, 308, 283 → 125 |
| SH-004 | 장바구니 | 「되돌리기」 | 누르면 바로 POST /cart(다시 담기) | (가벼운 쇼핑 행동) 「다시 담을까요?」 / 「방금 뺀 상품을 장바구니에 다시 담아요.」 / [취소] [다시 담기] | 가벼운 쇼핑 행동 | components/shop/CartView.tsx:236 → 153 |
| SH-002 상품 상세 | /shop/[slug]/products/[productId] | 「장바구니」 | 누르면 바로 POST /cart | (가벼운 쇼핑 행동) 「장바구니에 담을까요?」 / 「{옵션} × {수량}을 담아요.」 / [취소] [담기] | 가벼운 쇼핑 행동 | components/shop/ProductDetail.tsx:294 → 109 |
| SH-002 | 상품 상세 | 「구매하기」 | 누르면 바로 POST /cart 후 주문서로 이동(장바구니에 줄이 남음) | (가벼운 쇼핑 행동) 「바로 주문할까요?」 / 「이 상품이 장바구니에 담기고 주문서로 가요.」 / [취소] [주문서로 가기] | 가벼운 쇼핑 행동 | components/shop/ProductDetail.tsx:305 → 122-130 |
| SH-002 | 상품 상세 | 「♡/♥」(찜하기·찜 빼기) | 누르면 바로 POST /wishlist 또는 DELETE /wishlist/{id} | (가벼운 쇼핑 행동) 「찜할까요?」/「찜에서 뺄까요?」 / 「찜 목록에 {담아요/서 빠져요}. 상품은 그대로예요.」 / [취소] [찜하기]/[빼기] | 가벼운 쇼핑 행동 | components/shop/ProductDetail.tsx:298 → 137 |
| SH-002 | 상품 상세 | 「재입고 알림 받기」「재입고 알림 취소」 | 누르면 바로 POST/DELETE /restock-alerts | (가벼운 쇼핑 행동) 「재입고 알림을 받을까요?」/「알림을 취소할까요?」 / 「다시 입고되면 알려 드려요. 연락처로 알림이 가요.」(취소는 「더 이상 알려 드리지 않아요.」) / [취소] [알림 받기]/[알림 취소] | 가벼운 쇼핑 행동 | components/shop/ProductDetail.tsx:288 → 89 |
| SH-003 찜 | /shop/[slug]/wishlist | 「찜 빼기」(한 줄) | 누르면 바로 DELETE /wishlist/{id} | 「찜에서 뺄까요?」 / 「찜 목록에서만 빠져요. 상품은 그대로예요.」 / [취소] [빼기] | 가벼운 쇼핑 행동 | components/shop/WishlistView.tsx:90 → 38 |
| SH-003 | 찜 | 「품절 상품 빼기」 | 누르면 바로 DELETE(품절 상품 전부 반복 호출) | 「품절 상품 N개를 뺄까요?」 / 「찜 목록에서만 빠져요.」 / [취소] [빼기] | 가벼운 쇼핑 행동 | components/shop/WishlistView.tsx:97 → 38 |
| SH-008 쿠폰함 | /shop/[slug]/coupons | 「받기」 | 누르면 바로 POST /coupons/{id}/download | (가벼운 쇼핑 행동) 「쿠폰을 받을까요?」 / 「{쿠폰 이름}을 쿠폰함에 받아요.」 / [취소] [받기] | 가벼운 쇼핑 행동 | components/shop/CouponBox.tsx:234 → 112 |
| SH-008 | 쿠폰함 | 「등록」(쿠폰 코드) | 누르면(또는 Enter) 바로 POST /coupons/code | (가벼운 쇼핑 행동) 「이 코드를 등록할까요?」 / 「코드 {코드}로 쿠폰을 받아요. 코드는 한 번만 쓸 수 있어요.」 / [취소] [등록] | 가벼운 쇼핑 행동 | components/shop/CouponBox.tsx:170, 159-162 → 112 |
| SH-002 | 상품 상세 쿠폰 줄 | 「쿠폰 받기」 | 누르면 바로 POST /coupons/{id}/download | (가벼운 쇼핑 행동) 위 「받기」와 같은 확인 창 | 가벼운 쇼핑 행동 | components/shop/CouponRow.tsx:41 → 28 |
| SH-009 리뷰 쓰기 | /shop/[slug]/reviews/write | 「리뷰 올리기」「고친 리뷰 올리기」 | 누르면 바로 POST(작성) 또는 PUT(수정). 쓴 리뷰는 지우면 다시 쓸 수 없음 | 「리뷰를 올릴까요?」(수정은 「고친 리뷰를 올릴까요?」) / 「방송 닉네임으로 공개돼요. 올린 뒤 7일 안에만 고칠 수 있어요.」 / [취소] [올리기] | 보통 | components/shop/ReviewWrite.tsx:189 → 84-85 |
| SH-009 | 리뷰 쓰기 | 「사진 올리기」(+ 교환·반품 신청 창의 「사진 올리기」) | 사진을 고르면 바로 POST …/images(서버에 임시 저장) | (가벼운 쇼핑 행동) 확인 창 불필요 권고: 「사진 {N}장을 올렸어요」 안내 + ×로 빼기. 올리기 전 안내만 한 줄 | 가벼운 쇼핑 행동 | components/shop/ReviewWrite.tsx:151 → 64, components/shop/returns/ReturnSection.tsx:386 → 238 |
| SH-010 문의 | 상품 상세 문의 창 | 「문의 남기기」 | 입력 창에서 누르면 바로 POST /inquiries(비공개 선택 포함). 확인 문구 없음 | 「문의를 남길까요?」 / 「{비공개면 판매자만, 공개면 모두} 볼 수 있어요. 답변이 달리면 고치거나 지울 수 없어요.」 / [취소] [남기기] | 보통 | components/shop/ProductInquiries.tsx:150 → 134 |
| SH-012 알림 설정 | /shop/[slug]/me/notifications | 스위치 「마케팅 정보 받기」 끄기 | 누르면 바로 PUT(수신 철회) | 「이벤트·할인 소식을 그만 받을까요?」 / 「방송 시작·새 상품·할인 소식이 오지 않아요. 언제든 다시 켤 수 있어요.」 / [취소] [그만 받기] | 보통 | components/shop/MarketingConsent.tsx:150-153 → 73 |
| SH-012 | 알림 설정 | 「동의하고 받기」 | 펼친 동의 안내 아래에서 누르면 바로 PUT(수신 동의). 안내 전문이 확인 역할은 함, 「~할까요?」 창은 없음 | 「이벤트·할인 소식을 받을까요?」 / 「{쇼핑몰}에서 이름·휴대폰 번호로 소식을 보내요. 언제든 그만 받을 수 있어요.」 / [취소] [받기] | 보통 | components/shop/MarketingConsent.tsx:189 → 73 |
| 공통 머리글 | 전 화면 | 「로그아웃」 | 누르면 바로 POST /auth/logout 후 홈으로 이동 | 「로그아웃할까요?」 / 「장바구니와 찜은 그대로 남아요. 다시 로그인하면 이어서 쓸 수 있어요.」 / [취소] [로그아웃] | 보통 | components/shop/ShopChrome.tsx:118 → 111 |
| SH-011 회원가입 | /shop/[slug]/signup | 「가입하기」 | 누르면 바로 POST /signup(회원 생성) | 「가입할까요?」 / 「{쇼핑몰}에 {닉네임} 닉네임으로 가입해요.」 / [취소] [가입하기] (약관 동의 칸이 있어 보통 수준) | 보통 | components/shop/SignupForm.tsx:797 → 351 |
| SH-011 | 회원가입 | 「인증번호 받기」「인증번호 다시 받기」「확인」(인증번호) | 누르면 바로 POST /signup/verification, /resend, /confirm(문자 발송·본인 확인) | 「인증번호를 받을까요?」 / 「{010-****-1234}로 문자를 보내요. 하루에 받을 수 있는 횟수가 정해져 있어요.」 / [취소] [받기] (「확인」은 확인 창 불필요) | 가벼운 쇼핑 행동 | components/shop/SignupForm.tsx:658 → 227, 703 → 271, 692 → 296·328 |
| AU(구매자 로그인) | /shop/[slug]/login | 「로그인」 | 누르면 바로 POST /auth/login. 정보를 바꾸지 않는 인증이라 확인 창 불필요 권고 | (확인 창 없음 권고) | 가벼운 쇼핑 행동 | components/shop/LoginForm.tsx:59 → 25 |

### 화면-공개 (2) — `session_01VWVPemvkt3eicZ8fDRLSAR` (보관 상태 — MASTER 재배정 필요)

**① 쉬운 말 (9)**

| 화면ID | 경로 | 현재 문구 | 문제 유형 | 고칠 문장 | 파일:줄 |
|---|---|---|---|---|---|
| PF-001 랜딩 / PF-003 요금 / FAQ | /, /pricing, /faq | 「파트너스 명의 PG로 직접 들어와요. 플랫폼은 판매 수수료를 받지 않아요.」 | 영어·약어(PG)·어려운 말(플랫폼) | 결제 대금은 파트너스 이름으로 만든 결제 대행 계정으로 바로 들어와요. ONQ는 판매 수수료를 받지 않아요 | components/public/FaqList.tsx:11, components/public/Landing.tsx:27 |
| PF-002 기능 / FAQ / 랜딩 | /features, /faq, / | 「지급 · 회수 · 실패가 모두 원장에 남고, 실지급은 스위치를 켤 때만 나가요」「실지급 스위치 · 기본 꺼짐 · 켤 때 두 번 확인」 | 어려운 말(원장·실지급·회수) | 적립금을 주고 거둔 기록이 모두 남아요. 실제 지급은 파트너스가 켜야 시작돼요 (켜기 전에 한 번 더 물어봐요) | components/public/Features.tsx:23-24, components/public/FaqList.tsx:12, components/public/Landing.tsx:20 |
| PF-002 / PF-003 | /features, /pricing | 「운영 중인 외부 쇼핑몰 웹훅 연결」「결제 · 배송 · 송장 · 적립금」「ONQ 스토어」 | 어려운 말(웹훅)·내부 이름 | 운영 중인 다른 쇼핑몰의 주문을 자동으로 가져와요 / ONQ 쇼핑몰 | components/public/Pricing.tsx:10-11 |
| PF-001 / PF-002 | /, /features | 「HIT은 명예의 전당에」「HIT 카드 등록 → 오버레이 연출」「브라우저 소스」「타이머」 | 영어·약어 | 당첨 카드는 명예의 전당에 / 당첨 카드를 등록하면 방송 화면에 크게 나와요 / 방송 프로그램의 「브라우저 소스」 칸 (처음 한 번만 쓰는 말이라 사용법 링크 필요) | components/public/Landing.tsx:13, 11, components/public/Features.tsx:14 |
| PF-001 | / | 「플랜을 골라 시작해요」 | 어려운 말(플랜) | 요금제를 골라 시작해요 | components/public/Landing.tsx:98 |
| PF-003 요금 | /pricing | 질문 「해지하면 데이터는요?」에 「언제든 해지할 수 있고, 남은 기간까지 사용할 수 있어요」 (질문에 답이 아님) | 뜻 둘 | 해지해도 남은 기간까지는 쓸 수 있어요. 해지한 뒤 내 자료가 어떻게 되는지는 정해지는 대로 알려 드려요 | components/public/Pricing.tsx:16 |
| PF-004/PF-005 공통 틀 | 모든 공개 화면 하단 | 「상호 [플랫폼 상호] · 대표 [플랫폼 대표자] · 사업자등록번호 [플랫폼 사업자등록번호] …」 | 코드값(자리표시자 노출) | 정해진 값으로 채우거나, 정해지기 전에는 이 줄을 숨겨요 | components/public/PublicFrame.tsx:61 |
| PF-005 이용약관 | /terms | 「[확정 전]」이 본문 곳곳에 그대로 보임(`{{…}}` → 「[확정 전]」 치환), 「시행 전 초안이에요」 | 코드값(자리표시자 노출) | 확정 전 항목은 「정해지는 대로 알려 드려요」로 표기하거나 확정한 뒤 공개 | components/public/Terms.tsx:6, 38 |
| PF-003 요금 | /pricing | 「{p.name}로 시작하기」 (플랜 이름 받침에 따라 조사 어색) | 뜻 둘(조사) | {p.name} 요금제로 시작하기 | components/public/Pricing.tsx:50 |

### 개발 전담 (기반) (6) — `session_014TjcA8RirjWptikziBwasM` (서버 응답 문구)

**① 쉬운 말 (11)**

| 화면ID | 경로 | 현재 문구 | 문제 유형 | 고칠 문장 | 파일:줄 |
|---|---|---|---|---|---|
| AU-002 | /seller/login | 서버 문구 「지금은 이 계정으로 로그인할 수 없습니다. 쇼핑몰 대표자에게 문의해 주십시오」「오래 쓰지 않아 휴면 상태인 계정입니다. 본인 확인 뒤 다시 쓸 수 있습니다」「지금은 쇼핑몰을 이용할 수 없습니다. 고객센터에 문의해 주십시오」「가입 승인을 기다리고 있습니다」 | 어려운 말(휴면·승인)/오류에 해결 방법 없음(「본인 확인」을 어디서 하는지 없음) | 「오래 쓰지 않아 쉬고 있는 계정입니다. 「아이디/비밀번호 찾기」에서 본인 확인을 하면 다시 쓸 수 있습니다」「가입 신청을 확인하고 있습니다. 확인이 끝나면 알려 드립니다」 | lib/server/auth/messages.ts:9-11,13,22-24,26 |
| SH-011 | 서버 응답(가입) | 「재가입 제한 정보 보관 동의 값을 다시 확인해 주세요」 | 어려운 말(「값」) | 재가입 제한 정보 보관 동의를 다시 선택해 주세요 | lib/server/buyers/signup.ts:370 |
| AU(구매자 로그인) | /shop/[slug]/login | 「고른 탭과 계정 종류가 달라요. 다른 탭에서 로그인해 주세요」 (구매자 로그인에는 탭이 없음) | 뜻 둘 | 이 계정으로는 이 쇼핑몰에 로그인할 수 없어요. 가입한 쇼핑몰 주소에서 다시 로그인해 주세요 | lib/server/auth/messages.ts:88 |
| AU(구매자 로그인) | /shop/[slug]/login | 「오래 쓰지 않아 쉬고 있는 계정이에요. 본인 확인 뒤 다시 쓸 수 있어요」 / 「가입 승인을 기다리고 있어요. 승인되면 알려 드릴게요」 | 오류에 해결 방법 없음 / 뜻 둘(승인 대상이 판매자인지 내 계정인지 모름) | 오래 쓰지 않아 쉬고 있는 계정이에요. 쇼핑몰에 문의하면 다시 쓸 수 있어요 / 쇼핑몰이 아직 문을 열 준비를 하고 있어요. 열리면 로그인해 주세요 | lib/server/auth/messages.ts:84, 87 |
| SH-005 | 서버 응답(주문) | 「안내를 확인하고 동의해 주세요」 | 오류에 해결 방법 없음 | 주문서 아래 안내를 읽고 체크 칸에 동의해 주세요 | lib/server/orders/messages.ts:56 |
| SH-005/SH-004 | 서버 응답(주문·장바구니) | 「재고가 부족해요」 (어느 상품인지, 어떻게 하면 되는지 없음) | 오류에 해결 방법 없음 | 남은 수량이 모자라요. 수량을 줄이거나 장바구니를 확인해 주세요 | lib/server/orders/messages.ts:60, lib/server/shop-cart/service.ts:30 |
| SH-005 | 서버 응답(쿠폰) | 「쿠폰 최소 주문 금액을 채우지 못했어요」 | 어려운 말 | 주문 금액이 쿠폰을 쓸 수 있는 최소 금액보다 적어요. 상품을 더 담거나 다른 쿠폰을 골라 주세요 | lib/server/shop-coupons/service.ts:510 |
| SH-006 | 서버 응답(결제) | 「이미 결제했거나 결제가 진행 중인 주문이에요」 | 뜻 둘 | 이미 결제한 주문이에요. 주문 내역에서 확인해 주세요 | lib/server/payments/messages.ts:11 |
| SH-006 | 서버 응답(결제) | 「요청을 다시 확인해 주세요」 | 오류에 해결 방법 없음 | 입력한 내용이 맞지 않아요. 화면을 새로 열고 다시 해 주세요 | lib/server/payments/messages.ts:13 |
| SH-006 | 서버 응답(반품) | 「교환할 상품을 골라 주세요」 (반품에도 같은 문구가 나옴) | 뜻 둘 | 신청할 상품을 골라 주세요 | lib/server/shop-returns/service.ts:59 |
| SH-006 / 문의 | 서버 응답(반품·문의) | 「사진 크기가 맞지 않아요」「사진 크기를 확인해 주세요」 | 오류에 해결 방법 없음 | 사진 가로·세로가 맞지 않아요. 가로·세로 100~4,000px 사진으로 올려 주세요 (후기 문구와 같게) | lib/server/shop-returns/service.ts:72, lib/server/buyer-inquiries/service.ts:61 |

## 6. 이번에 확인하지 못한 것

- 시험 서버(`test.on-aircue.com`) 화면(비밀번호 미수령). 시드에 없는 상태(오류·빈 화면·데이터 많은 목록)
- 표(table)가 아닌 목록(리뷰·문의·공지·카드 격자)의 제목 열 위치·겹침, 모달 안 표
- 구매자 화면의 표 규칙(구매자 화면은 표가 적어 측정 제외)
- 서버가 내려 주는 오류 `message` 대부분, 구매자 메일·알림톡 문구
- 키보드 동선·접근성은 이번 범위가 아님

