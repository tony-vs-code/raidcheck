#!/usr/bin/env bash
set -euo pipefail

COMMIT_MSG="${1:-Update systemalerts project}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT"

echo "==> Running pytest quality gate..."
uv run pytest -v

echo "==> Staging project changes (excluding .env)..."
git add -A
git reset -- .env 2>/dev/null || true

if ! git diff --cached --quiet; then
    echo "==> Committing staged changes: $COMMIT_MSG"
    git commit -m "$COMMIT_MSG"
else
    echo "==> No new staged changes to commit."
fi

echo "==> Pushing to origin main..."
GIT_TERMINAL_PROMPT=0 git push origin main
echo "==> Successfully pushed to origin/main."
