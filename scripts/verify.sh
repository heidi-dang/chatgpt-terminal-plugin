#!/usr/bin/env bash
set -euo pipefail

echo "1/5 lint"
pnpm run lint

echo "2/5 typecheck"
pnpm run typecheck

echo "3/5 unit tests"
pnpm run test

echo "4/5 real PTY E2E"
pnpm run test:e2e

echo "5/5 build"
pnpm run build

echo "Full quality gate passed."
