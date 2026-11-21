import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadConfig } from "@code-health/cli-kit/config";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { cochangeConfig, readSettings } from "../src/config.ts";
import { runCochange } from "./support/run.ts";
import { steadyHistory } from "./support/scenarios.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cochange-config-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function settingsFor(document: unknown) {
  writeFileSync(join(dir, "code-health.json"), JSON.stringify(document));
  return readSettings(loadConfig(dir, cochangeConfig));
}

test("defaults follow the spec", () => {
  expect(settingsFor({})).toMatchObject({
    ref: "HEAD",
    firstParent: false,
    windowMonths: 12,
    recentMonths: 3,
    maxChangesetSize: 30,
    botPatterns: [],
    windowStated: false,
  });
});

test("the file overrides defaults, and stating the window is remembered", () => {
  const settings = settingsFor({
    exclude: ["dist/**"],
    cochange: { branch: "develop", windowMonths: 6, firstParent: true, identities: { botPatterns: ["bot$"] } },
  });
  expect(settings).toMatchObject({
    ref: "develop",
    windowMonths: 6,
    firstParent: true,
    exclude: ["dist/**"],
    botPatterns: ["bot$"],
    windowStated: true,
  });
});

test.each([
  [{ cochange: { windowMonths: 0 } }, "windowMonths must be a positive integer"],
  [{ cochange: { windowMonths: 1.5 } }, "windowMonths must be a positive integer"],
  [{ cochange: { minDegree: 101 } }, "percentage"],
  [{ cochange: { branch: "" } }, "branch"],
  [{ cochange: { branch: 3 } }, "branch"],
  [{ cochange: { grouping: "issue-key" } }, "grouping"],
  [{ cochange: { identities: { botPatterns: [1] } } }, "botPatterns"],
  [{ cochange: { nonsense: true } }, "unknown setting"],
])("invalid settings %j are config errors", (document, message) => {
  expect(() => settingsFor(document)).toThrowError(message);
});

test("config explain shows the cochange defaults and where values came from", async () => {
  const repo: GitFixture = steadyHistory();
  try {
    writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"windowMonths":6}}\n');
    const { code, stdout } = await runCochange(repo.path, ["config", "explain", "--limit", "all"]);
    expect(code).toBe(ExitCode.Success);
    const rows: { path: string; value: unknown; source: string }[] = JSON.parse(stdout).results;
    expect(rows.find((r) => r.path === "cochange.windowMonths")).toEqual({
      path: "cochange.windowMonths",
      value: 6,
      source: "file",
    });
    expect(rows.find((r) => r.path === "cochange.maxChangesetSize")).toMatchObject({ value: 30, source: "default" });
  } finally {
    repo.dispose();
  }
});

test("a bad config file exits 2 from the CLI", async () => {
  const repo = steadyHistory();
  try {
    writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"windowMonths":-1}}\n');
    expect((await runCochange(repo.path, ["refresh"])).code).toBe(ExitCode.Usage);
  } finally {
    repo.dispose();
  }
});
