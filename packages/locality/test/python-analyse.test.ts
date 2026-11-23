import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture, type Change } from "@code-health/fixtures/git-fixture";
import { adapterById, overrideSupportedAdapters } from "@code-health/parse/languages";
import { runLocality } from "./support/run.ts";

/**
 * Locality over a Python repository: units and the import graph come from the Python adapter, the recommendation
 * from the shared rules. A helper that lives far from the two packages that use it moves to their common ancestor.
 */
const add = (path: string, content: string): Change => ({ op: "add", path, content });

let repo: GitFixture;
beforeAll(() => {
  overrideSupportedAdapters([adapterById("python")!]);
  repo = GitFixture.build([
    {
      type: "commit",
      message: "Add the app",
      date: "2024-01-01T09:00:00Z",
      changes: [
        add("code-health.json", JSON.stringify({ entryPoints: ["app/main.py"] })),
        add("app/__init__.py", ""),
        add("app/main.py", ["from app.orders.checkout import checkout", "from app.billing.invoice import invoice", "", "", "def run():", "    return checkout(), invoice()", ""].join("\n")),
        add("app/orders/__init__.py", ""),
        add("app/orders/checkout.py", ["from shared.money import money", "", "", "def checkout():", "    return money(1)", ""].join("\n")),
        add("app/billing/__init__.py", ""),
        add("app/billing/invoice.py", ["from shared.money import money", "", "", "def invoice():", "    return money(2)", ""].join("\n")),
        add("shared/__init__.py", ""),
        add("shared/money.py", ["def money(amount):", "    return round(amount * 100) / 100", ""].join("\n")),
      ],
    },
    { type: "commit", message: "Add notes", date: "2025-01-01T09:00:00Z", changes: [add("NOTES.md", "Notes.\n")] },
  ]);
});
afterAll(() => {
  overrideSupportedAdapters(undefined);
  repo.dispose();
});

test("a helper used by two packages is recommended to move to the best of their ancestors that is not a grouping folder", async () => {
  const run = await runLocality(repo.path, ["analyse", "--limit", "all"]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  const rows = JSON.parse(run.stdout).results as { path: string; recommendation: string; rule: string; location: string; target: string; fanIn: number; unit: { kind: string; files: string[] } }[];
  const money = rows.find((row) => row.path === "shared/money.py")!;
  expect(money).toMatchObject({ recommendation: "move", rule: "two-consumers", location: "shared", target: "app/billing", fanIn: 2 });
  expect(money.unit.files).toEqual(["shared/money.py"]);
});
