# LifeLeft 구현 상태

> 기준일: 2026-09-21
> Source of Truth: GitHub main + 현재 작업 PR

## 완료

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
| DuckDNS 확보 | 완료 |
| 운영 도메인 설정 | 완료 |
| canonical / sitemap / robots | 완료 |
| Kakao VM immutable staging | 완료 |
| LifeLeft 전용 Nginx/TLS 배포 코드 | 완료 |
| 공개 검증/rollback workflow | 완료 |

## 운영 정본

```text
https://lifeleft.duckdns.org
```

DNS:

```text
lifeleft.duckdns.org → 210.109.82.212
```

## 배포 구조

- 기존 KakaoCloud VM
- 기존 HTTPS 443
- LifeLeft 전용 `server_name`
- WeddingPick default server 보존
- 별도 `/var/www/lifeleft`
- Let's Encrypt
- 외부 smoke 실패 시 rollback

## 남은 제품 작업

1. 공휴일 Snapshot
2. 공유 카드 이미지
3. 데이터 출처/기준일 세부 고도화
4. 검색 유입용 계산기별 콘텐츠 보강

## 배포 직전 확인

- PR CI 성공
- main 병합
- self-hosted runner 실행 여부
- DNS propagation
- certbot 발급
- public HTTPS smoke
