#!/bin/sh
# Builds a repository with one long but flat function: forty lines of straight-line code, no branches, committed on a fixed date.
set -eu
git init -q --initial-branch=main
git config user.name "Eval Author"
git config user.email "eval@example.com"
git config commit.gpgsign false
mkdir -p src
{
  echo 'export function describe(order) {'
  echo '  const lines = [];'
  i=1
  while [ $i -le 36 ]; do
    echo "  lines.push(\"field $i: \" + order.field$i);"
    i=$((i + 1))
  done
  echo '  return lines.join("\n");'
  echo '}'
} > src/describe.js
git add --all
GIT_AUTHOR_DATE=2024-01-01T09:00:00Z GIT_COMMITTER_DATE=2024-01-01T09:00:00Z git commit -q -m "Add describe"
