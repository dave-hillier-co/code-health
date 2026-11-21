import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { couplingHistory } from "./support/coupling-scenarios.ts";
import { probeCli } from "./support/probe-cli.ts";
import { runCochange } from "./support/run.ts";
import { indentedHistory, steadyHistory } from "./support/scenarios.ts";

// Ajv is CommonJS: under NodeNext the default import is the module object, whose `default` is the class.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugins", "cochange", "schemas");
const load = (name: string) => JSON.parse(readFileSync(join(schemaDir, name), "utf8"));

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(load("common.schema.json"));
ajv.addSchema(load("refresh.schema.json"));
ajv.addSchema(load("spread.schema.json"));
ajv.addSchema(load("hotspots.schema.json"));
ajv.addSchema(load("age.schema.json"));
ajv.addSchema(load("coupling.schema.json"));
// How a command schema for an analysis command is composed. The probe stands in for a real one.
ajv.addSchema({
  $id: "probe.schema.json",
  allOf: [{ $ref: "common.schema.json#/$defs/analysisEnvelope" }],
  type: "object",
  properties: { command: { const: "probe" }, results: { type: "array" } },
  unevaluatedProperties: false,
});

function validates(schema: string, text: string): string[] {
  const validate = ajv.getSchema(schema)!;
  return validate(JSON.parse(text)) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

let repo: GitFixture;
beforeAll(() => {
  repo = steadyHistory();
});
afterAll(() => repo.dispose());

test("the refresh output, as printed with meta, matches its schema", async () => {
  expect(validates("refresh.schema.json", (await runCochange(repo.path, ["refresh"])).stdout)).toEqual([]);
});

test("an analysis command's output matches the shared analysis envelope", async () => {
  const { stdout } = await runCochange(repo.path, ["probe"], probeCli);
  expect(validates("probe.schema.json", stdout)).toEqual([]);
});

test("the envelope rejects a document missing the evidence block", async () => {
  const { stdout } = await runCochange(repo.path, ["probe"], probeCli);
  const { evidence: _evidence, ...without } = JSON.parse(stdout);
  expect(validates("probe.schema.json", JSON.stringify(without))).toEqual([" must have required property 'evidence'"]);
});

test("a document with a field the schema does not know is rejected", async () => {
  const { stdout } = await runCochange(repo.path, ["refresh"]);
  const extra = JSON.stringify({ ...JSON.parse(stdout), surprise: true });
  expect(validates("refresh.schema.json", extra)).toEqual([" must NOT have unevaluated properties"]);
});

test("the spread output, as printed with meta, matches its schema, and a stray field does not", async () => {
  const { stdout } = await runCochange(repo.path, ["spread"]);
  expect(validates("spread.schema.json", stdout)).toEqual([]);
  const stray = JSON.parse(stdout);
  stray.results.overall.surprise = 1;
  expect(validates("spread.schema.json", JSON.stringify(stray))).not.toEqual([]);
});

test("hotspots and age output, as printed with meta, matches its schema in both views", async () => {
  const indented = indentedHistory();
  try {
    writeFileSync(join(indented.path, "code-health.json"), JSON.stringify({ components: { core: ["src/core/**"] } }));
    for (const command of ["hotspots", "age"]) {
      for (const by of ["file", "component"]) {
        const { code, stdout } = await runCochange(indented.path, [command, "--by", by]);
        expect(code).toBe(0);
        expect(validates(`${command}.schema.json`, stdout)).toEqual([]);
      }
    }
  } finally {
    indented.dispose();
  }
});

test("coupling output, as printed with meta, matches its schema, and stray fields do not", async () => {
  const coupled = couplingHistory();
  try {
    for (const args of [[], ["--file", "src/billing/invoice.ts"], ["--min-support", "1", "--min-degree", "0"]]) {
      const { code, stdout } = await runCochange(coupled.path, ["coupling", ...args, "--limit", "all"]);
      expect(code).toBe(0);
      expect(validates("coupling.schema.json", stdout)).toEqual([]);
    }
    const { stdout } = await runCochange(coupled.path, ["coupling"]);
    const topLevel = { ...JSON.parse(stdout), surprise: true };
    expect(validates("coupling.schema.json", JSON.stringify(topLevel))).not.toEqual([]);
    const inRow = JSON.parse(stdout);
    inRow.results[0].surprise = 1;
    expect(validates("coupling.schema.json", JSON.stringify(inRow))).not.toEqual([]);
    const inEvidence = JSON.parse(stdout);
    inEvidence.results[0].evidence.surprise = 1;
    expect(validates("coupling.schema.json", JSON.stringify(inEvidence))).not.toEqual([]);
  } finally {
    coupled.dispose();
  }
});

test("an analysis output that names identity inputs still matches its schema", async () => {
  const repoWithIdentities = steadyHistory();
  try {
    mkdirSync(join(repoWithIdentities.path, ".code-health", "local"), { recursive: true });
    writeFileSync(join(repoWithIdentities.path, ".code-health", "local", "mailmap"), "Alice <alice@example.com> Bob <bob@example.com>\n");
    for (const command of ["hotspots", "age", "coupling", "spread"]) {
      const { stdout } = await runCochange(repoWithIdentities.path, [command]);
      expect(JSON.parse(stdout).inputs.identityInputs.localMailmap).toMatch(/^[0-9a-f]{16}$/);
      expect(validates(`${command}.schema.json`, stdout)).toEqual([]);
    }
  } finally {
    repoWithIdentities.dispose();
  }
});
