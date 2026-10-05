# SCREEN_MAP — 디자인 정본 화면 지도

> 기준: Artifact https://claude.ai/artifact/YYGXZ3u4QvjQpEMUHnN4tS `1791213911-1437` (v271 이후 캔버스 전체 재동기화) · 동기화 2026-10-06 00:27 KST · 소스 `design/project/` · 검사 `npm run design:check`

## 상태 정의

- **FINAL**: 대표님 확정 현대화 기준(입력·선택·버튼 radius 8 · 패널·카드 12 · 관리자 컨트롤 40 / 기본 44 / 주요 CTA 48 / 방송 CTA 56+ · 같은 레벨 버튼 폭 고정 · Select 화살표 우측 14~16 · 날짜 전체 클릭 · PC 썸네일 64 · 검색 박스 외곽 프레임 완전성 · 검색 Body/Action Footer · 목록 Header/Table Body 분리 · 불필요한 내부 구분선 제거 · 표 일반 데이터 가운데·읽는 텍스트 왼쪽 · 관리자 목록 빠른 처리 · 상태 보존·모바일 내비)을 실제 소스가 충족한 보드만. 2026-10-05 기준 27개.
- **DRAFT**: 소스는 있으나 위 기준 전수 확인 전이거나 일부 미충족(비고에 빠진 것). 오래된 소스는 FINAL로 올리지 않았다.
- **BLOCKED**: 결정이 필요해 멈춤(`DESIGN_DECISION_REQUIRED`, MASTER 보고).
- **MISSING**: 보드 없음(메뉴 그룹 ID는 화면이 아니라 MISSING으로 두되 비고에 「메뉴 그룹」 표시).
- **PROPOSAL**: 대표님 확정 전 제안 보드. 구현 근거로 쓰지 않는다(IA 밖 공통 시스템 보드 표에서만 사용).
- **SUPERSEDED**: 폐지 또는 다른 보드가 대체. 변형 규칙: `-IA`(IA 개편판)가 있으면 그것이 정본이고 같은 ID의 기본·`-PC` 보드는 SUPERSEDED. `-OPS`(운영 편의성)가 있으면 그것이 정본. `-M`·`-E`·`-D`·`-S`·`-B`·`-C`·`-R`·`-DK`·`-PRE`는 상태·폭·다크 변형으로 정본의 일부다.

## 집계

| 영역 | IA 화면 수 |
|---|---|
| AU | 12 |
| PF | 10 |
| MA | 48 |
| SA | 78 |
| SH | 29 |
| OV | 8 |
| EM | 6 |
| OG | 2 |
| 합계 | 193 |

| 상태 | 수 |
|---|---|
| FINAL | 35 |
| DRAFT | 143 |
| BLOCKED | 0 |
| MISSING | 14 |
| SUPERSEDED | 1 |

소스 파일: `design/project/` 362개 (보드 339장 · canvas.json · ds/wds 2 · lop.css · ov.css · ibgen 17 · fonts/WantedSans-OFL.txt)

## AU 공통 인증

| ID | 화면 | Product Route | Design Source | Entry | Status | Artifact Version | 마지막 동기화(KST) | 비고 |
|---|---|---|---|---|---|---|---|---|
| AU-001 | 마스터 관리자 로그인 | /admin/login | design/project/AU-001.dc.html | AU-001.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| AU-002 | 파트너스 관리자 로그인 | /seller/login | design/project/AU-002.dc.html | AU-002.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · 변형: AU-002-M |
| AU-003 | 비밀번호 찾기 | /seller/password-reset | design/project/AU-003.dc.html | AU-003.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| AU-004 | 새 비밀번호 입력 | /seller/password-reset (새 비밀번호) | design/project/AU-004.dc.html | AU-004.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| AU-005 | 승인 대기 안내 | /seller/pending | design/project/AU-005.dc.html | AU-005.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| AU-006 | 이용 정지 안내 | /seller/suspended | design/project/AU-006.dc.html | AU-006.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| AU-007 | 세션 만료 | /seller/login?reason=expired | design/project/AU-007.dc.html | AU-007.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| AU-008 | 권한 없음(403) | (403 공통 컴포넌트) | design/project/AU-008.dc.html | AU-008.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| AU-009 | 페이지 없음(404) | (not-found 공통) | design/project/AU-009.dc.html | AU-009.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| AU-010 | 점검 중 | /maintenance | design/project/AU-010.dc.html | AU-010.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 공개 해요체 + 관리자 변형 합니다체(MASTER 결정 2026-10-05) |
| AU-011 | 아이디 찾기 | /seller/find-id | design/project/AU-011.dc.html | AU-011.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · 변형: AU-011-V |
| AU-012 | 직원 첫 로그인 · 계정 연결 | /seller/identity-link | design/project/AU-012.dc.html | AU-012.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |

## PF 플랫폼 소개·가입

| ID | 화면 | Product Route | Design Source | Entry | Status | Artifact Version | 마지막 동기화(KST) | 비고 |
|---|---|---|---|---|---|---|---|---|
| PF-001 | 서비스 소개(랜딩) | /about | design/project/PF-001.dc.html | PF-001.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 · 변형: PF-001-M |
| PF-002 | 기능 안내 | /features | design/project/PF-002.dc.html | PF-002.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 |
| PF-003 | 요금 안내 | /pricing | design/project/PF-003.dc.html | PF-003.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 |
| PF-004 | 자주 묻는 질문 | /faq | design/project/PF-004.dc.html | PF-004.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 |
| PF-005 | 공지사항 목록 | /notices | design/project/PF-005.dc.html | PF-005.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 |
| PF-006 | 공지 상세 | /notices/[noticeId] | design/project/PF-006.dc.html | PF-006.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 |
| PF-007 | 판매자 가입 신청 | /seller/signup | design/project/PF-007-2.dc.html | PF-007-2.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 · 변형: PF-007-3 |
| PF-007-1 | 가입 신청 · 약관 동의 | /seller/signup (약관 단계) | design/project/PF-007-1.dc.html | PF-007-1.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 |
| PF-008 | 이용약관(플랫폼) | /terms | design/project/PF-008.dc.html | PF-008.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 |
| PF-009 | 개인정보처리방침(플랫폼) | /privacy | design/project/PF-009.dc.html | PF-009.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 |

## MA 마스터 관리자

