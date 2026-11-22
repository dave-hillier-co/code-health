import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "vitest";
import { serialise } from "../src/serialise.ts";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { explainConfig, historyDefaults, loadConfig, PLUGIN_SECTIONS, type PluginConfigSpec } from "../src/config.ts";
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
    testPatterns: [],
    languages: {},
    entryPoints: [],
    includeRoots: [],
    components: {},
    vagueNames: ["utils", "helpers", "common", "misc"],
    history: historyDefaults,
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

test("includeRoots is a shared list of directories, and anything else fails", () => {
  writeConfig({ includeRoots: ["src", "third_party/include"] });
  expect(load().effective.includeRoots).toEqual(["src", "third_party/include"]);
  writeConfig({ includeRoots: "src" });
  expect(() => load()).toThrow(/includeRoots must be an array of strings/);
});

test("testPatterns is a shared list of globs, and anything else fails", () => {
  writeConfig({ testPatterns: ["src/support/**", "!test/real.ts"] });
  expect(load().effective.testPatterns).toEqual(["src/support/**", "!test/real.ts"]);
  writeConfig({ testPatterns: "src/support/**" });
  expect(() => load()).toThrow(/testPatterns must be an array of strings/);
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

test("hash is the first 16 hex digits of the SHA-256 of the serialised effective config, which is all the goldens rely on being pinned", () => {
  writeConfig({ exclude: ["dist"], cochange: { windowMonths: 3 } });
  const config = load();
  expect(config.hash).toBe(createHash("sha256").update(serialise(config.effective)).digest("hex").slice(0, 16));
  expect(config.hash).toBe("75fbe0ee7759457a");
});

const reading: PluginConfigSpec = { plugin: "cochange", section: { minSupport: 5 }, history: ["windowMonths", "botPatterns", "evidence", "branch"] };

function loadReading() {
  return loadConfig(root, reading);
}

test("the history section holds defaults for the settings every plugin reading history shares", () => {
  expect(loadReading().effective.history).toEqual({
    branch: null,
    firstParent: false,
    renameSimilarity: 50,
    renameLimit: 1000,
    windowMonths: 12,
    maxChangesetSize: 30,
    botPatterns: [],
    fixPatterns: historyDefaults.fixPatterns,
    fixExcludePatterns: historyDefaults.fixExcludePatterns,
    revertPatterns: ["^revert\\b"],
    fixMatchBody: false,
    evidence: {
      strong: { months: 24, logicalChanges: 300, contributors: 5 },
      moderate: { months: 6, logicalChanges: 50, contributors: 2 },
    },
  });
});

test("the default fix patterns do not include issue, and are listed as history keys a plugin may override", () => {
  expect(historyDefaults.fixPatterns).not.toContain("\\bissue\\b");
  writeConfig({ history: { fixPatterns: ["\\bpatch\\b"], fixMatchBody: true }, cochange: { revertPatterns: ["^undo\\b"] } });
  const cochange = loadConfig(root, { ...reading, history: [...reading.history!, "fixPatterns", "revertPatterns", "fixMatchBody"] }).effective.cochange;
  expect(cochange).toMatchObject({ fixPatterns: ["\\bpatch\\b"], revertPatterns: ["^undo\\b"], fixMatchBody: true });
});

test("cochange.risk.fixPatterns moved to history.fixPatterns, and the error says so", () => {
  writeConfig({ cochange: { risk: { fixPatterns: ["x"] } } });
  const spec: PluginConfigSpec = { plugin: "cochange", section: { risk: { followUpDays: 30 } } };
  expect(() => loadConfig(root, spec)).toThrowError(/cochange\.risk\.fixPatterns is an unknown setting; it moved to history\.fixPatterns/);
});

test("fix settings that are not an array of strings or a boolean name the path", () => {
  writeConfig({ history: { fixPatterns: [1] } });
  expect(() => loadReading()).toThrowError(/history\.fixPatterns must be an array of strings/);
  writeConfig({ history: { fixMatchBody: "yes" } });
  expect(() => loadReading()).toThrowError(/history\.fixMatchBody must be a boolean/);
});

test("a plugin takes the shared history value, and its own section overrides it", () => {
  writeConfig({ history: { windowMonths: 6, botPatterns: ["ci$"] } });
  expect(loadReading().effective.cochange).toMatchObject({ windowMonths: 6, botPatterns: ["ci$"], minSupport: 5 });
  writeConfig({ history: { windowMonths: 6, botPatterns: ["ci$"] }, cochange: { windowMonths: 3 } });
  expect(loadReading().effective.cochange).toMatchObject({ windowMonths: 3, botPatterns: ["ci$"] });
});

test("an override may reset a shared value to null, and a nested one overrides one key of the shared object", () => {
  writeConfig({ history: { branch: "main", evidence: { strong: { months: 36 } } }, cochange: { branch: null, evidence: { moderate: { months: 3 } } } });
  const cochange = loadReading().effective.cochange as Record<string, unknown>;
  expect(cochange.branch).toBeNull();
  expect(cochange.evidence).toEqual({
    strong: { months: 36, logicalChanges: 300, contributors: 5 },
    moderate: { months: 3, logicalChanges: 50, contributors: 2 },
  });
});

test("the hash covers the resolved history, so the shared section and an override each change it", () => {
  const defaults = loadReading().hash;
  writeConfig({ history: { windowMonths: 6 } });
  const shared = loadReading().hash;
  expect(shared).not.toBe(defaults);
  writeConfig({ cochange: { windowMonths: 6 } });
  const own = loadReading().hash;
  expect(own).not.toBe(defaults);
  expect(own).not.toBe(shared);
  writeConfig({ history: { windowMonths: 6 }, cochange: { windowMonths: 6 } });
  expect(loadReading().hash).not.toBe(defaults);
});

test("explain says whether a history value came from the shared section, an override or a default", () => {
  writeConfig({ history: { windowMonths: 6 }, cochange: { botPatterns: ["ci$"] } });
  const byPath = Object.fromEntries(explainConfig(loadReading()).map((row) => [row.path, row]));
  expect(byPath["history.windowMonths"]).toEqual({ path: "history.windowMonths", value: 6, source: "file" });
  expect(byPath["cochange.windowMonths"]).toEqual({ path: "cochange.windowMonths", value: 6, source: "file" });
  expect(byPath["cochange.botPatterns"]).toEqual({ path: "cochange.botPatterns", value: ["ci$"], source: "file" });
  expect(byPath["history.botPatterns"]?.source).toBe("default");
  expect(byPath["cochange.branch"]?.source).toBe("default");
  expect(byPath["cochange.evidence.strong.months"]?.source).toBe("default");
});

test("an invalid history value names the path it was written at", () => {
  writeConfig({ history: { windowMonths: 0 } });
  expect(() => loadReading()).toThrowError(/history\.windowMonths must be a positive integer/);
  writeConfig({ cochange: { windowMonths: 0 } });
  expect(() => loadReading()).toThrowError(/cochange\.windowMonths must be a positive integer/);
  writeConfig({ history: { botPatterns: [1] } });
  expect(() => loadReading()).toThrowError(/history\.botPatterns must be an array of strings/);
  writeConfig({ history: { branch: "" } });
  expect(() => loadReading()).toThrowError(/history\.branch must be a branch name or null/);
  writeConfig({ history: { windowMonth: 6 } });
  expect(() => loadReading()).toThrowError(/history\.windowMonth is an unknown setting/);
});

test("a plugin section accepts only the history keys its spec lists", () => {
  writeConfig({ cochange: { renameLimit: 5 } });
  expect(() => loadReading()).toThrowError(/cochange\.renameLimit is an unknown setting/);
  writeConfig({ history: { renameLimit: 5 } });
  expect(loadReading().effective.history).toMatchObject({ renameLimit: 5 });
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

test("languages maps file extensions to lexer profile names", () => {
  writeConfig({ languages: { zig: "rust", Nim: "python" } });
  expect(load().effective.languages).toEqual({ zig: "rust", nim: "python" });
  writeConfig({ languages: { ".zig": "rust" } });
  expectConfigError(/languages\.\.zig.*extension without its dot/);
  writeConfig({ languages: ["zig"] });
  expectConfigError(/languages.*object/);
  writeConfig({ languages: { zig: 1 } });
  expectConfigError(/languages\.zig.*profile name/);
});

test("explain reports the source of each value", () => {
  writeConfig({ exclude: ["dist/**"], cochange: { windowMonths: 6 }, components: { billing: ["b/**"] } });
  const rows = explainConfig(load());
  const byPath = Object.fromEntries(rows.map((row) => [row.path, row]));
  expect(byPath["exclude"]).toEqual({ path: "exclude", value: ["dist/**"], source: "file" });
  expect(byPath["languages"]).toEqual({ path: "languages", value: {}, source: "default" });
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

test("an unknown top-level key is a config error that names the known settings", () => {
  writeConfig({ exlude: ["dist/**"] });
  expectConfigError(/exlude is an unknown setting.*cochange.*exclude/);
  writeConfig({ cochnage: {} });
  expectConfigError(/cochnage is an unknown setting/);
});

test("$schema and every plugin's section are known, whichever plugin reads the file", () => {
  writeConfig({ $schema: "x", locality: {}, structure: {}, complexity: {}, cochange: {} });
  expect(() => load()).not.toThrow();
});

test("the known plugin sections are the plugins of this repository", () => {
  const plugins = readdirSync(fileURLToPath(new URL("../../../plugins", import.meta.url))).sort();
  expect([...PLUGIN_SECTIONS].sort()).toEqual(plugins);
});
