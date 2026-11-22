import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import { buildConfigSchema } from "../src/config-schema.ts";

const section = { windowMonths: 12, firstParent: false, bots: { patterns: ["[bot]"] }, ignored: {}, base: null, tags: ["a"] };
const spec = { plugin: "cochange", section };
const schema = buildConfigSchema([spec, { plugin: "locality", section: { depth: 2 } }]);
const validate = new Ajv2020({ strict: true }).compile(schema);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-health-config-schema-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("the schema is valid and names the shared keys and a section per plugin, in a stable order", () => {
  expect(Object.keys((schema.properties as object))).toEqual([
    "$schema",
    "exclude",
    "languages",
    "entryPoints",
    "includeRoots",
    "components",
    "vagueNames",
    "history",
    "cochange",
    "locality",
  ]);
  expect(buildConfigSchema([{ plugin: "locality", section: { depth: 2 } }, spec])).toEqual(schema);
});

test("a document the loader accepts validates", () => {
  const document = {
    $schema: "https://example.com/schema.json",
    exclude: ["dist/**"],
    languages: { zig: "rust" },
    components: { billing: ["src/billing/**"] },
    cochange: { windowMonths: 6, bots: { patterns: ["svc-"] }, ignored: { anything: 1 }, base: "main", tags: ["x", "y"] },
    locality: { depth: 3 },
  };
  writeFileSync(join(root, "code-health.json"), JSON.stringify(document));
  expect(() => loadConfig(root, spec)).not.toThrow();
  expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
});

test("what the loader rejects fails validation too: unknown keys, wrong types and a bad languages value", () => {
  for (const document of [
    { cochange: { windowMonth: 6 } },
    { cochange: { windowMonths: "six" } },
    { cochange: { bots: { pattern: [] } } },
    { exclude: "dist" },
    { languages: ["zig"] },
    { languages: { zig: 1 } },
    { unknown: {} },
  ]) {
    expect(validate(document), JSON.stringify(document)).toBe(false);
  }
});

test("the shared history section and each plugin's overrides of it are in the schema", () => {
  const reading = { plugin: "structure", section: { depth: 2 }, history: ["windowMonths", "botPatterns"] as const };
  const withHistory = buildConfigSchema([reading]);
  const validateHistory = new Ajv2020({ strict: true }).compile(withHistory);
  const properties = withHistory.properties as Record<string, { properties: Record<string, { default?: unknown; description?: string }>; additionalProperties: boolean }>;
  expect(Object.keys(properties.history!.properties)).toEqual(["branch", "firstParent", "renameSimilarity", "renameLimit", "windowMonths", "maxChangesetSize", "botPatterns", "fixPatterns", "revertPatterns", "fixMatchBody", "evidence"]);
  expect(properties.history!.properties.windowMonths!.default).toBe(12);
  expect(Object.keys(properties.structure!.properties)).toEqual(["depth", "windowMonths", "botPatterns"]);
  expect(properties.structure!.properties.windowMonths!.description).toBe("Overrides history.windowMonths for the structure plugin.");
  expect(validateHistory({ history: { windowMonths: 6 }, structure: { windowMonths: 3, botPatterns: ["ci$"] } })).toBe(true);
  expect(validateHistory({ structure: { renameLimit: 5 } })).toBe(false);
  expect(validateHistory({ history: { windowMonth: 6 } })).toBe(false);
  expect(validateHistory({ history: { windowMonths: "six" } })).toBe(false);
});

test("each setting carries its default, so an editor can show it", () => {
  const cochange = (schema.properties as Record<string, { properties: Record<string, { default: unknown }> }>).cochange!;
  expect(cochange.properties.windowMonths!.default).toBe(12);
});
