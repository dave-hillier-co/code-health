import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { distantHelpers } from "../../packages/locality/test/support/scenarios.ts";
import { bundle, bundleChunks, grammarsPath } from "../bundle.mjs";

vi.setConfig({ testTimeout: 120_000 });

let work: string;
let repo: GitFixture;
let locality: string;
let structure: string;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "composition-"));
  // The grammars are resolved beside the bundle, as they are in an installed plugin.
  cpSync(grammarsPath(), join(work, "grammars"), { recursive: true });
  locality = join(work, "locality.mjs");
  structure = join(work, "structure.mjs");
  writeFileSync(locality, await bundle("locality"));
  for (const [name, text] of await bundleChunks("locality")) writeFileSync(join(work, name), text);
  writeFileSync(structure, await bundle("structure"));
  repo = distantHelpers();
});
afterAll(() => {
  repo.dispose();
  rmSync(work, { recursive: true, force: true });
});

const run = (cli: string, ...args: string[]) => {
  const result = spawnSync("node", [cli, ...args, "--json"], { cwd: repo.path, encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
};

test("the dependency a unit is blocked by is named, by structure, as holding that unit's move back", () => {
  const analysed = run(locality, "analyse", "--limit", "all");
  const tool = analysed.results.find((row: { path: string }) => row.path === "src/lib/kernel/tool.ts");
  expect(tool.blockers).toEqual([expect.objectContaining({ path: "src/lib/kernel/core.ts", from: ["src/lib/kernel/tool.ts"] })]);

  const evidence = run(structure, "evidence", "src/lib/kernel/tool.ts->src/lib/kernel/core.ts");
  expect(evidence.inputs.locality).toMatchObject({ report: "locality.analyse", head: analysed.repo.head });
  expect(evidence.results[0].unblocks).toEqual([{ unit: "src/lib/kernel/tool.ts", unblockedGain: tool.blockers[0].unblockedGain }]);
});

test("the bundled locality plans a move and scrutinises a widely used unit, with ts-morph inside the bundle", () => {
  const planned = run(locality, "move", "src/shared/utils/money.ts");
  expect(planned.results).toEqual([{ from: "src/shared/utils/money.ts", to: "src/money.ts", role: "unit" }]);
  expect(planned.rewrites).toHaveLength(3);

  const reviewed = run(locality, "scrutinise");
  expect(reviewed.results.map((row: { path: string }) => row.path)).toEqual(["src/shared/format.ts"]);
  expect(reviewed.results[0].findings.map((finding: { flag: string }) => finding.flag)).toContain("special-general-mixture");
});
