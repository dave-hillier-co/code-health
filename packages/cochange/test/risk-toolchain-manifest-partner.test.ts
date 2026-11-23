import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { GitFixture, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { runCochange } from "./support/run.ts";

const alice: Identity = { name: "Alice", email: "alice@example.com" };
const mod = "tools/go.mod";
const work = "tools/go.work";
const sum = "tools/go.sum";
const main = "tools/main.go";

/** go.mod, go.work, go.sum and main.go changed together in each of ten changes. Branch `mod` edits go.mod alone. */
function history(): GitFixture {
  const steps: Step[] = [];
  let day = 0;
  const date = () => new Date(Date.UTC(2024, 0, 8 + 7 * day++, 9)).toISOString();
  const all = (i: number) => [mod, work, sum, main].map((path) => ({ op: i === 0 ? ("add" as const) : ("modify" as const), path, content: `v${i}\n` }));
  for (let i = 0; i <= 9; i++) steps.push({ type: "commit", message: `Change ${i}`, date: date(), author: alice, changes: all(i) });
  steps.push({ type: "branch", name: "mod" });
  steps.push({ type: "commit", message: "Bump a dependency", date: "2024-06-03T09:00:00Z", author: alice, changes: [{ op: "modify", path: mod, content: "bumped\n" }] });
  steps.push({ type: "checkout", name: "main" });
  return GitFixture.build(steps);
}

let repo: GitFixture;
beforeAll(() => {
  repo = history();
  repo.git("config", "user.email", "alice@example.com");
}, 60_000);
afterAll(() => repo.dispose());
beforeEach(() => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
  repo.git("checkout", "--quiet", "main");
});

test("module files of one toolchain are not missing from a change that edits go.mod, and are counted as skipped", async () => {
  const { stdout } = await runCochange(repo.path, ["risk", "main..mod", "--json"]);
  const factors = JSON.parse(stdout).results.factors as { name: string; value: Record<string, unknown>; evidence: { file: string }[] }[];
  const factor = factors.find((f) => f.name === "missing-co-change")!;
  expect(factor.evidence.map((e) => e.file)).toEqual([main]);
  expect(factor.value).toEqual({ count: 1, buildManifestPartnersSkipped: 1 });
});
