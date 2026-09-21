# LifeLeft 운영 배포 기준

> 기준일: 2026-09-21
> 운영 정본: https://lifeleft.duckdns.org
> 운영 IP: 210.109.15.68

## 운영 구조

```text
lifeleft.duckdns.org
→ 210.109.15.68
→ KakaoCloud 프로젝트 lifeleft
→ VM lifeleft-web-prod
→ Nginx 443
→ /var/www/lifeleft/current
→ /var/www/lifeleft/releases/<SHA>
```

WeddingPick 인프라와 공유하지 않는다.

## KakaoCloud

- 프로젝트: `lifeleft`
- VPC: `lifeleft-vpc`
- VPC CIDR: `10.10.0.0/16`
- Public Subnet: `lifeleft-vpc_public_sn1`
- Subnet CIDR: `10.10.10.0/24`
- VM: `lifeleft-web-prod`
- Private IP: `10.10.10.232`
- Public IP: `210.109.15.68`
- Runner label: `lifeleft-kakao`

## DNS

DuckDNS:

```text
lifeleft.duckdns.org
A → 210.109.15.68
```

IPv6 미사용.

## TLS

Let's Encrypt:

```text
/etc/letsencrypt/live/lifeleft.duckdns.org/fullchain.pem
/etc/letsencrypt/live/lifeleft.duckdns.org/privkey.pem
```

첫 배포 시 배포 스크립트가 Nginx와 certbot이 없으면 설치한다.

## 배포

자동 workflow:

`.github/workflows/deploy-lifeleft-domain.yml`

흐름:

```text
GitHub-hosted build
→ Typecheck
→ Static Export
→ artifact
→ LifeLeft self-hosted runner
→ /home/ubuntu/LifeLeft/static-releases/<SHA>
→ /var/www/lifeleft/releases/<SHA>
→ current symlink
→ Nginx
→ Let's Encrypt
→ public HTTPS smoke
→ finalize
```

외부 검증 실패 시 직전 LifeLeft release/Nginx 설정으로 rollback.

## 분리 원칙

금지:

- WeddingPick VM 사용
- WeddingPick runner 사용
- WeddingPick VPC 사용
- WeddingPick Nginx 사용
- WeddingPick 저장소를 LifeLeft 배포 브리지로 사용
- Render 사용
- 8443 사용

## SEO 정본

- canonical: `https://lifeleft.duckdns.org`
- sitemap: `https://lifeleft.duckdns.org/sitemap.xml`
- robots: `https://lifeleft.duckdns.org/robots.txt`
- 공유 URL: 현재 운영 페이지 URL
