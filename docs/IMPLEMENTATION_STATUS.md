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
| 전체 페이지 리뉴얼 (Countdown Board) | 완료 |
| 홈 즉시 계산 (나이 1개 입력) | 완료 |
| 다른 잔량 연결 | 완료 |
| /about · /privacy | 완료 |
| AdSense 스크립트 · ads.txt | 완료 |
| 공유 카드 이미지 (1080×1350 PNG) | 완료 |
| 친구 비교 링크 (결과값만 URL 포함) | 완료 |
| 은퇴 시점 시뮬레이션 (출근·월급) | 완료 |
| 연령대 평균 월급 비교 (공식 통계) | 완료 |
| 기대여명 기준 주말 계산 (공식 통계) | 완료 |
| 인생 시간 랭킹 /ranking | 완료 |
| 파비콘 (ico·svg·apple-touch) | 완료 |
| 페이지별 OG 카드 1200×630 + Twitter large card | 완료 |
| 입력 드롭다운 · 콤마 · 만원 표기 · 3단 날짜 휠 · 숫자 자동 축소 | 완료 |
| 생년월일 저장 · 전체 계산기 공통 나이 | 완료 |
| 커리어 위치 /career (산업 평균·고용 흐름·경제지표, 공식 통계 Snapshot) | 완료 |
| 다국어 | 보류 |
| AdSense 수동 광고 슬롯 ID | 대기 |
| 사업자 정보 · 문의 이메일 | 완료 |

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
