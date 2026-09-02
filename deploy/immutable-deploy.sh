#!/usr/bin/env bash
set -euo pipefail

archive=${1:-}
checksum_file=${2:-}
revision=${3:-}
: "${TERMINAL_DEPLOY_ROOT:?TERMINAL_DEPLOY_ROOT is required}"
: "${TERMINAL_SERVICE_NAME:?TERMINAL_SERVICE_NAME is required}"
: "${TERMINAL_HEALTH_URL:?TERMINAL_HEALTH_URL is required}"
agent_service=${TERMINAL_AGENT_SERVICE_NAME:-}
[[ -f "$archive" && -f "$checksum_file" ]] || { echo "release archive/checksum missing" >&2; exit 66; }
[[ "$revision" =~ ^[0-9a-fA-F]{7,64}$ ]] || { echo "invalid revision" >&2; exit 64; }

expected=$(awk 'NR==1 { print $1 }' "$checksum_file")
actual=$(sha256sum "$archive" | awk '{ print $1 }')
[[ -n "$expected" && "$actual" == "$expected" ]] || { echo "artifact checksum mismatch" >&2; exit 65; }

mkdir -p "$TERMINAL_DEPLOY_ROOT"
lock_path=${TERMINAL_DEPLOY_LOCK_PATH:-"$TERMINAL_DEPLOY_ROOT/.deploy.lock"}
exec 9>"$lock_path"
if ! flock -n 9; then
  echo "another Terminal deployment is already in progress" >&2
  exit 75
fi

releases="$TERMINAL_DEPLOY_ROOT/releases"
current="$TERMINAL_DEPLOY_ROOT/current"
release_dir="$releases/$revision"
mkdir -p "$releases"
if [[ -e "$current" && ! -L "$current" ]]; then
  echo "current must be a symlink or absent" >&2
  exit 65
fi
previous=''
if [[ -L "$current" ]]; then
  previous=$(readlink -f "$current")
  [[ -d "$previous" ]] || { echo "current points to a missing release" >&2; exit 65; }
fi
staging=''
switched=0

rollback() {
  rc=$?
  trap - ERR
  if [[ $switched -eq 1 ]]; then
    if [[ -n "$previous" && -d "$previous" ]]; then
      rollback_link="$TERMINAL_DEPLOY_ROOT/.current.rollback.$$"
      ln -s "$previous" "$rollback_link"
      mv -Tf "$rollback_link" "$current"
      sudo systemctl restart "$TERMINAL_SERVICE_NAME" || true
      [[ -z "$agent_service" ]] || sudo systemctl restart "$agent_service" || true
    else
      rm -f "$current"
    fi
  fi
  [[ -n "$staging" && -d "$staging" ]] && rm -rf "$staging"
  exit "$rc"
}
trap rollback ERR

if [[ -d "$release_dir" ]]; then
  [[ "$(cat "$release_dir/REVISION" 2>/dev/null)" == "$revision" ]] || { echo "existing immutable release has wrong revision" >&2; exit 65; }
  [[ "$(cat "$release_dir/ARTIFACT_SHA256" 2>/dev/null)" == "$expected" ]] || { echo "existing immutable release has different artifact" >&2; exit 65; }
else
  staging=$(mktemp -d "$releases/.staging-${revision}.XXXXXX")
  tar -xzf "$archive" -C "$staging"
  [[ "$(cat "$staging/REVISION")" == "$revision" ]] || { echo "release revision mismatch" >&2; exit 65; }
  [[ -f "$staging/packages/mcp-server/dist/cli.js" ]] || { echo "MCP CLI missing from release" >&2; exit 65; }
  [[ -f "$staging/packages/local-agent/dist/cli.js" ]] || { echo "local-agent CLI missing from release" >&2; exit 65; }
  [[ -f "$staging/packages/terminal-ui/dist/index.html" ]] || { echo "Terminal UI missing from release" >&2; exit 65; }
  [[ -f "$staging/NATIVE_RUNTIME_VERIFIED" ]] || { echo "native runtime verification marker missing from release" >&2; exit 65; }
  packaged_node_major=$(awk -F= '$1 == "node_major" { print $2 }' "$staging/NATIVE_RUNTIME_VERIFIED")
  runtime_node_major=$(node -p 'process.versions.node.split(".")[0]')
  [[ -n "$packaged_node_major" && "$packaged_node_major" == "$runtime_node_major" ]] || { echo "release native runtime Node major does not match production Node major" >&2; exit 65; }
  (cd "$staging/packages/local-agent" && node --input-type=module -e "await import('node-pty');")
  (cd "$staging" && node --input-type=module -e "await import('./packages/mcp-server/dist/index.js');")
  printf '%s\n' "$expected" > "$staging/ARTIFACT_SHA256"
  chmod -R a-w "$staging"
  mv "$staging" "$release_dir"
  staging=''
fi

next_link="$TERMINAL_DEPLOY_ROOT/.current.next.$$"
ln -s "$release_dir" "$next_link"
mv -Tf "$next_link" "$current"
switched=1
sudo systemctl restart "$TERMINAL_SERVICE_NAME"
sudo systemctl is-active --quiet "$TERMINAL_SERVICE_NAME"
curl --retry 8 --retry-delay 1 --retry-all-errors --connect-timeout 5 --max-time 10 -fsS "$TERMINAL_HEALTH_URL" >/dev/null
if [[ -n "$agent_service" ]]; then
  sudo systemctl restart "$agent_service"
  [[ "$(sudo systemctl show -p ActiveState --value "$agent_service")" == "active" ]] || { echo "local-agent service did not become active" >&2; exit 1; }
  [[ "$(sudo systemctl show -p SubState --value "$agent_service")" == "running" ]] || { echo "local-agent service did not enter running state" >&2; exit 1; }
  [[ "$(sudo systemctl show -p MainPID --value "$agent_service")" != "0" ]] || { echo "local-agent service has no running main process" >&2; exit 1; }
fi
switched=0
trap - ERR
printf 'deployed_revision=%s\n' "$revision"
printf 'release_dir=%s\n' "$release_dir"
