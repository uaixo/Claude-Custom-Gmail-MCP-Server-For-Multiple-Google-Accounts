# Project notes for Claude

## Workflow rules

- **Code review: always sync first.** Whenever the user asks for a code review
  (of "all the code", the repo, a file, etc.), before reading or assessing
  anything, run `git fetch origin main` and `git pull` (or otherwise fast-forward
  local `main`), and confirm local `HEAD` matches `origin/main`. Never review
  off a possibly-stale local checkout. State the commit being reviewed.
