import type { LoadedConfig, PluginConfigSpec } from "@code-health/cli-kit/config";
import { configError } from "@code-health/cli-kit/errors";
import { TOOL } from "./tool.ts";

/**
 * The `locality` section of code-health.json. These defaults define its shape:
 * unknown keys are rejected and values keep the type of their default.
 * Entry points, exclusions and vague names live in the suite-wide part of the file.
 */
export const localityConfig: PluginConfigSpec = {
  plugin: TOOL,
  section: {
    /** Minimum net distance a move must save to be worth reporting, in folder hops. */
    minDistance: 2,
    /** A unit of at most this many lines is tiny: its import overhead outweighs its content. */
    tinyLines: 15,
    /** A unit of more than this many lines is large and stays a module of its own. */
    largeLines: 150,
    /** A medium unit is inlined only while its consumer stays within this many lines. */
    inlineHostLines: 300,
    /** Distinct production consumer files at or above which a unit is scrutinised instead of moved. */
    highFanIn: 8,
    /** Deepest folder nesting a target may have. */
    maxDepth: 6,
    /** Globs of files that must not move and folders code may not move into (routes, migrations, app folders). */
    fixedPoints: [] as string[],
  },
};

export interface LocalitySettings {
  minDistance: number;
  tinyLines: number;
  largeLines: number;
  inlineHostLines: number;
  highFanIn: number;
  maxDepth: number;
  fixedPoints: string[];
  /** The suite's shared `entryPoints` globs. Empty means entries are detected. */
  entryPoints: string[];
  /** The suite's shared `exclude` globs. */
  exclude: string[];
  /** The suite's shared `vagueNames`. */
  vagueNames: string[];
}

/** Validates the effective locality section and returns it typed. Throws a config error (exit 2). */
export function readSettings(config: LoadedConfig): LocalitySettings {
  const section = config.effective[TOOL] as Record<string, unknown>;
  const at = (key: string) => `${TOOL}.${key}`;

  const positive = (key: string): number => {
    const value = section[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw configError(`code-health.json: ${at(key)} must be a positive integer`);
    }
    return value;
  };

  const fixedPoints = section.fixedPoints;
  if (!Array.isArray(fixedPoints) || fixedPoints.some((item) => typeof item !== "string")) {
    throw configError(`code-health.json: ${at("fixedPoints")} must be an array of strings`);
  }
  const tinyLines = positive("tinyLines");
  const largeLines = positive("largeLines");
  if (tinyLines >= largeLines) {
    throw configError(`code-health.json: ${at("tinyLines")} must be below ${at("largeLines")}`);
  }

  return {
    minDistance: positive("minDistance"),
    tinyLines,
    largeLines,
    inlineHostLines: positive("inlineHostLines"),
    highFanIn: positive("highFanIn"),
    maxDepth: positive("maxDepth"),
    fixedPoints: fixedPoints as string[],
    entryPoints: config.effective.entryPoints,
    exclude: config.effective.exclude,
    vagueNames: config.effective.vagueNames,
  };
}
