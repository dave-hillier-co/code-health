#!/bin/sh
# Builds the repository the change-risk eval prompts ask about, in the current directory.
# Run by `claude plugin eval --scaffold`. The history is fixed, so the answers do not depend on today's date.
#
# `main` has twenty weekly changes from 2025-01-06, by Eval Author (the invoking git identity) and Bob Builder:
#   src/billing/invoice.ts changed eight times, seven of them with src/billing/tax.ts and with its sibling test.
# Branches, each a single commit on top of `main`:
#   feature/discount     Eval Author  changes the invoice alone: tax.ts and the test are missing from it
#   feature/bob-change   Bob Builder  changes src/auth/login.ts
set -e

git init -q -b main .
git config user.name "Eval Author"
git config user.email "eval@example.com"
git config commit.gpgsign false

week=0
version=0

# A file of ten lines, every one rewritten by each version, so churn is the same for every change.
write() {
  version=$((version + 1))
  mkdir -p "$(dirname "$1")"
  i=0
  : > "$1"
  while [ "$i" -lt 10 ]; do
    echo "$1 line $i v$version" >> "$1"
    i=$((i + 1))
  done
}

commit() {
  # 2025-01-06T09:00:00Z, then every seven days. Plain arithmetic, so it needs neither GNU nor BSD date.
  when="$((1736154000 + week * 7 * 86400)) +0000"
  week=$((week + 1))
  git add -A
  GIT_AUTHOR_NAME="$2" GIT_AUTHOR_EMAIL="$3" GIT_AUTHOR_DATE="$when" GIT_COMMITTER_NAME="$2" GIT_COMMITTER_EMAIL="$3" GIT_COMMITTER_DATE="$when" \
    git commit -q -m "$1"
}

eval_author() { commit "$1" "Eval Author" "eval@example.com"; }
bob() { commit "$1" "Bob Builder" "bob@example.com"; }

together() {
  write src/billing/invoice.ts
  write src/billing/tax.ts
  write src/billing/invoice.test.ts
}

write README.md; eval_author "Add the readme"
together; eval_author "Add invoicing"
write src/reports/summary.ts; bob "Add a summary"
together; eval_author "Adjust totals"
write src/auth/login.ts; bob "Add login"
together; eval_author "Round the totals"
write src/reports/summary.ts; bob "Improve the summary"
together; eval_author "Apply discounts"
write src/auth/login.ts; bob "Tighten login"
together; eval_author "Add surcharge"
together; eval_author "Fix tax rounding"
write README.md; eval_author "Update the readme"
write src/reports/summary.ts; bob "Tune the summary"
together; eval_author "Add rebates"
write src/auth/login.ts; bob "Log failed logins"
write README.md; eval_author "Describe the billing module"
write src/billing/invoice.ts; eval_author "Note the invoice"
write src/reports/summary.ts; bob "Summarise by month"
write README.md; eval_author "Fix a typo in the readme"
write src/auth/login.ts; bob "Rate limit login"

# The branches start at the tip of main, in June.
branch() {
  git checkout -q main
  git checkout -q -b "$1"
}
on() {
  when="2025-06-$1T09:00:00 +0000"
  git add -A
  GIT_AUTHOR_NAME="$3" GIT_AUTHOR_EMAIL="$4" GIT_AUTHOR_DATE="$when" GIT_COMMITTER_NAME="$3" GIT_COMMITTER_EMAIL="$4" GIT_COMMITTER_DATE="$when" \
    git commit -q -m "$2"
}

branch feature/discount
write src/billing/invoice.ts
on 10 "Add a discount to the invoice" "Eval Author" "eval@example.com"

branch feature/bob-change
write src/auth/login.ts
on 11 "Change login" "Bob Builder" "bob@example.com"

git checkout -q main
