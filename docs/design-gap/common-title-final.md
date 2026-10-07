# 관리자 공통 제목 띠 대조 (2026-10-07 KST)

- 기준 main: `c516b095bc7e1dd85f3e9bbfb8d488810019c899`. 디자인 동기화 정본: v337까지 기록된 `design/DESIGN_SOURCE.md`.
- SA-011 `/seller/products`: FINAL `design/project/SA-011.dc.html` v336. MA-013 `/admin/partners/applications`: FINAL `design/project/MA-013-OPS.dc.html` v287.
- 공통 정본 `design/project/lop.css` `.ph2`: 최소 높이 48, 아래 경계선 1, 좌우 24, 행동 버튼 높이 48·최소 폭 120, 설명 아래 12. 실제 소스 브라우저 계산도 확인했다.
- production `styles/seller.css`의 `.seller-app .main > .au-ph`에 같은 규격을 적용했다. 768~1023는 기존 본문 여백 16을 사용한다. 기존 PageHead·토큰을 재사용했다.
- 마스터 layout도 `seller-app`을 사용하므로 적용된다. 쇼핑몰은 PageHead를 사용하지 않고 별도 ShopFrame 머리를 사용하여 이 선택자 적용 범위 밖이다. 모바일 390 규칙은 수정하지 않았다.

## 실제 렌더 증거

`tests/e2e/screenshots/common-title-final/`:

- `source-SA-011-1440.png`, `source-MA-013-1440.png`: FINAL 원본 HTML·CSS의 제목 영역 브라우저 렌더. 원본 링크 CSS를 로컬 원본 CSS로 주입한 캡처이다.
- `seller-1440.png`, `admin-1440.png`: 격리 PostgreSQL과 production build를 사용한 실제 로그인 화면. 제목 띠가 본문 전체 폭을 덮고 버튼·경계선 규격을 만족한다.
- `seller-1024.png`, `admin-1024.png`: 전용 artboard가 없는 폭의 배치·가로 넘침 안전성. 정본 1:1 PASS로 표시하지 않는다.
- `seller-390.png`, `admin-390.png`: 실제 로그인 모바일 화면의 가로 넘침 안전성. 이번 변경의 모바일 정본 일치 증거로 확대하지 않는다.

검증: `common-title-final.spec.ts` 3건, 기존 `admin-shell.spec.ts` 6건, 기존 판매가 충돌 E2E 2건, typecheck·build 통과. 로컬 기존 시험 DB를 재사용했으며 DB migration은 실행하지 않았다.

가격 시험의 최초 `http://127.0.0.1:3157` 실행은 APIRequestContext GET·정리 요청이 401이었다. production 쿠키는 secure이며 Playwright `network.js`의 로컬 HTTP secure 쿠키 예외는 localhost 및 `.localhost`만 허용한다. 서버·인증·가격 코드를 바꾸지 않고 기존 로그인 fixture의 baseURL을 `http://localhost:3157`로 맞춰 2건 통과했다. 임시 시험 계정·세션과 실패한 가격 시험 상품을 정리했다. 쿠키·비밀번호는 증거에 저장하지 않았다.

## 남은 범위

- 공통 본문 섹션 gap(정본 `.cont` 16과 현재 `.main` 24) 및 개별 화면 CTA·본문 차이는 이번 제목 띠 수정 밖이다. MA-013 정본의 「심사 기준 보기」 행동과 현재 화면 차이도 별도 담당 판단이 필요하다.
- 쇼핑몰 상단 제목·구매자 머리 구조의 남은 차이는 별도 정본·route 대조가 필요하다.
- 이 증거는 명시한 실제 렌더 화면과 공통 규격 확인이다. 관리자 전체 화면·쇼핑몰 전체 정본 PASS, 독립 검수, main 병합, CI, TEST 배포를 대신하지 않는다.
