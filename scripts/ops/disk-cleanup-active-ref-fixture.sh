#!/usr/bin/env bash
set -euo pipefail

script="$(dirname "$0")/disk-cleanup.sh"
source <(sed -n '/^readonly_path_within()/,/^}/p; /^readonly_exact_active_ref()/,/^}/p; /^readonly_space_details()/,/^}/p' "$script")

readonly_path_within / /opt/obs/src/.next && exit 1
readonly_path_within /opt/obs/src /opt/obs/src/.next && exit 1
readonly_path_within /opt/obs/src/.next /opt/obs/src/.next
readonly_path_within /opt/obs/src/.next/cache /opt/obs/src/.next
! readonly_path_within /opt/obs/src/.nextish /opt/obs/src/.next

printf 'active-ref path fixture PASS (root/parent=no, exact/descendant=yes, prefix sibling=no)\n'

log() { printf '%s\n' "$*"; }
df() {
  case "$1" in
    -hP) printf 'Filesystem Size Used Avail Use%% Mounted on\n/dev/private 60G 20G 39G 34%% /private/mount\n' ;;
    -iP) printf 'Filesystem Inodes IUsed IFree IUse%% Mounted on\n/dev/private 100 20 80 20%% /private/mount\n' ;;
    *) return 1 ;;
  esac
}
space_output="$(readonly_space_details fixture /)"
grep -Fq 'fixture 공간(총량/사용/남음/사용률): 60G 20G 39G 34%' <<<"$space_output"
! grep -Eq '/dev/private|/private/mount' <<<"$space_output"
printf 'filesystem detail fixture PASS (total/used/free/percent only)\n'

root="$(cd "$(dirname "$0")/../.." && pwd -P)"
workflow="$root/.github/workflows/disk-cleanup-obs-test.yml"
preflight="$(awk '
  /^      - name: Verify isolated checkout path$/ { in_step=1; next }
  in_step && /^        run: \|$/ { in_run=1; next }
  in_run && /^      - name:/ { exit }
  in_run { sub(/^          /, ""); print }
' "$workflow")"
[ -n "$preflight" ] || { echo 'checkout preflight block missing' >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
workspace="$tmp/workspace"
mkdir "$workspace"
git -C "$workspace" init --quiet
git -C "$workspace" config user.name fixture
git -C "$workspace" config user.email fixture@example.invalid
printf 'parent repository evidence\n' > "$workspace/runner-evidence"
git -C "$workspace" add runner-evidence
git -C "$workspace" commit --quiet -m fixture
printf 'preserve this dirty parent file\n' > "$workspace/runner-evidence"
parent_head="$(git -C "$workspace" rev-parse HEAD)"
parent_status="$(git -C "$workspace" status --porcelain --untracked-files=no)"
output="$tmp/github-output"
: > "$output"
run_preflight() {
  env GITHUB_WORKSPACE="$1" GITHUB_RUN_ID="$2" GITHUB_RUN_ATTEMPT=2 GITHUB_OUTPUT="$3" bash -euo pipefail -c "$preflight"
}

run_preflight "$workspace" 12345 "$output"
[ "$(cat "$output")" = 'checkout_path=disk-cleanup-12345-2' ]
[ -d "$workspace/disk-cleanup-12345-2" ]
[ -z "$(ls -A "$workspace/disk-cleanup-12345-2")" ]
# Before checkout initializes its target, Git can discover the parent repository.
[ "$(git -C "$workspace/disk-cleanup-12345-2" rev-parse --show-prefix)" = 'disk-cleanup-12345-2/' ]
# actions/checkout@v5 sees no target/.git, clears only the reserved target, then initializes there.
git -C "$workspace/disk-cleanup-12345-2" init --quiet
[ -z "$(git -C "$workspace/disk-cleanup-12345-2" rev-parse --show-prefix)" ]
[ "$(git -C "$workspace" rev-parse HEAD)" = "$parent_head" ]
[ "$(git -C "$workspace" status --porcelain --untracked-files=no)" = "$parent_status" ]
grep -Fxq 'preserve this dirty parent file' "$workspace/runner-evidence"
printf 'checkout preflight fixture PASS (checkout initializes a separate repository and preserves parent state)\n'

: > "$output"
existing_workspace="$tmp/existing-workspace"
mkdir "$existing_workspace"
printf 'preserve this runner evidence\n' > "$existing_workspace/disk-cleanup-12346-2"
if run_preflight "$existing_workspace" 12346 "$output" 2>/dev/null; then echo 'existing checkout path was accepted' >&2; exit 1; fi
grep -Fxq 'preserve this runner evidence' "$existing_workspace/disk-cleanup-12346-2"
[ ! -s "$output" ]
printf 'checkout preflight fixture PASS (existing file is rejected and preserved)\n'

: > "$output"
symlink_workspace="$tmp/symlink-workspace"
mkdir "$symlink_workspace"
outside="$tmp/outside"
mkdir "$outside"
printf 'preserve symlink target\n' > "$outside/evidence"
ln -s "$outside" "$symlink_workspace/disk-cleanup-12347-2"
if run_preflight "$symlink_workspace" 12347 "$output" 2>/dev/null; then echo 'symlink checkout path was accepted' >&2; exit 1; fi
grep -Fxq 'preserve symlink target' "$outside/evidence"
[ ! -s "$output" ]
printf 'checkout preflight fixture PASS (symlink target is rejected and preserved)\n'

grep -Fq 'path: ${{ steps.isolated_checkout.outputs.checkout_path }}' "$workflow"
grep -Fq 'clean: false' "$workflow"
grep -Fq 'persist-credentials: false' "$workflow"
grep -Fq 'if: always() && steps.checkout.outcome == '\''success'\''' "$workflow"
grep -Fq 'path: ${{ steps.isolated_checkout.outputs.checkout_path }}' "$workflow"
[ "$(grep -Fc 'working-directory: ${{ github.workspace }}/${{ steps.isolated_checkout.outputs.checkout_path }}' "$workflow")" -eq 3 ]
printf 'checkout workflow fixture PASS (isolated path, no clean, no persisted credentials)\n'
