import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture, type Change, type Identity } from "@code-health/fixtures/git-fixture";
import { runStructure } from "./support/run.ts";

const alice: Identity = { name: "Alice", email: "alice@example.com" };
const dependabot: Identity = { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" };

const source = (name: string, uses: string[], revision: number) =>
  [...uses.map((use) => `import { ${use} } from "../${use}/${use}.ts";`), `export function ${name}(): number {`, `  return ${uses.map((use) => `${use}()`).join(" + ") || "0"} + ${revision};`, "}", ""].join("\n");

const modify = (path: string, name: string, uses: string[], revision: number): Change => ({ op: "modify", path, content: source(name, uses, revision) });

let repo: GitFixture;
beforeAll(() => {
  const bulk: Change[] = Array.from({ length: 31 }, (_, i) => ({ op: "add", path: `bulk/f${i}.txt`, content: `${i}\n` }));
  repo = GitFixture.build([
    { type: "commit", message: "Add the modules", date: "2024-01-10T09:00:00Z", author: alice, changes: [
      { op: "add", path: "x/x.ts", content: source("x", [], 1) },
      { op: "add", path: "y/y.ts", content: source("y", ["x"], 1) },
    ] },
    { type: "commit", message: "Change x", date: "2024-02-10T09:00:00Z", author: alice, changes: [modify("x/x.ts", "x", [], 2)] },
    { type: "commit", message: "Bump a dependency", date: "2024-03-10T09:00:00Z", author: dependabot, changes: [modify("x/x.ts", "x", [], 3)] },
    { type: "commit", message: "Touch everything", date: "2024-04-10T09:00:00Z", author: alice, changes: [...bulk, modify("x/x.ts", "x", [], 4)] },
    { type: "commit", message: "Change y", date: "2024-05-10T09:00:00Z", author: alice, changes: [modify("y/y.ts", "y", ["x"], 2)] },
  ]);
});
afterAll(() => repo.dispose());

test("revisions leave out bot commits and over-limit changes, as cochange does", async () => {
  const run = await runStructure(repo.path, ["stability", "--json", "--by", "folder"]);
  expect(run.code).toBe(ExitCode.Success);
  const document = JSON.parse(run.stdout) as { units: { id: string; change: { revisions: number } }[] };
  const unit = document.units.find((u) => u.id === "x")!;
  expect(unit.change.revisions).toBe(2);
});
