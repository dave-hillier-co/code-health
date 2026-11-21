import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { rules } from "../src/commands.ts";
import { expectGolden } from "./support/golden.ts";
import { clusterHistory, features, hub, pair, trio } from "./support/cluster-scenarios.ts";
import { runCochange } from "./support/run.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = clusterHistory();
});
afterAll(() => repo.dispose());
afterEach(() => rmSync(join(repo.path, "code-health.json"), { force: true }));

const clusters = (...args: string[]) => runCochange(repo.path, ["clusters", ...args, "--json"]);
type Row = Record<string, any>;
const rowsOf = (stdout: string) => JSON.parse(stdout).results as [Row, Row, Row, Row];

test("the default listing matches its golden", async () => {
  const { code, stdout, stderr } = await clusters();
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  expectGolden("clusters", "clusters", stdout);
});

test("mutually coupled files form one component each, listed widest and strongest first", async () => {
  const rows = rowsOf((await clusters()).stdout);
  expect(rows.map((row) => row.files)).toEqual([[hub, ...features].sort(), pair, trio, ["src/ok/svc.test.ts", "src/ok/svc.ts"]]);
  expect(rows.map((row) => row.folders)).toEqual([4, 2, 1, 1]);
});

test("spread is the mean pairwise tree distance of the cluster's files", async () => {
  const [star, twoFolders, oneFolder] = rowsOf((await clusters()).stdout);
  // Three registry-to-feature pairs at distance 2, three feature pairs at distance 2.
  expect(star.spread).toBe(2);
  expect(twoFolders.spread).toBe(2);
  expect(oneFolder.spread).toBe(0);
});

test("a component spanning three folders is a cluster finding and a smaller one is not", async () => {
  const rows = rowsOf((await clusters()).stdout);
  expect(rows.map((row) => row.findings.includes("cluster"))).toEqual([true, false, false, false]);
});

test("a file coupled to files in three folders that never change together is a change magnet", async () => {
  const [star, ...others] = rowsOf((await clusters()).stdout);
  expect(star.findings).toEqual(["change-magnet", "cluster"]);
  expect(star.magnets).toEqual([hub]);
  expect(others.every((row) => row.magnets.length === 0)).toBe(true);
});

test("a cluster reports the weakest link, so thin evidence is visible", async () => {
  const [star] = rowsOf((await clusters()).stdout);
  expect(star.evidence).toEqual({ pairs: 3, weakestSupport: 7, clearsMinimum: true });
});

test("--min-degree 100 keeps only the files that always change together", async () => {
  const rows = rowsOf((await clusters("--min-degree", "100")).stdout);
  expect(rows.map((row) => row.files)).toEqual([pair, trio, ["src/ok/svc.test.ts", "src/ok/svc.ts"]]);
});

test("a support no pair reaches leaves nothing, with a note instead of a lowered bar", async () => {
  const document = JSON.parse((await clusters("--min-support", "8")).stdout);
  expect(document.results).toEqual([]);
  expect(document.note).toMatch(/No cluster/);
});

test("the rule explanations are registered for cochange explain", () => {
  expect(Object.keys(rules)).toEqual(expect.arrayContaining(["cluster", "change-magnet"]));
});

test("config can raise the minimum support", async () => {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { minSupport: 8 } }));
  expect(rowsOf((await clusters()).stdout)).toEqual([]);
});
