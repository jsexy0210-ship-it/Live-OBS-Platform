#!/usr/bin/env bash
set -euo pipefail

ROOT=/home/ubuntu/LifeLeft
STAGED="$ROOT/static-releases"
WEB_ROOT=/var/www/lifeleft
RELEASES="$WEB_ROOT/releases"
CURRENT="$WEB_ROOT/current"
CONF=/etc/nginx/sites-available/lifeleft
ENABLED=/etc/nginx/sites-enabled/lifeleft
BACKUPS="$ROOT/nginx-backups"
TX_PREV="$ROOT/.domain-update-prev-target"
TX_CONF="$ROOT/.domain-update-conf-backup"
TX_ENABLED="$ROOT/.domain-update-prev-enabled"
TX_NEW="$ROOT/.domain-update-new-sha"

release_sha="${1:-${GITHUB_SHA:-}}"
domain="${2:-lifeleft.duckdns.org}"
expected_ip="${3:-210.109.82.212}"

if [[ ! "$release_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid release SHA" >&2
  exit 1
fi
if [ "$domain" != "lifeleft.duckdns.org" ]; then
  echo "Unexpected production domain: $domain" >&2
  exit 1
fi
if [ "$expected_ip" != "210.109.82.212" ]; then
  echo "Unexpected production IP: $expected_ip" >&2
  exit 1
fi

source_dir="$STAGED/$release_sha"
test -f "$source_dir/index.html"
test -f "$source_dir/commute/index.html"
test -f "$source_dir/salary/index.html"
test -f "$source_dir/weekends/index.html"
test -f "$source_dir/work-time/index.html"
test -f "$source_dir/subscriptions/index.html"
test -f "$source_dir/survival/index.html"

for marker in "$TX_PREV" "$TX_CONF" "$TX_ENABLED" "$TX_NEW"; do
  if [ -e "$marker" ]; then
    echo "Pending LifeLeft domain transaction exists: $marker" >&2
    exit 1
  fi
done

echo "Waiting for public DNS: $domain -> $expected_ip"
resolved=false
for _ in $(seq 1 40); do
  if getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u | grep -Fxq "$expected_ip"; then
    resolved=true
    break
  fi
  sleep 15
done
if [ "$resolved" != "true" ]; then
  echo "DNS did not resolve to $expected_ip within the deployment window." >&2
  exit 1
fi

if ! command -v certbot >/dev/null 2>&1; then
  sudo -n apt-get update
  sudo -n apt-get install -y certbot
fi

sudo -n mkdir -p /var/www/html/.well-known/acme-challenge
challenge="lifeleft-preflight-${GITHUB_RUN_ID:-manual}"
printf 'lifeleft-acme-preflight\n' | sudo -n tee "/var/www/html/.well-known/acme-challenge/$challenge" >/dev/null
if ! curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
  -H "Host: $domain" "http://127.0.0.1/.well-known/acme-challenge/$challenge" | grep -Fxq "lifeleft-acme-preflight"; then
  sudo -n rm -f "/var/www/html/.well-known/acme-challenge/$challenge"
  echo "Existing port 80 ACME webroot is unavailable." >&2
  exit 1
fi
sudo -n rm -f "/var/www/html/.well-known/acme-challenge/$challenge"

cert_dir="/etc/letsencrypt/live/$domain"
if [ ! -f "$cert_dir/fullchain.pem" ] || [ ! -f "$cert_dir/privkey.pem" ]; then
  sudo -n certbot certonly \
    --webroot \
    --webroot-path /var/www/html \
    --domain "$domain" \
    --non-interactive \
    --agree-tos \
    --register-unsafely-without-email
fi

test -f "$cert_dir/fullchain.pem"
test -f "$cert_dir/privkey.pem"

sudo -n mkdir -p "$RELEASES"
target="$RELEASES/$release_sha"
if [ ! -f "$target/index.html" ]; then
  sudo -n rm -rf "$target"
  sudo -n cp -a "$source_dir" "$target"
fi
sudo -n chmod -R a+rX "$WEB_ROOT"

mkdir -p "$BACKUPS"
prev="$(readlink -f "$CURRENT" 2>/dev/null || true)"
if [ -n "$prev" ]; then
  printf '%s\n' "$prev" > "$TX_PREV"
else
  printf '%s\n' NONE > "$TX_PREV"
fi

if [ -f "$CONF" ]; then
  backup="$BACKUPS/lifeleft-$(date -u +%Y%m%dT%H%M%SZ)-${GITHUB_RUN_ID:-manual}.conf"
  sudo -n cp "$CONF" "$backup"
  sudo -n chmod 0644 "$backup"
  printf '%s\n' "$backup" > "$TX_CONF"
else
  printf '%s\n' NONE > "$TX_CONF"
fi

if [ -L "$ENABLED" ] || [ -f "$ENABLED" ]; then
  printf '%s\n' true > "$TX_ENABLED"
else
  printf '%s\n' false > "$TX_ENABLED"
fi
printf '%s\n' "$release_sha" > "$TX_NEW"

rollback_on_error() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "LifeLeft domain cutover failed; restoring prior state." >&2
    bash "$(dirname "$0")/rollback-lifeleft-domain.sh" || true
  fi
  exit "$status"
}
trap rollback_on_error EXIT

tmp_link="$WEB_ROOT/.current-$release_sha-${GITHUB_RUN_ID:-manual}"
sudo -n ln -s "$target" "$tmp_link"
sudo -n mv -Tf "$tmp_link" "$CURRENT"

tmp_conf="$(mktemp)"
cat > "$tmp_conf" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $domain;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $domain;

    ssl_certificate $cert_dir/fullchain.pem;
    ssl_certificate_key $cert_dir/privkey.pem;

    root $CURRENT;
    index index.html;

    location /_next/static/ {
        try_files \$uri =404;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        try_files \$uri \$uri.html \$uri/index.html =404;
    }

    error_page 404 /404.html;
    location = /404.html {
        internal;
    }

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
EOF

sudo -n install -m 0644 "$tmp_conf" "$CONF"
rm -f "$tmp_conf"
sudo -n ln -sfn "$CONF" "$ENABLED"

sudo -n nginx -t
sudo -n systemctl reload nginx

smoke="$(mktemp)"
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  --resolve "$domain:443:127.0.0.1" "https://$domain/" -o "$smoke"
grep -qi '<html' "$smoke"
grep -q 'LIFELEFT' "$smoke"
rm -f "$smoke"

curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  --resolve "$domain:443:127.0.0.1" "https://$domain/commute/" >/dev/null
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  --resolve "$domain:443:127.0.0.1" "https://$domain/sitemap.xml" >/dev/null

trap - EXIT
echo "LifeLeft domain cutover complete locally: https://$domain"
echo "External verification pending."
