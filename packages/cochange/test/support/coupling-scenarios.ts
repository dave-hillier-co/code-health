import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";

const author: Identity = { name: "Alice", email: "alice@example.com" };

/** Enough stable lines that git still sees a rename when one line changes. */
function source(name: string, version: number): string {
  const body = Array.from({ length: 9 }, (_, i) => `export const ${name}Step${i} = ${i};`);
  return [...body, `export const ${name} = ${version};`, ""].join("\n");
}

const invoice = "src/billing/invoice.ts";
const invoiceTest = "src/billing/invoice.test.ts";
const registry = "src/app/registry.ts";
const summary = "src/reports/summary.ts";
const movedSummary = "src/reporting/summary.ts";

/**
 * About thirty commits over a year. With the defaults
 * (support 5, degree 30 %, distance 2) it contains:
 *
 * - invoice and summary together 5 times, summary moved folder after the 5th,
 *   so the pair must be followed through the rename (distant, asymmetric);
 * - invoice and registry together 5 times (distant, asymmetric);
 * - invoice and its sibling test together 10 times (strong, distance 0);
 * - invoice alone twice, summary alone once (the move itself);
 * - one 33 file change touching invoice and summary, above the size maximum,
 *   which must not count on either side;
 * - a short-lived pair (3 shared changes) below the minimum support;
 * - a file changed with the invoice 5 times and then deleted, which must not be reported.
 */
export function couplingHistory(): GitFixture {
  const versions = new Map<string, number>();
  const exists = new Set<string>();
  const bump = (path: string): Change => {
    const version = (versions.get(path) ?? 0) + 1;
    versions.set(path, version);
    const content = source(path.replace(/\W/g, ""), version);
    if (!exists.has(path)) {
      exists.add(path);
      return { op: "add", path, content };
    }
    return { op: "modify", path, content };
  };

  // Each early commit also adds one bystander file, so the bulk edit at the end modifies files
  // that already exist. Adding them all at once would look like an imported history instead.
  const bystanders = Array.from({ length: 31 }, (_, i) => `src/bulk/file${String(i).padStart(2, "0")}.ts`);
  const steps: Step[] = [];
  let day = 0;
  const commit = (message: string, changes: Change[]) => {
    const bystander = bystanders[day];
    if (bystander !== undefined) changes = [...changes, bump(bystander)];
    const date = new Date(Date.UTC(2024, 0, 2 + day * 11, 9)).toISOString();
    day++;
    steps.push({ type: "commit", message, date, author, changes });
  };

  for (let i = 0; i < 5; i++) commit(`Summarise ${i}`, [bump(invoice), bump(summary)]);
  const moved: Change = { op: "rename", from: summary, path: movedSummary, content: source(summary.replace(/\W/g, ""), 99) };
  exists.delete(summary);
  exists.add(movedSummary);
  commit("Move reporting", [moved]);
  for (let i = 0; i < 5; i++) commit(`Register ${i}`, [bump(invoice), bump(registry)]);
  for (let i = 0; i < 10; i++) commit(`Test ${i}`, [bump(invoice), bump(invoiceTest)]);
  for (let i = 0; i < 2; i++) commit(`Tweak ${i}`, [bump(invoice)]);
  for (let i = 0; i < 3; i++) commit(`Flag ${i}`, [bump("src/flags/on.ts"), bump("lib/flags/off.ts")]);
  for (let i = 0; i < 5; i++) commit(`Scratch ${i}`, [bump(invoice), bump("src/scratch/tmp.ts")]);
  commit("Remove scratch", [{ op: "delete", path: "src/scratch/tmp.ts" }]);
  const bulk = bystanders.map(bump);
  commit("Reformat everything", [bump(invoice), bump(movedSummary), ...bulk]);

  return GitFixture.build(steps);
}
