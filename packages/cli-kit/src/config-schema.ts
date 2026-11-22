import { historyDefaults, type PluginConfigSpec } from "./config.ts";

export type JsonSchema = Record<string, unknown>;

export const CONFIG_SCHEMA_ID = "https://raw.githubusercontent.com/dave-hillier-co/code-health/main/code-health.schema.json";

const stringList = (description: string): JsonSchema => ({ type: "array", items: { type: "string" }, description });

/** The keys every plugin shares, as `loadConfig` validates them. */
function sharedProperties(): Record<string, JsonSchema> {
  return {
    $schema: { type: "string", description: "The JSON Schema of this file, for editors." },
    exclude: stringList(
      "Globs of files no plugin analyses. They add to the built-in excludes and do not replace them: .claude/**, .cache/**, .code-health/** and every directory below the repository root that is its own git checkout (it contains a .git file or directory: a linked worktree, a nested clone or a submodule) are always left out of source trees and history. `config explain` prints them with the source built-in, and commands report how many files each omitted.",
    ),
    testPatterns: stringList(
      "Globs that decide which files are tests, laid over each language's own conventions (*_test.go, *Tests.cs, *.test.ts, src/test/, tests/ and the like). A match makes a file a test, an entry that starts with ! makes it production, and the last matching entry wins. Rankings list production code first and say how many tests they left out.",
    ),
    languages: {
      type: "object",
      description:
        "File types the suite has no lexer profile for: file extension (no dot) to the name of a lexer profile. Per-function values of a mapped type are marked unverified.",
      additionalProperties: { type: "string" },
    },
    entryPoints: stringList("Globs of files that are entry points: code nothing in the repository imports and nothing may move."),
    includeRoots: stringList(
      "Directories, relative to the repository root, that C and C++ `#include` paths are written against (for `#include \"stage/Terrain.h\"` with the file at `src/stage/Terrain.h`, `src`). They are tried after the include directories of a compile_commands.json and before CMake's target include directories. With neither a compile_commands.json nor includeRoots, the directories are inferred from where the included files are.",
    ),
    components: { type: "object", description: "Named groups of paths: component name to globs." },
    vagueNames: stringList("Folder and file names that say nothing about their content."),
    history: {
      ...sectionSchema(historyDefaults),
      description:
        "How history is read, for every plugin that reads it. A plugin section may override any key it lists, and the plugin's own value wins over this one.",
    },
  };
}

function kindSchema(value: unknown): JsonSchema {
  if (typeof value === "string") return { type: "string" };
  if (typeof value === "number") return { type: "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  if (Array.isArray(value)) {
    const kinds = new Set(value.map((item) => typeof item));
    const items = kinds.size === 1 && (kinds.has("string") || kinds.has("number") || kinds.has("boolean")) ? { items: { type: [...kinds][0] } } : {};
    return { type: "array", ...items };
  }
  // A null default stands for a setting the code reads for itself, so any value may be given.
  return {};
}

/**
 * The schema of a section as `loadConfig` reads it: every key of the defaults is known and keeps its default's type,
 * unknown keys are rejected, and an empty object `{}` accepts any keys.
 */
function sectionSchema(defaults: unknown): JsonSchema {
  if (typeof defaults === "object" && defaults !== null && !Array.isArray(defaults)) {
    const entries = Object.entries(defaults);
    if (entries.length === 0) return { type: "object" };
    return {
      type: "object",
      properties: Object.fromEntries(entries.map(([key, value]) => [key, { ...sectionSchema(value), default: value }])),
      additionalProperties: false,
    };
  }
  return kindSchema(defaults);
}

/** The JSON Schema of code-health.json: the shared keys and the section of every plugin given. */
export function buildConfigSchema(specs: readonly PluginConfigSpec[]): JsonSchema {
  const sections: Record<string, JsonSchema> = {};
  for (const spec of [...specs].sort((a, b) => (a.plugin < b.plugin ? -1 : 1))) {
    const section = sectionSchema(spec.section) as { properties?: Record<string, JsonSchema> };
    const overrides = Object.fromEntries(
      (spec.history ?? []).map((key) => [key, { ...sectionSchema(historyDefaults[key]), description: `Overrides history.${key} for the ${spec.plugin} plugin.` }]),
    );
    sections[spec.plugin] = { ...section, properties: { ...section.properties, ...overrides }, description: `Settings of the ${spec.plugin} plugin.` };
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: CONFIG_SCHEMA_ID,
    title: "code-health.json",
    description: "Settings of the code-health plugins: keys every plugin shares, and one section per plugin.",
    type: "object",
    properties: { ...sharedProperties(), ...sections },
    additionalProperties: false,
  };
}
