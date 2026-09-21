# LifeLeft / 인생잔량

시간·돈·횟수의 잔량 계산 서비스.

- 제품 기준: `docs/MVP_SPEC.md`
- 인프라 기준: `docs/INFRASTRUCTURE.md`
- 배포 준비: `docs/DEPLOYMENT.md`
- 구현 상태: `docs/IMPLEMENTATION_STATUS.md`
- 기술: Next.js + TypeScript + Recharts
- 배포 형태: Static Export
- 저장: 브라우저 localStorage
- DB: 없음
- 신규 서버: 없음

## 현재 계산기

- 출근 잔량
- 월급 잔량
- 주말 잔량
- 회사 누적시간
- 구독 누적
- 생존 잔량

## 로컬 실행

```bash
npm install
npm run dev
```

## 검증

```bash
npm run typecheck
npm run build
bash -n scripts/stage-lifeleft-static.sh
```

## 배포 원칙

- 기존 KakaoCloud VM 재사용
- LifeLeft 정적 release 경로 분리
- 운영 URL 확정 전 Nginx 변경 없음
- Render 미사용
