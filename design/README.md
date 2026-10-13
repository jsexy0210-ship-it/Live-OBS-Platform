# design/ — 디자인 정본 (Claude Design 캔버스 실제 소스)

PNG·JPG는 정본이 아니라 검수 증거다. 이 폴더의 `project/`가 디자인 캔버스의 **실제 소스**이며, 개발 세션은 이 코드를 직접 읽고 구현한다(2026-10-05 대표님 지시).

## 구성

| 경로 | 내용 |
|---|---|
| `SCREEN_MAP.md` | 화면 ID ↔ 제품 경로 ↔ 디자인 소스 ↔ 상태(FINAL / DRAFT / BLOCKED / MISSING / SUPERSEDED). UI 작업의 출발점 |
| `DESIGN_SOURCE.md` | Artifact 주소·버전·동기화 시각, 정본 우선순위, 예외(폰트·런타임) |
| `CHANGELOG.md` | 동기화 이력(캔버스 버전 ↔ Git 커밋) |
| `project/*.dc.html` | 캔버스 보드. 전환하지 않은 화면은 정본이며, PF-003 및 전환된 SA 모바일 11개는 기존 링크/이행용 legacy로 보존 |
| `project/*.dc.tsx` | TSX로 전환한 화면의 유일한 정본(PF-003 v331 및 SCREEN_MAP에 등록된 SA 모바일 11개) |
| `preview/` | 기존 Next.js/React로 TSX 정본을 실행하는 개발 전용 미리보기 |
| `project/canvas.json` | 캔버스 인덱스(보드 좌표·페이지·제목·노트) |
| `project/lop.css` · `project/ov.css` | 관리자·쇼핑몰 공통 스타일(`.c24` `.sh24`) · 오버레이 스타일 |
| `project/ds/wds/tokens.json` · `tokens.css` | 디자인 시스템 토큰(WDS) |
| `project/ibgen/*.py.txt` | 보드 생성 스크립트 기록(참고용 · 실행 대상 아님) |
| `project/fonts/WantedSans-OFL.txt` | 서체 라이선스. 서체 파일은 저장소의 `public/fonts/wanted-sans/`를 쓴다(아래) |

## 보드 파일 읽는 법

- 한 파일은 `<x-dc>` 안의 마크업(화면)과 `<helmet><style>`(그 보드만의 보조 CSS), 마지막 `data-props`의 `$preview`(프레임 폭·높이)로 이루어진다.
- 관리자 보드는 `<div class="app c24 …">`로 시작하고 `lop.css`의 `.c24` 규칙을 쓴다. 구매자 보드는 `.sh24`, 휴대폰 틀은 `.sh24.m`. 오버레이는 `ov.css`.
- 본문 아래 `<div class="states">`는 **상태 변형**(빈 상태 · 로딩 · 오류 · 권한 없음 · 모달 등)이다. 구현할 때 본문과 같은 비중으로 본다.
- 문구는 그대로 쓴다: 마스터·파트너스 관리자는 명사형·합니다체, 구매자·공개·오버레이는 해요체(`CLAUDE.md`).
- 같은 ID의 변형(`-PC`, `-IA`, `-OPS`, `-M`, `-E` …) 중 어느 것이 정본인지는 `SCREEN_MAP.md`의 Entry 열을 따른다.

## 정본 ↔ 구현 나란히 비교(검수 증거)

- `node scripts/design-compare.mjs <보드ID> <구현1440.png> [구현390.png] <출력.png>` — HTML 정본은 1440 본판과 390 변형을 대조한다. PF-003은 `npm run design:preview` 실행 후 `node scripts/design-compare.mjs PF-003 <구현1440.png> <구현1024.png> <구현390.png> <출력.png>`로 TSX 미리보기의 세 화면 폭을 구현 캡처와 붙인다(왼쪽 정본 · 오른쪽 구현). 1024·390은 정본 아트보드가 아니라 구현 확인 폭이다.

## 미리보기

- TSX 정본은 `npm run design:preview`로 기존 Next.js 개발 서버에서 연다(`http://localhost:3001`). 이는 별도 `design/preview` 앱이며 production 앱·`/pricing`에서 import하지 않는다.
- PF-003의 기존 `.dc.html`과 `canvas.json` 엔트리는 캔버스·기존 href 호환을 위해 보존한 legacy 참조다. `SCREEN_MAP`의 Source/Entry와 `design:check`가 지정하는 유일한 정본은 `.dc.tsx`다.
- 전환되지 않은 `*.dc.html`은 캔버스 Artifact runtime(`support.js`, `artifact-type/`)을 그대로 쓴다. 일반 보드는 정적 확인 시 홀 · 반복 · 상호작용이 렌더되지 않을 수 있다.

## 규칙(요약 · 정본은 CLAUDE.md 「디자인 정본」)

1. UI 작업은 ① `design/SCREEN_MAP.md` ② 대상 화면의 FINAL 소스 ③ 공통 컴포넌트 소스 ④ `docs/IA.md` ⑤ production 소스 순으로 확인한다. FINAL 확인 없이 UI 구현을 시작하지 않는다.
2. DRAFT · BLOCKED 화면은 임의로 구현하지 않는다. 디자인 세션이 캔버스에서 고치고 `design/project` 동기화 PR로 FINAL 승격한 뒤 개발한다.
3. 새 화면·큰 UI 변경은 디자인 소스 수정 → 디자인 PR 병합 → 개발 PR 순서. 단순 구현 오류(정본과 다른 간격·문구)는 정본 기준으로 바로 고친다.
4. 디자인 소스는 production 앱 코드에서 import하지 않는다. `design/preview`만 개발 서버로 실행하고, 변환된 TSX는 root production build에서 route로 등록하지 않는다.
5. 캔버스를 고칠 때마다 `design/project`를 같은 내용으로 동기화하는 PR을 낸다. 커밋 규칙: `design(project): SA-011 …` / `design(system): …`.
6. 검사: `npm run design:check` — SCREEN_MAP의 소스 경로가 모두 존재하고, `docs/IA.md`의 화면 ID가 빠짐없이 등록돼 있는지 확인한다.

## SA 모바일 React 전환

`SCREEN_MAP.md`의 React 모바일 정본 표가 11개 모바일 변형의 유일한 TSX Source/Entry를 지정한다. preview는 `/mobile/SA-021-M`처럼 연다. 각 보드의 390px 두 상태를 보존하며 1440·1024 제품 레이아웃은 이 전환에서 정의하지 않는다. HTML·기존 생성기·canvas 인덱스는 이행/읽기 참조로 보존한다. 원 Artifact는 기존 버전이며 새 CSS 및 React 동기화는 미완료다.
