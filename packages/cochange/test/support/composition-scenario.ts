import { GitFixture, type Identity } from "@code-health/fixtures/git-fixture";

const alice: Identity = { name: "Alice", email: "alice@example.com" };

export const calc = "src/app/calc.ts";

const total = `export function total(items: number[]): number {
  let sum = 0;
  for (const item of items) sum += item;
  return sum;
}
`;

/** Ten nested conditions: cognitive complexity of 55, and a great deal more indentation than the file had. */
const classify = `
export function classify(a: number, b: number, c: number): string {
  if (a > 0) {
    if (b > 0) {
      if (c > 0) {
        if (a > b) {
          if (b > c) {
            if (a > c) {
              if (a + b > c) {
                if (a + c > b) {
                  if (b + c > a) {
                    return "scalene";
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return "none";
}
`;

/**
 * Real TypeScript, so the complexity plugin can parse it. `main` has a small module and a few commits;
 * `nest` adds one deeply nested function to it, and `quiet` changes a comment-free constant.
 */
export function compositionHistory(): GitFixture {
  const at = (day: number) => new Date(Date.UTC(2024, 0, 8 + day * 7, 9)).toISOString();
  return GitFixture.build([
    { type: "commit", message: "Add the calculator", date: at(0), author: alice, changes: [{ op: "add", path: calc, content: total }] },
    { type: "commit", message: "Add a helper", date: at(1), author: alice, changes: [{ op: "add", path: "src/app/helper.ts", content: "export const helper = 1;\n" }] },
    { type: "commit", message: "Change the helper", date: at(2), author: alice, changes: [{ op: "modify", path: "src/app/helper.ts", content: "export const helper = 2;\n" }] },
    { type: "branch", name: "nest" },
    { type: "commit", message: "Classify triangles", date: "2024-06-03T09:00:00Z", author: alice, changes: [{ op: "modify", path: calc, content: total + classify }] },
    { type: "checkout", name: "main" },
    { type: "branch", name: "quiet" },
    { type: "commit", message: "Change the helper again", date: "2024-06-04T09:00:00Z", author: alice, changes: [{ op: "modify", path: "src/app/helper.ts", content: "export const helper = 3;\n" }] },
    { type: "checkout", name: "main" },
  ]);
}
