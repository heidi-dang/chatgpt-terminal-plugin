#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

DEV_MODE=0
VERIFY_ONLY=0
SKIP_TESTS=0

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  BOLD=$'\033[1m'
  GREEN=$'\033[32m'
  CYAN=$'\033[36m'
  YELLOW=$'\033[33m'
  RED=$'\033[31m'
  RESET=$'\033[0m'
else
  BOLD=''
  GREEN=''
  CYAN=''
  YELLOW=''
  RED=''
  RESET=''
fi

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Bootstrap and verify the ChatGPT Terminal Plugin monorepo.

Options:
  --dev         Developer bootstrap. Installs dependencies, builds all packages,
                and runs fast static/unit verification (skips E2E).
  --verify      Verification only. Requires dependencies to already be installed;
                runs typecheck, lint, unit tests, build, and E2E tests.
  --skip-tests  Skip unit and E2E test suites. Typecheck, lint, and build still run.
  -h, --help    Show this help text.

Default:
  Install the frozen dependency graph, typecheck, lint, run unit tests, build the
  MCP server/local agent/protocol/Terminal UI, then run the real-PTY E2E suite.
EOF
}

log() {
  printf '%s==>%s %s\n' "$CYAN" "$RESET" "$*"
}

success() {
  printf '%s%s✓%s %s\n' "$BOLD" "$GREEN" "$RESET" "$*"
}

warn() {
  printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2
}

die() {
  printf '%sError:%s %s\n' "$RED" "$RESET" "$*" >&2
  exit 1
}

on_error() {
  local exit_code=$?
  local line_no=${BASH_LINENO[0]:-unknown}
  printf '%sError:%s installer failed near line %s (exit %s).\n' "$RED" "$RESET" "$line_no" "$exit_code" >&2
  exit "$exit_code"
}
trap on_error ERR

while (($#)); do
  case "$1" in
    --dev)
      DEV_MODE=1
      ;;
    --verify)
      VERIFY_ONLY=1
      ;;
    --skip-tests)
      SKIP_TESTS=1
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

if ((DEV_MODE && VERIFY_ONLY)); then
  die '--dev and --verify cannot be used together.'
fi

command -v node >/dev/null 2>&1 || die 'Node.js 22 or newer is required.'
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || die 'Unable to determine the installed Node.js major version.'
((NODE_MAJOR >= 22)) || die "Node.js 22 or newer is required; found $(node --version)."

[[ -f package.json && -f pnpm-lock.yaml && -f pnpm-workspace.yaml ]] || \
  die 'Run this installer from a complete chatgpt-terminal-plugin checkout.'

PACKAGE_MANAGER_SPEC="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).packageManager')"
[[ "$PACKAGE_MANAGER_SPEC" == pnpm@* ]] || die "Unsupported packageManager declaration: $PACKAGE_MANAGER_SPEC"
EXPECTED_PNPM_VERSION="${PACKAGE_MANAGER_SPEC#pnpm@}"
PNPM_CMD=()

if command -v pnpm >/dev/null 2>&1 && [[ "$(pnpm --version 2>/dev/null || true)" == "$EXPECTED_PNPM_VERSION" ]]; then
  PNPM_CMD=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  PNPM_CMD=(corepack pnpm)
  ACTUAL_PNPM_VERSION="$("${PNPM_CMD[@]}" --version 2>/dev/null || true)"
  [[ "$ACTUAL_PNPM_VERSION" == "$EXPECTED_PNPM_VERSION" ]] || \
    die "Corepack did not resolve pnpm $EXPECTED_PNPM_VERSION (resolved: ${ACTUAL_PNPM_VERSION:-none})."
elif command -v npx >/dev/null 2>&1; then
  warn "pnpm $EXPECTED_PNPM_VERSION is not installed; using npx for this run."
  PNPM_CMD=(npx --yes "pnpm@$EXPECTED_PNPM_VERSION")
else
  die "pnpm $EXPECTED_PNPM_VERSION is required. Install Corepack or pnpm and rerun ./install.sh."
fi

pnpm_run() {
  "${PNPM_CMD[@]}" "$@"
}

log "Node $(node --version)"
log "pnpm $(pnpm_run --version)"

if ((VERIFY_ONLY)); then
  [[ -d node_modules ]] || die 'node_modules is missing. Run ./install.sh first.'
  log 'Verification-only mode: keeping the installed dependency graph unchanged.'
else
  if ((DEV_MODE)); then
    log 'Installing workspace dependencies for development...'
    pnpm_run install
  else
    log 'Installing the frozen dependency graph...'
    pnpm_run install --frozen-lockfile
  fi
fi

log 'Running TypeScript checks...'
pnpm_run typecheck

log 'Running ESLint...'
pnpm_run lint

if ((SKIP_TESTS == 0)); then
  log 'Running unit tests...'
  pnpm_run test
else
  warn 'Unit tests skipped by --skip-tests.'
fi

log 'Building protocol, Terminal UI, MCP server, and local agent...'
pnpm_run build

if ((SKIP_TESTS == 0)); then
  if ((DEV_MODE)); then
    warn 'E2E tests skipped in --dev mode. Run ./install.sh --verify before release.'
  else
    log 'Running real-PTY MCP end-to-end tests...'
    pnpm_run test:e2e
  fi
else
  warn 'E2E tests skipped by --skip-tests.'
fi

success 'ChatGPT Terminal Plugin is installed and verified.'
printf '\nNext steps:\n'
printf '  Server config: deploy/server-environment.example\n'
printf '  Agent config:  deploy/local-agent-environment.example\n'
printf '  Deployment:    docs/deployment.md\n'
printf '  Development:   pnpm dev\n'
