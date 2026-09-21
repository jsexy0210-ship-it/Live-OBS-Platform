# LifeLeft 운영 배포 기준

> 기준일: 2026-09-21
> 운영 정본: https://lifeleft.duckdns.org
> 운영 IP: 210.109.82.212

## 운영 구조

```text
lifeleft.duckdns.org
→ 210.109.82.212
→ 기존 KakaoCloud VM
→ Nginx 443 name-based virtual host
→ /var/www/lifeleft/current
→ /var/www/lifeleft/releases/<SHA>
```

WeddingPick은 기존 IP/default server 구조를 그대로 유지한다.

LifeLeft는 별도 Nginx 파일만 사용:

```text
/etc/nginx/sites-available/lifeleft
/etc/nginx/sites-enabled/lifeleft
```

WeddingPick Nginx 설정 파일 수정 금지.

## DNS

DuckDNS:

```text
lifeleft.duckdns.org
A → 210.109.82.212
```

IPv6 미사용.

## TLS

Let's Encrypt 인증서:

```text
/etc/letsencrypt/live/lifeleft.duckdns.org/fullchain.pem
/etc/letsencrypt/live/lifeleft.duckdns.org/privkey.pem
```

발급 방식:

- 기존 80 포트 ACME webroot 재사용
- `/var/www/html/.well-known/acme-challenge/`
- certbot `webroot`
- Nginx plugin 자동수정 미사용

## 배포

자동 workflow:

`.github/workflows/deploy-lifeleft-domain.yml`

트리거:

- main push
- 수동 workflow_dispatch

흐름:

```text
GitHub-hosted build
→ Typecheck
→ Static Export
→ artifact
→ 기존 self-hosted runner
→ /home/ubuntu/LifeLeft/static-releases/<SHA>
→ /var/www/lifeleft/releases/<SHA>
→ current symlink 전환
→ 별도 LifeLeft Nginx host
→ nginx -t
→ reload
→ 로컬 HTTPS smoke
→ 외부 GitHub-hosted HTTPS smoke
→ finalize
```

외부 검증 실패 시 직전 LifeLeft symlink/Nginx 설정으로 자동 rollback.

## 안전 규칙

- 신규 VM 없음
- 신규 DB 없음
- 신규 API 없음
- Render 없음
- 8443 없음
- WeddingPick 디렉터리 접근 금지
- WeddingPick Nginx 파일 수정 금지
- LifeLeft 전용 server_name만 추가
- Nginx reload 전 `nginx -t` 필수
- 공개 검증 실패 시 rollback

## 정적 경로

staging:

```text
/home/ubuntu/LifeLeft/static-releases/<SHA>
```

live:

```text
/var/www/lifeleft/releases/<SHA>
/var/www/lifeleft/current
```

## SEO 정본

- canonical: `https://lifeleft.duckdns.org`
- sitemap: `https://lifeleft.duckdns.org/sitemap.xml`
- robots: `https://lifeleft.duckdns.org/robots.txt`
- 공유 URL: 현재 운영 페이지 URL

## 배포 확인

필수 경로:

- `/`
- `/commute/`
- `/salary/`
- `/weekends/`
- `/work-time/`
- `/subscriptions/`
- `/survival/`
- `/robots.txt`
- `/sitemap.xml`
