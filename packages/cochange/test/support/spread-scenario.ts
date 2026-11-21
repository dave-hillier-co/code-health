import { GitFixture, type Identity } from "@code-health/fixtures/git-fixture";

const alice: Identity = { name: "Alice", email: "alice@example.com" };

/** Enough stable lines that git still sees a rename when one line changes. */
function source(name: string, version: number): string {
  const body = Array.from({ length: 9 }, (_, i) => `export const ${name}Step${i} = ${i};`);
  return [...body, `export const ${name} = ${version};`, ""].join("\n");
}

/**
 * Seven commits ending 2024-05-20, written for `maxChangesetSize` 4:
 *
 * | date       | change                                                   | spread |
 * |------------|----------------------------------------------------------|--------|
 * | 2024-01-08 | invoice and tax, with their test two folders away        | 8/3    |
 * | 2024-01-15 | the invoice alone                                        | 0      |
 * | 2024-02-12 | a new summary in src/reports, and the invoice            | 2      |
 * | 2024-02-20 | `Code-Health:` commit moving the summary next to invoice | left out |
 * | 2024-04-02 | summary and invoice, now siblings                        | 0      |
 * | 2024-04-03 | five new modules, over the maximum                       | left out |
 * | 2024-05-20 | README at the root and the invoice                       | 2      |
 *
 * The February change stays at 2 although the summary was moved later, and
 * nothing happens in March.
 */
export function spreadHistory(): GitFixture {
  return GitFixture.build([
    {
      type: "commit",
      message: "Add invoicing",
      date: "2024-01-08T09:00:00Z",
      author: alice,
      changes: [
        { op: "add", path: "src/billing/invoice.ts", content: source("invoice", 1) },
        { op: "add", path: "src/billing/tax.ts", content: "tax(1);\n" },
        { op: "add", path: "test/billing/invoice.test.ts", content: "test(1);\n" },
      ],
    },
    {
      type: "commit",
      message: "Fix rounding",
      date: "2024-01-15T09:00:00Z",
      author: alice,
      changes: [{ op: "modify", path: "src/billing/invoice.ts", content: source("invoice", 2) }],
    },
    {
      type: "commit",
      message: "Add a summary",
      date: "2024-02-12T09:00:00Z",
      author: alice,
      changes: [
        { op: "add", path: "src/reports/summary.ts", content: source("summary", 1) },
        { op: "modify", path: "src/billing/invoice.ts", content: source("invoice", 3) },
      ],
    },
    {
      type: "commit",
      message:
        "Co-locate the summary with invoicing\n\nMoves the file and touches the invoice.\n\nCode-Health: locality/move-to-neighbour",
      date: "2024-02-20T09:00:00Z",
      author: alice,
      changes: [
        { op: "rename", from: "src/reports/summary.ts", path: "src/billing/summary.ts", content: source("summary", 2) },
        { op: "modify", path: "src/billing/invoice.ts", content: source("invoice", 4) },
      ],
    },
    {
      type: "commit",
      message: "Show tax in the summary",
      date: "2024-04-02T09:00:00Z",
      author: alice,
      changes: [
        { op: "modify", path: "src/billing/summary.ts", content: source("summary", 3) },
        { op: "modify", path: "src/billing/invoice.ts", content: source("invoice", 5) },
      ],
    },
    {
      type: "commit",
      message: "Scaffold five modules",
      date: "2024-04-03T09:00:00Z",
      author: alice,
      changes: ["a", "b", "c", "d", "e"].map((name) => ({
        op: "add" as const,
        path: `modules/${name}/index.ts`,
        content: `${name}();\n`,
      })),
    },
    {
      type: "commit",
      message: "Document the project",
      date: "2024-05-20T09:00:00Z",
      author: alice,
      changes: [
        { op: "add", path: "README.md", content: "# Demo\n" },
        { op: "modify", path: "src/billing/invoice.ts", content: source("invoice", 6) },
      ],
    },
  ]);
}
