import { GitFixture, type Identity, type Step } from "@code-health/fixtures/git-fixture";

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

/** Lines nested `depth` levels deep, two spaces per level. */
function nested(name: string, depth: number, version: number): string {
  const lines: string[] = [];
  for (let level = 0; level < depth; level++) lines.push(`${"  ".repeat(level)}if (${name}${level}) {`);
  lines.push(`${"  ".repeat(depth)}run(${version});`);
  for (let level = depth - 1; level >= 0; level--) lines.push(`${"  ".repeat(level)}}`);
  return lines.join("\n") + "\n";
}

/**
 * Five files of different shapes, ending 2024-06-15. `engine` is deeply nested
 * and changes constantly, `util` is flat and changes just as often, `page` is
 * lightly nested and changes a little, `legacy` was reworked three times in
 * autumn 2023 and has been quiet since, and `guide.md` was written in January
 * 2023 and never touched again, so it is outside a 12 month window.
 */
export function indentedHistory(): GitFixture {
  const engine = (version: number) => ({ path: "src/core/engine.ts", content: nested("engine", 6, version) });
  const util = (version: number) => ({ path: "src/core/util.ts", content: `export const util = ${version};\n` });
  const page = (version: number) => ({ path: "src/ui/page.ts", content: nested("page", 2, version) });
  const legacy = (version: number) => ({ path: "src/legacy/old.ts", content: nested("legacy", 3, version) });
  const rework = (date: string, version: number): Step => ({
    type: "commit",
    message: `Rework the legacy code ${version}`,
    date,
    author: alice,
    changes: [{ op: "modify", ...legacy(version) }],
  });
  const monthly = (date: string, version: number): Step => ({
    type: "commit",
    message: `Tune the engine ${version}`,
    date,
    author: alice,
    changes: [
      { op: "modify", ...engine(version) },
      { op: "modify", ...util(version) },
    ],
  });
  const pageTweak = (date: string, version: number): Step => ({
    type: "commit",
    message: `Tweak the page ${version}`,
    date,
    author: bob,
    changes: [{ op: "modify", ...page(version) }],
  });
  return GitFixture.build([
    {
      type: "commit",
      message: "Start",
      date: "2023-01-05T09:00:00Z",
      author: alice,
      changes: [
        { op: "add", ...engine(1) },
        { op: "add", ...util(1) },
        { op: "add", ...page(1) },
        { op: "add", ...legacy(1) },
        { op: "add", path: "docs/guide.md", content: "# Guide\n" },
      ],
    },
    rework("2023-08-10T09:00:00Z", 2),
    rework("2023-09-10T09:00:00Z", 3),
    rework("2023-10-10T09:00:00Z", 4),
    monthly("2024-02-01T09:00:00Z", 2),
    pageTweak("2024-03-10T09:00:00Z", 2),
    monthly("2024-03-20T09:00:00Z", 3),
    monthly("2024-04-20T09:00:00Z", 4),
    pageTweak("2024-05-20T09:00:00Z", 3),
    monthly("2024-05-25T09:00:00Z", 5),
    monthly("2024-06-15T09:00:00Z", 6),
  ]);
}
