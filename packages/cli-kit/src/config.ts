import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_EXCLUDE_ENTRIES } from "./builtin-excludes.ts";
import { configError } from "./errors.ts";
import { serialise } from "./serialise.ts";

export const CONFIG_FILE = "code-health.json";

/**
 * The history-reading settings every plugin that reads history shares. They are the top-level `history` section of
 * code-health.json, and a plugin section may override any key it lists in its spec's `history`.
 */
export const historyDefaults = {
  /** Analysed branch. null analyses HEAD. */
  branch: null as string | null,
  /** Follow only first parents, for repositories that merge long-lived feature branches. */
  firstParent: false,
  /** Rename similarity percentage for git's -M. Changing it rebuilds the cache. */
  renameSimilarity: 50,
  renameLimit: 1000,
  /** Analysis window in months, back from the analysed commit's date. */
  windowMonths: 12,
  /** Commits touching more files than this are left out of co-change, as bulk changes. */
  maxChangesetSize: 30,
  /** Regular expressions matched against `Name <email>` of an author; their commits are left out of history. */
  botPatterns: [] as string[],
  /**
   * Regular expressions, matched case-insensitively against a commit subject, that mark a fix. The defaults are a Conventional
   * Commits `fix:` or `fix(scope):` prefix, a merge of a fix/, hotfix/ or bugfix/ branch, fix, fixes, fixed or fixing at the start of
   * the subject (after an optional Conventional Commits type or scope, or a ticket prefix such as "ABC-123:"), "to fix", and the whole
   * words bug, bugs, bugfix, hotfix and defect anywhere. They are a judgement call, so every count of fixes keeps the commits that matched.
   */
  fixPatterns: [
    "^fix(\\([^)]*\\))?!?:",
    "^merge .*\\b(fix|hotfix|bugfix)[/-]",
    "^(?:(?:[a-z]+(?:\\([^)]*\\))?!?|[a-z][a-z0-9]*-\\d+):\\s*)?(?:fix|fixes|fixed|fixing)\\b",
    "\\bto\\s+fix\\b",
    "\\bbug\\b",
    "\\bbugs\\b",
    "\\bbugfix\\b",
    "\\bhotfix\\b",
    "\\bdefect\\b",
    "\\bfix(?:es)?\\s+#\\d+",
    "^review\\s+fix(?:es)?\\b",
  ] as string[],
  /**
   * Regular expressions, matched case-insensitively against the subject of a commit that a fix pattern matched. A match means the
   * commit is not a defect fix, so it is counted as excluded with the pattern that excluded it and not as a fix. The first pattern
   * is the Conventional Commits rule: when a subject has a type prefix, the type decides, so chore, ci, test, docs, style, build,
   * refactor and perf are not fixes even when "fix" appears later in the subject. The others name fix targets that are not defects
   * (typos, spelling, lint and formatting, within three words after the fix word) and review-comment follow-ups ("address
   * comments", "review comments", "comment nits", "review feedback", "review fixes"). Test and CI repairs are fixes. A guideline
   * list, a judgement call not calibrated on a corpus.
   */
  fixExcludePatterns: [
    "^(?:chore|ci|test|tests|docs|style|build|refactor|perf)(?:\\([^)]*\\))?!?:",
    "\\bfix(?:es|ed|ing)?\\W+(?:\\w+\\W+){0,2}?(?:typos?|typographical|spelling|lints?|linting|linters?|formatting|whitespace|prettier|eslint|gofmt)\\b",
    "\\b(?:address(?:es|ed|ing)?\\s+(?:the\\s+)?(?:review\\s+)?comments?|review\\s+(?:comments?|feedback|fixes)|comment\\s+nits?)\\b",
  ] as string[],
  /** Regular expressions matched against a commit subject that mark a revert. The "This reverts commit" line git writes in the body always marks one. A revert is not counted as a fix. */
  revertPatterns: ["^revert\\b"] as string[],
  /** Also match `fixPatterns` against the commit body. Off, because "Fixes #123" trailers close any kind of issue. */
  fixMatchBody: false,
  /** Guidelines that grade the evidence a history gives (months of history, logical changes, contributors). */
  evidence: {
    strong: { months: 24, logicalChanges: 300, contributors: 5 },
    moderate: { months: 6, logicalChanges: 50, contributors: 2 },
  },
};

export type HistoryKey = keyof typeof historyDefaults;
export type HistoryConfig = typeof historyDefaults;

export interface SharedConfig {
  exclude: string[];
  /** File extension (no dot, lower case) to lexer profile name: file types the suite has no profile for. */
  languages: Record<string, string>;
  entryPoints: string[];
  /** Repo-relative directories `#include` is tried against, for C and C++ trees with no usable `compile_commands.json`. */
  includeRoots: string[];
  components: Record<string, unknown>;
  vagueNames: string[];
  /** The shared history settings, as written in the `history` section. */
  history: HistoryConfig;
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
  /**
   * The keys of the shared `history` section this plugin reads. Its section accepts each of them as an override, and
   * its effective section holds the resolved value: the plugin's own when the file sets one, otherwise the shared one.
   * `section` must not list them.
   */
  history?: readonly HistoryKey[];
}

export interface LoadedConfig {
  /** Absolute path of the file that was read, or null when the repo has none. */
  file: string | null;
  effective: EffectiveConfig;
  /** Short digest of the effective config, stable across key order and unrelated sections. */
  hash: string;
  sources: Record<string, ConfigSource>;
}

