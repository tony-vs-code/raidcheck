#!/usr/bin/env python3
"""Helper script for GitHub Actions CI/CD release workflow."""

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PYPROJECT_PATH = REPO_ROOT / "pyproject.toml"

def get_current_version() -> str:
    text = PYPROJECT_PATH.read_text(encoding="utf-8")
    m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    return m.group(1) if m else "0.1.0"

def calculate_next_patch(current_ver: str) -> str:
    cur = current_ver.lstrip("v")
    parts = cur.split(".")
    if len(parts) == 3 and parts[2].isdigit():
        parts[2] = str(int(parts[2]) + 1)
        return ".".join(parts)
    return f"{cur}.1"

def bump_patch_version(current_ver: str) -> str:
    new_ver = calculate_next_patch(current_ver)
    text = PYPROJECT_PATH.read_text(encoding="utf-8")
    updated = re.sub(
        r'^version\s*=\s*"[^"]+"',
        f'version = "{new_ver}"',
        text,
        count=1,
        flags=re.MULTILINE,
    )
    PYPROJECT_PATH.write_text(updated, encoding="utf-8")
    return new_ver

def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: release_helper.py [get-version | bump-patch [current_ver]]", file=sys.stderr)
        return 1

    action = sys.argv[1]
    if action == "get-version":
        print(get_current_version())
        return 0
    elif action == "bump-patch":
        cur = sys.argv[2] if len(sys.argv) > 2 else get_current_version()
        print(bump_patch_version(cur))
        return 0
    else:
        print(f"Unknown action: {action}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
