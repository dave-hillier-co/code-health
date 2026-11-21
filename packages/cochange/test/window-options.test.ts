import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { runCochange } from "./support/run.ts";
import { steadyHistory } from "./support/scenarios.ts";

let repo: GitFixture;
let parent: string;
let clone: string;
beforeAll(() => {
  repo = steadyHistory();
  parent = mkdtempSync(join(tmpdir(), "cochange-window-"));
  clone = join(parent, "clone");
  execFileSync("git", ["clone", "--quiet", "--depth", "3", `file://${repo.path}`, clone], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
}, 120_000);
afterAll(() => {
  repo.dispose();
  rmSync(parent, { recursive: true, force: true });
});

const windowed = [["hotspots"], ["coupling"], ["clusters"], ["brief", "src/billing/invoice.ts"]] as const;

describe.each(windowed)("cochange %s in a shallow clone", (command, ...rest) => {
  test("refuses without a window, and the window the error asks for can be given", async () => {
    const refused = await runCochange(clone, [command, ...rest, "--json"]);
    expect(refused.code).toBe(ExitCode.Environment);
    expect(JSON.parse(refused.stderr).error.code).toBe("shallow-clone");

    const stated = await runCochange(clone, [command, ...rest, "--json", "--since", "2024-01-01"]);
    expect(stated.stderr).toBe("");
    expect(stated.code).toBe(ExitCode.Success);
    expect(JSON.parse(stated.stdout).evidence.truncated.shallow).toBe(true);
  });
});

describe("--since and --until on a history command", () => {
  test("cut the window: since included, until excluded, a bare until looking back the configured months", async () => {
    const run = await runCochange(repo.path, ["hotspots", "--json", "--since", "2024-01-01", "--until", "2024-03-01"]);
    expect(run.code).toBe(ExitCode.Success);
    expect(JSON.parse(run.stdout).window).toEqual({ since: "2024-01-01T00:00:00.000Z", until: "2024-03-01T00:00:00.000Z" });

    const bare = await runCochange(repo.path, ["hotspots", "--json", "--until", "2024-03-01"]);
    expect(JSON.parse(bare.stdout).window).toEqual({ since: "2023-03-01T00:00:00.000Z", until: "2024-03-01T00:00:00.000Z" });
  });

  test("a window that is not a date, or ends before it starts, is a usage error", async () => {
    expect((await runCochange(repo.path, ["hotspots", "--since", "last week"])).code).toBe(ExitCode.Usage);
    expect((await runCochange(repo.path, ["hotspots", "--since", "2024-03-01", "--until", "2024-01-01"])).code).toBe(ExitCode.Usage);
  });
});