export type ConfigSource = "default" | "file" | "built-in";

export interface ConfigRow {
  path: string;
  value: unknown;
  source: ConfigSource;
}

const sharedDefaults: SharedConfig = {
  exclude: [],
  languages: {},
  entryPoints: [],
  includeRoots: [],
  components: {},
  vagueNames: ["utils", "helpers", "common", "misc"],
  history: historyDefaults,
};

const stringLists = ["exclude", "entryPoints", "includeRoots", "vagueNames"];

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

  const historyKeys = spec.history ?? [];
  for (const key of historyKeys) {
    if (key in spec.section) throw new Error(`the ${spec.plugin} section lists ${key}, which it takes from history`);
  }
  const pluginDefaults = { ...spec.section, ...Object.fromEntries(historyKeys.map((key) => [key, historyDefaults[key]])) };
  const defaults: Record<string, unknown> = { ...sharedDefaults, [spec.plugin]: pluginDefaults };
  const rows = new Map<string, ConfigRow>();
  const effective: Record<string, unknown> = {};
  for (const key of Object.keys(defaults)) {
    effective[key] = merge(defaults[key], document?.[key], key, rows);
  }
  readHistory(effective.history as HistoryConfig, "history");
  const pluginDocument = document?.[spec.plugin] as Record<string, unknown> | undefined;
  const override = Object.fromEntries(historyKeys.filter((key) => pluginDocument?.[key] !== undefined).map((key) => [key, pluginDocument![key]]));
  readHistory(override as Partial<HistoryConfig>, spec.plugin);
  const section = effective[spec.plugin] as Record<string, unknown>;
  for (const key of historyKeys) {
    section[key] = overlay((effective.history as HistoryConfig)[key], pluginDocument?.[key]);
    inheritSources(rows, spec.plugin, key);
  }

  const sources: Record<string, ConfigSource> = {};
  for (const row of rows.values()) sources[row.path] = row.source;
  const hash = createHash("sha256").update(serialise(effective)).digest("hex").slice(0, 16);
  return { file: document ? file : null, effective: effective as EffectiveConfig, hash, sources };
}

/** The shared value, with whatever the plugin's own section sets laid over it, key by key through objects. */
function overlay(shared: unknown, own: unknown): unknown {
  if (own === undefined) return shared;
  if (isPlainObject(shared) && isPlainObject(own)) {
    return Object.fromEntries(Object.keys(shared).map((key) => [key, overlay(shared[key], own[key])]));
  }
  return own;
}

/** A plugin value that its own section does not set comes from `history`, and `config explain` says where from. */
function inheritSources(rows: Map<string, ConfigRow>, plugin: string, key: string): void {
  const own = `${plugin}.${key}`;
  for (const row of [...rows.values()]) {
    if (row.path !== own && !row.path.startsWith(`${own}.`)) continue;
    if (row.source === "file") continue;
    const shared = rows.get(`history${row.path.slice(plugin.length)}`);
    if (shared !== undefined) rows.set(row.path, { ...row, source: shared.source });
  }
}

/** Range checks of the history settings, with the path the offending value was written at. */
function readHistory(history: Partial<HistoryConfig>, where: string): void {
  const positive = (key: "renameSimilarity" | "renameLimit" | "windowMonths" | "maxChangesetSize"): void => {
    const value = history[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw configError(`${CONFIG_FILE}: ${where}.${key} must be a positive integer`);
  };
  positive("renameSimilarity");
  positive("renameLimit");
  positive("windowMonths");
  positive("maxChangesetSize");
  const { branch, botPatterns, fixPatterns, fixExcludePatterns, revertPatterns } = history;
  if (branch !== undefined && branch !== null && (typeof branch !== "string" || branch === "")) {
    throw configError(`${CONFIG_FILE}: ${where}.branch must be a branch name or null`);
  }
  if (botPatterns !== undefined && (!Array.isArray(botPatterns) || botPatterns.some((pattern) => typeof pattern !== "string"))) {
    throw configError(`${CONFIG_FILE}: ${where}.botPatterns must be an array of strings`);
  }
  for (const [key, value] of [["fixPatterns", fixPatterns], ["fixExcludePatterns", fixExcludePatterns], ["revertPatterns", revertPatterns]] as const) {
    if (value !== undefined && (!Array.isArray(value) || value.some((pattern) => typeof pattern !== "string"))) {
      throw configError(`${CONFIG_FILE}: ${where}.${key} must be an array of strings`);
    }
  }
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
  BUILTIN_EXCLUDE_ENTRIES.forEach((entry, index) => rows.push({ path: `exclude.built-in[${index}]`, value: entry, source: "built-in" }));
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
      if (!(key in defaultValue)) throw configError(`${CONFIG_FILE}: ${path}.${key} is an unknown setting${removedHint(`${path}.${key}`)}`);
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

/** Settings that moved, so that a file still using the old path is told the new one. */
const removedSettings: Record<string, string> = {
  "cochange.risk.fixPatterns": "history.fixPatterns",
  "cochange.risk.revertPatterns": "history.revertPatterns",
};

function removedHint(path: string): string {
  const moved = removedSettings[path];
  return moved === undefined ? "" : `; it moved to ${moved}, which cochange.${moved.slice("history.".length)} may override`;
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
