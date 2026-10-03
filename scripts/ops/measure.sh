#!/usr/bin/env bash
# measure.mjs를 node 컨테이너로 실행한다(서버에는 Node가 없음). 결과는 /opt/obs/checks/measure-<KST>-<이름표>.json
# 사용: scripts/ops/measure.sh <이름표> [초=60] [초당 요청=20] [주소=http://127.0.0.1/api/health]
. "$(dirname "$0")/lib.sh"

label="${1:?사용법: measure.sh <이름표> [초] [초당 요청] [주소]}"
dur="${2:-60}"; rps="${3:-20}"; url="${4:-$HEALTH_URL}"
mkdir -p "$CHECK_DIR"
name="measure-$(kst +%Y%m%d-%H%M%S)-$label.json"
docker run --rm --network host -v "$OPS_ROOT/scripts/ops:/ops:ro" -v "$CHECK_DIR:/out" node:22-bookworm-slim \
  node /ops/measure.mjs --url "$url" --duration "$dur" --rps "$rps" --label "$label" --out "/out/$name"
log "결과: $CHECK_DIR/$name"
