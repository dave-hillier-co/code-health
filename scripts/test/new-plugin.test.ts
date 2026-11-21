import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import { afterAll, beforeAll, beforeEach, afterEach, expect, test, vi } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { buildAll, staleBundles } from "../bundle.mjs";
import { scaffoldPlugin, validatePluginName } from "../new-plugin.mjs";

vi.setConfig({ testTimeout: 120_000 });

// Ajv is CommonJS: under NodeNext the default import is the module object, whose `default` is the class.
const Ajv2020 = Ajv2020Module.default;

const repository = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A repository root with the real marketplace, one existing plugin's manifest and schemas, and the real packages and dependencies. */
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "new-plugin-"));
  mkdirSync(join(root, ".claude-plugin"));
  // Only cochange: the scaffold is tested against a marketplace of one existing plugin, however many the repository lists.
  const listed = readFileSync(join(repository, ".claude-plugin", "marketplace.json"), "utf8");
  const marketplace = JSON.parse(listed);
  marketplace.plugins = marketplace.plugins.filter((p: { name: string }) => p.name === "cochange");
  writeFileSync(join(root, ".claude-plugin", "marketplace.json"), JSON.stringify(marketplace, null, 2) + "\n");
  mkdirSync(join(root, "plugins", "cochange", ".claude-plugin"), { recursive: true });
  cpSync(join(repository, "plugins", "cochange", ".claude-plugin", "plugin.json"), join(root, "plugins", "cochange", ".claude-plugin", "plugin.json"));
  cpSync(join(repository, "plugins", "cochange", "schemas"), join(root, "plugins", "cochange", "schemas"), { recursive: true });
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

test("names must be kebab-case and avoid the reserved prefixes", () => {
  expect(validatePluginName("structure")).toBeNull();
  expect(validatePluginName("dead-code")).toBeNull();
  for (const bad of ["Structure", "dead_code", "-x", "x-", "1x", "claude-tools", "anthropic-x", "cc-plugin-x"]) {
    expect(validatePluginName(bad)).not.toBeNull();
  }
});

test("a scaffolded plugin has a manifest, a marketplace entry, schemas and a package", () => {
  scaffoldPlugin({ root, name: "sample-tool", description: "Does a sample thing." });

  const manifest = readJson(join(root, "plugins", "sample-tool", ".claude-plugin", "plugin.json"));
  const existing = readJson(join(root, "plugins", "cochange", ".claude-plugin", "plugin.json"));
  expect(manifest).toMatchObject({ name: "sample-tool", displayName: "Sample Tool", version: "0.1.0", description: "Does a sample thing." });
  expect(manifest).toMatchObject({ author: existing.author, license: existing.license, repository: existing.repository, engines: existing.engines });

  const marketplace = readJson(join(root, ".claude-plugin", "marketplace.json"));
  expect(marketplace.plugins.map((p: { name: string }) => p.name)).toEqual(["cochange", "sample-tool"]);
  expect(marketplace.plugins[1]).toEqual({ name: "sample-tool", source: "./plugins/sample-tool", description: "Does a sample thing." });
  expect(marketplace.plugins.every((p: object) => !("version" in p))).toBe(true);

  expect(readdirSync(join(root, "plugins", "sample-tool", "schemas")).sort()).toEqual(["common.schema.json", "describe.schema.json"]);
  expect(existsSync(join(root, "packages", "sample-tool", "src", "main.ts"))).toBe(true);
});

test("a scaffold refuses a bad name, a missing description and a name already taken", () => {
  expect(() => scaffoldPlugin({ root, name: "Bad", description: "x" })).toThrow("kebab-case");
  expect(() => scaffoldPlugin({ root, name: "fine", description: "" })).toThrow("description");
  expect(() => scaffoldPlugin({ root, name: "cochange", description: "x" })).toThrow("already exists");
});

test("the build picks the scaffolded plugin up, and its bundled CLI runs and matches its schema", async () => {
  scaffoldPlugin({ root, name: "sample-tool", description: "Does a sample thing." });
  expect(await buildAll(root)).toContain("sample-tool");
  const bundle = join(root, "plugins", "sample-tool", "dist", "sample-tool.mjs");

  const result = run(bundle, ["describe"]);
  expect(result.stderr).toBe("");
  const document = JSON.parse(result.stdout);
  expect(document).toMatchObject({ tool: "sample-tool", command: "describe", results: { plugin: "sample-tool" } });

  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const schemas = join(root, "plugins", "sample-tool", "schemas");
  for (const file of readdirSync(schemas)) ajv.addSchema(readJson(join(schemas, file)));
  const validate = ajv.getSchema("describe.schema.json")!;
  const { meta: _meta, ...withoutMeta } = document;
  expect(validate(withoutMeta), JSON.stringify(validate.errors)).toBe(true);

  expect(existsSync(join(root, "plugins", "sample-tool", "dist", "grammars"))).toBe(false);
  expect(await staleBundles(root)).not.toContain("sample-tool");
});

test("a plugin that parses ships grammars beside its bundle, which loads them relative to itself", async () => {
  scaffoldPlugin({ root, name: "sample-parser", description: "Parses a sample.", parses: true });
  await buildAll(root);
  const dist = join(root, "plugins", "sample-parser", "dist");
  expect(readdirSync(join(dist, "grammars")).sort()).toEqual([
    "tree-sitter-javascript.wasm",
    "tree-sitter-tsx.wasm",
    "tree-sitter-typescript.wasm",
    "web-tree-sitter.wasm",
  ]);

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
  expect(await staleBundles(root)).not.toContain("sample-parser");
});

test("a stale or missing grammar file makes a parsing plugin's dist stale", async () => {
  scaffoldPlugin({ root, name: "sample-parser", description: "Parses a sample.", parses: true });
  await buildAll(root);
  rmSync(join(root, "plugins", "sample-parser", "dist", "grammars", "tree-sitter-tsx.wasm"));
  expect(await staleBundles(root)).toContain("sample-parser");
});
