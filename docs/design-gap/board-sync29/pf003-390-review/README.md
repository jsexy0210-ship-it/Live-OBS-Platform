# PF-003 390 정본 후보 검증 (2026-10-17 KST)

원본 PF003 커밋: 2745434233fda20cd9ffb394d579f59970eeefdd. 통합 기준: 선행 디자인 후보 5f77625893183b3a6d9e414c5fab4c95516131ab. 해당 PF003 단일 커밋만 정상 통합하고 CHANGELOG는 선행 최신 행을 보존했습니다. SA-152·제품 소스는 수정하지 않았습니다.

정본 TSX를 React 19.3.0 ReactDOMServer와 esbuild로 렌더한 후 실제 Chromium에서 저장한 디자인 증거입니다. 실제 Next Image 컴포넌트, 원본 브랜드 이미지, tokens.css·lop.css·public-brand.css·Wanted Sans를 사용했습니다. Next preview 서버·hydration·운영 /pricing·API·DB·배포 동작 검증은 하지 않았습니다. 재현에 사용한 로컬 build.cjs/render.cjs는 전용 체크아웃의 .local-pf003에 보존했습니다.

- 정상/실패 각 390px: clientWidth=scrollWidth=390, 화면 밖 요소 0. 전체 보드 884×3273px, 두 상태의 끝과 바닥글까지 캡처했습니다. 폰트 로드 확인.
- PC 1440·1024: 기준과 후보의 전체 PNG SHA-256 각각 동일(metrics.json). 1024는 기존 1440 고정 보드를 보존한 결과이며 1024 반응형 정본 신설이나 제품 일치 판정이 아닙니다.
- 링크는 기존 designHref 규칙을 보존했습니다. PF003 자체 링크 / 는 기존 preview 루트입니다. 운영 화면의 링크 실행이나 메뉴·FAQ 상호작용은 미검증입니다.
- design-map-check: IA 196 / MAP 203, IA 누락 0, 깨진 경로 0. git diff --check 통과. TSX 소스 양쪽 esbuild 번들 성공.

증거: ../PF-003-M-390-states.png(두 상태 전체), ../PF-003-1440-head.png(기존 파일명 유지, 새 전체 캡처), candidate-pc-1024.png, metrics.json.

Git TSX가 소스 권위이며 Canvas 동기화 미완료를 유지합니다. 공개 PF003 390에 한정한 후보이며 관리자 모바일 제공이나 기존 판단 필요 항목을 완료로 바꾸지 않습니다. 독립검수 및 최신 main 정합 후 게시 판단이 남았습니다.
