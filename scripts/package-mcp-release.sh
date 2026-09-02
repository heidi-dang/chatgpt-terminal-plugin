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
pnpm --filter @terminal/mcp-server deploy --prod --legacy --reporter=append-only "$stage/release/packages/mcp-server"
mkdir -p "$stage/release/packages/terminal-ui/dist"
cp packages/terminal-ui/dist/index.html "$stage/release/packages/terminal-ui/dist/index.html"
printf '%s\n' "$revision" > "$stage/release/REVISION"

node --input-type=module -e "await import(process.argv[1]);" "$stage/release/packages/mcp-server/dist/index.js"
archive="$output_dir/chatgpt-terminal-mcp-${revision}.tar.gz"
tar -C "$stage/release" -czf "$archive" .
sha256sum "$archive" > "$archive.sha256"
printf 'release_archive=%s\n' "$archive"
printf 'release_sha256=%s\n' "$(cut -d' ' -f1 "$archive.sha256")"
