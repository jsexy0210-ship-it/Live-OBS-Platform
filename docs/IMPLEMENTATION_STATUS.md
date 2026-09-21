# LifeLeft 구현 상태

> 기준일: 2026-09-21
> Source of Truth: GitHub main + 현재 작업 PR

## 구현 완료

| 영역 | 상태 |
|---|---|
| 공통 Result Hero | 완료 |
| 섹션별 팩트/임팩트 배지 | 완료 |
| 차트 공통 시스템 | 완료 |
| 출근 잔량 | 완료 |
| 월급 잔량 | 완료 |
| 주말 잔량 | 완료 |
| 회사 누적시간 | 완료 |
| 구독 누적 | 완료 |
| 생존 잔량 | 완료 |
| Static Export CI | 완료 |
| 기존 인프라 재사용 정책 | 완료 |

## 현재 차트

- Depletion Donut
- Area Chart
- Line Chart
- Horizontal Bar
- Stacked Bar
- Pie Chart
- Life Grid

## 현재 계산 기준

출근 잔량:
- 사용자 입력 기반 추정
- 공휴일 Snapshot 미연결
- 공휴일·휴직·회사별 휴무일 미반영

월급 잔량:
- 현재 월 급여 유지 가정
- 연봉 상승·성과급·퇴직금·세금 변동 미반영

주말 잔량:
- 사용자 선택 기준 나이 기반 단순 계산
- 실제 수명 예측 아님

회사 누적시간:
- 사용자 입력 기반 추정
- 공휴일·휴직·재택·야근 변동 미반영

## 다음 작업

1. 공휴일 Snapshot
2. 결과 공유
3. localStorage 저장/복원
4. 입력 Validation
5. OG/SEO 보강
6. 기존 인프라 운영 배포

## 인프라

- 신규 VM 없음
- 신규 DB 없음
- 신규 백엔드 없음
- Render 없음
- 기존 GitHub Actions 사용
- 기존 KakaoCloud VM 사용
- 기존 Nginx/HTTPS 443 사용
