import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import { afterAll, beforeAll, beforeEach, afterEach, expect, test, vi } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { shippedGrammarFiles } from "@code-health/parse/copy-grammars";
import { buildAll, staleBundles } from "../bundle.mjs";
import { scaffoldTool, validateToolName } from "../new-tool.mjs";

vi.setConfig({ testTimeout: 120_000 });

// Ajv is CommonJS: under NodeNext the default import is the module object, whose `default` is the class.
const Ajv2020 = Ajv2020Module.default;

const repository = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A repository root with one existing tool's schemas in the plugin folder, and the real packages and dependencies. */
let root: string;
const plugin = () => join(root, "plugins", "code-health");
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "new-tool-"));
  // Only cochange: the scaffold copies the shared schema definitions from an existing tool, however many the repository has.
  cpSync(join(repository, "plugins", "code-health", "schemas", "cochange"), join(plugin(), "schemas", "cochange"), { recursive: true });
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
  mkdirSync(join(root, "packages"));
  symlinkSync(join(repository, "packages", "parse"), join(root, "packages", "parse"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

let repo: GitFixture;
beforeAll(() => {
  repo = GitFixture.build([
    {
      type: "commit",
      message: "Add a module",
      date: "2024-01-01T00:00:00Z",
      changes: [{ op: "add", path: "src/answer.ts", content: "export const answer = 42;\n" }],
    },
  ]);
});
afterAll(() => repo.dispose());

const run = (bundle: string, args: string[]) => spawnSync("node", [bundle, ...args], { cwd: repo.path, encoding: "utf8" });
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("names must be kebab-case", () => {
  expect(validateToolName("structure")).toBeNull();
  expect(validateToolName("dead-code")).toBeNull();
  for (const bad of ["Structure", "dead_code", "-x", "x-", "1x"]) {
    expect(validateToolName(bad)).not.toBeNull();
  }
});

test("a scaffolded tool has schemas in the plugin folder and a package, and adds no plugin of its own", () => {
  const created = scaffoldTool({ root, name: "sample-tool" });

  expect(readdirSync(join(plugin(), "schemas", "sample-tool")).sort()).toEqual(["common.schema.json", "describe.schema.json"]);
  expect(readJson(join(plugin(), "schemas", "sample-tool", "common.schema.json")).$defs.envelope.properties.tool).toEqual({ const: "sample-tool" });
  expect(existsSync(join(root, "packages", "sample-tool", "src", "main.ts"))).toBe(true);
  expect(readdirSync(join(root, "plugins"))).toEqual(["code-health"]);
  expect(created.every((path) => path.startsWith("plugins/code-health/schemas/sample-tool/") || path.startsWith("packages/sample-tool/"))).toBe(true);
});

test("a scaffold refuses a bad name and a name already taken", () => {
  expect(() => scaffoldTool({ root, name: "Bad" })).toThrow("kebab-case");
  expect(() => scaffoldTool({ root, name: "cochange" })).toThrow("already exists");
});

test("the build picks the scaffolded tool up, and its bundled CLI runs from the plugin's dist and matches its schema", async () => {
  scaffoldTool({ root, name: "sample-tool" });
  expect(await buildAll(root)).toEqual(["sample-tool"]);
  const bundle = join(plugin(), "dist", "sample-tool.mjs");

  const result = run(bundle, ["describe"]);
  expect(result.stderr).toBe("");
  const document = JSON.parse(result.stdout);
  expect(document).toMatchObject({ tool: "sample-tool", command: "describe", results: { tool: "sample-tool" } });

  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const schemas = join(plugin(), "schemas", "sample-tool");
  for (const file of readdirSync(schemas)) ajv.addSchema(readJson(join(schemas, file)));
  const validate = ajv.getSchema("describe.schema.json")!;
  const { meta: _meta, ...withoutMeta } = document;
  expect(validate(withoutMeta), JSON.stringify(validate.errors)).toBe(true);

  expect(existsSync(join(plugin(), "dist", "grammars"))).toBe(false);
  expect(await staleBundles(root)).toEqual([]);
});

test("two tools are bundled into the one dist, with one notices file", async () => {
  scaffoldTool({ root, name: "sample-tool" });
  scaffoldTool({ root, name: "other-tool" });
  expect(await buildAll(root)).toEqual(["other-tool", "sample-tool"]);
  expect(readdirSync(join(plugin(), "dist")).sort()).toEqual(["THIRD_PARTY_NOTICES.md", "other-tool.mjs", "sample-tool.mjs"]);
  expect(JSON.parse(run(join(plugin(), "dist", "other-tool.mjs"), ["describe"]).stdout)).toMatchObject({ tool: "other-tool" });
  expect(await staleBundles(root)).toEqual([]);

  rmSync(join(plugin(), "dist", "other-tool.mjs"));
  expect(await staleBundles(root)).toEqual(["other-tool"]);
});

test("a tool that parses makes the plugin ship grammars beside the bundles, which load them relative to themselves", async () => {
  scaffoldTool({ root, name: "sample-parser", parses: true });
  await buildAll(root);
  const dist = join(plugin(), "dist");
  // The grammar of every supported adapter and the runtime, whichever languages are supported.
  expect(readdirSync(join(dist, "grammars")).sort()).toEqual(shippedGrammarFiles());

  // Run a copy of dist from a directory that has no node_modules and is not the build tree: the grammars must come from beside the bundle.
  const installed = mkdtempSync(join(tmpdir(), "installed-plugin-"));
  try {
    cpSync(dist, join(installed, "dist"), { recursive: true });
    const result = run(join(installed, "dist", "sample-parser.mjs"), ["parse", "src/answer.ts"]);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).results).toEqual({
      file: "src/answer.ts",
      grammar: "typescript",
      rootType: "program",
      namedChildren: 1,
      hasErrors: false,
    });
  } finally {
    rmSync(installed, { recursive: true, force: true });
  }
  expect(await staleBundles(root)).toEqual([]);
});

test("a stale or missing grammar file, or a chunk no tool produces, makes the dist stale", async () => {
  scaffoldTool({ root, name: "sample-parser", parses: true });
  await buildAll(root);
  rmSync(join(plugin(), "dist", "grammars", "tree-sitter-tsx.wasm"));
  expect(await staleBundles(root)).toContain("grammars");

  await buildAll(root);
  cpSync(join(plugin(), "dist", "sample-parser.mjs"), join(plugin(), "dist", "chunk-LEFTOVER.mjs"));
  expect(await staleBundles(root)).toContain("chunks");
  await buildAll(root);
  expect(existsSync(join(plugin(), "dist", "chunk-LEFTOVER.mjs"))).toBe(false);
});
