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
UNIT_BACKUP=''
PREVIOUS_CURRENT_TARGET=''
PREVIOUS_CURRENT_PRESENT=0
PREVIOUS_UNIT_PRESENT=0
PREVIOUS_ENABLED=0
MUTATION_STARTED=0
INSTALL_COMMITTED=0
SERVICE_NAME='chatgpt-terminal-agent.service'

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
  rc=$?
  trap - EXIT
  set +e

  if ((MUTATION_STARTED && !INSTALL_COMMITTED)); then
    if ((PREVIOUS_CURRENT_PRESENT)); then
      rollback_link="$INSTALL_ROOT/.current.rollback.$$"
      ln -s -- "$PREVIOUS_CURRENT_TARGET" "$rollback_link"
      mv -Tf -- "$rollback_link" "$CURRENT_LINK"
    else
      rm -f -- "$CURRENT_LINK"
    fi

    if ((PREVIOUS_UNIT_PRESENT)); then
      install -m 0644 -- "$UNIT_BACKUP" "$UNIT_PATH"
    else
      rm -f -- "$UNIT_PATH"
    fi

    systemctl --user daemon-reload || true
    if ((PREVIOUS_ENABLED)); then
      systemctl --user enable "$SERVICE_NAME" >/dev/null 2>&1 || true
      ((RESTART)) && systemctl --user restart "$SERVICE_NAME" || true
    else
      systemctl --user disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
    fi
  fi

  [[ -z "$TMP_LINK" ]] || rm -f -- "$TMP_LINK"
  [[ -z "$UNIT_BACKUP" ]] || rm -f -- "$UNIT_BACKUP"
  exit "$rc"
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

if [[ -L "$CURRENT_LINK" ]]; then
  PREVIOUS_CURRENT_TARGET=$(readlink -- "$CURRENT_LINK")
  PREVIOUS_CURRENT_PRESENT=1
elif [[ -e "$CURRENT_LINK" ]]; then
  die "$CURRENT_LINK must be a symlink or absent."
fi
if [[ -f "$UNIT_PATH" ]]; then
  UNIT_BACKUP=$(mktemp "$INSTALL_ROOT/.agent-unit-backup.XXXXXX")
  cp -p -- "$UNIT_PATH" "$UNIT_BACKUP"
  PREVIOUS_UNIT_PRESENT=1
elif [[ -e "$UNIT_PATH" ]]; then
  die "$UNIT_PATH must be a regular file or absent."
fi
if systemctl --user is-enabled --quiet "$SERVICE_NAME" >/dev/null 2>&1; then
  PREVIOUS_ENABLED=1
fi

MUTATION_STARTED=1

# Keep systemd bound to one durable path. Only this symlink changes between verified
# checkouts/releases, so a timestamped checkout is never baked into the service unit.
TMP_LINK="$INSTALL_ROOT/.current.$$"
ln -s -- "$ROOT_DIR" "$TMP_LINK"
mv -Tf -- "$TMP_LINK" "$CURRENT_LINK"
TMP_LINK=''

install -m 0644 -- "$UNIT_SOURCE" "$UNIT_PATH"
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME" >/dev/null

if ((RESTART)); then
  # Agent restart intentionally replaces its gateway connection/PTY ownership; callers
  # should run the updater between Terminal turns, not during an active user PTY.
  systemctl --user restart "$SERVICE_NAME"
  systemctl --user is-active --quiet "$SERVICE_NAME" || \
    die 'chatgpt-terminal-agent.service did not become active.'
  printf 'Updated local-agent service to %s and restarted it successfully.\n' "$ROOT_DIR"
else
  printf 'Staged local-agent service at %s -> %s without restarting it.\n' "$CURRENT_LINK" "$ROOT_DIR"
fi
