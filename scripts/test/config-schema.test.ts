import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, test } from "vitest";
import { loadConfig } from "../../packages/cli-kit/src/config.ts";
import { cochangeConfig } from "../../packages/cochange/src/config.ts";
import { complexityConfig } from "../../packages/complexity/src/config.ts";
import { localityConfig } from "../../packages/locality/src/config.ts";
import { structureConfig } from "../../packages/structure/src/config.ts";
import { checkConfigSchema, generateConfigSchema, SCHEMA_FILE } from "../config-schema.mjs";

const root = join(import.meta.dirname, "..", "..");
const schema = JSON.parse(readFileSync(join(root, SCHEMA_FILE), "utf8"));
const validate = new Ajv2020({ strict: true }).compile(schema);

test("the committed schema is what the plugins' config sections generate", async () => {
  expect(await checkConfigSchema(root)).toEqual([]);
});

test("a stale committed schema is reported with the command that fixes it", async () => {
  const copy = mkdtempSync(join(tmpdir(), "config-schema-"));
  try {
    writeFileSync(join(copy, SCHEMA_FILE), "{}\n");
    const [problem] = await checkConfigSchema(copy, root);
    expect(problem).toMatch(/npm run config-schema/);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("generation is deterministic", async () => {
  expect(await generateConfigSchema(root)).toBe(await generateConfigSchema(root));
});

test("the schema is where this repository's code-health.json points", () => {
  const own = JSON.parse(readFileSync(join(root, "code-health.json"), "utf8"));
  expect(own.$schema).toBe(`https://raw.githubusercontent.com/dave-hillier-co/code-health/main/${SCHEMA_FILE}`);
  expect(schema.$id).toBe(own.$schema);
});

test("this repository's own code-health.json validates", () => {
  const own = JSON.parse(readFileSync(join(root, "code-health.json"), "utf8"));
  expect(validate(own), JSON.stringify(validate.errors)).toBe(true);
});

test("every plugin's defaults validate, and each loads the same document the schema accepts", () => {
  for (const spec of [cochangeConfig, complexityConfig, localityConfig, structureConfig]) {
    expect(validate({ [spec.plugin]: spec.section }), `${spec.plugin}: ${JSON.stringify(validate.errors)}`).toBe(true);
    const copy = mkdtempSync(join(tmpdir(), "config-schema-"));
    try {
      const document = { exclude: ["dist/**"], languages: { zig: "rust" }, [spec.plugin]: spec.section };
      writeFileSync(join(copy, "code-health.json"), JSON.stringify(document));
      expect(() => loadConfig(copy, spec)).not.toThrow();
      expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
});

test("a setting no plugin has is rejected", () => {
  expect(validate({ locality: { minDistanc: 2 } })).toBe(false);
  expect(validate({ complexity: { guidelines: { nesting: "deep" } } })).toBe(false);
});
