import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";

export const alice: Identity = { name: "Alice", email: "alice@example.com" };
export const bob: Identity = { name: "Bob", email: "bob@example.com" };
export const carol: Identity = { name: "Carol", email: "carol@example.com" };

export const invoice = "src/billing/invoice.ts";
export const tax = "src/billing/tax.ts";
export const invoiceTest = "src/billing/invoice.test.ts";
export const summary = "src/reports/summary.ts";
export const login = "src/auth/login.ts";
export const readme = "README.md";

/** `lines` stable lines, every one rewritten when the version changes: churn is then 2 x lines. */
export function body(name: string, lines: number, version: number): string {
  return Array.from({ length: lines }, (_, i) => `${name} line ${i} v${version}`).join("\n") + "\n";
}

const sizes: Record<string, number> = { [invoice]: 20, [tax]: 10, [invoiceTest]: 10, [summary]: 10, [login]: 10, [readme]: 5 };

/** The ordinary history: sixteen merged changes, fourteen direct and two merges, by Alice and Bob. */
function mainHistory(): { steps: Step[]; versions: Map<string, number> } {
  const versions = new Map<string, number>();
  const edit = (path: string, op: "add" | "modify"): Change => {
    const version = (versions.get(path) ?? 0) + 1;
    versions.set(path, version);
    return { op, path, content: body(path, sizes[path]!, version) };
  };
  const steps: Step[] = [];
  let week = 0;
  const date = () => new Date(Date.UTC(2024, 0, 8 + 7 * week++, 9)).toISOString();
  const commit = (message: string, author: Identity, changes: Change[]) =>
    steps.push({ type: "commit", message, date: date(), author, changes });
  const together = (message: string, author: Identity, op: "add" | "modify") =>
    commit(message, author, [edit(invoice, op), edit(tax, op), edit(invoiceTest, op)]);
  const feature = (name: string, author: Identity, edits: Change[]) => {
    steps.push({ type: "branch", name });
    commit(`Work on ${name}`, author, edits);
    steps.push({ type: "checkout", name: "main" });
    steps.push({ type: "merge", branch: name, message: `Merge ${name}`, date: date(), author });
  };

  commit("Add the readme", alice, [edit(readme, "add")]);
  together("Add invoicing", alice, "add");
  commit("Add a summary", bob, [edit(summary, "add")]);
  together("Adjust totals", alice, "modify");
  commit("Add login", bob, [edit(login, "add")]);
  together("Round the totals", alice, "modify");
  commit("Fix summary rounding", bob, [edit(summary, "modify")]);
  together("Apply discounts", alice, "modify");
  feature("feature-a", bob, [edit(summary, "modify"), edit(readme, "modify")]);
  together("Add surcharge", alice, "modify");
  together("Fix tax rounding", alice, "modify");
  commit("Tighten login", bob, [edit(login, "modify")]);
  feature("feature-b", bob, [edit(login, "modify")]);
  commit("Tune the summary", bob, [edit(summary, "modify")]);
  commit("Note the invoice", alice, [edit(invoice, "modify")]);
  commit("Update the readme", alice, [edit(readme, "modify")]);
  return { steps, versions };
}

/**
 * Sixteen merged changes on `main`, then five branches that each start at its tip:
 *
 * | branch     | author | touches                                                         |
 * |------------|--------|-----------------------------------------------------------------|
 * | `complete` | Alice  | invoice, tax and the invoice test, which always change together |
 * | `missing`  | Alice  | the invoice alone                                               |
 * | `mixed`    | Alice  | moves the summary and edits the readme                          |
 * | `bulk`     | Carol  | twelve new files in six folders                                 |
 * | `auth`     | Bob    | the login module under src/auth                                 |
 *
 * The invoice changed seven times, six of them with tax and with the test, so with the default
 * support of 5 and a confidence of 80 % each is expected whenever the invoice changes.
 */
export function riskHistory(): GitFixture {
  const { steps, versions } = mainHistory();
  const next = (path: string) => (versions.get(path) ?? 0) + 1;
  const edit = (path: string): Change => ({ op: "modify", path, content: body(path, sizes[path]!, next(path)) });
  const on = (name: string, author: Identity, day: string, message: string, changes: Change[]): Step[] => [
    { type: "checkout", name: "main" },
    { type: "branch", name },
    { type: "commit", message, date: `2024-06-${day}T09:00:00Z`, author, changes },
  ];
  const bulk: Change[] = Array.from({ length: 12 }, (_, i) => ({
    op: "add" as const,
    path: `src/area${i % 6}/module${i}.ts`,
    content: body(`module${i}`, 30, 1),
  }));
  return GitFixture.build([
    ...steps,
    ...on("complete", alice, "06", "Complete the invoice change", [edit(invoice), edit(tax), edit(invoiceTest)]),
    ...on("missing", alice, "07", "Change the invoice", [edit(invoice)]),
    ...on("mixed", alice, "08", "Move the summary and touch the readme", [
      { op: "rename", from: summary, path: "src/reporting/summary.ts" },
      edit(readme),
    ]),
    ...on("bulk", carol, "09", "Add a lot of modules", bulk),
    ...on("auth", bob, "10", "Change login", [edit(login)]),
    { type: "checkout", name: "main" },
  ]);
}
