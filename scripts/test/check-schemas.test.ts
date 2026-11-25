import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { checkSchemas } from "../check-schemas.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "check-schemas-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(content));
  }
  return root;
}

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "list.schema.json",
  type: "object",
  properties: { command: { const: "list" }, results: { type: "array" } },
  required: ["command", "results"],
};

test("this repository's schemas compile and its golden outputs validate", async () => {
  const { problems, schemas, goldens } = checkSchemas();
  expect(problems).toEqual([]);
  expect(schemas).toBeGreaterThan(0);
  expect(goldens).toBeGreaterThan(0);
});

test("a golden that matches its schema passes, including variants of a command", () => {
  const root = repo({
    "plugins/code-health/schemas/p/list.schema.json": schema,
    "packages/p/test/golden/one/list.json": { command: "list", results: [] },
    "packages/p/test/golden/one/list.empty.json": { command: "list", results: [] },
  });
  expect(checkSchemas(root)).toEqual({ schemas: 1, goldens: 2, problems: [] });
});

test("a golden that breaks its schema is reported with the failing path", () => {
  const root = repo({
    "plugins/code-health/schemas/p/list.schema.json": schema,
    "packages/p/test/golden/one/list.json": { command: "list", results: 3 },
  });
  const { problems } = checkSchemas(root);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("packages/p/test/golden/one/list.json: /results must be array");
});

test("a golden without a schema, or naming another command, is reported", () => {
  const root = repo({
    "plugins/code-health/schemas/p/list.schema.json": schema,
    "packages/p/test/golden/one/missing.json": { command: "missing" },
    "packages/p/test/golden/one/list.json": { command: "other", results: [] },
  });
  const { problems } = checkSchemas(root);
  expect(problems.some((p) => p.includes("no schema plugins/code-health/schemas/p/missing.schema.json"))).toBe(true);
  expect(problems.some((p) => p.includes('names command "other"'))).toBe(true);
});

test("scenarios starting with an underscore are exempt", () => {
  const root = repo({
    "plugins/code-health/schemas/p/list.schema.json": schema,
    "packages/p/test/golden/_plumbing/probe.json": { command: "probe" },
  });
  expect(checkSchemas(root)).toEqual({ schemas: 1, goldens: 0, problems: [] });
});

test("a schema that is not valid JSON Schema is reported", () => {
  const root = repo({
    "plugins/code-health/schemas/p/bad.schema.json": { $id: "bad.schema.json", type: "nonsense" },
  });
  const { problems } = checkSchemas(root);
  expect(problems.some((p) => p.startsWith("plugins/code-health/schemas/p/bad.schema.json"))).toBe(true);
});
