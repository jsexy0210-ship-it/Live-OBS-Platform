관리자 화면 39개에 제목 바로 아래 목적 안내를 추가하고, 42개 표의 테두리가 table grid만 감싸도록 목록을 정리했습니다. 검색·건수·정렬/페이지 이동은 표 바깥에 두며, 실제 폼 카드와 API·권한·대리조회·URL 상태 계약은 유지했습니다. 입력 안내는 짧은 행동 문구로 정리하고 필요한 형식·필수·길이 안내는 helper/aria 설명으로 보존했습니다.

기준은 f6932e80이며 기존 열린 UI PR #1001 #996 #992 #998 #1007 #988 #989 #997 #993의 스택을 보존한 후속 패치입니다. 공통 계약/정본은 feat/common-list-layout-contract의 501499bb까지 머지했습니다. 새로운 공통 부품이나 API 기능은 만들지 않았습니다.

검증:
- Fresh 기본 npm run build 통과: 본인 서버를 종료하고 본인 .next 생성 캐시만 삭제한 뒤 재생성했습니다. stale webpack 생성 타입 오류는 fresh 기본 빌드에서 사라졌으며 API 수정/타입 우회 없이 확인했습니다.
- Build 후 npm run typecheck: 확인 중입니다.
- npm run design:check: IA 누락 0, 깨진 경로 0. git diff --check 통과했습니다.
- 실제 앱 API fixture 브라우저: 파트너스/공지/계정 3개 목록 × 1440·1024·390, 대리조회 확인창 3개 = 12검사 통과. 제목/설명 순서·table-only 경계·목록 건수/표 분리·좌우 배치·페이지 overflow·dialog 잘림을 확인했습니다.
- Focused 공통 후속: 1440·1024·390에서 readonly control fixture computed color #6b707a, 실제 날짜 popup viewport 범위, 390 변환 표 외곽 border 0px을 확인했습니다. 관리자 업무 조회 전용 폼은 실제로 span 값을 사용하므로, 회색 검증은 실제 앱 CSS 내 독립 readonly input fixture임을 구분합니다.
- Production 앱 API fixture: 401 로그인 이동 및 READ_ONLY 관리자 계정 직접 진입 차단 2검사 통과했습니다. 실 API/DB E2E를 실행했다는 뜻은 아닙니다.
- 변경한 앱 파일 43개에서 핵심 API/권한/redirect/URL 상태 호출 167개를 기준 SHA와 비교하여 변경 0을 확인했습니다.

증거는 /tmp/onq-admin-layout-evidence/ 에 inventory.json, pr-overlap.json, results.json, focused.json, access.json, contract-check.json 및 viewport screenshots로 남겼습니다.

후속/제한:
- 개별 MA FINAL 보드의 목적 안내와 목록 구조 동기화는 디자인 담당 후속입니다. 42는 표 위치 수이며 보드 수가 아닙니다. 공통 DS 정본은 현재 연결했습니다.
- 파트너스 상세 8개 탭의 sidebar 이동은 별도 연결 후속으로 남겼습니다. ?tab=info/shop/subscription/pg/broadcasts/orders/notes/activity 및 권한 계약, 메모 건수·결제 오류 표시를 유지하도록 공통 담당과 계약을 전달했습니다.
- 미병합·미배포 상태입니다.

직접 변경한 앱 파일:
- `app/(admin)/admin/(shell)/account/page.tsx`
- `app/(admin)/admin/(shell)/accounts/page.tsx`
- `app/(admin)/admin/(shell)/accounts/roles/page.tsx`
- `app/(admin)/admin/(shell)/billing/invoices/[paymentId]/page.tsx`
- `app/(admin)/admin/(shell)/billing/invoices/page.tsx`
- `app/(admin)/admin/(shell)/billing/plans/page.tsx`
- `app/(admin)/admin/(shell)/billing/refunds/[refundId]/page.tsx`
- `app/(admin)/admin/(shell)/billing/refunds/page.tsx`
- `app/(admin)/admin/(shell)/billing/subscriptions/page.tsx`
- `app/(admin)/admin/(shell)/logs/[logId]/page.tsx`
- `app/(admin)/admin/(shell)/logs/page.tsx`
- `app/(admin)/admin/(shell)/notifications/page.tsx`
- `app/(admin)/admin/(shell)/ops/access/page.tsx`
- `app/(admin)/admin/(shell)/ops/automation/[jobId]/page.tsx`
- `app/(admin)/admin/(shell)/ops/automation/page.tsx`
- `app/(admin)/admin/(shell)/ops/infra/page.tsx`
- `app/(admin)/admin/(shell)/ops/live/page.tsx`
- `app/(admin)/admin/(shell)/ops/monitor/page.tsx`
- `app/(admin)/admin/(shell)/ops/rewards/page.tsx`
- `app/(admin)/admin/(shell)/page.tsx`
- `app/(admin)/admin/(shell)/partners/[sellerId]/page.tsx`
- `app/(admin)/admin/(shell)/partners/applications/[sellerId]/page.tsx`
- `app/(admin)/admin/(shell)/partners/applications/page.tsx`
- `app/(admin)/admin/(shell)/partners/page.tsx`
- `app/(admin)/admin/(shell)/settings/assistant/page.tsx`
- `app/(admin)/admin/(shell)/settings/branding/page.tsx`
- `app/(admin)/admin/(shell)/settings/maintenance/page.tsx`
- `app/(admin)/admin/(shell)/settings/messages/page.tsx`
- `app/(admin)/admin/(shell)/settings/platform-business/page.tsx`
- `app/(admin)/admin/(shell)/settings/policy/page.tsx`
- `app/(admin)/admin/(shell)/settings/vendors/page.tsx`
- `app/(admin)/admin/(shell)/settlement/collection/page.tsx`
- `app/(admin)/admin/(shell)/settlement/pg/page.tsx`
- `app/(admin)/admin/(shell)/support/assistant/page.tsx`
- `app/(admin)/admin/(shell)/support/inquiries/[inquiryId]/page.tsx`
- `app/(admin)/admin/(shell)/support/inquiries/page.tsx`
- `app/(admin)/admin/(shell)/support/notices/[noticeId]/page.tsx`
- `app/(admin)/admin/(shell)/support/notices/new/page.tsx`
- `app/(admin)/admin/(shell)/support/notices/page.tsx`
- `app/(admin)/admin/_components/PartnerDetailTabs.tsx`
- `app/(admin)/admin/_components/PartnerTabs.tsx`
- `app/(admin)/admin/_components/RejectApplicationDialog.tsx`
- `app/(admin)/admin/_components/SupplementDialog.tsx`
