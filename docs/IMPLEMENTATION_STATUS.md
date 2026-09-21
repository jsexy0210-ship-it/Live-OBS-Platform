# LifeLeft 구현 상태

> 기준일: 2026-09-21
> Source of Truth: GitHub main

## 제품

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
| 결과 공유 | 완료 |
| localStorage 저장/복원 | 완료 |
| 입력 범위 보정 | 완료 |
| Static Export CI | 완료 |
| canonical / sitemap / robots | 완료 |

## 운영 인프라

| 항목 | 상태 |
|---|---|
| LifeLeft 프로젝트 | 완료 |
| VPC/Subnet | 완료 |
| 전용 VM | 완료 |
| 전용 Public IP | 완료 |
| SSH 접속 | 완료 |
| DuckDNS 신규 IP 변경 | 대기 |
| LifeLeft self-hosted runner 등록 | 대기 |
| Nginx/TLS 자동 배포 | 코드 완료 / 실행 대기 |
| Public HTTPS smoke | 대기 |

## 운영 정본

```text
https://lifeleft.duckdns.org
210.109.15.68
```

## 다음 작업

1. DuckDNS를 `210.109.15.68`로 변경
2. `lifeleft-web-prod`에 GitHub runner `lifeleft-kakao` 등록
3. 대기 중인 LifeLeft deploy workflow 실행
4. HTTPS public smoke
5. 공휴일 Snapshot
6. 공유 카드 이미지
