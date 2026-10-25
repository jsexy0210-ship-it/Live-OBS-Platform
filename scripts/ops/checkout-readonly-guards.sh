#!/usr/bin/env bash
# Read-only checkout identity, mount and active-reference guards. No cleanup functions.
readonly_path_overlap() {
  local a="$1" b="$2"
  [[ "$a" == "$b" || "$a" == "/" || "$b" == "/" || "$a" == "$b/"* || "$b" == "$a/"* ]]
}

readonly_path_within() {
  local path="$1" target="$2"
  [[ "$path" == "$target" || "$path" == "$target/"* ]]
}

readonly_checkout_git_state() {
  local root="$1" top="" origin="" status="" identity=UNKNOWN dirty=UNKNOWN
  top="$(git -C "$root" rev-parse --show-toplevel 2>/dev/null || true)"
  origin="$(git -C "$root" remote get-url origin 2>/dev/null || true)"
  case "${origin,,}" in
    https://github.com/jsexy0210-ship-it/live-obs-platform|https://github.com/jsexy0210-ship-it/live-obs-platform.git|git@github.com:jsexy0210-ship-it/live-obs-platform|git@github.com:jsexy0210-ship-it/live-obs-platform.git)
      [ "$top" = "$root" ] && identity=ONQ ;;
  esac
  if [ "$identity" = ONQ ]; then
    if status="$(git -C "$root" status --porcelain --untracked-files=normal 2>/dev/null)"; then
      [ -z "$status" ] && dirty=clean || dirty=dirty
    fi
  fi
  printf '%s %s' "$identity" "$dirty"
}

readonly_target_mount_state() {
  local root="$1" target="$2" mounts mount root_mount="" target_mount="" nested=no
  local root_mount_len=0 target_mount_len=0 mount_len
  [ -r /proc/self/mountinfo ] || { printf 'UNKNOWN'; return; }
  mounts="$(awk '{print $5}' /proc/self/mountinfo 2>/dev/null)" || { printf 'UNKNOWN'; return; }
  [ -n "$mounts" ] || { printf 'UNKNOWN'; return; }
  while IFS= read -r mount; do
    mount_len=${#mount}
    if { [ "$mount" = / ] || [ "$target" = "$mount" ] || [[ "$target" == "$mount/"* ]]; } && [ "$mount_len" -gt "$target_mount_len" ]; then
      target_mount="$mount"; target_mount_len="$mount_len"
    fi
    if { [ "$mount" = / ] || [ "$root" = "$mount" ] || [[ "$root" == "$mount/"* ]]; } && [ "$mount_len" -gt "$root_mount_len" ]; then
      root_mount="$mount"; root_mount_len="$mount_len"
    fi
    case "$mount" in "$target"|"$target/"*) nested=yes ;; esac
  done <<<"$mounts"
  if [ -z "$root_mount" ] || [ -z "$target_mount" ]; then printf 'UNKNOWN'
  elif [ "$nested" = yes ] || [ "$target_mount" != "$root_mount" ]; then printf 'separate'
  else printf 'same'
  fi
}

readonly_exact_active_ref() {
  local target="$1" proc_root="${2:-/proc}" proc entry path found=0 incomplete=0
  [ -d "$proc_root" ] && [ -r "$proc_root" ] || { printf 'UNKNOWN'; return; }
  for proc in "$proc_root"/[0-9]*; do
    [ -d "$proc" ] || continue
    if [ ! -r "$proc/fd" ]; then incomplete=1; continue; fi
    for entry in "$proc"/cwd "$proc"/root "$proc"/exe "$proc"/fd/*; do
      if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then incomplete=1; continue; fi
      if ! path="$(readlink -- "$entry" 2>/dev/null)"; then incomplete=1; continue; fi
      if readonly_path_within "${path% (deleted)}" "$target"; then found=1; break 2; fi
    done
  done
  if [ "$found" = 1 ]; then printf 'yes'
  elif [ "$incomplete" = 1 ]; then printf 'UNKNOWN'
  else printf 'no'
  fi
}

readonly_live_app_mount_sources() {
  local ids id mounts source all_mounts="" failed=0
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || { printf 'UNKNOWN'; return; }
  ids="$(docker ps -q --filter label=com.docker.compose.project=obs-web --filter label=com.docker.compose.service=obs-web-app 2>/dev/null)" || { printf 'UNKNOWN'; return; }
  [ -n "$ids" ] || { printf 'UNKNOWN'; return; }
  for id in $ids; do
    mounts="$(docker inspect --format '{{range .Mounts}}{{println .Source}}{{end}}' "$id" 2>/dev/null)" || { failed=1; continue; }
    while IFS= read -r source; do
      [ -z "$source" ] && continue
      [[ "$source" == /* && "$source" != *$'\r'* ]] || failed=1
    done <<<"$mounts"
    all_mounts+="${mounts}"$'\n'
  done
  [ "$failed" = 0 ] || { printf 'UNKNOWN'; return; }
  printf 'KNOWN\n%s\n__END__' "$all_mounts"
}

readonly_live_app_ref_for_target() {
  local state="$1" sources="$2" target="$3" source target_real source_real unresolved=0
  [ "$state" = KNOWN ] || { printf 'UNKNOWN'; return; }
  command -v realpath >/dev/null 2>&1 || { printf 'UNKNOWN'; return; }
  target_real="$(realpath -e -- "$target" 2>/dev/null || true)"
  [ -n "$target_real" ] || { printf 'UNKNOWN'; return; }
  while IFS= read -r source; do
    [ -n "$source" ] || continue
    source_real="$(realpath -e -- "$source" 2>/dev/null || true)"
    if [ -z "$source_real" ]; then unresolved=1; continue; fi
    if readonly_path_overlap "$source_real" "$target_real"; then printf 'yes'; return; fi
  done <<<"$sources"
  [ "$unresolved" = 0 ] && printf 'no' || printf 'UNKNOWN'
}
