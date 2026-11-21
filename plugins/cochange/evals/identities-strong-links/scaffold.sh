#!/bin/sh
# A repository whose duplicate authors are all strong links: the same address apart from case and a +tag,
# and two GitHub noreply addresses with one username.
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

for week in 01 08 15; do
  commit "J Park" "Jo@Corp.example" "2024-01-${week}T10:00:00Z" "api/jo.txt"
  commit "jsmith" "1234+jsmith@users.noreply.github.com" "2024-01-${week}T11:00:00Z" "web/john.txt"
  commit "Ria Moss" "ria@corp.example" "2024-01-${week}T12:00:00Z" "db/ria.txt"
done
for week in 22 28; do
  commit "Jo Park" "jo+git@corp.example" "2024-01-${week}T10:00:00Z" "api/jo.txt"
  commit "John Smith" "jsmith@users.noreply.github.com" "2024-01-${week}T11:00:00Z" "web/john.txt"
  commit "Ria Moss" "ria@corp.example" "2024-01-${week}T12:00:00Z" "db/ria.txt"
done
