## 변경
전체 주문(SA-021)과 입금 확인(SA-026)의 목록 UX를 대표님 최신 확정 규칙으로 통일했습니다. 검색·필터, 왼쪽 건수와 오른쪽 작업 버튼(ListHead), 표 전용 외곽(ListTable), 더 불러오기를 분리했습니다. PageHead 제목 아래에 목적·핵심 안내를 연결했습니다.

주문 API는 총건수를 제공하지 않으므로 항상 「불러온 N건」으로 표시합니다. 「N건 넘게」 추측 문구를 제거했습니다. 검색 placeholder는 「검색어 입력」이고 닉네임·주문번호 지원 안내는 입력 title에 보존했습니다. 필터 창의 좌우 버튼은 같은 폭·높이 토큰을 적용하고 모바일 터치·wrap·창 잘림을 확인했습니다. 입금 기한은 모바일 카드에서 전체 폭으로 표시해 마지막 시각이 잘리지 않게 했습니다.

## 선행 변경 보존·정본
- 최신 main `4a06ba90`에서 독립 worktree/branch를 만들고 실제 `origin/pr/990` 전체 변경을 merge `9ef74fc6`으로 보존했습니다. 상태 칩·stage·refund/shipped/query/cursor/관리 링크와 기존 시험을 제거하거나 별도 재구현하지 않았습니다.
- FINAL 정본: `design/project/SA-021-OPS.dc.html`(기존 v287), `design/project/SA-026.dc.html`(기존 v336), DS-PANEL·DS-ROW-ACTION·SA-LNB, docs/IA.md를 직접 확인했습니다.
- 대표님 승인 delta의 Git 디자인 source `3e55c5db`, 구현 `824bc0d7`, 짧은 입력 안내 `c7892c44`, 모바일 입금 기한 source `98cc46f9`, 건수 live 안내 `6507ecbb`, 날짜 td 매핑 `97fdaa7e`, 모바일 이중 테두리 제거 `700fe0b3`를 순서대로 merge했습니다. 디자인·공통 부품 소유 파일은 본인이 직접 고치지 않았습니다.
- 본인 구현 커밋 `35fb6daa`는 지정 4파일만 변경했습니다.

## 검증
- `npm run build`: 최신 dependency까지 통과(343 static pages).
- `npm run typecheck`: 최신 dependency까지 통과.
- `npm run design:check`: 통과. IA 누락 0, 깨진 경로 0.
- `git diff --check`: 통과. latest main 정상 fetch/merge: Already up to date.
- 신규 `unified-order-list-ux.spec.ts`: 최신 dependency `700fe0b3`까지 포함한 production fixture 8/8 통과(31.3초).
- 1440·1024·390 두 화면 실제 Chromium 렌더에서 건수/작업/필터가 표 프레임 밖인지, 가로 페이지 넘침이 없는지 확인했습니다. 상태/shipped 필터·검색과 URL 복원·cursor/offset·상태별 관리 링크·입금 선택/확인 창/취소/expectedVersion 요청 계약·모바일 날짜 잘림·로딩·0건·오류 재시도·403·입금 402를 검증했습니다.
- 초기 새 section 접근성 이름이 기존 주문 검색 selector와 부분 일치해 충돌한 문제는 section을 「주문 조건」으로 바꿔 기존 #990 시험 계약을 유지했습니다.

## 렌더 증거
최종 증거 폴더: `/tmp/onq-order-list-evidence-final` (각 시험 outputPath에 SA-021/SA-026 1440·1024·390, SA-021 필터 창, 두 화면 로딩/0건/오류/권한/잠금 스크린샷 및 attachments).

## 한계·미완료
- 이번 브라우저 검증은 로컬 production 앱에 API 응답 fixture를 주입한 UX/요청 계약 검증입니다. 실제 DB·로그인·입금 확인·결제·환불 API E2E를 통과했다는 뜻이 아닙니다. 기존 `seller-orders.spec.ts`/`seller-deposits.spec.ts` 실API 시험은 실행하지 않았습니다. 실제 결제·환불·보상·배포도 실행하지 않았습니다.
- 기존 정본 전체와의 잔여 차이(#990 부분 일치: 서버 미지원 칩 집계·개봉 상태·목록 즉시 처리 등), SA026 서버 미지원 검색/기한 연장/내려받기를 이번 UI 규칙 변경에서 추측 추가하지 않았습니다.
- 공통 디자인 소유자가 기록한 외부 캔버스 미동기화 한계는 남아 있습니다. 최신 승인 규칙은 Git source delta로 반영했으며 캔버스까지 동기화 완료라고 보고하지 않습니다.
- GitHub API 네트워크 차단으로 PR 등록은 가능한 정상 경로까지 수행하고 등록 상태를 별도 보고합니다. 검수 전담의 독립 검수·병합을 요청하며 구현자가 main을 병합하지 않습니다.
