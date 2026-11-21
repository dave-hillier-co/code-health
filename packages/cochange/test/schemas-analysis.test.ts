import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { clusterHistory } from "./support/cluster-scenarios.ts";
import { runCochange } from "./support/run.ts";

// Ajv is CommonJS: under NodeNext the default import is the module object, whose `default` is the class.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugins", "cochange", "schemas");
const load = (name: string) => JSON.parse(readFileSync(join(schemaDir, name), "utf8"));

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(load("common.schema.json"));
for (const name of ["clusters", "trend", "hotspots"]) ajv.addSchema(load(`${name}.schema.json`));

function validates(schema: string, document: unknown): string[] {
  const validate = ajv.getSchema(schema)!;
  return validate(document) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

let repo: GitFixture;
beforeAll(() => {
  repo = clusterHistory();
});
afterAll(() => repo.dispose());

const run = async (...argv: string[]) => JSON.parse((await runCochange(repo.path, argv)).stdout);

test("clusters output, as printed with meta, matches its schema, and stray fields do not", async () => {
  for (const args of [[], ["--min-support", "8"], ["--min-degree", "100"]]) {
    expect(validates("clusters.schema.json", await run("clusters", ...args, "--limit", "all"))).toEqual([]);
  }
  const document = await run("clusters");
  expect(validates("clusters.schema.json", { ...document, surprise: true })).not.toEqual([]);
  document.results[0].evidence.surprise = 1;
  expect(validates("clusters.schema.json", document)).not.toEqual([]);
});

test("trend output, as printed with meta, matches its schema", async () => {
  for (const args of [["src/drift/engine.ts"], ["src/drift/engine.ts", "--samples", "3"]]) {
    expect(validates("trend.schema.json", await run("trend", ...args))).toEqual([]);
  }
});

test("hotspots output with test-drift findings matches its schema", async () => {
  expect(validates("hotspots.schema.json", await run("hotspots", "--limit", "all"))).toEqual([]);
});
