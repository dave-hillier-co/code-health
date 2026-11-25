import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { runStructure } from "./support/run.ts";
import { directRepository, mechanismsRepository, workspaceRepository } from "./support/census-scenario.ts";

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
  count: number;
  samePackage: boolean;
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

test("entries of the modules' own package come first, and repeats of one entry in one folder are listed once with a count", async () => {
  const workspace = workspaceRepository();
  try {
    const run = await runStructure(workspace.path, ["evidence", "--json", "packages/app/src/orders/place.ts->packages/app/src/billing/lines.ts"]);
    expect(run.stderr).toBe("");
    const pack = (JSON.parse(run.stdout) as { results: { nearbyMechanisms: Nearby[]; nearbyMechanismsOmitted: number }[] }).results[0]!;
    expect(pack.nearbyMechanisms).toEqual([
      { mechanism: "events", variant: "call", path: "packages/app/src/events/announce.ts", line: 3, detail: "bus.emit", count: 3, samePackage: true, distance: 2, near: "both" },
      { mechanism: "events", variant: "base-type", path: "packages/app/src/events/bus.ts", line: 2, detail: "new EventEmitter", count: 1, samePackage: true, distance: 2, near: "both" },
      { mechanism: "events", variant: "base-type", path: "packages/app/src/orders/plugin/hook.ts", line: 2, detail: "new EventEmitter", count: 1, samePackage: false, distance: 1, near: "from" },
      { mechanism: "events", variant: "call", path: "packages/app/src/orders/plugin/hook.ts", line: 3, detail: "hooks.on", count: 1, samePackage: false, distance: 1, near: "from" },
    ]);
    expect(pack.nearbyMechanismsOmitted).toBe(0);
  } finally {
    workspace.dispose();
  }
});

test("a codebase using no mechanism has none nearby", async () => {
  const { pack } = await evidence(direct.path, "src/a.ts->src/b.ts");
  expect(pack.nearbyMechanisms).toEqual([]);
});

test("the evidence pack with nearby mechanisms matches the golden", async () => {
  const { stdout } = await evidence(repo.path, edge);
  expectGolden("census", "evidence.nearby", stdout);
});
