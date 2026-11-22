import { GitFixture, type Change } from "@code-health/fixtures/git-fixture";

/** Guidelines low enough that the functions below are over them: cognitive 6 and cyclomatic 4. */
export const lowGuidelines = JSON.stringify({
  complexity: { guidelines: { cognitive: { warn: 6, high: 12 }, cyclomatic: { warn: 4, high: 8 } } },
});

const orderType = "{ items: number[]; vip: boolean; coupon?: string }";

/** Cognitive 8, cyclomatic 5: over both guidelines above. `extra` goes before the return. */
export function priceFunction(name = "price", extra = ""): string {
  return `export function ${name}(order: ${orderType}): number {
  let total = 0;
  for (const item of order.items) {
    if (item > 100 && order.vip) {
      total += item * 0.8;
    } else {
      total += order.coupon ? item * 0.9 : item;
    }
  }
${extra}  return total;
}
`;
}

/** One more `if` at the top level of the function: cognitive +1 and cyclomatic +1. */
export const oneMoreBranch = "  if (order.items.length > 50) total = 0;\n";

export const simpleFunction = "export function simple(a: number): number {\n  return a + 1;\n}\n";

/** Four nested ifs: cognitive 1 + 2 + 3 + 4 = 10, cyclomatic 5, nesting 4. Over the cognitive and cyclomatic guidelines. */
export const riskyFunction = `export function risky(a: number, b: number, c: number, d: number): number {
  if (a > 0) {
    if (b > 0) {
      if (c > 0) {
        if (d > 0) {
          return a + b + c + d;
        }
      }
    }
  }
  return 0;
}
`;

const date = (day: number) => `2024-01-${String(day).padStart(2, "0")}T00:00:00+00:00`;

/**
 * A repository whose main branch holds the base: a configured guideline, `src/pricing.ts` with the over-guideline
 * function `price`, and `src/stable.ts`, over a guideline too and never touched afterwards. A `feature` branch
 * then adds one commit with `changes`, and stays checked out.
 */
export function repoWithFeature(changes: Change[], configuration = lowGuidelines): GitFixture {
  return GitFixture.build([
    {
      type: "commit",
      message: "Base",
      date: date(1),
      changes: [
        { op: "add", path: "code-health.json", content: configuration },
        { op: "add", path: "src/pricing.ts", content: priceFunction() },
        { op: "add", path: "src/stable.ts", content: priceFunction("stable") },
        { op: "add", path: "src/label.ts", content: "export const label = (n: string): string => n.trim();\n" },
      ],
    },
    { type: "branch", name: "feature" },
    { type: "commit", message: "Feature", date: date(2), changes },
  ]);
}
