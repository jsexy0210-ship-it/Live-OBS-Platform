IA 개편 보드 생성 스크립트 (디자인 전담 (3), 2026-10-05) — 다음 세션 인계용
- 받아서 쓰는 법: 이 폴더의 *.py.txt를 .py로 이름을 바꿔 한 폴더에 둔다. ib.py 맨 위 P(보드 폴더 경로)를 자기 컨테이너의 project/ 폴더로 고친다.
- ib.py: 공통 틀(헤드·파트너스 GNB 8개·전역 검색·페이지 틀·상태 블록 stwrap·canvas.json에 보드 추가 addboard). 기존 보드가 있으면 그 위치를 유지한다.
- home.py(SA-002-IA 파트너스 홈) · pdp.py(SH-003-PC-IA 상품 상세, 기존 SH-003-PC 파일을 문자열 치환해 파생) · shop_home.py(SH-001-PC-IA) · cart.py(SH-004-PC-IA 장바구니 + SH-005-PC-IA 주문서 블록 순서 바꾸기) · mhome.py(MA-001-IA 마스터 홈, MA-023의 마스터 GNB를 재사용).
- 필요 조건: 원본 보드 파일(project/SH-003-PC.dc.html 등)과 lop.css·ds/wds/tokens.css가 같은 폴더에 있어야 한다.
- 눈 확인: python3 -m http.server 8000 (project 폴더에서) 후 shot_board.mjs.txt(Playwright, 보드 ID와 폭을 인자로) 로 전체 페이지 캡처.
- 새 보드는 생성 후 canvas.json과 함께 Artifact publish(files)로 올린다. 기존 보드는 지우지 않는다(Old-*, 루트 79개 파일 포함, 대표님 지시).
