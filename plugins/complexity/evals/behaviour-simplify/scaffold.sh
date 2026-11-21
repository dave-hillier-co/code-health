#!/bin/sh
# Builds the repository the behaviour case works in: one deeply nested function with tests, committed.
set -eu
git init -q --initial-branch=main
git config user.name "Eval Author"
git config user.email "eval@example.com"
git config commit.gpgsign false
mkdir -p src test

cat > src/ship.js <<'EOF'
export function ship(order, warehouse) {
  const results = [];
  if (order.paid) {
    if (order.items.length > 0) {
      for (const item of order.items) {
        if (warehouse.has(item.sku)) {
          if (!order.hold) {
            if (item.quantity > 0) {
              results.push({ sku: item.sku, shipped: true });
            } else {
              results.push({ sku: item.sku, shipped: false, reason: "no quantity" });
            }
          } else {
            results.push({ sku: item.sku, shipped: false, reason: "hold" });
          }
        } else {
          results.push({ sku: item.sku, shipped: false, reason: "not stocked" });
        }
      }
    }
  }
  return results;
}
EOF

cat > test/ship.test.js <<'EOF'
import assert from "node:assert/strict";
import { test } from "node:test";
import { ship } from "../src/ship.js";

const stock = new Set(["a", "b"]);

test("ships stocked items of a paid order", () => {
  const order = { paid: true, hold: false, items: [{ sku: "a", quantity: 1 }] };
  assert.deepEqual(ship(order, stock), [{ sku: "a", shipped: true }]);
});

test("reports why an item was not shipped", () => {
  const order = { paid: true, hold: false, items: [{ sku: "a", quantity: 0 }, { sku: "z", quantity: 1 }] };
  assert.deepEqual(ship(order, stock), [
    { sku: "a", shipped: false, reason: "no quantity" },
    { sku: "z", shipped: false, reason: "not stocked" },
  ]);
});

test("holds everything on a held order, and ships nothing unpaid", () => {
  const held = { paid: true, hold: true, items: [{ sku: "a", quantity: 1 }] };
  assert.deepEqual(ship(held, stock), [{ sku: "a", shipped: false, reason: "hold" }]);
  assert.deepEqual(ship({ ...held, paid: false }, stock), []);
});
EOF

cat > package.json <<'EOF'
{ "name": "shop", "private": true, "type": "module", "scripts": { "test": "node --test" } }
EOF

git add --all
git commit -q -m "Add shipping"
