#!/bin/sh
# A repository whose only identity ambiguity is two authors with the same name and nothing else in common:
# different addresses and domains, active in the same weeks, working in unrelated folders.
set -e
git init -q -b main .
git config commit.gpgsign false

commit() {
  name="$1"; email="$2"; date="$3"; path="$4"
  mkdir -p "$(dirname "$path")"
  echo "$date" >> "$path"
  git add "$path"
  GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" GIT_AUTHOR_DATE="$date" \
  GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" GIT_COMMITTER_DATE="$date" \
    git commit -q -m "Change $path"
}

for week in 01 08 15 22; do
  commit "Sam Hill" "one@alpha.example" "2024-01-${week}T10:00:00Z" "web/pages/home.txt"
  commit "Sam Hill" "two@beta.example" "2024-01-${week}T11:00:00Z" "db/migrations/001.txt"
  commit "Ria Moss" "ria@alpha.example" "2024-01-${week}T12:00:00Z" "api/routes.txt"
done
