관리 화면의 제목 아래 목적 안내와 목록 경계가 화면마다 달랐습니다. 대표님 최신 결정에 맞춰 공통 PageHead 설명행, 왼쪽 건수·오른쪽 작업, 표 그리드만 감싸는 ListTable를 추가하고 DS-PANEL·DS-ROW-ACTION·SA-021-OPS·SA-026 실제 소스와 관련 정책을 함께 반영했습니다.

- base main `4a06ba9016dae9784774329c1e253ecc92b0c9d3`; 디자인 source 첫 커밋 `3e55c5db`, 구현 첫 커밋 `824bc0d7`. 디자인 후 구현 순서를 보존했습니다. 최신 source delta `501499bb`, 공통 구현 `700fe0b3`.
- source: main 디자인 aggregate v337, DS-PANEL/DS-ROW-ACTION 공통 원본, SA-021 `/seller/orders` FINAL v287 `1791217739-ca0d` 실제 원본 `SA-021-OPS.dc.html`, SA-026 `/seller/orders/deposits` FINAL v336 `1791268289-8313`. 이번 Git 변경은 대표님 승인 정책 delta이며 새로운 캔버스 버전을 만들지 않았습니다.
- `PageHead.description?: ReactNode`, `au-ph-description`: title ReactNode/h1 보존, 설명을 aria-describedby로 연결, 모바일 뒤로 바 아래 설명→주요 작업 순서.
- 기존 `ListHead.total/unit/loaded/actions` 유지, 불러온/전체 건수 의미와 aria-live 보존. `ListTable`은 children/className/aria-label을 받는 table-only wrapper, `au-list-section`은 테두리 없는 외부 영역입니다. SearchBox·ListHead·pagination·안내를 wrapper 밖에 둡니다. 모바일 카드 변환 표는 행 카드 경계만 남기고 wrapper 이중선을 제거합니다.
- 읽기 전용 값은 label-alt 회색, placeholder는 기존 assistive 토큰. SA-021 검색 안내는 `검색어 입력`, SA-026 입금 기한 td는 모바일 wide 정보 보존. 버튼·타이포·간격 토큰을 재사용했습니다.
- 소유 범위12파일만 변경했습니다. DatePicker/TimePicker/셸/shellNav 진행 중 소유 파일과 shared SCREEN_MAP/DESIGN_SOURCE/CHANGELOG/canvas는 수정하지 않았습니다.

검증:
- `npm run typecheck -- --incremental false`, `npm run build`(343페이지), `npm run design:check`, `git diff --check` 통과. 빌드 출력에 최신 모바일/readonly selector 포함을 확인했습니다.
- 실제 common TSX+CSS+useTableCards를 번들링하여 1440/1024/390에서 title/description 접근성, 건수/작업 정렬·줄바꿈, grid-only frame, 표 밖 작업 팝업 clipping, 번호 이동, 스크롤, mobile-back 순서를 확인했습니다. readonly 토큰과 입력 방지도 확인했습니다. 분리된 부품 harness에서는 Next routing hook만 stub했습니다. 실제 API/앱 E2E 완료로 세지 않습니다.
- 실제 디자인 HTML/CSS/JS 원본4개 렌더를 대조했고 DS-PANEL은1440/1024/390에서 overflow 없이 확인했습니다. SA-021-OPS·SA-026·DS-ROW-ACTION 고정 artboard는 native1440 원본 렌더입니다. 기존 개별 모바일 board 전체를 검수 완료했다고 주장하지 않습니다.
- 로컬 검수 경로 `/tmp/onq-list-layout-evidence/` (component/source PNG와 component-metrics/source-mobile-metrics/mobile-card-readonly-metrics), `/tmp/onq-list-layout-build-final.log`. 스크린샷은 증거이며 HTML/CSS/JS가 실제 소스입니다.
- 공개 OPEN24 실제 fetched refs 대조: style auth/logout 다른 hunk는 보존 merge 가능합니다. merge-tree #989/#997 무충돌, #1002 lop source에 승인 auth와 목록 delta 둘 다 보존됨. #1002의 기존 UI_STATUS 충돌은 이 PR에서 수정하지 않았습니다.

남은 동기화·판단:
- 관리자39/seller72 개별 FINAL source의 설명문과 목록 grid 구조는 아직 전체 반영하지 않았습니다. 앱 페이지 작업은 각각 전담 브랜치이며 공통 CSS가 설명문을 자동 생성하지 않습니다. 별도 source 파일별 동기화·검수가 필요합니다.
- 외부 캔버스 도구 미연결이므로 외부 canvas sync 완료로 부르지 않습니다. 메타데이터와 canvas 버전도 미갱신입니다. 이 브랜치는 미병합 승인 규칙 delta입니다.
- 날짜/시간 실제 선택기 및 페이지 내비게이션의 sidebar 전환은 별도 전담 후속 작업입니다. 현재 정책만 최신 결정으로 기록했습니다.
- api.github.com은 기존 네트워크403으로 PR/CI 접근이 막혀 있습니다. 인증/네트워크 우회와 main 직접 push/merge는 하지 않습니다.
