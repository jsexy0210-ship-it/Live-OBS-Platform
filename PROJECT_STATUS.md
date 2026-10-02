# Project Status

> 기준일: 2026-10-02

## 단계

0단계: 이전 프로젝트 정리 및 최소 구성 (완료, PR #7 병합)
1단계 준비: 망고TCG 구조 분석 (`docs/REFERENCE_MANGOTCG.md`)
1단계: 디자인 작업 (기능 구현보다 먼저 진행). 프롬프트: `docs/DESIGN_PROMPT.md`, 결과 대기

## 현재 저장소

- Next.js 최소 앱 (`app/layout.tsx`, `app/page.tsx`)
- CI: typecheck + build, 배포 워크플로 재유입 검사
- 배포 워크플로: 없음

## 인프라 방향

기존 카카오클라우드 프로젝트·VM 자원을 신규 플랫폼에 재사용하는 방향 (운영자 결정, 2026-10-02).

- 실제 자원 이름·상태: 콘솔 확인 필요 (미확인)
- Object Storage 버킷: 존재 여부·이름 미확인
- 이번 작업에서 서버·DNS·러너는 변경하지 않음

## 미확정·미확인

- `docs/PRODUCT_SCOPE.md`의 미확정 항목
- 카카오클라우드 실제 자원 상태 (콘솔 확인 필요)
