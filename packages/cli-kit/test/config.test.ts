import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { explainConfig, loadConfig } from "../src/config.ts";
import { CliError, ExitCode } from "../src/errors.ts";

const section = { windowMonths: 12, firstParent: false, bots: { patterns: ["[bot]"] }, ignored: {} };
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-health-config-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeConfig(content: unknown): void {
  writeFileSync(join(root, "code-health.json"), typeof content === "string" ? content : JSON.stringify(content));
}

function load() {
  return loadConfig(root, { plugin: "cochange", section });
}

function expectConfigError(message: RegExp): void {
  try {
    load();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(ExitCode.Usage);
    expect((error as CliError).message).toMatch(message);
  }
}

test("missing file gives defaults for shared keys and the plugin section", () => {
  const config = load();
  expect(config.file).toBeNull();
  expect(config.effective).toEqual({
    exclude: [],
    languages: [],
    entryPoints: [],
    components: {},
    vagueNames: ["utils", "helpers", "common", "misc"],
    cochange: section,
  });
});

test("file values override defaults, merging objects key by key", () => {
  writeConfig({
    $schema: "https://example.com/schema.json",
    exclude: ["dist/**"],
    cochange: { windowMonths: 6, bots: { patterns: ["svc-"] } },
  });
  const { effective, file } = load();
  expect(file).toBe(join(root, "code-health.json"));
  expect(effective.exclude).toEqual(["dist/**"]);
  expect(effective.cochange).toEqual({ ...section, windowMonths: 6, bots: { patterns: ["svc-"] } });
});

test("sections of other plugins are ignored and do not affect the hash", () => {
  const before = load().hash;
  writeConfig({ locality: { anything: "goes" }, cochange: {} });
  const config = load();
  expect(config.effective).not.toHaveProperty("locality");
  expect(config.hash).toBe(before);
});

test("hash is stable, short and changes with effective values only", () => {
  const defaults = load().hash;
  expect(defaults).toMatch(/^[0-9a-f]{16}$/);
  writeConfig({ cochange: { windowMonths: 12 } });
  expect(load().hash).toBe(defaults);
  writeConfig({ cochange: { windowMonths: 3 } });
  expect(load().hash).not.toBe(defaults);
});

test("hash does not depend on key order in the file", () => {
  writeConfig('{"exclude":["a"],"cochange":{"windowMonths":3,"firstParent":true}}');
  const first = load().hash;
  writeConfig('{"cochange":{"firstParent":true,"windowMonths":3},"exclude":["a"]}');
  expect(load().hash).toBe(first);
});

test("components and open-ended sections accept any keys", () => {
  writeConfig({ components: { billing: ["src/billing/**"] }, cochange: { ignored: { a: 1 } } });
  const { effective } = load();
  expect(effective.components).toEqual({ billing: ["src/billing/**"] });
  expect((effective.cochange as typeof section).ignored).toEqual({ a: 1 });
});

test("explain reports the source of each value", () => {
  writeConfig({ exclude: ["dist/**"], cochange: { windowMonths: 6 }, components: { billing: ["b/**"] } });
  const rows = explainConfig(load());
  const byPath = Object.fromEntries(rows.map((row) => [row.path, row]));
  expect(byPath["exclude"]).toEqual({ path: "exclude", value: ["dist/**"], source: "file" });
  expect(byPath["languages"]).toEqual({ path: "languages", value: [], source: "default" });
  expect(byPath["cochange.windowMonths"]).toEqual({ path: "cochange.windowMonths", value: 6, source: "file" });
  expect(byPath["cochange.firstParent"]?.source).toBe("default");
  expect(byPath["cochange.bots.patterns"]?.source).toBe("default");
  expect(byPath["components.billing"]).toEqual({ path: "components.billing", value: ["b/**"], source: "file" });
  expect(rows.map((row) => row.path)).toEqual(rows.map((row) => row.path).sort());
});

test("invalid JSON is a config error naming the file", () => {
  writeConfig("{ nope");
  expectConfigError(/code-health\.json.*JSON/s);
});

test("a non-object document is a config error", () => {
  writeConfig("[1]");
  expectConfigError(/must be a JSON object/);
});

test("wrong types are config errors naming the key", () => {
  writeConfig({ exclude: "dist" });
  expectConfigError(/exclude.*array/);
  writeConfig({ exclude: [1] });
  expectConfigError(/exclude.*strings/);
  writeConfig({ cochange: { windowMonths: "six" } });
  expectConfigError(/cochange\.windowMonths.*number/);
  writeConfig({ cochange: "x" });
  expectConfigError(/cochange.*object/);
});

test("unknown keys in the plugin section are config errors", () => {
  writeConfig({ cochange: { windowMonth: 6 } });
  expectConfigError(/cochange\.windowMonth\b.*unknown/);
  writeConfig({ cochange: { bots: { pattern: [] } } });
  expectConfigError(/cochange\.bots\.pattern\b.*unknown/);
});
