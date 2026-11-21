import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadConfig } from "@code-health/cli-kit/config";
import { structureConfig, readSettings } from "../src/config.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "structure-config-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function settingsFor(document: unknown) {
  writeFileSync(join(dir, "code-health.json"), JSON.stringify(document));
  return readSettings(loadConfig(dir, structureConfig));
}

test("defaults", () => {
  expect(settingsFor({})).toMatchObject({
    ref: "HEAD",
    windowMonths: 12,
    exactLimit: 16,
    minRevisions: 3,
    minVolatilityRatio: 2,
    minInstabilityGap: 20,
  });
});

test("the section overrides defaults", () => {
  expect(settingsFor({ structure: { exactLimit: 8, branch: "trunk" } })).toMatchObject({ exactLimit: 8, ref: "trunk" });
});

test("an exact limit above what the subset search supports is a config error", () => {
  expect(() => settingsFor({ structure: { exactLimit: 31 } })).toThrow(/exactLimit/);
});

test("unknown keys are rejected", () => {
  expect(() => settingsFor({ structure: { exactLimt: 8 } })).toThrow();
});

test("coupling, hub and check settings have defaults", () => {
  expect(settingsFor({})).toMatchObject({
    minStaticCoupling: 3,
    minSupport: 3,
    significanceLevel: 0.01,
    hubMinFeatures: 3,
    hubMinConfidence: 50,
    hubMaxFeatureCoupling: 20,
    hubMinOutward: 50,
    hubMinAppendShare: 60,
    hubContentionDays: 14,
    hubMinAuthors: 3,
    layers: [],
    mainBranch: "main",
    base: null,
  });
});

test("the significance level is a probability", () => {
  expect(() => settingsFor({ structure: { significanceLevel: 1 } })).toThrow(/significanceLevel/);
  expect(() => settingsFor({ structure: { significanceLevel: 0 } })).toThrow(/significanceLevel/);
  expect(settingsFor({ structure: { significanceLevel: 0.05 } })).toMatchObject({ significanceLevel: 0.05 });
});

test("hub shares are percentages", () => {
  expect(() => settingsFor({ structure: { hubMinAppendShare: 101 } })).toThrow(/percentage/);
});

test("layers are validated and read in order", () => {
  const layers = [
    { name: "ui", paths: ["src/ui/**"] },
    { name: "domain", paths: ["src/domain/**"], allow: ["ui"] },
  ];
  expect(settingsFor({ structure: { layers } }).layers).toEqual([
    { name: "ui", paths: ["src/ui/**"], allow: null },
    { name: "domain", paths: ["src/domain/**"], allow: ["ui"] },
  ]);
  expect(() => settingsFor({ structure: { layers: [{ name: "ui" }] } })).toThrow(/paths/);
});
