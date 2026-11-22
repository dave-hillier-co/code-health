import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configError } from "./errors.ts";
import { serialise } from "./serialise.ts";

export const CONFIG_FILE = "code-health.json";

export interface SharedConfig {
  exclude: string[];
  /** File extension (no dot, lower case) to lexer profile name: file types the suite has no profile for. */
  languages: Record<string, string>;
  entryPoints: string[];
  components: Record<string, unknown>;
  vagueNames: string[];
}

export type EffectiveConfig = SharedConfig & Record<string, unknown>;

export interface PluginConfigSpec {
  /** Name of the plugin's own section in code-health.json. */
  plugin: string;
  /**
   * Defaults for that section. They define its shape: keys not listed here are rejected,
   * values must keep the type of their default, and an empty object `{}` accepts any keys.
   */
  section: Record<string, unknown>;
}

export interface LoadedConfig {
  /** Absolute path of the file that was read, or null when the repo has none. */
  file: string | null;
  effective: EffectiveConfig;
  /** Short digest of the effective config, stable across key order and unrelated sections. */
  hash: string;
  sources: Record<string, ConfigSource>;
}

export type ConfigSource = "default" | "file";

export interface ConfigRow {
  path: string;
  value: unknown;
  source: ConfigSource;
}

const sharedDefaults: SharedConfig = {
  exclude: [],
  languages: {},
  entryPoints: [],
  components: {},
  vagueNames: ["utils", "helpers", "common", "misc"],
};

const stringLists = ["exclude", "entryPoints", "vagueNames"];

/**
 * The plugins whose sections may appear in code-health.json. Every plugin reads the one file, so a plugin
 * cannot tell another's section from a misspelt key without this list. A test keeps it equal to `plugins/`.
 */
export const PLUGIN_SECTIONS: readonly string[] = ["cochange", "complexity", "locality", "structure"];

/** Keys at the top of code-health.json besides the shared settings and the plugin sections. */
const documentKeys = ["$schema"];

/** A key that is neither shared, a plugin's section nor `$schema` is a typo, and fails the way the schema flags it. */
function rejectUnknownKeys(document: Record<string, unknown>, plugin: string): void {
  const known = new Set([...Object.keys(sharedDefaults), ...PLUGIN_SECTIONS, plugin]);
  for (const key of Object.keys(document)) {
    if (documentKeys.includes(key) || known.has(key)) continue;
    throw configError(`${CONFIG_FILE}: ${key} is an unknown setting; known settings are ${[...known].sort().join(", ")}`);
  }
}

/** Reads code-health.json at the repo root: shared keys plus the named plugin's section. */
export function loadConfig(root: string, spec: PluginConfigSpec): LoadedConfig {
  const file = join(root, CONFIG_FILE);
  const document = existsSync(file) ? parseDocument(file) : undefined;

  if (document !== undefined) rejectUnknownKeys(document, spec.plugin);

  for (const key of stringLists) {
    const value = document?.[key];
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
      throw configError(`${CONFIG_FILE}: ${key} must be an array of strings`);
    }
  }

  if (document !== undefined && document.languages !== undefined) document.languages = readLanguages(document.languages);

  const defaults: Record<string, unknown> = { ...sharedDefaults, [spec.plugin]: spec.section };
  const rows = new Map<string, ConfigRow>();
  const effective: Record<string, unknown> = {};
  for (const key of Object.keys(defaults)) {
    effective[key] = merge(defaults[key], document?.[key], key, rows);
  }

  const sources: Record<string, ConfigSource> = {};
  for (const row of rows.values()) sources[row.path] = row.source;
  const hash = createHash("sha256").update(serialise(effective)).digest("hex").slice(0, 16);
  return { file: document ? file : null, effective: effective as EffectiveConfig, hash, sources };
}

/** `languages` maps extensions to lexer profile names. Whether a profile exists is the analysing plugin's to say. */
function readLanguages(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) throw configError(`${CONFIG_FILE}: languages must be an object mapping file extensions to lexer profile names`);
  const mapped: Record<string, string> = {};
  for (const [extension, profile] of Object.entries(value)) {
    if (extension === "" || extension.startsWith(".")) {
      throw configError(`${CONFIG_FILE}: languages.${extension} must name an extension without its dot, such as "zig"`);
    }
    if (typeof profile !== "string" || profile === "") throw configError(`${CONFIG_FILE}: languages.${extension} must be a lexer profile name`);
    mapped[extension.toLowerCase()] = profile;
  }
  return mapped;
}

/** Flat provenance report: each effective value with the path it lives at and where it came from. */
export function explainConfig(config: LoadedConfig): ConfigRow[] {
  const rows: ConfigRow[] = [];
  flatten(config.effective, "", (path, value) => {
    rows.push({ path, value, source: config.sources[path] ?? "default" });
  });
  return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function parseDocument(file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw configError(`${CONFIG_FILE} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!isPlainObject(parsed)) throw configError(`${CONFIG_FILE} must be a JSON object`);
  return parsed;
}

function merge(defaultValue: unknown, fileValue: unknown, path: string, rows: Map<string, ConfigRow>): unknown {
  if (fileValue === undefined) {
    flatten(defaultValue, path, (leaf, value) => rows.set(leaf, { path: leaf, value, source: "default" }));
    return defaultValue;
  }

  if (isPlainObject(defaultValue)) {
    if (!isPlainObject(fileValue)) throw configError(`${CONFIG_FILE}: ${path} must be an object`);
    if (Object.keys(defaultValue).length === 0) {
      flatten(fileValue, path, (leaf, value) => rows.set(leaf, { path: leaf, value, source: "file" }));
      return fileValue;
    }
    for (const key of Object.keys(fileValue)) {
      if (!(key in defaultValue)) throw configError(`${CONFIG_FILE}: ${path}.${key} is an unknown setting`);
    }
    const merged: Record<string, unknown> = {};
    for (const key of Object.keys(defaultValue)) {
      merged[key] = merge(defaultValue[key], fileValue[key], `${path}.${key}`, rows);
    }
    return merged;
  }

  if (defaultValue !== null && kindOf(fileValue) !== kindOf(defaultValue)) {
    throw configError(`${CONFIG_FILE}: ${path} must be ${article(kindOf(defaultValue))}`);
  }
  rows.set(path, { path, value: fileValue, source: "file" });
  return fileValue;
}

function flatten(value: unknown, path: string, visit: (path: string, value: unknown) => void): void {
  if (isPlainObject(value) && Object.keys(value).length > 0) {
    for (const key of Object.keys(value)) flatten(value[key], path === "" ? key : `${path}.${key}`, visit);
  } else {
    visit(path, value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  return value === null ? "null" : typeof value;
}

function article(kind: string): string {
  return kind === "array" || kind === "object" ? `an ${kind}` : `a ${kind}`;
}
