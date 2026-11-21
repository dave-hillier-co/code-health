import { GitFixture, type Step } from "@code-health/fixtures/git-fixture";

/** A small function with a known shape: cognitive 0, cyclomatic 1. */
export const flatSource = `export function label(name: string): string {
  return name.trim();
}
`;

/**
 * Cognitive 8 and cyclomatic 5, counted by hand: for +1, if +2, && +1, else +1, and the ternary two levels
 * deep in the else +3. Nesting 2, one parameter.
 */
export const pricingSource = `export function price(order: { items: number[]; vip: boolean; coupon?: string }): number {
  let total = 0;
  for (const item of order.items) {
    if (item > 100 && order.vip) {
      total += item * 0.8;
    } else {
      total += order.coupon ? item * 0.9 : item;
    }
  }
  return total;
}

export const double = (x: number): number => x * 2;
`;

export const testSource = `import { price } from "../src/pricing.ts";

export function checksPrice(): void {
  if (price({ items: [1], vip: false }) !== 1) {
    throw new Error("wrong");
  }
}
`;

export const goSource = `package shop

func Total(items []int) int {
	sum := 0
	for _, item := range items {
		if item > 0 {
			sum += item
		}
	}
	return sum
}
`;

export const pythonSource = `def total(items):
    out = 0
    for item in items:
        if item > 0:
            out += item
    return out
`;

export function steps(): Step[] {
  return [
    {
      type: "commit",
      message: "Add pricing",
      date: "2024-01-01T00:00:00+00:00",
      changes: [
        { op: "add", path: "src/pricing.ts", content: pricingSource },
        { op: "add", path: "src/label.ts", content: flatSource },
        { op: "add", path: "test/pricing.test.ts", content: testSource },
        { op: "add", path: "src/total.go", content: goSource },
        { op: "add", path: "tools/total.py", content: pythonSource },
        { op: "add", path: "notes.md", content: "# Notes\n\n- one\n  - two\n" },
      ],
    },
  ];
}

/** A clean repository with one commit holding code in several languages. */
export function buildRepo(extra: Step[] = []): GitFixture {
  return GitFixture.build([...steps(), ...extra]);
}
