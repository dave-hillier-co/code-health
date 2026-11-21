import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configError } from "./errors.ts";
import { serialise } from "./serialise.ts";

export const CONFIG_FILE = "code-health.json";

export interface SharedConfig {
  exclude: string[];
  languages: string[];
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
  languages: [],
  entryPoints: [],
  components: {},
  vagueNames: ["utils", "helpers", "common", "misc"],
};

const stringLists = ["exclude", "languages", "entryPoints", "vagueNames"];

/** Reads code-health.json at the repo root: shared keys plus the named plugin's section. */
export function loadConfig(root: string, spec: PluginConfigSpec): LoadedConfig {
  const file = join(root, CONFIG_FILE);
  const document = existsSync(file) ? parseDocument(file) : undefined;

  for (const key of stringLists) {
    const value = document?.[key];
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
      throw configError(`${CONFIG_FILE}: ${key} must be an array of strings`);
    }
  }

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
