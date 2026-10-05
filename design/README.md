# design/ — 디자인 정본 (Claude Design 캔버스 실제 소스)

PNG·JPG는 정본이 아니라 검수 증거다. 이 폴더의 `project/`가 디자인 캔버스의 **실제 소스**이며, 개발 세션은 이 코드를 직접 읽고 구현한다(2026-10-05 대표님 지시).

## 구성

| 경로 | 내용 |
|---|---|
| `SCREEN_MAP.md` | 화면 ID ↔ 제품 경로 ↔ 디자인 소스 ↔ 상태(FINAL / DRAFT / BLOCKED / MISSING / SUPERSEDED). UI 작업의 출발점 |
| `DESIGN_SOURCE.md` | Artifact 주소·버전·동기화 시각, 정본 우선순위, 예외(폰트·런타임) |
| `CHANGELOG.md` | 동기화 이력(캔버스 버전 ↔ Git 커밋) |
| `project/*.dc.html` | 보드(아트보드) 하나 = 파일 하나. 캔버스 `project/`와 경로·이름이 같다 |
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

## 미리보기

- 정식 미리보기는 캔버스에서 한다: https://claude.ai/artifact/YYGXZ3u4QvjQpEMUHnN4tS (보드 이름으로 찾기). 캔버스 런타임(`support.js`, `artifact-type/`)은 Artifact 유형 소유라 저장소에 복사하지 않았다. 그래서 저장소만으로는 **빌드·실행이 되지 않는다(Build: NOT_APPLICABLE)**. 없는 빌드 시스템을 새로 만들지 않는다.
- 빠른 정적 확인: `design/project/` 안에서 보드 파일을 Chromium으로 열면 `lop.css`·토큰이 상대 경로로 붙어 정적 마크업은 보인다. `{{…}}` 홀 · `<sc-for>` 반복 · 상호작용은 렌더링되지 않는다. 폰트는 시스템 서체로 대체된다.

## 규칙(요약 · 정본은 CLAUDE.md 「디자인 정본」)

1. UI 작업은 ① `design/SCREEN_MAP.md` ② 대상 화면의 FINAL 소스 ③ 공통 컴포넌트 소스 ④ `docs/IA.md` ⑤ production 소스 순으로 확인한다. FINAL 확인 없이 UI 구현을 시작하지 않는다.
2. DRAFT · BLOCKED 화면은 임의로 구현하지 않는다. 디자인 세션이 캔버스에서 고치고 `design/project` 동기화 PR로 FINAL 승격한 뒤 개발한다.
3. 새 화면·큰 UI 변경은 디자인 소스 수정 → 디자인 PR 병합 → 개발 PR 순서. 단순 구현 오류(정본과 다른 간격·문구)는 정본 기준으로 바로 고친다.
4. 디자인 소스는 production 코드에서 import하지 않는다. `design/`은 타입 검사·린트·Next 빌드·Docker 이미지에서 제외한다.
5. 캔버스를 고칠 때마다 `design/project`를 같은 내용으로 동기화하는 PR을 낸다. 커밋 규칙: `design(project): SA-011 …` / `design(system): …`.
6. 검사: `npm run design:check` — SCREEN_MAP의 소스 경로가 모두 존재하고, `docs/IA.md`의 화면 ID가 빠짐없이 등록돼 있는지 확인한다.
