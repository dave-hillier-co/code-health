#!/bin/sh
# Builds the repository the packaging eval cases run in: an npm workspace of five packages. `ui` and `api`
# change together in almost every change, `shared` is used in three unrelated parts by `ui`, `api` and
# `app`, `app` is the entry point, and the date helpers a case asks about live in one file of `ui` that
# nothing else uses. Nothing is published and no purpose is declared. Dates are pinned, so the history is the same every time.
set -e
git init -q -b main
git config user.email eval@example.com
git config user.name Eval
mkdir -p packages/shared/src packages/ui/src packages/api/src packages/app/src
cat > package.json <<'JSON'
{ "name": "demo", "private": true, "workspaces": ["packages/*"] }
JSON
manifest() {
  # name, then dependencies
  name="$1"
  shift
  deps=""
  for dep in "$@"; do
    deps="$deps\"@demo/$dep\": \"*\", "
  done
  deps="${deps%, }"
  extra=""
  if [ "$name" = "app" ]; then extra='"bin": { "app": "./bin.js" }, '; fi
  printf '{ "name": "@demo/%s", "private": true, %s"main": "src/index.ts", "dependencies": { %s } }\n' "$name" "$extra" "$deps" > "packages/$name/package.json"
}
manifest shared
manifest ui shared
manifest api shared
manifest app ui api shared
cat > packages/shared/src/index.ts <<'TS'
export { formatMoney } from "./money.ts";
export { formatDate } from "./format.ts";
export { log } from "./log.ts";
TS
cat > packages/shared/src/money.ts <<'TS'
export function formatMoney(cents: number): string {
  return (cents / 100).toFixed(2);
}
TS
cat > packages/shared/src/format.ts <<'TS'
export function formatDate(iso: string): string {
  return iso.slice(0, 10);
}
TS
cat > packages/shared/src/log.ts <<'TS'
export function log(message: string): void {
  console.log(message);
}
TS
cat > packages/ui/src/dates.ts <<'TS'
export function weekday(iso: string): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(iso).getUTCDay()] ?? "";
}
export function isWeekend(iso: string): boolean {
  const day = new Date(iso).getUTCDay();
  return day === 0 || day === 6;
}
TS
cat > packages/ui/src/index.ts <<'TS'
import { formatDate } from "@demo/shared";
import { isWeekend, weekday } from "./dates.ts";
export function view(iso: string): string {
  return `${weekday(iso)} ${formatDate(iso)}${isWeekend(iso) ? " (weekend)" : ""}`;
}
TS
cat > packages/api/src/index.ts <<'TS'
import { formatMoney } from "@demo/shared";
export function price(cents: number): string {
  return formatMoney(cents);
}
TS
cat > packages/app/src/index.ts <<'TS'
import { log } from "@demo/shared";
import { price } from "@demo/api";
import { view } from "@demo/ui";
export function main(): void {
  log(`${view("2024-01-01")} ${price(100)}`);
}
TS
commit() {
  GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git commit -q -m "$2"
}
git add package.json packages/shared
commit 2023-06-01T09:00:00Z "Add shared"
git add packages/ui packages/api
commit 2023-06-02T09:00:00Z "Add ui and api"
git add packages/app
commit 2023-06-03T09:00:00Z "Add app"
# Forty-two changes, eight days apart from 2023-07-09: fourteen touch ui and api together, two ui alone, two api
# alone, fourteen shared alone and ten app alone. Dates are epoch seconds, so no date arithmetic is needed.
touch_file() {
  printf '// change %s\n' "$2" >> "$1"
}
pattern=BSPBSBPUSBSPBASBPSBSPBSPBSBPUSBSPBASBPSBSP
base=1688202000
n=0
while [ "$n" -lt 42 ]; do
  kind=$(printf '%s' "$pattern" | cut -c$((n + 1)))
  n=$((n + 1))
  when="$((base + n * 691200)) +0000"
  case "$kind" in
    B)
      touch_file packages/ui/src/index.ts "$n"
      touch_file packages/api/src/index.ts "$n"
      git add -A
      commit "$when" "Change ui and api ($n)"
      ;;
    U)
      touch_file packages/ui/src/index.ts "$n"
      git add -A
      commit "$when" "Change ui ($n)"
      ;;
    A)
      touch_file packages/api/src/index.ts "$n"
      git add -A
      commit "$when" "Change api ($n)"
      ;;
    S)
      touch_file packages/shared/src/log.ts "$n"
      git add -A
      commit "$when" "Change shared ($n)"
      ;;
    P)
      touch_file packages/app/src/index.ts "$n"
      git add -A
      commit "$when" "Change app ($n)"
      ;;
  esac
done
