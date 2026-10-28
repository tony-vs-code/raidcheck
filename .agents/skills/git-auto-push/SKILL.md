---
name: git-auto-push
description: Automatically run pytest validation, stage project changes, commit, and push to origin once a feature is completed
---

# Git Auto-Push Skill

Use this skill once a feature, bug fix, or milestone is completed to validate the test suite (`uv run pytest -v`), stage all relevant project changes (excluding `.env`), commit with a descriptive message, and push to `origin main`.

## Usage

Run the helper script with a clear commit message:

```bash
.agents/skills/git-auto-push/scripts/git_auto_push.sh "<commit message>"
```

### Example
```bash
.agents/skills/git-auto-push/scripts/git_auto_push.sh "Add git-auto-push skill and expand pytest suite to 22 tests"
```

## Workflow Steps Performed by `git_auto_push.sh`
1. **Quality Gate**: Runs `uv run pytest -v`. If any test fails, the script exits immediately without committing or pushing.
2. **Safe Staging**: Runs `git add -A` and explicitly unstages `.env` (`git reset -- .env 2>/dev/null || true`) so secrets are never committed.
3. **Commit**: Checks `git diff --cached --quiet` and creates a commit if staged changes are present.
4. **Push**: Pushes `main` to `origin` (`git push origin main`).
