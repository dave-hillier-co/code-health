import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadConfig } from "@code-health/cli-kit/config";
import { localityConfig, readSettings } from "../src/config.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "locality-config-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function settingsFor(document: unknown) {
  writeFileSync(join(dir, "code-health.json"), JSON.stringify(document));
  return readSettings(loadConfig(dir, localityConfig));
}

function failureFor(document: unknown): string {
  try {
    settingsFor(document);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

test("defaults follow the spec", () => {
  expect(settingsFor({})).toMatchObject({
    minDistance: 2,
    tinyLines: 15,
    largeLines: 150,
    inlineHostLines: 300,
    highFanIn: 8,
    maxDepth: 6,
    fixedPoints: [],
    entryPoints: [],
    exclude: [],
    vagueNames: ["utils", "helpers", "common", "misc"],
  });
});

test("the file overrides defaults and the suite-wide keys are read from the shared part", () => {
  const settings = settingsFor({
    entryPoints: ["src/main.ts"],
    exclude: ["dist"],
    locality: { minDistance: 3, highFanIn: 4, fixedPoints: ["src/routes/**"] },
  });
  expect(settings).toMatchObject({
    minDistance: 3,
    highFanIn: 4,
    fixedPoints: ["src/routes/**"],
    entryPoints: ["src/main.ts"],
    exclude: ["dist"],
  });
});

test("settings must be positive integers and sizes must be ordered", () => {
  expect(failureFor({ locality: { minDistance: 0 } })).toMatch(/locality.minDistance must be a positive integer/);
  expect(failureFor({ locality: { tinyLines: 200, largeLines: 100 } })).toMatch(/tinyLines must be below locality.largeLines/);
  expect(failureFor({ locality: { fixedPoints: [1] } })).toMatch(/locality.fixedPoints must be an array of strings/);
});

test("unknown settings are rejected", () => {
  expect(failureFor({ locality: { nope: 1 } })).toMatch(/locality.nope is an unknown setting/);
});
