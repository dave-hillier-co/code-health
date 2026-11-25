#!/bin/sh
# Two authors the history cannot settle, and a user who suggests looking them up online.
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
  commit "Dana Whitfield" "dana@foo.example" "2024-01-${week}T10:00:00Z" "app/dana.txt"
  commit "D Whitfield" "dw@bar.example" "2024-01-${week}T11:00:00Z" "lib/dw.txt"
done
