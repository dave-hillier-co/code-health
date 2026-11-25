#!/bin/sh
# The scaffold.sh repository, plus an event bus that other folders (shipping, notifications) already use. The cycle is the
# same, and an event emitter is now a mechanism the codebase has, so the census finds it near the boundary.
set -e
git init -q -b main
git config user.email eval@example.com
git config user.name Eval
mkdir -p src/orders src/billing
cat > code-health.json <<'JSON'
{ "entryPoints": ["src/main.ts"] }
JSON
cat > src/main.ts <<'TS'
import { place } from "./orders/place.ts";
import { charge } from "./billing/charge.ts";
export const run = () => [place(), charge()];
TS
cat > src/orders/place.ts <<'TS'
import { taxRate } from "../billing/tax.ts";
export function place(): number {
  return 100 * (1 + taxRate());
}
TS
cat > src/billing/tax.ts <<'TS'
export function taxRate(): number {
  return 0.2;
}
TS
cat > src/billing/charge.ts <<'TS'
import { orderTotal } from "../orders/total.ts";
import { taxRate } from "./tax.ts";
export function charge(): number {
  return orderTotal() * taxRate();
}
TS
cat > src/orders/total.ts <<'TS'
import { charge } from "../billing/charge.ts";
export function orderTotal(): number {
  return charge.length + 50;
}
TS
commit() {
  GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git commit -q -m "$2"
}
git add src/main.ts code-health.json
commit 2024-01-01T09:00:00Z "Add the entry"
git add src/orders/place.ts src/billing/tax.ts
commit 2024-01-02T09:00:00Z "Add placing orders"
git add src/billing/charge.ts src/orders/total.ts
commit 2024-01-03T09:00:00Z "Add charging"
for week in 1 2 3 4 5 6; do
  echo "// orders revision $week" >> src/orders/place.ts
  git add src/orders/place.ts
  commit "2024-02-0${week}T09:00:00Z" "Change orders $week"
  echo "// billing revision $week" >> src/billing/tax.ts
  git add src/billing/tax.ts
  commit "2024-03-0${week}T09:00:00Z" "Change billing $week"
done
# The rest of the codebase already decouples through an event emitter, in folders next to orders and billing.
mkdir -p src/events src/notifications src/shipping
cat > src/events/bus.ts <<'TS'
import { EventEmitter } from "node:events";
export class Bus extends EventEmitter {}
export const bus = new Bus();
TS
cat > src/notifications/mail.ts <<'TS'
import { bus } from "../events/bus.ts";
export function listen(): void {
  bus.on("shipped", () => {});
}
TS
cat > src/shipping/ship.ts <<'TS'
import { bus } from "../events/bus.ts";
export function ship(id: number): void {
  bus.emit("shipped", id);
}
TS
git add src/events src/notifications src/shipping
commit 2024-04-01T09:00:00Z "Add shipping notifications over the event bus"
