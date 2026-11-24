import { afterAll, beforeAll, expect, test } from "vitest";
import { GitFixture, type Change, type Step } from "@code-health/fixtures/git-fixture";
import { runCochange } from "./support/run.ts";

let repo: GitFixture;
beforeAll(() => {
  const versions = new Map<string, number>();
  const bump = (path: string): Change => {
    const version = (versions.get(path) ?? 0) + 1;
    versions.set(path, version);
    const content = `export const v = ${version};\n`;
    return version === 1 ? { op: "add", path, content } : { op: "modify", path, content };
  };
  const steps: Step[] = [];
  let day = 0;
  const commit = (changes: Change[]) => {
    const date = new Date(Date.UTC(2024, 0, 2 + day * 7, 9)).toISOString();
    steps.push({ type: "commit", message: `change ${day++}`, date, author: { name: "Alice", email: "alice@example.com" }, changes });
  };
  // Two pairs with degree 100: a/a.ts with z/z.ts 5 times, b/b.ts with y/y.ts 8 times. By path a/a.ts comes first.
  for (let i = 0; i < 5; i++) commit([bump("a/a.ts"), bump("z/z.ts")]);
  for (let i = 0; i < 8; i++) commit([bump("b/b.ts"), bump("y/y.ts")]);
  repo = GitFixture.build(steps);
});
afterAll(() => repo.dispose());

test("pairs that tie on degree are listed by shared changes, highest first, before path order", async () => {
  const { stdout } = await runCochange(repo.path, ["coupling", "--json", "--no-cache"]);
  const rows = JSON.parse(stdout).results as { path: string; with: string; degree: number; support: number }[];
  expect(rows.map((row) => [row.path, row.with, row.degree, row.support])).toEqual([
    ["b/b.ts", "y/y.ts", 100, 8],
    ["a/a.ts", "z/z.ts", 100, 5],
  ]);
});
