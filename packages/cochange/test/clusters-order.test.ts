import { afterAll, beforeAll, expect, test } from "vitest";
import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { runCochange } from "./support/run.ts";

const author: Identity = { name: "Alice", email: "alice@example.com" };
const distantPair = ["alpha/one/two/three/x.ts", "omega/four/five/six/y.ts"];
const spreadTrio = ["src/a/p.ts", "src/b/q.ts", "src/c/r.ts"];

let repo: GitFixture;
beforeAll(() => {
  const versions = new Map<string, number>();
  const bump = (path: string): Change => {
    const version = (versions.get(path) ?? 0) + 1;
    versions.set(path, version);
    return { op: version === 1 ? "add" : "modify", path, content: `export const version = ${version};\n` };
  };
  const steps: Step[] = [];
  let day = 0;
  const commit = (message: string, paths: string[]) => {
    const date = new Date(Date.UTC(2024, 0, 2 + day * 5, 9)).toISOString();
    day++;
    steps.push({ type: "commit", message, date, author, changes: paths.map(bump) });
  };
  for (let i = 0; i < 7; i++) commit(`Adjust the distant pair ${i}`, distantPair);
  for (let i = 0; i < 7; i++) commit(`Adjust the trio ${i}`, spreadTrio);
  repo = GitFixture.build(steps);
});
afterAll(() => repo.dispose());

test("a cluster with a finding is listed before one without, whatever their scores", async () => {
  const { stdout } = await runCochange(repo.path, ["clusters", "--json"]);
  const rows = JSON.parse(stdout).results as { files: string[]; score: number; findings: string[] }[];
  expect(rows.map((row) => row.files)).toEqual([spreadTrio, distantPair]);
  expect(rows[0]!.score).toBeLessThan(rows[1]!.score);
  expect(rows[0]!.findings).toEqual(["cluster"]);
});
