#!/usr/bin/env bash
set -euo pipefail

source <(sed -n '/^readonly_path_within()/,/^}/p; /^readonly_exact_active_ref()/,/^}/p' "$(dirname "$0")/disk-cleanup.sh")

readonly_path_within / /opt/obs/src/.next && exit 1
readonly_path_within /opt/obs/src /opt/obs/src/.next && exit 1
readonly_path_within /opt/obs/src/.next /opt/obs/src/.next
readonly_path_within /opt/obs/src/.next/cache /opt/obs/src/.next
! readonly_path_within /opt/obs/src/.nextish /opt/obs/src/.next

printf 'active-ref path fixture PASS (root/parent=no, exact/descendant=yes, prefix sibling=no)\n'
