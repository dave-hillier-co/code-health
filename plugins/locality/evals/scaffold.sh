#!/bin/sh
# Builds the repository the eval cases run in: a tiny app whose slugify helper lives in shared/utils but has one consumer.
set -e
git init -q -b main
git config user.email eval@example.com
git config user.name Eval
mkdir -p src/shared/utils src/orders src/billing
cat > code-health.json <<'JSON'
{ "entryPoints": ["src/main.ts"] }
JSON
cat > src/main.ts <<'TS'
import { place } from "./orders/place.ts";
import { charge } from "./billing/charge.ts";
export const run = () => [place(), charge()];
TS
cat > src/orders/place.ts <<'TS'
import { formatMoney } from "../shared/utils/money.ts";
import { slugify } from "../shared/utils/slug.ts";
export function place(): string {
  return slugify("order") + formatMoney(1);
}
TS
cat > src/billing/charge.ts <<'TS'
import { formatMoney } from "../shared/utils/money.ts";
export function charge(): string {
  return formatMoney(2);
}
TS
cat > src/shared/utils/money.ts <<'TS'
export function formatMoney(amount: number): string {
  return "$" + amount.toFixed(2);
}
TS
cat > src/shared/utils/slug.ts <<'TS'
export function slugify(text: string): string {
  return text.toLowerCase().replace(/ /g, "-");
}
TS
git add -A
GIT_AUTHOR_DATE=2024-01-01T09:00:00Z GIT_COMMITTER_DATE=2024-01-01T09:00:00Z git commit -q -m "Add the app"
