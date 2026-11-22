#!/bin/sh
# A repository with five people and a bot, from January 2023 to the first of March 2025, built so that every
# line has a known author. Ann and Bob commit every other month and are active. Eve joined in September 2024
# and is active. Cy's last commit is in September 2023 and Di's in March 2024, so both have left.
#
# Lines at HEAD (a star marks someone who has left):
#   src/core/engine.ts   10  Cy 10*
#   src/core/parser.ts   10  Cy 9*, Ann 1
#   src/core/lexer.ts    10  Di 8*, Bob 2
#   src/api/routes.ts    10  Ann 5, Bob 5
#   src/api/auth.ts      10  Ann 10
#   src/util/log.ts      10  Bob 10
#   src/ui/view.ts       10  Eve 10
#   src/gen/deps.ts      10  the bot 5 (nobody's), Di 5*
# With the default guideline of 90 percent three files are abandoned: the engine, the parser and what people wrote
# in deps. Routes and auth change together six times between January and March 2025, so they are coupled hotspots.
set -e
git init -q -b main .
git config commit.gpgsign false

ANN="Ann Active|ann@example.com"
BOB="Bob Builder|bob@example.com"
CY="Cy Gone|cy@example.com"
DI="Di Departed|di@example.com"
EVE="Eve Newer|eve@example.com"
BOT="dependabot[bot]|49699333+dependabot[bot]@users.noreply.github.com"

# commit WHO DAY MESSAGE: whatever is staged, or an empty commit.
commit() {
  name="${1%%|*}"; email="${1#*|}"; stamp="$2T09:00:00Z"
  GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" GIT_AUTHOR_DATE="$stamp" \
  GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" GIT_COMMITTER_DATE="$stamp" \
    git commit -q --allow-empty -m "$3"
}

# lines PREFIX FROM COUNT: COUNT lines named PREFIX<FROM>.. each its own constant.
lines() {
  i="$2"; end=$(($2 + $3 - 1))
  while [ "$i" -le "$end" ]; do echo "export const $1$i = $i;"; i=$((i + 1)); done
}
write() { mkdir -p "$(dirname "$1")"; cat > "$1"; git add "$1"; }
rev() { echo "export const revision = $1;"; }

{ lines engine 1 10; } | write src/core/engine.ts
{ lines parser 1 9; } | write src/core/parser.ts
commit "$CY" 2023-01-10 "Start the engine"
{ lines bot 1 5; } | write src/gen/deps.ts
commit "$BOT" 2023-01-12 "Bump dependencies"
{ lines lexer 1 8; } | write src/core/lexer.ts
{ lines bot 1 5; lines pin 1 5; } | write src/gen/deps.ts
commit "$DI" 2023-02-10 "Add the lexer"
{ lines parser 1 9; lines ann 1 1; } | write src/core/parser.ts
{ lines route 1 4; rev 0; } | write src/api/routes.ts
{ lines auth 1 9; rev 0; } | write src/api/auth.ts
commit "$ANN" 2023-03-05 "Add routes and auth"
{ lines route 1 4; lines extra 1 5; rev 0; } | write src/api/routes.ts
{ lines log 1 10; } | write src/util/log.ts
{ lines lexer 1 8; lines bob 1 2; } | write src/core/lexer.ts
commit "$BOB" 2023-03-20 "Fill in routes, logging and the lexer"

commit "$CY" 2023-05-02 "Review"
commit "$ANN" 2023-05-05 "Maintenance 0"
commit "$BOB" 2023-05-20 "Housekeeping 0"
commit "$DI" 2023-06-01 "Review"
commit "$ANN" 2023-07-04 "Maintenance 1"
commit "$BOB" 2023-07-19 "Housekeeping 1"
commit "$ANN" 2023-09-02 "Maintenance 2"
commit "$CY" 2023-09-15 "Hand over"
commit "$BOB" 2023-09-17 "Housekeeping 2"
commit "$ANN" 2023-11-01 "Maintenance 3"
commit "$BOB" 2023-11-16 "Housekeeping 3"
commit "$DI" 2023-11-20 "Review"
commit "$ANN" 2023-12-31 "Maintenance 4"
commit "$BOB" 2024-01-15 "Housekeeping 4"
commit "$ANN" 2024-02-29 "Maintenance 5"
commit "$DI" 2024-03-01 "Last day"
commit "$BOB" 2024-03-15 "Housekeeping 5"
commit "$ANN" 2024-04-29 "Maintenance 6"
commit "$BOB" 2024-05-14 "Housekeeping 6"
commit "$ANN" 2024-06-28 "Maintenance 7"
commit "$BOB" 2024-07-13 "Housekeeping 7"
commit "$ANN" 2024-08-27 "Maintenance 8"
{ lines view 1 10; } | write src/ui/view.ts
commit "$EVE" 2024-09-10 "Add the view"
commit "$BOB" 2024-09-11 "Housekeeping 8"
commit "$EVE" 2024-10-10 "Eve is around"
commit "$ANN" 2024-10-26 "Maintenance 9"
commit "$EVE" 2024-11-09 "Eve is around"
commit "$BOB" 2024-11-10 "Housekeeping 9"
commit "$EVE" 2024-12-09 "Eve is around"
commit "$ANN" 2024-12-25 "Maintenance 10"
bump() {
  { lines route 1 4; lines extra 1 5; rev "$1"; } | write src/api/routes.ts
  { lines auth 1 9; rev "$1"; } | write src/api/auth.ts
  commit "$3" "$2" "Wire auth into routes $1"
}
bump 1 2025-01-05 "$ANN"
commit "$EVE" 2025-01-08 "Eve is around"
commit "$BOB" 2025-01-09 "Housekeeping 10"
bump 2 2025-01-15 "$BOB"
bump 3 2025-01-25 "$ANN"
bump 4 2025-02-04 "$BOB"
commit "$EVE" 2025-02-07 "Eve is around"
bump 5 2025-02-14 "$ANN"
commit "$BOB" 2025-02-20 "Housekeeping 11"
commit "$ANN" 2025-02-23 "Maintenance 11"
bump 6 2025-03-01 "$ANN"

# Opting in is the repository's own decision. This scaffold has made it, uncommitted, so the analysis can run.
cat > code-health.json <<'JSON'
{ "cochange": { "knowledge": { "enabled": true, "trials": 2000 } } }
JSON
