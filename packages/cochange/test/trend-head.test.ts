import { afterAll, beforeAll, expect, test } from "vitest";
import { GitFixture, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { runCochange } from "./support/run.ts";
import { nested } from "./support/trend-scenarios.ts";

const author: Identity = { name: "Alice", email: "alice@example.com" };
const file = "src/engine.ts";

let repo: GitFixture;
beforeAll(() => {
  const bot: Identity = { name: "dependabot[bot]", email: "bot@example.com" };
  const steps: Step[] = [
    { type: "commit", message: "Add the engine", date: "2024-01-01T09:00:00+00:00", author, changes: [{ op: "add", path: file, content: nested(1) }] },
    { type: "commit", message: "Nest the engine", date: "2024-02-01T09:00:00+00:00", author, changes: [{ op: "modify", path: file, content: nested(2) }] },
    // A commit the analysed history leaves out (a bot commit), after the last commit it keeps.
    { type: "commit", message: "Rewrite the engine", date: "2024-03-01T09:00:00+00:00", author: bot, changes: [{ op: "modify", path: file, content: nested(6) }] },
  ];
  repo = GitFixture.build(steps);
});
afterAll(() => repo.dispose());

test("when the analysed history leaves out a later change the last sample is the file at HEAD, so the peak is not below the current value", async () => {
  const { stdout } = await runCochange(repo.path, ["trend", file, "--json"]);
  expectGolden("trend", "trend.at-head", stdout);
  const result = JSON.parse(stdout).results;
  expect(result.revisions).toBe(2);
  const last = result.samples.at(-1);
  expect(last).toMatchObject({ commit: repo.git("rev-parse", "HEAD"), complexity: 36, atHead: true });
  expect(result.summary.peak.complexity).toBe(36);
  expect(result.summary.complexity.last).toBe(36);
  expect(result.samples.at(-2).complexity).toBe(4);
  expect(result.samples.slice(0, -1).every((s: { atHead?: boolean }) => s.atHead === undefined)).toBe(true);
});