| ID | 화면 | Product Route | Design Source | Entry | Status | Artifact Version | 마지막 동기화(KST) | 비고 |
|---|---|---|---|---|---|---|---|---|
| MA-001 | 통합 대시보드 | /admin | design/project/MA-001-IA.dc.html | MA-001-IA.dc.html | FINAL | v291 (1791219075-ad9b) | 2026-10-06 01:51 KST | FINAL 재확인(2026-10-06 마스터 묶음) · MA-001-R2~R4 지시 반영: 「오늘 처리할 일」 유지 + 파트너스·오늘·구독 3섹션(구현 /admin과 같은 칸) + 「기간별 현황」(최근 7·30·90일 · 일별 결제 금액·들어온 주문·가입 신청·시작한 방송 · 상위 5 파트너스 · 월별 받은 구독료). 변형 MA-001(차트 초안)은 SUPERSEDED, R2~R4(역할별 홈)는 보류(후순위, 역할별 홈은 나중에 다시 꺼낼 수 있게 남김 — MASTER 2026-10-06) |
| MA-002 | 알림 센터 | /admin/notifications | design/project/MA-002.dc.html | MA-002.dc.html | FINAL | v291 (1791219075-ad9b) | 2026-10-06 01:51 KST | FINAL 재확인(2026-10-06 마스터 묶음) · 제목 「알림 센터」(DS-NAV) · 결제 연결 오류·방송 화면 용어 · 행 버튼 「대신 보기」 |
| MA-010 | 파트너스(메뉴 그룹) | — | — | 메뉴 그룹 ID(화면 아님) | MISSING | 1791213911-1437 | 2026-10-06 00:27 KST | IA 그룹 헤더 · 보드 대상 아님 |
| MA-011 | 파트너스 목록 | /admin/partners | design/project/MA-011.dc.html | MA-011.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | DS-PANEL 목록 패널 구조 적용(v243) · 변형: MA-011-PRE, MA-011-S |
| MA-012 | 파트너스 상세 | /admin/partners/[sellerId] | design/project/MA-012-1.dc.html | MA-012-1.dc.html | FINAL | v291 (1791219075-ad9b) | 2026-10-06 01:51 KST | FINAL 재확인(2026-10-06 마스터 묶음) · 현대화 규칙 반영(쉬운 말 · 날짜 2026.10.06 · 확인 창 · DS-NAV 제목) |
| MA-013 | 가입 신청 목록 | /admin/partners/applications | design/project/MA-013-OPS.dc.html | MA-013-OPS.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | ADMIN_OPS_UX P1 · MA-013 정본 · 변형: MA-013 (MA-013 = SUPERSEDED) · 현대화 기준 재확인(v270): 글 열 제목 왼쪽 · 관리 열 가운데 8px·폭 토큰(lop.css 공통 .acts2) |
| MA-014 | 가입 신청 상세 | /admin/partners/applications/[sellerId] | design/project/MA-014.dc.html | MA-014.dc.html | FINAL | v291 (1791219075-ad9b) | 2026-10-06 01:51 KST | FINAL 재확인(2026-10-06 마스터 묶음) · 현대화 규칙 반영(쉬운 말 · 날짜 2026.10.06 · 확인 창 · DS-NAV 제목) |
| MA-015 | 이용 정지 / 해제 | (MA-011·012 다이얼로그) | design/project/MA-015-S.dc.html | MA-015-S.dc.html | FINAL | v291 (1791219075-ad9b) | 2026-10-06 01:51 KST | FINAL 재확인(2026-10-06 마스터 묶음) · 현대화 규칙 반영(쉬운 말 · 날짜 2026.10.06 · 확인 창 · DS-NAV 제목) |
| MA-016 | 파트너스 화면 대리 조회 | — | design/project/MA-016.dc.html | MA-016.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · 변형: MA-016-M |
| MA-020 | 구독·요금제(메뉴 그룹) | — | — | 메뉴 그룹 ID(화면 아님) | MISSING | 1791213911-1437 | 2026-10-06 00:27 KST | IA 그룹 헤더 · 보드 대상 아님 |
| MA-021 | 요금제 목록 | /admin/billing/plans | design/project/MA-021.dc.html | MA-021.dc.html | FINAL | v291 (1791219075-ad9b) | 2026-10-06 01:51 KST | FINAL 재확인(2026-10-06 마스터 묶음) · 현대화 규칙 반영(쉬운 말 · 날짜 2026.10.06 · 확인 창 · DS-NAV 제목) |
| MA-022 | 요금제 등록·수정 | /admin/billing/plans (등록·수정) | design/project/MA-022.dc.html | MA-022.dc.html | FINAL | v291 (1791219075-ad9b) | 2026-10-06 01:51 KST | FINAL 재확인(2026-10-06 마스터 묶음) · 현대화 규칙 반영(쉬운 말 · 날짜 2026.10.06 · 확인 창 · DS-NAV 제목) |
| MA-023 | 구독 현황 | /admin/billing/subscriptions | design/project/MA-023.dc.html | MA-023.dc.html | FINAL | v291 (1791219075-ad9b) | 2026-10-06 01:51 KST | FINAL 재확인(2026-10-06 마스터 묶음) · 날짜 칸 .dt · 빠른 선택 40 「최근 1개월」 기본 |
| MA-024 | 청구·결제 내역 | /admin/billing/invoices | design/project/MA-024.dc.html | MA-024.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(v267): 「불러온 n건」 머리 · 청구 열 글 열 왼쪽 · 「항목」 가운데 · 상태 5종 |
| MA-025 | 청구 상세 | /admin/billing/invoices/[paymentId] | design/project/MA-025.dc.html | MA-025.dc.html | FINAL | v291 (1791219075-ad9b) | 2026-10-06 01:51 KST | FINAL 재확인(2026-10-06 마스터 묶음) · 현대화 규칙 반영(쉬운 말 · 날짜 2026.10.06 · 확인 창 · DS-NAV 제목) |
| MA-026 | 환불 요청 목록 | /admin/billing/refunds | design/project/MA-026.dc.html | MA-026.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| MA-027 | 환불 처리 | /admin/billing/refunds/[refundId] | design/project/MA-027.dc.html | MA-027.dc.html | FINAL | v291 (1791219075-ad9b) | 2026-10-06 01:51 KST | FINAL 재확인(2026-10-06 마스터 묶음) · 확인 창 버튼 순서 · 일시 표기 |
| MA-030 | 정산·결제 현황(메뉴 그룹) | — | — | 메뉴 그룹 ID(화면 아님) | MISSING | 1791213911-1437 | 2026-10-06 00:27 KST | IA 그룹 헤더 · 보드 대상 아님 |
| MA-031 | PG 연결 상태 | /admin/settlement/pg | design/project/MA-031.dc.html | MA-031.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| MA-032 | 구독료 수납 현황 | /admin/settlement/collection | design/project/MA-032.dc.html | MA-032.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| MA-040 | 운영 현황(메뉴 그룹) | — | — | 메뉴 그룹 ID(화면 아님) | MISSING | 1791213911-1437 | 2026-10-06 00:27 KST | IA 그룹 헤더 · 보드 대상 아님 |
| MA-041 | 실시간 방송 중 파트너스 | /admin/ops/live | design/project/MA-041.dc.html | MA-041.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| MA-042 | 주문·오버레이 접속 현황 | /admin/ops/access | design/project/MA-042.dc.html | MA-042.dc.html | FINAL | v291 (1791219075-ad9b) | 2026-10-06 01:51 KST | FINAL 재확인(2026-10-06 마스터 묶음) · 제목 「주문 · 방송 화면 접속」(DS-NAV) |
| MA-043 | 적립금 실지급 파트너스 | /admin/ops/rewards | design/project/MA-043.dc.html | MA-043.dc.html | FINAL | v291 (1791219075-ad9b) | 2026-10-06 01:51 KST | FINAL 재확인(2026-10-06 마스터 묶음) · 제목 「적립금 실제 지급 켠 파트너스」(DS-NAV) |
| MA-050 | 고객지원(메뉴 그룹) | — | — | 메뉴 그룹 ID(화면 아님) | MISSING | 1791213911-1437 | 2026-10-06 00:27 KST | IA 그룹 헤더 · 보드 대상 아님 |
| MA-051 | 파트너스 문의 목록 | /admin/support/inquiries | design/project/MA-051.dc.html | MA-051.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| MA-052 | 문의 상세·답변 | /admin/support/inquiries/[inquiryId] | design/project/MA-052.dc.html | MA-052.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| MA-053 | 공지사항 목록 | /admin/support/notices | design/project/MA-053.dc.html | MA-053.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| MA-054 | 공지 작성·수정 | /admin/support/notices/new · [noticeId] | design/project/MA-054.dc.html | MA-054.dc.html | FINAL | v291 (1791219075-ad9b) | 2026-10-06 01:51 KST | FINAL 재확인(2026-10-06 마스터 묶음) · 정책(MASTER 2026-10-06): 예약 발송 제외 · 즉시 「지금 게시하기」만(게시·발송 시각·리마인드 행 제거) |
| MA-055 | 도우미 답변 자료 | /admin/support/assistant | design/project/MA-055.dc.html | MA-055.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| MA-060 | 관리자 계정·권한(메뉴 그룹) | — | — | 메뉴 그룹 ID(화면 아님) | MISSING | 1791213911-1437 | 2026-10-06 00:27 KST | IA 그룹 헤더 · 보드 대상 아님 |
| MA-061 | 관리자 계정 목록 | /admin/accounts | design/project/MA-061.dc.html | MA-061.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| MA-062 | 계정 추가·수정 | /admin/accounts (다이얼로그) | design/project/MA-062.dc.html | MA-062.dc.html | FINAL | v291 (1791219075-ad9b) | 2026-10-06 01:51 KST | FINAL 재확인(2026-10-06 마스터 묶음) · 정책(MASTER 2026-10-06): 관리자 추가는 처음 비밀번호 직접 입력 + 첫 로그인 때 변경(초대 링크 아님) · 상태 「이용 중/정지」 구현 일치 |
| MA-063 | 역할별 권한 표 | /admin/accounts/roles | design/project/MA-063.dc.html | MA-063.dc.html | FINAL | v291 (1791219075-ad9b) | 2026-10-06 01:51 KST | FINAL 재확인(2026-10-06 마스터 묶음) · 정책(MASTER 2026-10-06): 고정 역할 조회만(저장·변경 이력·셀 편집·변경 상태 제거) · 제목 「역할별로 할 수 있는 일」 구현 일치 |
| MA-070 | 로그 추적 | /admin/logs | design/project/MA-070.dc.html | MA-070.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| MA-071 | 로그 추적 상세 | /admin/logs/[logId] | design/project/MA-071.dc.html | MA-071.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| MA-080 | 시스템 설정(메뉴 그룹) | — | — | 메뉴 그룹 ID(화면 아님) | MISSING | 1791213911-1437 | 2026-10-06 00:27 KST | IA 그룹 헤더 · 보드 대상 아님 |
| MA-081 | 플랫폼 기본 정책 | — | design/project/MA-081.dc.html | MA-081.dc.html | FINAL | v293 (1791238661-161d) | 2026-10-06 07:17 KST | FINAL 재확인(2026-10-06 MASTER 우선 요청, 서버 #583 병합) · 제목 「플랫폼 기본 정책」(DS-NAV) · 설정 그룹 탭 줄 제거 · 쉬운 말(방송 화면 · 실제 지급 · 대신 보기) · 일시 2026.09.01 · 확인 창 [취소][저장] |
| MA-082 | 알림 채널 설정 | /admin/settings/messages | design/project/MA-082.dc.html | MA-082.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| MA-083 | 점검 모드 | /admin/settings/maintenance | design/project/MA-083.dc.html | MA-083.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · 변형: MA-083-M |
| MA-084 | 도우미 설정 | /admin/settings/assistant | design/project/MA-084.dc.html | MA-084.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| MA-085 | 파비콘·공유 카드 | /admin/settings/branding | design/project/MA-085.dc.html | MA-085.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · 변형: MA-085-M |
| MA-086 | 발송 단가 | /admin/settings/messages | design/project/MA-086.dc.html | MA-086.dc.html | FINAL | v291 (1791219075-ad9b) | 2026-10-06 01:51 KST | FINAL 재확인(2026-10-06 마스터 묶음) · 설정 그룹 탭 줄 제거(마스터 설정은 LNB 화면, DS-NAV) · 날짜 칸 .dt |
| MA-087 | 외부 서비스 연동 | — | design/project/MA-087.dc.html | MA-087.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 업체 로고 v243 규격(PNG·256KB) · 관리자 화면 경로 미정 · docs/IA.md 등재(#599) |
| MA-090 | 내 계정 | — | design/project/MA-090.dc.html | MA-090.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| MA-100 | 실시간 감시 | /admin/ops/monitor | design/project/MA-100.dc.html | MA-100.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| MA-110 | 자동 연결 작업 목록 | /admin/ops/automation | design/project/MA-110.dc.html | MA-110.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| MA-111 | 자동 연결 작업 상세 | /admin/ops/automation/[jobId] | design/project/MA-111.dc.html | MA-111.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |

## SA 파트너스 관리자

| ID | 화면 | Product Route | Design Source | Entry | Status | Artifact Version | 마지막 동기화(KST) | 비고 |
|---|---|---|---|---|---|---|---|---|
| SA-001 | 방송 대시보드 | /seller/broadcast | design/project/SA-001.dc.html | SA-001.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · 변형: SA-001-B, SA-001-C, SA-001-DK, SA-001-E, SA-001-L, SA-001-M1, SA-001-M2, SA-001-M3, SA-001-M4, SA-001-M5, SA-001-M6 |
| SA-002 | 파트너스 홈 | /seller | design/project/SA-002-IA.dc.html | SA-002-IA.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(c24/sh24 토큰 · 2026-10-05 이후 작성·갱신) · 변형: SA-002 (SA-002 = SUPERSEDED) |
| SA-002-O | 오버레이 전용 홈 | /seller (오버레이 전용) | design/project/SA-002-O.dc.html | SA-002-O.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-003 | 시작하기 | /seller/onboarding | design/project/SA-003.dc.html | SA-003.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-004 | 온보딩 | /seller/onboarding | design/project/SA-004.dc.html | SA-004.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-005 | 쇼핑몰 통합 전환 | — | design/project/SA-005.dc.html | SA-005.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-006 | 외부 쇼핑몰 연동 | /seller/external-shops | design/project/SA-006.dc.html | SA-006.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-010 | 상품(메뉴 그룹) | — | — | 메뉴 그룹 ID(화면 아님) | MISSING | 1791213911-1437 | 2026-10-06 00:27 KST | IA 그룹 헤더 · 보드 대상 아님 |
| SA-011 | 상품 목록 | /seller/products | design/project/SA-011.dc.html | SA-011.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | DS-PANEL 목록 패널 구조 적용(v243) · 변형: SA-011-DK, SA-011-M, SA-011-PRE, SA-011-S · 현대화 기준 재확인(v270): 관리 열 가로 flex 가운데 8px(열 190) · 상품명 제목 왼쪽 · 썸네일 64 |
| SA-012 | 상품 등록·수정 | /seller/products/new · [productId] | design/project/SA-012.dc.html | SA-012.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(v270): 폼 표 안 버튼 40(입력과 같은 줄) · 표 안 보조 행동만 32 · 아이콘 버튼 정사각 32 · 하단 고정 행동 줄 · 상태 12종 · 변형: SA-012-D, SA-012-DK, SA-012-E |
| SA-013 | 상품 상세 미리보기 | (상품 목록 미리보기) | design/project/SA-013.dc.html | SA-013.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-014 | 재고 일괄 수정 | /seller/products/stock | design/project/SA-014.dc.html | SA-014.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-015 | 카테고리 관리 | /seller/products/categories | design/project/SA-015.dc.html | SA-015.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-016 | 상품 진열 | /seller/products/display | design/project/SA-016.dc.html | SA-016.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-017 | 재입고 알림 | /seller/products/restock-alerts | design/project/SA-017.dc.html | SA-017.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-018 | 엑셀 일괄 등록·내보내기 | — (PR #462 작업 중) | design/project/SA-018.dc.html | SA-018.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(v267): 글 열 제목 왼쪽 · 행동 줄 flex 8px · 내보내기 관리 열 버튼 40 통일 · 되돌리기 danger 단독 · 로딩·오류 상태 추가(9종) |
| SA-020 | 주문(메뉴 그룹) | — | — | 메뉴 그룹 ID(화면 아님) | MISSING | 1791213911-1437 | 2026-10-06 00:27 KST | IA 그룹 헤더 · 보드 대상 아님 |
| SA-021 | 주문 목록 | /seller/orders | design/project/SA-021-OPS.dc.html | SA-021-OPS.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | ADMIN_OPS_UX P1 · SA-021 정본 · 변형: SA-021, SA-021-PRE, SA-021-S (SA-021 = SUPERSEDED) · v258 부분 환불 표기(결제 칸 배지 · 금액 아래 환불 줄) · v259 주문번호 보조 표시(접수 시각 아래) · 현대화 기준 확인(v266): 글 열 제목 왼쪽(th.l) · 관리 열 가운데 8px · 버튼 폭 토큰 · Select 공통 화살표 · 상태 변형 7종 · SA-021(1차)도 같은 기준 |
| SA-022 | 주문 상세 | /seller/orders/[orderId] | design/project/SA-022.dc.html | SA-022.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(v266): 썸네일 64×64 · 글 열 제목 왼쪽 · 버튼 위계(목록·취소 환불 2차 · 송장 입력 1차) · 상태 변형 11종 · 모달 X 44px · v259 상단 주문번호 + 복사 버튼 · 복사 토스트 상태 |
| SA-023 | 취소·환불 처리 | /seller/orders/refund-requests | design/project/SA-023.dc.html | SA-023.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · 변형: SA-023-R |
| SA-024 | 현금영수증·세금계산서 | — | design/project/SA-024.dc.html | SA-024.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-025 | 배송 | /seller/shipping | design/project/SA-025.dc.html | SA-025.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(v270): 기간 빠른 선택 40 · 글 열 제목 왼쪽 · 행 「발송 처리」 40(택배사·송장 입력과 같은 줄) · 상태 7종 |
| SA-026 | 입금 확인 | /seller/orders/deposits | design/project/SA-026.dc.html | SA-026.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-027 | 배송·송장 발급 | — | design/project/SA-027.dc.html | SA-027.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-028 | 송장 출력·추적 | — | design/project/SA-028.dc.html | SA-028.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-029 | 교환·반품 | /seller/returns | design/project/SA-029.dc.html | SA-029.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-030 | 적립금(메뉴 그룹) | — | — | 메뉴 그룹 ID(화면 아님) | MISSING | 1791213911-1437 | 2026-10-06 00:27 KST | IA 그룹 헤더 · 보드 대상 아님 |
| SA-031 | 적립 정책 | /seller/rewards | design/project/SA-031.dc.html | SA-031.dc.html | FINAL | v288 (1791217961-0a6c) | 2026-10-06 02:18 KST | FINAL(통합 「적립금」 탭 1 · 저장 확인 창 · 이력 일시 2026.09.15 · 「인기 카드 1위 보너스」 · 상태 7종) · 현대화 기준 충족(표 규칙 · 쉬운 말 · 확인 창 · 날짜 칸) |
| SA-032 | 지급·회수 원장 | /seller/rewards/ledger | design/project/SA-032.dc.html | SA-032.dc.html | FINAL | v288 (1791217961-0a6c) | 2026-10-06 02:18 KST | FINAL(통합 「적립금」 탭 2 · 기간 빠른 선택 40 기본값 최근 1개월 · 날짜 칸 .i.dt · 일시 2026.10.02 21:10 · 「실제 지급」 · 상태 6종) · 현대화 기준 충족(표 규칙 · 쉬운 말 · 확인 창 · 날짜 칸) |
| SA-033 | 회원별 잔액 | /seller/rewards/balances | design/project/SA-033.dc.html | SA-033.dc.html | FINAL | v288 (1791217961-0a6c) | 2026-10-06 02:18 KST | FINAL(통합 「적립금」 탭 3 · 잔액 조정 확인 창 · 상태 7종) · 현대화 기준 충족(표 규칙 · 쉬운 말 · 확인 창 · 날짜 칸) |
| SA-034 | 실지급 스위치 | /seller/rewards/live-payout | design/project/SA-034.dc.html | SA-034.dc.html | FINAL | v288 (1791217961-0a6c) | 2026-10-06 02:18 KST | FINAL(통합 「적립금」 탭 4 「실제 지급 켜기」 · 켜기 확인 창 「적립금을 실제로 지급하도록 켜시겠습니까?」 · 상태 6종) · 현대화 기준 충족(표 규칙 · 쉬운 말 · 확인 창 · 날짜 칸) |
| SA-035 | 쿠폰 | /seller/coupons | design/project/SA-035.dc.html | SA-035.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-040 | 회원(메뉴 그룹) | — | — | 메뉴 그룹 ID(화면 아님) | MISSING | 1791213911-1437 | 2026-10-06 00:27 KST | IA 그룹 헤더 · 보드 대상 아님 |
| SA-041 | 회원 목록 | /seller/members | design/project/SA-041.dc.html | SA-041.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-042 | 회원 상세 | /seller/members/[memberId] | design/project/SA-042.dc.html | SA-042.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-043 | 구매 제한 | /seller/purchase-restrictions | design/project/SA-043.dc.html | SA-043.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-044 | 회원 등급 | /seller/member-grades | design/project/SA-044.dc.html | SA-044.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-045 | 구매자 문의 | — | — | — | MISSING | 1791213911-1437 | 2026-10-06 00:27 KST | 메뉴 그룹(화면 아님) · 옛 보드 SA-045(회원 알림 발송)는 SA-049로 이동(MASTER 결정 2026-10-05), 캔버스의 인덱스 밖 고아 파일 SA-045.dc.html은 MASTER가 삭제(v257 1791209877-f282) |
| SA-046 | 문의 목록 | /seller/buyer-inquiries | design/project/SA-046.dc.html | SA-046.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-047 | 문의 상세·답변 | /seller/buyer-inquiries (상세) | design/project/SA-047.dc.html | SA-047.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-048 | 상품 리뷰 | /seller/reviews | design/project/SA-048.dc.html | SA-048.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-049 | 회원 알림 발송 | /seller/member-messages | design/project/SA-049.dc.html | SA-049.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · SA-045에서 이동한 보드 |
| SA-050 | 방송·오버레이(메뉴 그룹) | — | — | 메뉴 그룹 ID(화면 아님) | MISSING | 1791213911-1437 | 2026-10-06 00:27 KST | IA 그룹 헤더 · 보드 대상 아님 |
| SA-051 | 오버레이 편집기 | /seller/overlay (편집기) | design/project/SA-051.dc.html | SA-051.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · 변형: SA-051-B, SA-051-C, SA-051-D, SA-051-P |
| SA-052 | 오버레이 URL | /seller/overlay | design/project/SA-052.dc.html | SA-052.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-053 | HIT 카드 이력 | /seller/hit-cards | design/project/SA-053.dc.html | SA-053.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-054 | 방송 이력 | /seller/broadcasts | design/project/SA-054.dc.html | SA-054.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-055 | 방송 상세 | /seller/broadcasts/[broadcastId] | design/project/SA-055.dc.html | SA-055.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-056 | 통계 | /seller/stats (+ orders·sales·products·members·broadcasts) | design/project/SA-056.dc.html | SA-056.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · 변형: SA-056-B, SA-056-M, SA-056-O, SA-056-P, SA-056-S · 변형 SA-056-P(상품 탭) FINAL v268: 상품 전환 퍼널 구역(조회→담기→주문→결제 · 단계 수·전환율 · 상품별 상위 20 표 · 로그인 회원만 집계 안내 · 집계 전 상태) · 기간 빠른 선택 40 통일 |
| SA-057 | 유튜브 연결 | /seller/youtube | design/project/SA-057.dc.html | SA-057.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-060 | 쇼핑몰 정보 | /seller/settings/shop | design/project/SA-060.dc.html | SA-060.dc.html | FINAL | v283 (1791217115-7fad) | 2026-10-06 01:45 KST | 현대화 기준 충족(폼 표 `.ft` · 입력 폭 토큰 · 저장 48 · 행 버튼 32 · 썸네일 패턴 · 상태 13종) · 쉬운 말(탭 아이콘(파비콘) · 공유 카드 이미지 · 인기 카드) · 높이 2600→4200으로 공지 · 이용안내 구역과 상태 변형까지 보이게 · 변형: SA-060-D · 구현은 쇼핑몰 정보 한 화면(탭 아이콘 · 공유 카드 · 내 도메인 · 사업자 · 공지 포함, DS-NAV) |
| SA-061 | 배송비 정책 | /seller/settings/shipping | design/project/SA-061.dc.html | SA-061.dc.html | FINAL | v288 (1791217961-0a6c) | 2026-10-06 02:18 KST | FINAL(통합 「주문 · 배송 설정」 탭 2 · 저장 확인 창 · 상태 8종) · 현대화 기준 충족(표 규칙 · 쉬운 말 · 확인 창 · 날짜 칸) |
| SA-062 | 법정 고지·약관 | /seller/settings/legal | design/project/SA-062.dc.html | SA-062.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 개발 맞춤 2026-10-05 (2탭 · 게시 스위치) |
| SA-063 | 주문 설정 | /seller/settings/order | design/project/SA-063.dc.html | SA-063.dc.html | FINAL | v288 (1791217961-0a6c) | 2026-10-06 02:18 KST | FINAL(통합 「주문 · 배송 설정」 탭 1 · 저장 확인 창 DS-CONFIRM · 상태 10종) · 현대화 기준 충족(표 규칙 · 쉬운 말 · 확인 창 · 날짜 칸) |
| SA-064 | 홈 배너 | /seller/banners | design/project/SA-064.dc.html | SA-064.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-065 | 이벤트 팝업 | /seller/banners/popups | design/project/SA-065.dc.html | SA-065.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-066 | 쇼핑몰 공지·자주 묻는 질문 | /seller/settings/shop-notices | design/project/SA-066.dc.html | SA-066.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-067 | 검색 노출 | /seller/settings/seo | design/project/SA-067.dc.html | SA-067.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-068 | 회원 정책 | /seller/settings/member | design/project/SA-068.dc.html | SA-068.dc.html | FINAL | v288 (1791217961-0a6c) | 2026-10-06 02:18 KST | FINAL(통합 「약관 · 회원 정책」 탭 2 · 저장 확인 창 · 상태 6종) · 현대화 기준 충족(표 규칙 · 쉬운 말 · 확인 창 · 날짜 칸) |
| SA-070 | 결제(PG) 연결 | (폐지) | — | — | SUPERSEDED | 1791213911-1437 | 2026-10-06 00:27 KST | 플랫폼 결제대행사 키 하나 결정(2026-10-05 MASTER)으로 폐지 · 보드 SA-070 · SA-070-B 삭제됨(v255) · docs/IA.md 폐지 표시(#599) |
| SA-080 | 주문자 알림 설정 | /seller/settings/order-notifications | design/project/SA-080.dc.html | SA-080.dc.html | FINAL | v288 (1791217961-0a6c) | 2026-10-06 02:18 KST | FINAL(메뉴 「알림 설정」 제목 통일 · 저장 확인 창 · 알림 문구는 구매자 해요체 · 상태 11종) · 현대화 기준 충족(표 규칙 · 쉬운 말 · 확인 창 · 날짜 칸) |
| SA-081 | 발송·이용 충전 | /seller/settings/message-balance | design/project/SA-081.dc.html | SA-081.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · 비용 정본 docs/COST_POLICY.md · docs/IA.md 등재(#599) |
| SA-082 | 배송 자동화 | — | design/project/SA-082.dc.html | SA-082.dc.html | FINAL | v288 (1791217961-0a6c) | 2026-10-06 02:18 KST | FINAL(통합 「주문 · 배송 설정」 탭 3 · 켜기/끄기 확인 창 버튼 순서 [취소][실행] · 상태 8종) · 현대화 기준 충족(표 규칙 · 쉬운 말 · 확인 창 · 날짜 칸) |
| SA-090 | 구독·결제 | /seller/subscription | design/project/SA-090.dc.html | SA-090.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · 변형: SA-090-M |
| SA-100 | 직원 계정·권한 | /seller/staff | design/project/SA-100.dc.html | SA-100.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · 변형: SA-100-D, SA-100-M |
| SA-110 | 공지·문의(메뉴 그룹) | — | — | 메뉴 그룹 ID(화면 아님) | MISSING | 1791213911-1437 | 2026-10-06 00:27 KST | IA 그룹 헤더 · 보드 대상 아님 |
| SA-111 | 공지사항 목록 | /seller/notices | design/project/SA-111.dc.html | SA-111.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-112 | 공지 상세 | /seller/notices/[id] | design/project/SA-112.dc.html | SA-112.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-113 | 내 문의 목록 | /seller/inquiries | design/project/SA-113.dc.html | SA-113.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-114 | 문의 작성 | /seller/inquiries/new | design/project/SA-114.dc.html | SA-114.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-115 | 문의 상세·답변 | /seller/inquiries/[id] | design/project/SA-115.dc.html | SA-115.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-120 | 내 계정 | — | design/project/SA-120.dc.html | SA-120.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(v271) · MASTER 결정 A(정본 2열 표형 구조, 구현 #623 fc28633과 일치): 프로필 표(이름 저장) · 비밀번호 표(현재·새 8자 이상·확인 칸, 변경 시 항상 다른 기기 로그아웃) · 후속(서버 API 없음): 연락처 · 알림 수신 · 로그인 기기 · 세션은 상태 변형에만 · 상태 8종 |
| SA-130 | 알림 센터 | /seller/notifications | design/project/SA-130.dc.html | SA-130.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-140 | 도우미 | /seller/assistant | design/project/SA-140.dc.html | SA-140.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-150 | 자동 연결 안내 | /seller/automation | design/project/SA-150.dc.html | SA-150.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-151 | 자동 연결 결제 | /seller/automation/pay | design/project/SA-151.dc.html | SA-151.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-152 | 자동 연결 진행 | /seller/automation/[jobId] | design/project/SA-152.dc.html | SA-152.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SA-153 | 자동 연결 완료 | /seller/automation/[jobId]/done | design/project/SA-153.dc.html | SA-153.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |

## SH 구매자 쇼핑몰

| ID | 화면 | Product Route | Design Source | Entry | Status | Artifact Version | 마지막 동기화(KST) | 비고 |
|---|---|---|---|---|---|---|---|---|
| SH-001 | 쇼핑몰 홈 | /shop/[slug] | design/project/SH-001-IA.dc.html | SH-001-IA.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(c24/sh24 토큰 · 2026-10-05 이후 작성·갱신) · 변형: SH-001-PC-IA, SH-001, SH-001-PC (SH-001, SH-001-PC = SUPERSEDED) |
| SH-002 | 상품 목록·검색 | /shop/[slug]/products · /search | design/project/SH-002-IA.dc.html | SH-002-IA.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(c24/sh24 토큰 · 2026-10-05 이후 작성·갱신) · 변형: SH-002-PC-IA, SH-002, SH-002-F, SH-002-PC, SH-002-S (SH-002, SH-002-PC = SUPERSEDED) |
| SH-003 | 상품 상세 | /shop/[slug]/products/[productId] | design/project/SH-003-IA.dc.html | SH-003-IA.dc.html | FINAL | v284 (1791217340-eeda) | 2026-10-06 01:52 KST | FINAL 재확인(현대화 기준 충족): 휴대폰 위 바 56 · ← 44 아이콘(DS-NAV) · 하단 바 「장바구니에 담기」「바로 주문하기」(찜 · 공유 44) · 일시 2026.10.01 표기 · 품절 |
| SH-004 | 장바구니 | /shop/[slug]/cart | design/project/SH-004-IA.dc.html | SH-004-IA.dc.html | FINAL | v284 (1791217340-eeda) | 2026-10-06 01:52 KST | FINAL 재확인(현대화 기준 충족): 휴대폰 위 바 56 · ← 44 아이콘(DS-NAV) · 쉬운 말(#644) 반영 확인 |
| SH-005 | 주문서 | /shop/[slug]/checkout | design/project/SH-005-IA.dc.html | SH-005-IA.dc.html | FINAL | v284 (1791217340-eeda) | 2026-10-06 01:52 KST | FINAL 재확인(현대화 기준 충족): 휴대폰 위 바 56 · ← 44 아이콘(DS-NAV) · 쉬운 말(#644: 보호자 · 금액을 한 번 더 확인해요) · 쿠폰 기한 2026.10.15 표기 |
| SH-006 | 결제 진행 | /shop/[slug]/checkout (결제 단계) | design/project/SH-006.dc.html | SH-006.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · 변형: SH-006-PC |
| SH-007 | 주문 완료 | /shop/[slug]/orders/[orderId] (완료) | design/project/SH-007.dc.html | SH-007.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(v267): 주문번호 날짜-순번(20261002-0412) 휴대폰·PC 모두 표시 · 안내 한 줄 · 버튼 사이 8px · 변형 SH-007-PC · 변형: SH-007-PC |
| SH-008 | 결제 실패 | /shop/[slug]/checkout (실패) | design/project/SH-008.dc.html | SH-008.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · 변형: SH-008-PC |
| SH-009 | 미성년자 구매 제한 안내 | — | design/project/SH-009.dc.html | SH-009.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · 변형: SH-009-PC |
| SH-010 | 로그인 | /shop/[slug]/login | design/project/SH-010.dc.html | SH-010.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · 변형: SH-010-PC |
| SH-011 | 회원가입 | /shop/[slug]/signup | design/project/SH-011.dc.html | SH-011.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(c24/sh24 토큰 · 2026-10-05 이후 작성·갱신) · 변형: SH-011-PC |
| SH-012 | 비밀번호 찾기 | — | design/project/SH-012.dc.html | SH-012.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · 변형: SH-012-PC |
| SH-020 | 마이페이지 | /shop/[slug]/me | design/project/SH-020-IA.dc.html | SH-020-IA.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(c24/sh24 토큰 · 2026-10-05 이후 작성·갱신) · 변형: SH-020-PC-IA, SH-020, SH-020-PC (SH-020, SH-020-PC = SUPERSEDED) |
| SH-021 | 주문 내역 | /shop/[slug]/orders | design/project/SH-021-IA.dc.html | SH-021-IA.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(c24/sh24 토큰 · 2026-10-05 이후 작성·갱신) · 변형: SH-021, SH-021-PC (SH-021, SH-021-PC = SUPERSEDED) |
| SH-022 | 주문 상세 | /shop/[slug]/orders/[orderId] | design/project/SH-022-IA.dc.html | SH-022-IA.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(c24/sh24 토큰 · 2026-10-05 이후 작성·갱신) · 변형: SH-022, SH-022-M, SH-022-PC (SH-022, SH-022-PC = SUPERSEDED) |
| SH-022-R | 교환·반품 요청 시트 | /shop/[slug]/orders/[orderId] (시트) | design/project/SH-022-R.dc.html | SH-022-R.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |
| SH-023 | 내 적립금 | — | design/project/SH-023-IA.dc.html | SH-023-IA.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(c24/sh24 토큰 · 2026-10-05 이후 작성·갱신) · 변형: SH-023, SH-023-PC (SH-023, SH-023-PC = SUPERSEDED) |
| SH-024 | 회원정보 수정 | — | design/project/SH-024-IA.dc.html | SH-024-IA.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(c24/sh24 토큰 · 2026-10-05 이후 작성·갱신) · 변형: SH-024, SH-024-PC (SH-024, SH-024-PC = SUPERSEDED) |
| SH-025 | 알림 설정 | /shop/[slug]/me/notifications | design/project/SH-025-IA.dc.html | SH-025-IA.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(c24/sh24 토큰 · 2026-10-05 이후 작성·갱신) · 변형: SH-025, SH-025-PC (SH-025, SH-025-PC = SUPERSEDED) |
| SH-026 | 내 문의 | — | design/project/SH-026-IA.dc.html | SH-026-IA.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(c24/sh24 토큰 · 2026-10-05 이후 작성·갱신) · 변형: SH-026, SH-026-PC (SH-026, SH-026-PC = SUPERSEDED) |
| SH-027 | 배송지 관리 | — | design/project/SH-027-IA.dc.html | SH-027-IA.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(c24/sh24 토큰 · 2026-10-05 이후 작성·갱신) · 변형: SH-027, SH-027-PC (SH-027, SH-027-PC = SUPERSEDED) |
| SH-028 | 쿠폰함 | /shop/[slug]/coupons | design/project/SH-028-IA.dc.html | SH-028-IA.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(c24/sh24 토큰 · 2026-10-05 이후 작성·갱신) · 변형: SH-028, SH-028-PC (SH-028, SH-028-PC = SUPERSEDED) |
| SH-029 | 리뷰 쓰기·내 리뷰 | /shop/[slug]/reviews · /reviews/write | design/project/SH-029-IA.dc.html | SH-029-IA.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(c24/sh24 토큰 · 2026-10-05 이후 작성·갱신) · 변형: SH-029, SH-029-PC (SH-029, SH-029-PC = SUPERSEDED) |
| SH-030 | 공지·이용안내 | /shop/[slug]/help | design/project/SH-030.dc.html | SH-030.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · 변형: SH-030-PC |
| SH-031 | 개인정보처리방침(쇼핑몰) | /shop/[slug]/privacy | design/project/SH-031.dc.html | SH-031.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(c24/sh24 토큰 · 2026-10-05 이후 작성·갱신) · 변형: SH-031-PC |
| SH-032 | 이용약관(쇼핑몰) | /shop/[slug]/terms | design/project/SH-032.dc.html | SH-032.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(c24/sh24 토큰 · 2026-10-05 이후 작성·갱신) · 변형: SH-032-PC |
| SH-034 | 찜·최근 본 상품 | /shop/[slug]/wishlist | design/project/SH-034-IA.dc.html | SH-034-IA.dc.html | FINAL | 1791213911-1437 | 2026-10-06 00:27 KST | 현대화 기준 충족(c24/sh24 토큰 · 2026-10-05 이후 작성·갱신) · 변형: SH-034, SH-034-PC (SH-034, SH-034-PC = SUPERSEDED) |
| SH-040 | 쇼핑몰 준비 중·정지 안내 | (ShopState 공통) | design/project/SH-040.dc.html | SH-040.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 · 변형: SH-040-PC |
| SH-041 | 쇼핑몰 잠금 | (ShopState 공통) | design/project/SH-041.dc.html | SH-041.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | c24/sh24 틀 적용 · 현대화 기준(버튼 폭 고정 · Select 화살표 · 날짜 전체 클릭 · 목록 Header/Body 분리 · 빠른 처리) 전수 확인 전 |

## OV 오버레이

| ID | 화면 | Product Route | Design Source | Entry | Status | Artifact Version | 마지막 동기화(KST) | 비고 |
|---|---|---|---|---|---|---|---|---|
| OV-000 | 효과 명세 | /overlay/[token] | design/project/OV-000.dc.html | OV-000.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 |
| OV-001 | 세로형 9:16 기본 템플릿 | /overlay/[token] | design/project/OV-001.dc.html | OV-001.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 · 변형: OV-001-B, OV-001-C, OV-001-E, OV-001-F, OV-001-G, OV-001-P |
| OV-002 | 가로형 16:9 기본 템플릿 | /overlay/[token] | design/project/OV-002.dc.html | OV-002.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 · 변형: OV-002-B, OV-002-C, OV-002-E, OV-002-G |
| OV-003 | HIT 카드 강조 | /overlay/[token] | design/project/OV-003.dc.html | OV-003.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 · 변형: OV-003-B |
| OV-004 | 구매 랭킹·명예의 전당 | /overlay/[token] | design/project/OV-004.dc.html | OV-004.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 |
| OV-005 | 오픈 타이머 | /overlay/[token] | design/project/OV-005.dc.html | OV-005.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 · 변형: OV-005-B |
| OV-006 | 연결 끊김 / 방송 대기 | /overlay/[token] | design/project/OV-006.dc.html | OV-006.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 · 변형: OV-006-B, OV-006-C |
| OV-007 | 이벤트 할인 카드 | /overlay/[token] | design/project/OV-007.dc.html | OV-007.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 |

## EM 메일

| ID | 화면 | Product Route | Design Source | Entry | Status | Artifact Version | 마지막 동기화(KST) | 비고 |
|---|---|---|---|---|---|---|---|---|
| EM-001 | 메일 · 주문 완료 | (메일) | design/project/EM-001.dc.html | EM-001.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 |
| EM-002 | 메일 · 발송 | (메일) | design/project/EM-002.dc.html | EM-002.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 |
| EM-003 | 메일 · 배송 완료 | (메일) | design/project/EM-003.dc.html | EM-003.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 |
| EM-004 | 메일 · 취소·환불 | (메일) | design/project/EM-004.dc.html | EM-004.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 |
| EM-101 | 메일 · 가입 승인 | (메일) | design/project/EM-101.dc.html | EM-101.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 |
| EM-102 | 메일 · 가입 반려 | (메일) | design/project/EM-102.dc.html | EM-102.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 |

## OG 공유 카드

| ID | 화면 | Product Route | Design Source | Entry | Status | Artifact Version | 마지막 동기화(KST) | 비고 |
|---|---|---|---|---|---|---|---|---|
| OG-001 | 공유 카드 · 마스터 관리자 | (공유 카드 이미지) | design/project/OG-001.dc.html | OG-001.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 |
| OG-002 | 공유 카드 · 파트너스 관리자 | (공유 카드 이미지) | design/project/OG-002.dc.html | OG-002.dc.html | DRAFT | 1791213911-1437 | 2026-10-06 00:27 KST | 공통 틀 밖(오버레이 · 메일 · 공유 카드 등) · 전용 기준으로 확인 전 |

## IA 밖 보드 · 공통 시스템 보드

| 보드 | 내용 | 상태 |
|---|---|---|
| Brand1·2·3 | 브랜드 제안(초안) | DRAFT |
| DS1~DS6 | 디자인 시스템 설명 보드(DS6 = 카페24식 공통 틀) | DRAFT · DS6 참고 · DS1~5 초안 |
| DS-CONFIRM | 공통 확인 창 — 저장·삭제·변경·상태 변경·일괄 처리 앞 다이얼로그(규칙 6항 · 관리자 6종 · 구매자 PC 2종 · 휴대폰 시트 2종, 대표님 지시 2026-10-06 · docs PR #627) | FINAL v272 (1791213148-ad9f) · `design/project/DS-CONFIRM.dc.html` |
| IA1·IA2·IA3 | 정보구조도 보드(IA1은 v279에서 확정 GNB·LNB로 재생성) | DRAFT · 정본은 docs/IA.md |
| DS-DATEPICKER | 공통 날짜 선택(네이버식) — 칸 2026.10.05 · 빈 칸 「날짜 선택」/「시작일」~「종료일」 · 달력 아이콘 · 달력 ‹ 2026.10 › · 일 빨강 토 파랑 · 오늘 테두리 · 고른 날 채운 원 · 기간 연한 배경 · [초기화][적용] · 관리자 40 · 구매자 PC · 휴대폰 시트 48 · 검색 필터 기본값(최근 1개월) · 규칙 5(대표님 지시 2026-10-06 · docs PR #631 · #630 · #632) | FINAL v276 (1791214099-aa42) · `design/project/DS-DATEPICKER.dc.html` · lop.css `.i.dt` / `.inp.dt` |
| DS-NAV | 새 GNB · 메뉴 구조표(제안) — 파트너스 GNB 10→8 · LNB 50→34, 마스터 8→6 · 28→24, 구매자 이름 2곳, 통폐합 전후 대응표 · 원칙 5(대표님 지시 2026-10-05 · docs/IA.md 「GNB·위계 현대화」 PR #637) · 화면 ← 버튼(Back) 규격 6항·시안 5(대표님 지시 「화면 진입 시 Back 기능도 없다」, 경로는 docs/BACK_ROUTES.md) | FINAL v278 (대표님 확정 2026-10-06 「그대로 진행」, docs/IA.md 「확정 메뉴 구조」 PR #637) · `design/project/DS-NAV.dc.html` |
| DS-TYPE-SCALE | 글자 · 버튼 · 간격 · 모서리 · 아이콘 · 표 · 일시 표기 크기 체계 한 장(시각 규격 2026-10-05 + 일시 2026.10.05 22:25) | FINAL v278 (대표님 확정 2026-10-06 「그대로 진행」) · `design/project/DS-TYPE-SCALE.dc.html` |
| IA1·IA2·IA3 | 정보구조도 보드 | DRAFT · 정본은 docs/IA.md |
| Handoff | 개발 이관 목록 보드 | DRAFT |
| Main | 캔버스 표지 | — |
| ScreenList | 화면 목록 보드 | DRAFT · 정본은 이 SCREEN_MAP |
| SH-T · SH-T-PC | 파트너스별 테마 구조 비교 | DRAFT |
| OV-008 | 오버레이 위젯 해부·효과 | DRAFT |

## 공통 컴포넌트 → 실제 소스 위치

| 컴포넌트 | 소스 |
|---|---|
| AdminShell / SellerShell (관리자 공통 틀: GNB + LNB + 경로 줄 + ← 버튼) | **메뉴 구조 정본 DS-NAV(확정 2026-10-06) · 파트너스·마스터 LNB 정본 design/project/SA-LNB.dc.html(v279) · ← 버튼 lop.css `.c24 .bk`** · design/project/lop.css (`.c24 .gnb` `.lnb` `.pathbar` `.ph2` `.rtabs`) · 휴대폰 틀 design/project/SA-FRAME-M.dc.html · 마스터 메뉴는 design/project/MA-001-IA.dc.html의 GNB·LNB |
| ShopHeader / ShopFrame (구매자 공통 머리 · 바닥 · 탭바) | design/project/lop.css (`.sh24 .tb` `.hd` `.cat` `.ft` `.m .mh` `.tabbar`) · 정본 예시 design/project/SH-001-PC-IA.dc.html · SH-001-IA.dc.html |
| SearchBox · ListPanel (검색 패널 3층 · 목록 패널 2층 · 외곽 프레임 완전성) | design/project/DS-PANEL.dc.html · lop.css (`.c24 .box.dense` `.ft` `.sbtn` `.lpanel` `.ltop` `.lt`) |
| 행 동작 · 칩 · 일괄 고정 줄 · 사이드 패널 · 확인 3단계 (관리자 목록 즉시 처리) | design/project/DS-ROW-ACTION.dc.html · 적용 예 MA-013-OPS.dc.html · SA-021-OPS.dc.html · 정본 규칙 docs/ADMIN_OPS_UX.md |
| Table | lop.css `.c24 .lt`(목록) · `.ft`(표형 폼) · `.sh24 .tbl`(구매자) |
| Button | lop.css `.c24 .b` + `.sm` `.lg` `.pri` `.neg` `.dark` (높이 토큰 `--ui-h-*`, 폭 토큰 `--btn-w-*`) · 구매자 `.sh24 .btn` |
| Input · Select · DatePicker | lop.css `.c24 .i` + `.w-xs~.w-f` · Select 화살표 · 날짜 전체 클릭 규칙은 docs/DESIGN_PROMPT.md 「규격」 |
| Modal · 확인 창 | **정본 DS-CONFIRM** · lop.css `.c24 .cfm` `.ovl` · 구매자 `.sh24 .cfm` · 휴대폰 `.sh24.m .sheet .pn` · 위험 실행 `.b.neg.pri` / `.btn.neg.p` · 예시 MA-013-OPS(반려 사유) · SA-021-OPS(환불) |
| BottomSheet (휴대폰 시트) | design/project/SH-003-O.dc.html(옵션) · SH-002-F.dc.html(필터) · SH-022-M.dc.html(취소 요청) |
| Badge · 상태 배지 | lop.css `.c24 .tag` (`g` `bl` `y` `r` `n` `live`) · 규칙 DS-ROW-ACTION ② |
| ProductCard (상품 카드 · 상태 8종) | design/project/SH-CARD-IA.dc.html |
| Toast · 결과 안내 | lop.css `.c24 .toast2` · `.sh24 .toast` |
| 디자인 시스템 토큰 | design/project/ds/wds/tokens.json · tokens.css (WDS 351개) · 공통 UI 토큰 lop.css `:root` (`--ui-r-*` `--ui-h-*` `--btn-w-*` `--c24-*`) |
| 오버레이 공통 | design/project/ov.css · 효과 명세 OV-000.dc.html · 위젯 해부 OV-008.dc.html |

## 토큰: 디자인 vs production

- `design/project/ds/wds/tokens.css`와 `styles/tokens.css`의 WDS 토큰 351개는 이름·값이 모두 같다(2026-10-05 스크립트 비교, 차이 0).
- 공통 UI 토큰: 디자인 `lop.css :root`의 `--ui-r-*` `--ui-h-*` `--btn-w-*` `--ui-dur*`는 production `styles/tokens.css`에 같은 이름으로 있다. production에만 있는 토큰: `--ui-ease` `--ui-focus*` `--ui-fs-*` `--ui-gap-*` `--ui-gutter*` `--ui-hit-min` `--ui-lh-*`(개발 쪽 확장). 디자인에만 있는 토큰: `--c24-*`(카페24식 관리자 색·높이)와 `--ui-r-sheet` `--ui-line-input`.
- production `styles/lop.css`는 디자인 `design/project/lop.css`의 사본 계열이나 별도로 고쳐 왔다. 어느 쪽이 정본인지: 보드가 쓰는 디자인 `lop.css`가 정본이고, production 차이는 개발 PR에서 맞춘다(이 PR에서는 비교만).

## 빌드 · 미리보기

- Build: **NOT_APPLICABLE** — 보드(`*.dc.html`)는 Claude Design 캔버스의 런타임(`support.js` · `artifact-type/dc-runtime.js`, 유형 소유라 이관 대상 아님) 위에서만 렌더링된다. 저장소에는 빌드 시스템을 두지 않았다(새로 만들지 않음).
- 미리보기: 캔버스 링크에서 보드를 연다(README 참고). 로컬 확인은 `lop.css` · `ds/wds/tokens.css`를 같은 상대 경로로 둔 채 Chromium으로 열면 런타임 없이도 정적 마크업은 보인다(`{{…}}` 홀과 `sc-for` 반복은 렌더링되지 않음).
