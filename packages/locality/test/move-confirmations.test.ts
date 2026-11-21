import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { GitFixture, type Change } from "@code-health/fixtures/git-fixture";
import { runLocality } from "./support/run.ts";

const add = (path: string, content: string): Change => ({ op: "add", path, content });

interface Confirmation {
  language: string;
  tool: string;
  status: "confirmed" | "not confirmed";
  detail: string;
}

let python: GitFixture;
let typescript: GitFixture;
beforeAll(() => {
  python = GitFixture.build([
    {
      type: "commit",
      message: "Add the app",
      date: "2024-01-01T09:00:00Z",
      changes: [
        add("code-health.json", JSON.stringify({ entryPoints: ["src/app/main.py"] })),
        add("src/app/main.py", "from orders.place import place\nfrom billing.charge import charge\n\n\ndef run():\n    return [place(), charge()]\n"),
        add("src/orders/__init__.py", ""),
        add("src/billing/__init__.py", ""),
        add("src/orders/place.py", "from shared.utils.money import format_money\n\n\ndef place():\n    return format_money(1)\n"),
        add("src/billing/charge.py", "from shared.utils.money import format_money\n\n\ndef charge():\n    return format_money(2)\n"),
        add("src/shared/__init__.py", ""),
        add("src/shared/utils/__init__.py", ""),
        add("src/shared/utils/money.py", "def format_money(amount):\n    return '$' + str(amount)\n"),
      ],
    },
    { type: "commit", message: "Add notes", date: "2025-01-01T09:00:00Z", changes: [add("NOTES.md", "Notes.\n")] },
  ]);
  typescript = GitFixture.build([
    {
      type: "commit",
      message: "Add the app",
      date: "2024-01-01T09:00:00Z",
      changes: [
        add("code-health.json", JSON.stringify({ entryPoints: ["src/app/main.ts"] })),
        add("src/app/main.ts", 'import { place } from "../orders/place.ts";\nimport { charge } from "../billing/charge.ts";\nexport const run = () => [place(), charge()];\n'),
        add("src/orders/place.ts", 'import { money } from "../shared/utils/money.ts";\nexport function place(): string {\n  return money(1);\n}\n'),
        add("src/billing/charge.ts", 'import { money } from "../shared/utils/money.ts";\nexport function charge(): string {\n  return money(2);\n}\n'),
        add("src/shared/utils/money.ts", 'export function money(amount: number): string {\n  return "$" + amount;\n}\n'),
      ],
    },
    { type: "commit", message: "Add notes", date: "2025-01-01T09:00:00Z", changes: [add("NOTES.md", "Notes.\n")] },
  ]);
});
afterAll(() => {
  python.dispose();
  typescript.dispose();
});

const scratch: string[] = [];
const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Puts a `python3` that cannot import rope first on the PATH, so the confirmation does not depend on this machine. */
function withPythonWithoutRope(): void {
  const directory = mkdtempSync(join(tmpdir(), "code-health-python-"));
  scratch.push(directory);
  writeFileSync(join(directory, "python3"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(directory, "python3"), 0o755);
  process.env.PATH = `${directory}${delimiter}${originalPath}`;
}

async function confirmationsOf(repo: GitFixture, unit: string): Promise<Confirmation[]> {
  const run = await runLocality(repo.path, ["move", "--json", unit]);
  return (JSON.parse(run.stdout) as { confirmations: Confirmation[] }).confirmations;
}

test("a move reports what the language's confirming tool said, not confirmed when the tool cannot check it", async () => {
  withPythonWithoutRope();
  const confirmations = await confirmationsOf(python, "src/shared/utils/money.py");
  expect(confirmations).toEqual([{ language: "python", tool: "rope", status: "not confirmed", detail: expect.stringContaining("rope is not installed") }]);
});

test("a move of a language with no confirming tool has no confirmations", async () => {
  expect(await confirmationsOf(typescript, "src/shared/utils/money.ts")).toEqual([]);
});
