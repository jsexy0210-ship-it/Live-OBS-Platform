# LifeLeft 인프라 기준

> 기준일: 2026-09-21
> 운영 정본: https://lifeleft.duckdns.org

## 원칙

LifeLeft 인프라는 WeddingPick과 완전 분리.

공유:

- KakaoCloud 계정
- GitHub 계정

분리:

- KakaoCloud 프로젝트
- VPC
- Subnet
- Security Group
- VM
- Public IP
- GitHub self-hosted runner
- Nginx
- TLS
- 배포 workflow

## 현재 인프라

```text
project  lifeleft
VPC      lifeleft-vpc / 10.10.0.0/16
subnet   lifeleft-vpc_public_sn1 / 10.10.10.0/24
VM       lifeleft-web-prod
private  10.10.10.232
public   210.109.15.68
domain   lifeleft.duckdns.org
runner   lifeleft-kakao
```

## 네트워크

```text
Internet
→ lifeleft.duckdns.org
→ 210.109.15.68
→ lifeleft-web-prod
→ Nginx 80/443
→ LifeLeft Static Export
```

Security Group:

- TCP 22: 관리자 공인 IP/32
- TCP 80: 0.0.0.0/0
- TCP 443: 0.0.0.0/0

## 파일 경로

staging:

```text
/home/ubuntu/LifeLeft/static-releases/<SHA>
```

live:

```text
/var/www/lifeleft/releases/<SHA>
/var/www/lifeleft/current
```

## 배포

GitHub-hosted runner:

- npm install
- typecheck
- static export
- artifact 생성

LifeLeft self-hosted runner:

- artifact 다운로드
- immutable staging
- release 전환
- Nginx/TLS
- local smoke
- rollback/finalize

VM에서 npm build를 수행하지 않는다.

## 미사용

- WeddingPick 인프라
- Render
- DB
- Redis
- 별도 API
- 컨테이너 런타임

상세: `docs/DEPLOYMENT.md`
