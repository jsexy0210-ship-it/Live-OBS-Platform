# LifeLeft 인프라 기준

> 기준일: 2026-09-21
> 운영 정본: https://lifeleft.duckdns.org

## 원칙

**신규 인프라 없음**

재사용:

- 기존 GitHub
- 기존 GitHub Actions
- 기존 self-hosted runner 운영 방식
- 기존 KakaoCloud VM
- 기존 Nginx
- 기존 HTTPS 443

미사용:

- Render
- 신규 VM
- 신규 DB
- 신규 Redis
- 신규 API 서버
- 별도 컨테이너 런타임

## 네트워크

```text
lifeleft.duckdns.org
→ 210.109.82.212
→ Nginx 443
→ LifeLeft 전용 server_name
```

WeddingPick default server 유지.

LifeLeft는 host 기반 분리.

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

WeddingPick:

```text
/home/ubuntu/WeddingPick/
/var/www/weddingpick/
```

LifeLeft 배포 코드에서 위 WeddingPick 경로 접근 금지.

## Nginx

LifeLeft 전용 설정:

```text
/etc/nginx/sites-available/lifeleft
/etc/nginx/sites-enabled/lifeleft
```

기존 WeddingPick 설정 파일 수정 금지.

443 포트 공유는 `server_name lifeleft.duckdns.org`로 분리.

## TLS

- Let's Encrypt
- certbot webroot
- ACME root: `/var/www/html`
- 인증서 호스트: `lifeleft.duckdns.org`

## CI / Deploy

PR CI:

- shell syntax
- WeddingPick 경로 침범 검사
- TypeScript
- Static Export
- sitemap/robots 검증

main:

- production build
- self-hosted staging
- domain cutover
- 외부 HTTPS 검증
- 성공 finalize
- 실패 rollback

## 운영 안전 규칙

- `nginx -t` 성공 전 reload 금지
- 신규 default_server 생성 금지
- 기존 IP 서비스 redirect 금지
- 8443 금지
- Render 금지
- 외부 smoke 실패 시 rollback

상세: `docs/DEPLOYMENT.md`
