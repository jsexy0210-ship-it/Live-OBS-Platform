#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:-out}"
RELEASE_SHA="${2:-${GITHUB_SHA:-}}"
ROOT="/home/ubuntu/LifeLeft"
RELEASES="$ROOT/static-releases"

if [[ ! "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid release SHA" >&2
  exit 1
fi

test -f "$SOURCE_DIR/index.html"
test -f "$SOURCE_DIR/commute/index.html"
test -f "$SOURCE_DIR/salary/index.html"
test -f "$SOURCE_DIR/weekends/index.html"
test -f "$SOURCE_DIR/work-time/index.html"
test -f "$SOURCE_DIR/subscriptions/index.html"
test -f "$SOURCE_DIR/survival/index.html"

mkdir -p "$RELEASES"

release="$RELEASES/$RELEASE_SHA"
incoming="$ROOT/.static-incoming-$RELEASE_SHA-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}"
previous="$ROOT/.static-previous-$RELEASE_SHA-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}"

cleanup() {
  rm -rf "$incoming"
}
trap cleanup EXIT

root_device="$(stat -c %d "$ROOT")"
release_device="$(stat -c %d "$RELEASES")"
if [ "$root_device" != "$release_device" ]; then
  echo "Release directory must share the LifeLeft filesystem" >&2
  exit 1
fi

rm -rf "$incoming" "$previous"
mkdir -p "$incoming"
cp -a "$SOURCE_DIR"/. "$incoming"/

test -f "$incoming/index.html"
test -f "$incoming/commute/index.html"
test -f "$incoming/salary/index.html"
test -f "$incoming/weekends/index.html"
test -f "$incoming/work-time/index.html"
test -f "$incoming/subscriptions/index.html"
test -f "$incoming/survival/index.html"

if [ -e "$release" ]; then
  mv "$release" "$previous"
fi

if ! mv "$incoming" "$release"; then
  if [ -e "$previous" ]; then
    mv "$previous" "$release" || true
  fi
  exit 1
fi

rm -rf "$previous"

candidate_tmp="$RELEASES/.latest-candidate-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}"
printf '%s\n' "$RELEASE_SHA" > "$candidate_tmp"
mv -f "$candidate_tmp" "$RELEASES/latest-candidate"

trap - EXIT
echo "LifeLeft static candidate staged: $release"
echo "Public cutover: not performed"
