#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Configuring git hooks directory to .githooks/..."
chmod +x .githooks/*
git config core.hooksPath .githooks

echo "==> Git hooks installed successfully:"
ls -la .githooks/
