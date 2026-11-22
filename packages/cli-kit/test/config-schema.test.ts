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
    "components",
    "vagueNames",
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

test("each setting carries its default, so an editor can show it", () => {
  const cochange = (schema.properties as Record<string, { properties: Record<string, { default: unknown }> }>).cochange!;
  expect(cochange.properties.windowMonths!.default).toBe(12);
});
