# SA-056 / 공용 날짜·시간 읽기 전용 독립 검수

검수: 2026-10-06 20:41 KST. 대표님, SA-056 로컬 커밋은 **두 2열 행 복원이라는 한정 수정으로 push 검토 가능**합니다. 화면 정합 완료/모바일 합격/실제 API E2E 완료 판정은 불가합니다. 저장소 파일 수정·추가 push·PR 생성은 하지 않았습니다.

## 불변 기준과 소유

- main: `4a06ba9016dae9784774329c1e253ecc92b0c9d3`.
- branch/worktree: `feat/sa056-hierarchy`, `/workspace/Live-OBS-Platform-sa056`; HEAD `df8a2c117c5b065e22009f2a9e837164b329cfdb`, 작업 트리 clean.
- 변경: `app/(seller)/seller/(shell)/stats/page.tsx` 1파일. 공백 제외 diff는 div wrapper 4줄 추가뿐입니다. 계산/API/문구/CSV/권한/상태 로직 변경은 없습니다.
- 실제 정본: `design/SCREEN_MAP.md:183`, SA-056 `/seller/stats`, `design/project/SA-056.dc.html`, FINAL v336 `1791268289-8313`.
- public OPEN24 `/tmp/onq-open-prs.json`과 `origin/pr/<번호>`를 SHA 일치 확인 후 main...ref 변경 경로 대조: SA-056 page, stats/**, SA-056 source, DatePicker.tsx, lop.css 직접 overlap 0건. API를 우회하지 않았습니다.
- **소유 확인 필요**: UI_STATUS:219은 미배정/통계 전담(2) 보관, 최신 표:351은 파트너스 운영(5)로 기록했습니다. HANDOFF:50의 현재 파트너스 운영(5) 큐에는 SA-056이 없습니다. MASTER께서 현재 소유자에게 한정 커밋 배정을 알려 주신 뒤 publish를 판단하시면 됩니다.
- 날짜 전담 worktree는 DatePicker.tsx/lop.css 미커밋 변경이 있어 검수 제외했습니다. event-design worktree의 커밋 사본 SHA256이 `git show origin/main:...`와 동일함을 확인했습니다. 이 보고는 owner의 진행 중 수정에 대한 판정이 아닙니다.

## SA-056 코드와 FINAL 소스의 정합

독립 재렌더: 실제 Next production build + 시스템 Chromium + 명시적 API fixture. FINAL HTML/CSS/JS도 직접 브라우저로 열었습니다. 스크린샷은 증거이며 정본은 HTML/CSS/JS입니다.

- 1440: KPI6칸, `[일별 매출 | 방송 내역]`, `[상품 상위5 | 회원·적립금·쿠폰]` 각각2열(586px×2) 복원. FINAL은590px×2입니다. 1024/390은 기존 CSS의1열, KPI는4/2열입니다. document width는 세 폭에서 viewport와 같습니다.
- **390 내부 경계 실패**: 방문자 badge 오른쪽380.81px, 타일 오른쪽374px →6.81px 침범. 차트 날짜 width60.5px, 간격44.28px →인접 라벨16.22px 겹침; 마지막 라벨 오른쪽382.09px, 본문 경계374px →8.09px 침범. documentWidth만으로 합격 처리하면 안 됩니다. 기존 stats 컴포넌트 결함이며 한정 wrapper commit은 이를 해결하지 않았습니다.
- 기간 UI desktop 입력150px/DatePicker wrapper128px →wrapper 경계22px 초과. `components/seller/stats/stats.css` 기간 input 폭과 `lop.css:367` wrapper 폭 계약이 다릅니다. 별도 period-bounds 증거를 남겼습니다.
- 남은 FINAL 차이: 비교 날짜는 체크 옆 대신 아래 안내에 있으나 형식이8/6~9/5로 축약됨; 정본에 없는 일/주/월 토글과 설명 줄; KPI는 하나의 외곽 요약 패널이 아닌 각각 테두리; 차트는 정본의 boxed chart/상단 수치/원 단위 설명과 다름; 방송 표 비율 독립 열이 없고 매출 안 괄호로 병합; 정본의 상품/회원 통계 버튼은 표 아래인데 구현은 섹션 머리; 회원 표의 행·집계 정보가 다름; 셸 검색/경로/폰트·라운드/간격 차이가 남습니다. 데이터 자체가 다른 fixture 숫자는 디자인 불일치 근거로 쓰지 않았습니다.
- SA-056-M은 실제 **회원 통계** source입니다. UI_STATUS:535의 휴대폰 보드 목록에 이를 포함한 것은 명명 혼동이며, SA-056 요약의 확정 모바일 source라고 간주하면 안 됩니다. 1024/390은 반응형 품질 검수이며 승인 모바일 source와1:1 확인은 아닙니다.
- 권한/빈 상태/집계중/실패/최대 기간/비교 끔은 소스·코드에 존재하나 이번 브라우저 fixture는 populated overview만 렌더했습니다. 실제 permission/menu suppression, 새로고침/뒤로 상태 보존, CSV/API 통합은 미검증입니다.

### 증거

`/tmp/sa056-independent-evidence/`:
- `FINAL-v336-1440.png` — 확정 실제 소스 렌더.
- `overview-fixture-1440.png`, `overview-fixture-1024.png`, `overview-fixture-390.png` — 독립 app fixture 렌더.
- `metrics.json`, `defects-390.json`, `period-bounds.json` — 열 수·타일/날짜 라벨·기간 입력 경계.
- 재현 스크립트 `/tmp/sa056-independent-render.cjs`, `/tmp/sa056-period-probe.cjs`.

### 검증의 경계

- 독립 `npm run design:check`, `git diff --check` 통과. `npm run typecheck -- --incremental false`도 통과했습니다. 설계 map 검사는 HTML 대조/동작 검증의 대체가 아닙니다.
- 소유자의 build/typecheck 성공 기록은 `/tmp/sa056-pr-body.md`; 이번 검수는 build를 재생성하지 않고 기존 build로 독립 렌더했습니다.
- 앱 E2E 실패는 `/tmp/sa056-e2e.log`: Playwright bundled headless browser 없음으로 test launch 실패. 소유자 보고의 Prisma no-engine P6001/engine download403로 seed/API도 막힘. 시스템 Chromium fixture 성공은 실제 DB/API E2E 성공이 아닙니다.

## 공용 DatePicker / DateTimePicker: 레이아웃 owner 전달용 patch 요청 근거

정본 DS-DATEPICKER FINAL v276 `1791214099-aa42`, `design/project/DS-DATEPICKER.dc.html`. 커밋된 파일 `components/admin-ui/DatePicker.tsx`, `styles/lop.css`만 임시 React harness에 읽어 번들링했습니다. 파일 수정은 `/tmp`에만 했습니다.

지원: 단일 날짜/기간/직접 입력/달력 아이콘·전체 클릭/기간 빠른 선택/오늘·선택·기간 강조/min·max 날짜 버튼/Escape·바깥 클릭/화살표·PageUpDown/390 바닥 시트. DateTimePicker는 날짜+`HH:mm` 텍스트 입력입니다. 독립 TimePicker 선택 UI는 없으며 해당 FINAL source도 map에 없습니다. 새 시간 UI를 임의 설계할 근거는 없습니다.

1. **팝오버 외부 컨테이너 경계** (`DatePicker.tsx:96~130`, `lop.css:374~376`): 포털 없이 부모 내부 fixed child. transform+overflow:hidden 부모로 재현하면 popup center hit=false, 화면에서 달력이 완전히 잘립니다. 외부 컨테이너 경계를 침범/clip하지 않는 상위 layer(portal 또는 기존 overlay host), anchor 측정 좌표 계약을 owner께 요청합니다.
2. **스크롤·resize 정렬** (`:99~107`): 최초 anchor만 측정. scroll350px 뒤 anchor y=-263.97/popup y134.03으로 원래 위치에 남습니다. scroll/resize/visualViewport 변화 시 재배치 또는 닫기, actual popover 높이 기반 flip/clamp를 요청합니다. hardcoded372/380은 실제 높이379와 다릅니다.
3. **모바일 축소 높이** (`lop.css:395~400`):390×844는 시트442px로 정상,390×320에서는 top=-122px로 월 머리/요일이 사라집니다. max-height+내부 scroll/접근 가능한 머리·footer 및 visualViewport 처리 필요. 축소 viewport 재현이며 실기기 키보드 검증은 아직 하지 않았습니다. FINAL mobile source의 제목/닫기/동일폭 하단 CTA도 현재 컴포넌트에 없습니다.
4. **datetime bounds** (`DatePicker.tsx:335~358`): min=`2026-10-06T10:00`/max=`2026-10-07T18:00`을 DatePicker에 그대로 전달하여 같은 날10/6이 disabled. 반대로09:00 입력이 `2026-10-06T09:00`으로 emit됩니다. date부분과 time부분 bounds 분리 및 최종 datetime 범위 검증/오류 피드백이 필요합니다. 현재 min/max 지원 완료라고 보고하면 안 됩니다.
5. **기간 규칙** (`:19`, `:254~257`, `:319`): 안내는 시작보다 앞을 고를 수 없다고 하지만10/15→10/10을 클릭하면10/10~10/15로 자동 swap합니다. DS-DATEPICKER source 역시 앞 날짜 선택 불가를 안내합니다. 종료 선택 중 min=start로 비활성하고 typed range 정책을 일치시키거나, 정책 변경이면 MASTER 디자인 판단이 필요합니다.
6. **키보드** (`:23`,`:50~58`,`:195~205`):↓두 번으로 날짜focus/Escape 복귀는 실측 성공. Enter는 달력을 열지 않고 현재 값을 확정해 주석의↓·Enter 열기 설명과 다릅니다. selected/today/firstday가 disabled일 때 roving tabstop도 disabled인 코드이므로 허용 가능한 날짜로 focus 선택이 필요합니다(이 마지막 조건은 source 검토, 별도 브라우저 재현 미실시). 모바일 시트 focus/배경 Tab 접근 제한은 이 검수에서 완료하지 않았습니다.
7. **직접 입력·시간 정보 보존**: 날짜 직접 입력 min/max 밖도 emit하도록 명시되어 있으며 화면별 validator가 필요합니다. 시간 오류는 blur 때 원값으로 돌아가고 aria-invalid 설명이 없습니다. 날짜 없이 먼저 쓴 시간은 emit되지 않아 blur에 사라질 수 있습니다. 소유자께 정상/오류/빈 날짜 시간 입력 순서의 피드백과 보존 검증을 요청합니다.

증거: `/tmp/onq-date-audit/evidence/metrics.json`, `desktop-1440.png`, `desktop-scroll.png`, `desktop-ancestor-clip.png`, `mobile390x844.png`, `mobile390x320.png`. 재현 `/tmp/onq-date-audit/probe.cjs`; 실제 source에서 transpile한 임시 bundle이며 별도 mock 컴포넌트가 아닙니다.

## 남은 실제 동기화 선행조건

SA-056은 소유 기록 정리 → 기존 모바일 경계/날짜 입력/정본 표·CTA·정보 위계 차이 소유자 배정 → 실제 API E2E → FINAL actual source와 재대조 → UI_STATUS 갱신/검수 순서가 필요합니다. 날짜 공용 변경은 owner의 현재 미커밋 작업이 커밋된 뒤 이 재현 조건으로 다시 확인합니다. 이벤트 DRAFT remote source와 이 기존 화면 검수를 전체 UI 현대화 완료로 합산하지 않습니다. shared map·FINAL·canvas는 변경하지 않았고 외부 canvas sync도 주장하지 않습니다.
