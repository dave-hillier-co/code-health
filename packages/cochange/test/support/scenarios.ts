import { GitFixture, type Identity } from "@code-health/fixtures/git-fixture";

const alice: Identity = { name: "Alice", email: "alice@example.com" };
const bob: Identity = { name: "Bob", email: "bob@example.com" };

/** Enough stable lines that git still sees a rename when one line changes. */
function source(name: string, version: number): string {
  const body = Array.from({ length: 9 }, (_, i) => `export const ${name}Step${i} = ${i};`);
  return [...body, `export const ${name} = ${version};`, ""].join("\n");
}

/**
 * Six commits by two authors over five months, ending 2024-06-01. Touches a
 * source file with its sibling test, a pair in distant folders, and a rename.
 */
export function steadyHistory(): GitFixture {
  return GitFixture.build([
    {
      type: "commit",
      message: "Add invoicing",
      date: "2024-01-10T09:00:00Z",
      author: alice,
      changes: [
        { op: "add", path: "src/billing/invoice.ts", content: source("invoice", 1) },
        { op: "add", path: "src/reports/summary.ts", content: source("summary", 1) },
        { op: "add", path: "test/billing/invoice.test.ts", content: "test(1);\n" },
      ],
    },
    {
      type: "commit",
      message: "Show tax in the summary",
      date: "2024-02-10T09:00:00Z",
      author: bob,
      changes: [
        { op: "modify", path: "src/billing/invoice.ts", content: source("invoice", 2) },
        { op: "modify", path: "src/reports/summary.ts", content: source("summary", 2) },
      ],
    },
    {
      type: "commit",
      message: "Round totals",
      date: "2024-03-05T09:00:00Z",
      author: alice,
      changes: [
        { op: "modify", path: "src/billing/invoice.ts", content: source("invoice", 3) },
        { op: "modify", path: "test/billing/invoice.test.ts", content: "test(3);\n" },
      ],
    },
    {
      type: "commit",
      message: "Document the project",
      date: "2024-04-01T09:00:00Z",
      author: bob,
      changes: [{ op: "add", path: "README.md", content: "# Demo\n" }],
    },
    {
      type: "commit",
      message: "Move reporting",
      date: "2024-05-01T09:00:00Z",
      author: alice,
      changes: [
        { op: "rename", from: "src/reports/summary.ts", path: "src/reporting/summary.ts", content: source("summary", 4) },
      ],
    },
    {
      type: "commit",
      message: "Support credit notes",
      date: "2024-06-01T09:00:00Z",
      author: bob,
      changes: [{ op: "modify", path: "src/billing/invoice.ts", content: source("invoice", 4) }],
    },
  ]);
}
