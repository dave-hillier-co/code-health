import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { runStructure } from "./support/run.ts";
import { directRepository, mechanismsRepository } from "./support/census-scenario.ts";

let repo: GitFixture;
let direct: GitFixture;
beforeAll(() => {
  repo = mechanismsRepository();
  direct = directRepository();
});
afterAll(() => {
  repo?.dispose();
  direct?.dispose();
});

interface Nearby {
  mechanism: string;
  variant: string;
  path: string;
  line: number | null;
  detail: string;
  distance: number;
  near: "from" | "to" | "both";
}

async function evidence(cwd: string, edge: string) {
  const run = await runStructure(cwd, ["evidence", "--json", edge]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return { stdout: run.stdout, pack: (JSON.parse(run.stdout) as { results: { nearbyMechanisms: Nearby[] }[] }).results[0]! };
}

const edge = "src/orders/report.ts->src/billing/lines.ts";

test("mechanisms in the two modules' folders come first, each saying which side it is near", async () => {
  const { pack } = await evidence(repo.path, edge);
  const inside = pack.nearbyMechanisms.filter((m) => m.distance === 0);
  expect(inside.map((m) => [m.mechanism, m.path, m.near])).toEqual([
    ["callbacks", "src/billing/lines.ts", "both"],
    ["events", "src/billing/listen.ts", "to"],
    ["events", "src/orders/place.ts", "from"],
  ]);
});

test("then mechanisms in neighbouring folders, nearest first, at most ten", async () => {
  const { pack } = await evidence(repo.path, edge);
  expect(pack.nearbyMechanisms).toHaveLength(10);
  const distances = pack.nearbyMechanisms.map((m) => m.distance);
  expect(distances).toEqual([...distances].sort((a, b) => a - b));
  // src/events is a sibling of src/orders and src/billing: up one, down one.
  expect(pack.nearbyMechanisms.find((m) => m.path === "src/events/bus.ts")).toMatchObject({ distance: 2, near: "both" });
});

test("a codebase using no mechanism has none nearby", async () => {
  const { pack } = await evidence(direct.path, "src/a.ts->src/b.ts");
  expect(pack.nearbyMechanisms).toEqual([]);
});

test("the evidence pack with nearby mechanisms matches the golden", async () => {
  const { stdout } = await evidence(repo.path, edge);
  expectGolden("census", "evidence.nearby", stdout);
});
