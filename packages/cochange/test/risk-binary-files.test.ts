import { afterAll, beforeAll, expect, test } from "vitest";
import { GitFixture, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { runCochange } from "./support/run.ts";

const alice: Identity = { name: "Alice", email: "alice@example.com" };

/** A short history, then a branch whose one change edits two source files and adds two binary files (NUL bytes, so git gives no line counts). */
let repo: GitFixture;
beforeAll(() => {
  const steps: Step[] = [];
  for (let i = 0; i < 6; i++) {
    steps.push({
      type: "commit",
      message: `Change ${i}`,
      date: new Date(Date.UTC(2024, 0, 8 + 7 * i, 9)).toISOString(),
      author: alice,
      changes: [{ op: i === 0 ? "add" : "modify", path: "src/a.ts", content: `export const a = ${i};\n` }, { op: i === 0 ? "add" : "modify", path: "src/b.ts", content: `export const b = ${i};\n` }],
    });
  }
  steps.push({ type: "branch", name: "pictures" });
  steps.push({
    type: "commit",
    message: "Edit sources and add goldens",
    date: "2024-06-03T09:00:00Z",
    author: alice,
    changes: [
      { op: "modify", path: "src/a.ts", content: "export const a = 99;\nexport const more = 1;\n" },
      { op: "modify", path: "src/b.ts", content: "export const b = 99;\n" },
      { op: "add", path: "test/golden/one.png", content: "PNG\u0000\u0001\u0002one" },
      { op: "add", path: "test/golden/two.png", content: "PNG\u0000\u0001\u0002two" },
    ],
  });
  steps.push({ type: "checkout", name: "main" });
  repo = GitFixture.build(steps);
}, 60_000);
afterAll(() => repo.dispose());

test("binary files are counted apart in entropy and as edited files in mixed-purpose, so the file counts add up", async () => {
  const { stdout } = await runCochange(repo.path, ["risk", "main..pictures", "--json"]);
  const results = JSON.parse(stdout).results as { change: { files: number }; factors: { name: string; value: Record<string, unknown> }[] };
  const value = (name: string) => results.factors.find((f) => f.name === name)!.value;
  expect(results.change.files).toBe(4);
  expect(value("entropy")).toMatchObject({ filesWithLineChanges: 2, binaryFiles: 2 });
  expect(value("mixed-purpose")).toMatchObject({ moved: 0, edited: 4 });
});
