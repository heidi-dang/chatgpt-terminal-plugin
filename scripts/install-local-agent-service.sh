#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
INSTALL_ROOT="$HOME/.local/share/chatgpt-terminal-plugin"
CURRENT_LINK="$INSTALL_ROOT/current"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/chatgpt-terminal-agent.service"
ENV_FILE="$HOME/.config/chatgpt-terminal-plugin/agent.env"
UNIT_SOURCE="$ROOT_DIR/deploy/systemd/chatgpt-terminal-agent.service.example"
RESTART=1
TMP_LINK=''

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-local-agent-service.sh [--no-restart]

Install or update the ChatGPT Terminal local-agent user service through a stable
~/.local/share/chatgpt-terminal-plugin/current symlink. Run this only from a
checkout that has already passed ./install.sh --verify (or an equivalent gate).

Options:
  --no-restart  Stage the stable pointer and systemd unit without restarting the agent.
  -h, --help    Show this help text.
USAGE
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$TMP_LINK" ]]; then
    rm -f -- "$TMP_LINK"
  fi
}
trap cleanup EXIT

while (($#)); do
  case "$1" in
    --no-restart)
      RESTART=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
  shift
done

command -v systemctl >/dev/null 2>&1 || die 'systemctl is required for the user service.'
[[ -f "$ROOT_DIR/packages/local-agent/dist/cli.js" ]] || \
  die 'Built local-agent entrypoint is missing. Run ./install.sh --verify first.'
[[ -f "$UNIT_SOURCE" ]] || die 'Local-agent systemd unit template is missing.'
[[ -f "$ENV_FILE" ]] || \
  die "Agent environment file is missing: $ENV_FILE (configure it before installing the service)."

mkdir -p -- "$INSTALL_ROOT" "$UNIT_DIR"

# Keep systemd bound to one durable path. Only this symlink changes between verified
# checkouts/releases, so a timestamped checkout is never baked into the service unit.
TMP_LINK="$INSTALL_ROOT/.current.$$"
ln -s -- "$ROOT_DIR" "$TMP_LINK"
mv -Tf -- "$TMP_LINK" "$CURRENT_LINK"
TMP_LINK=''

install -m 0644 -- "$UNIT_SOURCE" "$UNIT_PATH"
systemctl --user daemon-reload
systemctl --user enable chatgpt-terminal-agent.service >/dev/null

if ((RESTART)); then
  # Agent restart intentionally replaces its gateway connection/PTY ownership; callers
  # should run the updater between Terminal turns, not during an active user PTY.
  systemctl --user restart chatgpt-terminal-agent.service
  systemctl --user is-active --quiet chatgpt-terminal-agent.service || \
    die 'chatgpt-terminal-agent.service did not become active.'
  printf 'Updated local-agent service to %s and restarted it successfully.\n' "$ROOT_DIR"
else
  printf 'Staged local-agent service at %s -> %s without restarting it.\n' "$CURRENT_LINK" "$ROOT_DIR"
fi
