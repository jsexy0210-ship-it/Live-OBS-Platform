# Project Status

> 기준일: 2026-10-02

## 단계

0단계: LifeLeft 정리 및 최소 구성 (완료, PR #7 병합)
1단계 준비: 망고TCG 구조 분석 (`docs/REFERENCE_MANGOTCG.md`)

## 현재 저장소

- Next.js 최소 앱 (`app/layout.tsx`, `app/page.tsx`)
- CI: typecheck + build, 배포 워크플로 재유입 검사
- 배포 워크플로: 없음

## 인프라 방향

기존 LifeLeft용 카카오클라우드 자원을 신규 플랫폼에 재사용하는 방향 (운영자 결정, 2026-10-02).

저장소 문서 기준 기존 자원 (실제 콘솔 미확인):

```text
project  lifeleft          # 프로젝트 이름은 생성 후 변경 불가, 설명만 변경 가능
VPC      lifeleft-vpc / 10.10.0.0/16
subnet   lifeleft-vpc_public_sn1 / 10.10.10.0/24
VM       lifeleft-web-prod (public 210.109.15.68)
domain   lifeleft.duckdns.org
runner   lifeleft-kakao (self-hosted)
```

- Object Storage 버킷: 저장소 문서에 기록 없음. 존재 여부·이름 미확인.
- 기존 LifeLeft 사이트는 VM에서 계속 서비스 중일 수 있음. 이번 작업에서 서버·DNS·러너는 변경하지 않음.

## 미확정·미확인

- `docs/PRODUCT_SCOPE.md`의 미확정 항목
- 카카오클라우드 실제 자원 상태 (콘솔 확인 필요)
