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
    hotspotPercentile: 90,
    maxChangesetSize: 30,
    botPatterns: [],
    windowStated: false,
  });
});

test("a hook section is an unknown setting, since the suite has no hooks", () => {
  expect(() => settingsFor({ cochange: { hook: { enabled: true } } })).toThrow("unknown setting");
});

test("grouping defaults to off, and the other modes carry their own settings", () => {
  expect(settingsFor({}).grouping).toEqual({ mode: "off" });
  expect(settingsFor({ cochange: { grouping: "issue-key" } }).grouping).toEqual({ mode: "issue-key", pattern: "[A-Z][A-Z0-9]+-\\d+" });
  expect(settingsFor({ cochange: { grouping: "issue-key", issuePattern: "#(\\d+)" } }).grouping).toEqual({ mode: "issue-key", pattern: "#(\\d+)" });
  expect(settingsFor({ cochange: { grouping: "author-window", groupingWindowHours: 2 } }).grouping).toEqual({ mode: "author-window", windowSeconds: 7200 });
  expect(settingsFor({ cochange: { grouping: "author-window" } }).grouping).toEqual({ mode: "author-window", windowSeconds: 4 * 3600 });
});

test("the file overrides defaults, and stating the window is remembered", () => {
  const settings = settingsFor({
    exclude: ["dist/**"],
    cochange: { branch: "develop", windowMonths: 6, firstParent: true, botPatterns: ["bot$"] },
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

test("the shared history section sets the analysis window, and the cochange section overrides it", () => {
  const shared = settingsFor({ history: { windowMonths: 6, maxChangesetSize: 10, botPatterns: ["ci$"], branch: "develop", renameSimilarity: 60 } });
  expect(shared).toMatchObject({ windowMonths: 6, maxChangesetSize: 10, botPatterns: ["ci$"], ref: "develop", renameSimilarity: 60, windowStated: true });
  const overridden = settingsFor({ history: { windowMonths: 6, maxChangesetSize: 10 }, cochange: { windowMonths: 3 } });
  expect(overridden).toMatchObject({ windowMonths: 3, maxChangesetSize: 10 });
});

test.each([
  [{ cochange: { windowMonths: 0 } }, "windowMonths must be a positive integer"],
  [{ cochange: { windowMonths: 1.5 } }, "windowMonths must be a positive integer"],
  [{ cochange: { minDegree: 101 } }, "percentage"],
  [{ cochange: { hotspotPercentile: 100 } }, "between 1 and 99"],
  [{ cochange: { hotspotPercentile: 0 } }, "positive integer"],
  [{ cochange: { branch: "" } }, "branch"],
  [{ cochange: { branch: 3 } }, "branch"],
  [{ cochange: { grouping: "weekly" } }, "grouping"],
  [{ cochange: { botPatterns: [1] } }, "cochange.botPatterns"],
  [{ history: { botPatterns: [1] } }, "history.botPatterns"],
  [{ history: { windowMonths: 0 } }, "history.windowMonths must be a positive integer"],
  [{ cochange: { identities: { location: "cloud" } } }, "identities.location"],
  [{ cochange: { identities: { servicePatterns: "ci" } } }, "servicePatterns"],
  [{ cochange: { identities: { unmappedShareGuideline: 101 } } }, "unmappedShareGuideline"],
  [{ cochange: { identities: { significantCommits: -1 } } }, "significantCommits"],
  [{ cochange: { nonsense: true } }, "unknown setting"],
  [{ cochange: { grouping: "issue-key", issuePattern: "(" } }, "issuePattern"],
  [{ cochange: { grouping: "issue-key", issuePattern: "" } }, "issuePattern"],
  [{ cochange: { grouping: "author-window", groupingWindowHours: 0 } }, "groupingWindowHours"],
])("invalid settings %j are config errors", (document, message) => {
  expect(() => settingsFor(document)).toThrowError(message);
});

test("identity settings default to an undecided location and a 5 percent unmapped guideline", () => {
  expect(settingsFor({}).identities).toEqual({
    location: null,
    servicePatterns: [],
    agentTrailerPatterns: [],
    unmappedShareGuideline: 5,
    significantCommits: 3,
  });
  expect(settingsFor({ cochange: { identities: { location: "local", servicePatterns: ["deploy"] } } }).identities).toMatchObject({
    location: "local",
    servicePatterns: ["deploy"],
  });
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
