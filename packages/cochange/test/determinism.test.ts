import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { clusterHistory } from "./support/cluster-scenarios.ts";
import { couplingHistory } from "./support/coupling-scenarios.ts";
import { withoutMeta } from "./support/golden.ts";
import { after, trendHistory } from "./support/trend-scenarios.ts";

const main = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts");

let clusters: GitFixture;
let coupling: GitFixture;
let trend: GitFixture;
let again: GitFixture;
beforeAll(() => {
  clusters = clusterHistory();
  coupling = couplingHistory();
  trend = trendHistory();
  again = clusterHistory();
});
afterAll(() => [clusters, coupling, trend, again].forEach((repo) => repo.dispose()));

/** The real entry point in a child process, so the environment is really the one stated. */
function run(repo: GitFixture, env: Record<string, string>, ...args: string[]): string {
  const result = spawnSync(process.execPath, [main, ...args, "--json", "--limit", "all"], { cwd: repo.path, encoding: "utf8", env: { ...process.env, ...env } });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return withoutMeta(result.stdout);
}

const commands: [string, () => GitFixture, string[]][] = [
  ["clusters", () => clusters, ["clusters"]],
  ["hotspots with test drift", () => clusters, ["hotspots"]],
  ["brief", () => coupling, ["brief", "src/billing/invoice.ts", "src/app/registry.ts"]],
  ["trend", () => trend, ["trend", after, "--samples", "4"]],
];

test.each(commands)("%s gives the same bytes in another time zone and locale, on a cold cache and a warm one", (_name, repo, args) => {
  const fixture = repo();
  rmSync(join(fixture.path, ".cache"), { recursive: true, force: true });
  const cold = run(fixture, { TZ: "UTC", LANG: "C" }, ...args);
  expect(run(fixture, { TZ: "UTC", LANG: "C" }, ...args)).toBe(cold);
  expect(run(fixture, { TZ: "Pacific/Kiritimati", LANG: "C" }, ...args)).toBe(cold);
  expect(run(fixture, { TZ: "America/Los_Angeles", LC_ALL: "tr_TR.UTF-8" }, ...args)).toBe(cold);
});

test("clusters of the same history built twice, at different paths, are the same bytes", () => {
  expect(run(again, { TZ: "UTC" }, "clusters")).toBe(run(clusters, { TZ: "UTC" }, "clusters"));
});
