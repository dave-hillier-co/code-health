import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { GitFixture, type Step } from "@code-health/fixtures/git-fixture";
import { ann, bob, cy } from "./support/knowledge-scenario.ts";
import { runCochange } from "./support/run.ts";

vi.setConfig({ testTimeout: 120_000 });

const before = "src/engine.ts";
const after = "src/core/engine.ts";

let repo: GitFixture;
beforeAll(() => {
  const steps: Step[] = [];
  const commit = (day: string, author: typeof ann, message: string) => {
    steps.push({ type: "commit", message, date: `${day}T09:00:00Z`, author, changes: [] });
  };
  steps.push({
    type: "commit",
    message: "Start the engine",
    date: "2023-01-10T09:00:00Z",
    author: cy,
    changes: [{ op: "add", path: before, content: `${Array.from({ length: 10 }, (_, i) => `export const e${i} = ${i};`).join("\n")}\n` }],
  });
  commit("2023-06-01", cy, "Hand over");
  // Ann and Bob stay active every second month until the end.
  for (const [i, day] of ["2023-03-01", "2023-05-01", "2023-07-01", "2023-09-01", "2023-11-01", "2024-01-01", "2024-05-01", "2024-07-01", "2024-09-01", "2024-11-01", "2025-01-01"].entries()) {
    commit(day, i % 2 === 0 ? ann : bob, `Maintenance ${i}`);
  }
  commit("2024-03-01", bob, "Move the engine");
  steps.push({ type: "commit", message: "Move the engine into core", date: "2024-03-02T09:00:00Z", author: ann, changes: [{ op: "rename", from: before, path: after }] });
  repo = GitFixture.build(steps.sort((a, b) => ("date" in a && "date" in b ? Date.parse(a.date) - Date.parse(b.date) : 0)));
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: true, trials: 500, turnoverRate: 100 } } }));
});
afterAll(() => repo.dispose());

test("a file renamed between the two dates is the same file, so its abandonment is a hit and not a file that is gone", async () => {
  const { stdout } = await runCochange(repo.path, ["abandonment", "backtest", "--at", "2023-10-31", "--limit", "all", "--json"]);
  const { results } = JSON.parse(stdout);
  expect(results.candidates).toBe(1);
  expect(results.predicted).toEqual({ files: 1, goneByOutcome: 0 });
  expect(results.actual).toEqual({ files: 1 });
  expect(results.truePositives).toBe(1);
  expect(results.files.map((f: { path: string }) => f.path)).toEqual([before]);
});
