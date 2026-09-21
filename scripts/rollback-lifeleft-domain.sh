#!/usr/bin/env bash
set -euo pipefail

ROOT=/home/ubuntu/LifeLeft
WEB_ROOT=/var/www/lifeleft
CURRENT="$WEB_ROOT/current"
CONF=/etc/nginx/sites-available/lifeleft
ENABLED=/etc/nginx/sites-enabled/lifeleft
TX_PREV="$ROOT/.domain-update-prev-target"
TX_CONF="$ROOT/.domain-update-conf-backup"
TX_ENABLED="$ROOT/.domain-update-prev-enabled"
TX_NEW="$ROOT/.domain-update-new-sha"

if [ ! -r "$TX_NEW" ]; then
  echo "No pending LifeLeft domain transaction."
  exit 0
fi

prev="$(cat "$TX_PREV" 2>/dev/null || echo NONE)"
conf_backup="$(cat "$TX_CONF" 2>/dev/null || echo NONE)"
prev_enabled="$(cat "$TX_ENABLED" 2>/dev/null || echo false)"

if [ "$prev" = "NONE" ]; then
  sudo -n rm -f "$CURRENT"
else
  sudo -n ln -sfn "$prev" "$CURRENT"
fi

if [ "$conf_backup" = "NONE" ]; then
  sudo -n rm -f "$CONF"
else
  sudo -n cp "$conf_backup" "$CONF"
fi

if [ "$prev_enabled" = "true" ] && [ -f "$CONF" ]; then
  sudo -n ln -sfn "$CONF" "$ENABLED"
else
  sudo -n rm -f "$ENABLED"
fi

sudo -n nginx -t
sudo -n systemctl reload nginx

rm -f "$TX_PREV" "$TX_CONF" "$TX_ENABLED" "$TX_NEW"
echo "LifeLeft domain rollback complete."
