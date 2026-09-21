#!/usr/bin/env bash
set -euo pipefail

ROOT=/home/ubuntu/LifeLeft
TX_PREV="$ROOT/.domain-update-prev-target"
TX_CONF="$ROOT/.domain-update-conf-backup"
TX_ENABLED="$ROOT/.domain-update-prev-enabled"
TX_NEW="$ROOT/.domain-update-new-sha"
LIVE="$ROOT/static-live-domain"

if [ ! -r "$TX_NEW" ]; then
  echo "No pending LifeLeft domain transaction."
  exit 0
fi

sha="$(cat "$TX_NEW")"
printf '%s\n' "$sha" > "$LIVE"
rm -f "$TX_PREV" "$TX_CONF" "$TX_ENABLED" "$TX_NEW"

echo "LifeLeft domain release finalized: $sha"
