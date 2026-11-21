import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadConfig } from "@code-health/cli-kit/config";
import { cochangeConfig } from "../src/config.ts";
import { overridesPath, readKnowledgeSettings, readOverrides } from "../src/abandonment/settings.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "knowledge-settings-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function settingsFor(document: unknown) {
  writeFileSync(join(dir, "code-health.json"), JSON.stringify(document));
  return readKnowledgeSettings(loadConfig(dir, cochangeConfig).effective);
}

test("the analysis is off by default and the defaults follow the spec", () => {
  expect(settingsFor({})).toEqual({
    enabled: false,
    activityWindowMonths: 6,
    periodMonths: 3,
    horizonPeriods: 4,
    abandonmentThreshold: 90,
    turnoverRate: null,
    trials: 10_000,
    alphas: [95, 99],
    seed: 1,
    rank: "hotspot",
    copyDetection: true,
    atRiskProbability: 10,
    concentratedTailRatio: 3,
  });
});

test("a stated turnover rate is a percentage and is read as a fraction", () => {
  expect(settingsFor({ cochange: { knowledge: { turnoverRate: 7.5 } } }).turnoverRate).toBe(0.075);
});

test("nonsense settings are refused", () => {
  expect(() => settingsFor({ cochange: { knowledge: { abandonmentThreshold: 0 } } })).toThrow(/abandonmentThreshold/);
  expect(() => settingsFor({ cochange: { knowledge: { turnoverRate: 120 } } })).toThrow(/turnoverRate/);
  expect(() => settingsFor({ cochange: { knowledge: { alphas: [100] } } })).toThrow(/alphas/);
  expect(() => settingsFor({ cochange: { knowledge: { rank: "people" } } })).toThrow(/rank/);
  expect(() => settingsFor({ cochange: { knowledge: { unknownThing: 1 } } })).toThrow(/unknown/);
});

test("overrides live in the local folder, and an identity cannot be in both lists", () => {
  expect(overridesPath(dir)).toBe(join(dir, ".code-health", "local", "knowledge-overrides.json"));
  expect(readOverrides(dir).stamp).toBeNull();
  mkdirSync(join(dir, ".code-health", "local"), { recursive: true });
  writeFileSync(overridesPath(dir), JSON.stringify({ schemaVersion: 1, active: ["A <a@x>"], inactive: ["B <b@x>"] }));
  const read = readOverrides(dir);
  expect([...read.active, ...read.inactive]).toEqual(["A <a@x>", "B <b@x>"]);
  expect(read.stamp).toMatch(/^[0-9a-f]{16}$/);
  writeFileSync(overridesPath(dir), JSON.stringify({ schemaVersion: 1, active: ["A <a@x>"], inactive: ["A <a@x>"] }));
  expect(() => readOverrides(dir)).toThrow(/both/);
});
