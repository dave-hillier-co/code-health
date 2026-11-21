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
