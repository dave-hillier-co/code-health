#!/bin/sh
# The same repository as risk-scaffold.sh, for a user who is new to it: the invoking git identity is Nia Newcomer,
# who has never committed here, and `feature/first-change` is her first commit, changing src/reports/summary.ts.
set -e

sh "$(dirname "$0")/risk-scaffold.sh"

git checkout -q main
git checkout -q -b feature/first-change
echo "// reworked" >> src/reports/summary.ts
git add -A
GIT_AUTHOR_NAME="Nia Newcomer" GIT_AUTHOR_EMAIL="nia@example.com" GIT_AUTHOR_DATE="2025-06-12T09:00:00 +0000" \
GIT_COMMITTER_NAME="Nia Newcomer" GIT_COMMITTER_EMAIL="nia@example.com" GIT_COMMITTER_DATE="2025-06-12T09:00:00 +0000" \
  git commit -q -m "Rework the summary"
git config user.name "Nia Newcomer"
git config user.email "nia@example.com"
