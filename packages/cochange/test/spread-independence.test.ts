import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { withoutMeta } from "./support/golden.ts";
import { runCochange } from "./support/run.ts";
import { spreadHistory } from "./support/spread-scenario.ts";

const main = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts");
const config = '{"cochange":{"maxChangesetSize":4}}\n';

let first: GitFixture;
let second: GitFixture;
beforeAll(() => {
  first = spreadHistory();
  second = spreadHistory();
  for (const repo of [first, second]) writeFileSync(join(repo.path, "code-health.json"), config);
});
afterAll(() => {
  first.dispose();
  second.dispose();
});

/** The real entry point in a child process, so the environment really is the one stated. */
function spreadIn(repo: GitFixture, env: Record<string, string>, ...args: string[]): string {
  const result = spawnSync(process.execPath, [main, "spread", ...args], {
    cwd: repo.path,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return withoutMeta(result.stdout);
}

test("buckets and windows do not depend on the time zone or locale", () => {
  const baseline = spreadIn(first, { TZ: "UTC", LANG: "C" });
  for (const env of [
    { TZ: "Pacific/Kiritimati", LANG: "C" },
    { TZ: "America/Los_Angeles", LANG: "de_DE.UTF-8" },
    { TZ: "Asia/Kolkata", LC_ALL: "tr_TR.UTF-8" },
  ]) {
    expect(spreadIn(first, env), JSON.stringify(env)).toBe(baseline);
    expect(spreadIn(first, env, "--bucket", "week"), JSON.stringify(env)).toBe(spreadIn(first, { TZ: "UTC" }, "--bucket", "week"));
  }
});

test("a cold cache, a warm cache and a repository at another path give the same bytes", async () => {
  rmSync(join(first.path, ".cache"), { recursive: true, force: true });
  const cold = spreadIn(first, { TZ: "UTC" });
  const warm = spreadIn(first, { TZ: "UTC" });
  expect(warm).toBe(cold);
  expect(spreadIn(second, { TZ: "UTC" })).toBe(cold);
  const noRefresh = withoutMeta((await runCochange(first.path, ["spread", "--no-refresh", "--json"])).stdout);
  expect(noRefresh).toBe(cold);
});

test("a git configuration of the user does not change the result", () => {
  const baseline = spreadIn(second, { TZ: "UTC" });
  expect(spreadIn(second, { TZ: "UTC", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "log.showSignature", GIT_CONFIG_VALUE_0: "true", GIT_CONFIG_KEY_1: "diff.renames", GIT_CONFIG_VALUE_1: "false" })).toBe(baseline);
});

test("changes are bucketed and the window anchored by committer date, not author date", async () => {
  const repo = GitFixture.build([
    {
      type: "commit",
      message: "Authored in January, committed in February",
      date: "2024-01-31T23:00:00Z",
      committerDate: "2024-02-02T09:00:00Z",
      changes: [{ op: "add", path: "src/a.ts", content: "a(1);\n" }, { op: "add", path: "docs/b.md", content: "b\n" }],
    },
    {
      type: "commit",
      message: "Authored in March, committed in April",
      date: "2024-03-30T09:00:00Z",
      committerDate: "2024-04-04T09:00:00Z",
      changes: [{ op: "modify", path: "src/a.ts", content: "a(2);\n" }],
    },
  ]);
  try {
    const { stdout } = await runCochange(repo.path, ["spread", "--json"]);
    const document = JSON.parse(stdout);
    expect(document.window.until).toBe("2024-04-04T09:00:00.000Z");
    const populated = document.results.buckets.filter((b: { logicalChanges: number }) => b.logicalChanges > 0).map((b: { bucket: string }) => b.bucket);
    expect(populated).toEqual(["2024-02", "2024-04"]);
    // The empty March bucket sits between them: nothing was committed then, whatever the authors dated.
    expect(document.results.buckets.map((b: { bucket: string }) => b.bucket)).toEqual(["2024-02", "2024-03", "2024-04"]);
  } finally {
    repo.dispose();
  }
});
