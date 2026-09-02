#!/usr/bin/env bash
set -euo pipefail

revision=${1:-}
output_dir=${2:-}
if [[ -z "$revision" || -z "$output_dir" ]]; then
  echo "usage: $0 <git-revision> <output-directory>" >&2
  exit 64
fi
if [[ ! "$revision" =~ ^[0-9a-fA-F]{7,64}$ ]]; then
  echo "revision must be a hexadecimal git revision" >&2
  exit 64
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"
resolved_revision=$(git rev-parse --verify "$revision^{commit}" 2>/dev/null) || { echo "revision is not a local commit" >&2; exit 65; }
head_revision=$(git rev-parse HEAD)
[[ "$resolved_revision" == "$head_revision" ]] || { echo "release revision does not match checked-out HEAD" >&2; exit 65; }
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || { echo "refusing to package a dirty working tree" >&2; exit 65; }
revision="$resolved_revision"
[[ -f packages/mcp-server/dist/index.js ]] || { echo "build MCP server before packaging" >&2; exit 65; }
[[ -f packages/protocol/dist/index.js ]] || { echo "build protocol before packaging" >&2; exit 65; }
[[ -f packages/terminal-ui/dist/index.html ]] || { echo "build Terminal UI before packaging" >&2; exit 65; }

mkdir -p "$output_dir"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/release/packages"
pnpm --config.ignore-scripts=true --filter @terminal/mcp-server deploy --prod --legacy --reporter=append-only "$stage/release/packages/mcp-server"
HUSKY=0 pnpm --filter @terminal/local-agent deploy --prod --legacy --reporter=append-only "$stage/release/packages/local-agent"
mkdir -p "$stage/release/packages/terminal-ui/dist" "$stage/release/packages/terminal-ui/src"
cp -p packages/terminal-ui/dist/index.html "$stage/release/packages/terminal-ui/dist/index.html"
cp -p packages/terminal-ui/src/main.ts "$stage/release/packages/terminal-ui/src/main.ts"
cp -p packages/terminal-ui/src/styles.css "$stage/release/packages/terminal-ui/src/styles.css"
printf '%s\n' "$revision" > "$stage/release/REVISION"

(
  cd "$stage/release/packages/local-agent"
  node --input-type=module -e "const pty = await import('node-pty'); const proc = pty.spawn('/bin/sh', ['-lc', 'printf __TERMINAL_NATIVE_PTY_OK__'], { name: 'xterm', cols: 80, rows: 24, cwd: process.cwd(), env: process.env }); let output = ''; proc.onData((chunk) => { output += chunk; }); await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('native PTY packaging self-test timed out')), 3000); proc.onExit(() => { clearTimeout(timer); resolve(); }); }); if (!output.includes('__TERMINAL_NATIVE_PTY_OK__')) throw new Error('native PTY packaging self-test produced no expected output');"
)
printf 'node_major=%s\n' "$(node -p 'process.versions.node.split(".")[0]')" > "$stage/release/NATIVE_RUNTIME_VERIFIED"

node --input-type=module -e "await import(process.argv[1]);" "$stage/release/packages/mcp-server/dist/index.js"
node --input-type=module -e "const runtime = await import(process.argv[1]); await runtime.readTerminalUiDocument(); await runtime.readTerminalUiStyles();" "$stage/release/packages/mcp-server/dist/ui-runtime.js"
archive="$output_dir/chatgpt-terminal-mcp-${revision}.tar.gz"
tar -C "$stage/release" -czf "$archive" .
archive_basename=$(basename "$archive")
(
  cd "$output_dir"
  sha256sum "$archive_basename" > "$archive_basename.sha256"
)
printf 'release_archive=%s\n' "$archive"
printf 'release_sha256=%s\n' "$(cut -d' ' -f1 "$archive.sha256")"
