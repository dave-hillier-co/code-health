import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { withoutMeta } from "./support/golden.ts";
import { distantHelpers } from "./support/scenarios.ts";

const main = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts");

let first: GitFixture;
let second: GitFixture;
beforeAll(() => {
  first = distantHelpers();
  second = distantHelpers();
});
afterAll(() => {
  first.dispose();
  second.dispose();
});

/** The real entry point in a child process, so the environment and working directory really are the ones stated. */
function analyseIn(repo: GitFixture, env: Record<string, string>, cwd = repo.path): string {
  const result = spawnSync(process.execPath, [main, "analyse", "--json", "--limit", "all"], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return withoutMeta(result.stdout);
}

test("the time zone, the locale and the directory the command is run from do not change a byte", () => {
  const baseline = analyseIn(first, { TZ: "UTC", LANG: "C" });
  const environments: Record<string, string>[] = [
    { TZ: "Pacific/Kiritimati", LANG: "C" },
    { TZ: "America/Los_Angeles", LANG: "de_DE.UTF-8" },
    { TZ: "Asia/Kolkata", LC_ALL: "tr_TR.UTF-8" },
  ];
  for (const env of environments) expect(analyseIn(first, env), JSON.stringify(env)).toBe(baseline);
  const inner = join(first.path, "src", "shared");
  mkdirSync(inner, { recursive: true });
  expect(analyseIn(first, { TZ: "UTC" }, inner)).toBe(baseline);
});

test("a cold parse and history cache, a warm one and a repository at another path give the same bytes", () => {
  rmSync(join(first.path, ".cache"), { recursive: true, force: true });
  const cold = analyseIn(first, { TZ: "UTC" });
  const warm = analyseIn(first, { TZ: "UTC" });
  expect(warm).toBe(cold);
  expect(analyseIn(second, { TZ: "UTC" })).toBe(cold);
});
