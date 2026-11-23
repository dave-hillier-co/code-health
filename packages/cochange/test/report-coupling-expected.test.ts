import { afterAll, beforeAll, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { pairHistory } from "./support/pair-history.ts";
import { runCochange } from "./support/run.ts";

let rich: GitFixture;
let thin: GitFixture;
beforeAll(() => {
  rich = pairHistory([
    ["src/epsilon.ts", "src/zeta.ts", 6],
    ["src/alpha.ts", "src/beta.ts", 6],
    ["src/gamma.ts", "src/delta.ts", 8],
    ["src/mu.ts", "src/mu.test.ts", 7],
    ["testdata/one.json", "testdata/two.json", 5],
  ]);
  thin = pairHistory([
    ["src/p.ts", "src/q.ts", 5],
    ["src/r.ts", "src/s.ts", 3],
    ["src/t.ts", "src/u.ts", 4],
  ]);
});
afterAll(() => {
  rich.dispose();
  thin.dispose();
});

interface Table {
  caption: string;
  rows: { file: string; with: string }[];
  total?: number;
}
type Section = { id: string; blocks: { type: string; text?: string }[] };
const document = async (repo: GitFixture) => JSON.parse((await runCochange(repo.path, ["report", "coupling", "--slots"])).stdout);
const tables = (doc: { data: { sections: Section[] } }, id: string) => doc.data.sections.find((s) => s.id === id)!.blocks.filter((b) => b.type === "ranked-table") as unknown as Table[];
const markdown = async (repo: GitFixture) => (await runCochange(repo.path, ["report", "coupling", "--format", "md"])).stdout;

test("pairs that tie on degree are ordered by shared changes, then by path, and the caption says so", async () => {
  const doc = await document(rich);
  const [judged] = tables(doc, "pairs");
  expect(judged!.rows.map((r) => r.file)).toEqual(["src/delta.ts", "src/alpha.ts", "src/epsilon.ts"]);
  expect(judged!.caption).toContain("Sorted by degree, then shared changes, then path");
});

test("only production pairs get a judgement slot; tests and fixtures are listed apart, with a count", async () => {
  const doc = await document(rich);
  expect(doc.slots.map((s: { id: string }) => s.id)).toEqual(["pair-1", "pair-2", "pair-3", "summary", "limits"]);
  const [, expected] = tables(doc, "pairs");
  expect(expected!.rows.map((r) => r.file)).toEqual(["src/mu.test.ts", "testdata/one.json"]);
  expect(await markdown(rich)).toContain("2 pairs are expected pairs (1 a test and the code it tests, 1 a fixture or golden file and what it checks)");
});

test("a history with few pairs at the support floor says how many there are and how many sit just below it, without judging them", async () => {
  const doc = await document(thin);
  expect(doc.slots.map((s: { id: string }) => s.id)).toEqual(["pair-1", "summary", "limits"]);
  const md = await markdown(thin);
  expect(md).toContain("1 pair reaches the support floor of 5 shared changes (cochange.minSupport), which is too few to rank. The floor was not lowered. 2 further pairs share 3 to 4 changes, just below it.");
  expect(md).toContain("Pairs just below the support floor, with 3 to 4 shared changes. They are not judged.");
  expect(md).toContain("src/r.ts");
  expect(md).toContain("src/t.ts");
});

test("one line replaces the trend column when the earlier window is empty", async () => {
  const md = await markdown(rich);
  expect(md).toContain("The window before the current one holds no eligible change, so no pair has a trend.");
  expect(md).not.toContain("no earlier window");
});
