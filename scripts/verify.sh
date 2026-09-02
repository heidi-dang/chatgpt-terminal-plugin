#!/bin/bash
# Exit immediately if any command fails
set -e 

echo "1. Running Linters..."
pnpm run lint

echo "2. Running Type Checks..."
pnpm run typecheck

echo "3. Running Test Suite..."
pnpm run test

echo "4. Verifying Build..."
pnpm run build

echo "✅ All checks passed. Ready for commit."
