#!/usr/bin/env bash
# Builds the repository the eval prompts ask about, in the current directory.
# Run by `claude plugin eval --scaffold`. The history is fixed, so the answers do not depend on today's date:
#   src/billing/invoice.ts changes with src/reports/summary.ts (6 times), src/app/registry.ts (6)
#   and its sibling test (8), and alone 3 times. It is the most indented file and changed last.
set -euo pipefail

git init -q -b main .
git config user.name "Eval Author"
git config user.email "eval@example.com"

day=0
commit() {
  # 2025-01-06T09:00:00Z, then every four days. Plain arithmetic, so it needs neither GNU nor BSD date.
  local when="$((1736154000 + day * 4 * 86400)) +0000"
  day=$((day + 1))
  git add -A
  GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when" git commit -q -m "$1"
}

# Writes a file nested `depth` levels deep, so the files differ in indentation complexity.
version=0
touch_file() {
  local path="$1" depth="$2"
  version=$((version + 1))
  mkdir -p "$(dirname "$path")"
  {
    echo "export function run$version(input: number): number {"
    local i indent="  "
    for ((i = 0; i < depth; i++)); do
      echo "${indent}if (input > $i) {"
      indent="$indent  "
    done
    echo "${indent}return input + $version;"
    for ((i = 0; i < depth; i++)); do
      indent="${indent%  }"
      echo "${indent}}"
    done
    echo "  return 0;"
    echo "}"
  } >"$path"
}

for i in 1 2 3 4 5 6; do
  touch_file src/billing/invoice.ts 6
  touch_file src/reports/summary.ts 1
  commit "Show invoice figures in the summary ($i)"
done
for i in 1 2 3 4 5 6; do
  touch_file src/billing/invoice.ts 6
  touch_file src/app/registry.ts 1
  commit "Register invoice handling ($i)"
done
for i in 1 2 3 4 5 6 7 8; do
  touch_file src/billing/invoice.ts 6
  touch_file src/billing/invoice.test.ts 2
  commit "Invoice rule $i with its test"
done
for name in alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima; do
  touch_file "src/misc/$name.ts" 1
  commit "Add $name"
done
for i in 1 2 3; do
  touch_file src/billing/invoice.ts 6
  commit "Tweak invoice $i"
done
