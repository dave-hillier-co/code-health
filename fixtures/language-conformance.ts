import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe } from "vitest";

/**
 * The shared conformance harness. Every language keeps hand-verified fixtures in `fixtures/languages/<id>/`,
 * one folder per area below, and every plugin that uses the language's adapter runs the areas it owns over
 * every registered adapter. A language is `supported` (suite.md, Tiers) only when it passes them all.
 *
 * The harness reads fixtures and describes what a language must have. It never imports an adapter: each
 * plugin's suite passes its registry's adapters in, so this package depends on none of them.
 */
export const languagesRoot = fileURLToPath(new URL("./languages/", import.meta.url));

export interface FixtureArea {
  /** The plugin whose conformance suite runs it. */
  checkedBy: "parse" | "complexity" | "structure" | "locality" | "lexical";
  /** Each case is a folder with its own `expected.json`, or the area is itself one case. */
  cases: "folders" | "single";
  /** A supported language must have it. */
  required: boolean;
  /** Part of the lexical agreement corpus, so adding to it moves the recorded rates. */
  corpus: boolean;
  /** What a case pins down, for the message of a language that lacks it. */
  pins: string;
}

export const fixtureAreas = {
  adapter: { checkedBy: "parse", cases: "folders", required: true, corpus: true, pins: "units, import and file edges, consumers, unresolved references, barrels and syntax errors" },
  metrics: { checkedBy: "complexity", cases: "folders", required: true, corpus: true, pins: "cyclomatic, cognitive, nesting, length, statements and parameters of every function, counted by hand" },
  "metrics-wide": { checkedBy: "complexity", cases: "folders", required: false, corpus: false, pins: "further metric cases, kept out of the agreement corpus" },
  depth: { checkedBy: "complexity", cases: "single", required: true, corpus: false, pins: "implementation nodes, interface size and forwarded call of every unit, counted by hand" },
  agreement: { checkedBy: "lexical", cases: "single", required: true, corpus: true, pins: "files with the awkward shapes: lambdas, nested classes, expression bodies, macros and templates" },
  census: { checkedBy: "structure", cases: "folders", required: true, corpus: false, pins: "the decoupling mechanisms found in a small codebase" },
  packaging: { checkedBy: "structure", cases: "folders", required: true, corpus: false, pins: "packages, entry points, abstractness and boundary findings of a small workspace" },
  moves: { checkedBy: "locality", cases: "folders", required: true, corpus: false, pins: "the file moves and reference rewrites for a set of operations" },
} as const satisfies Record<string, FixtureArea>;

export type AreaName = keyof typeof fixtureAreas;
export const areaNames = Object.keys(fixtureAreas) as AreaName[];

export const languageDirectory = (id: string): string => `${languagesRoot}${id}/`;
export const areaDirectory = (id: string, area: AreaName): string => `${languageDirectory(id)}${area}/`;

export interface FixtureCase {
  /** The folder name, or the area name for a single case. */
  name: string;
  /** Absolute, with a trailing slash. */
  directory: string;
}

function folders(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => statSync(`${directory}${name}`).isDirectory())
    .sort();
}

/** The cases of an area: its folders in name order, or the area itself when it is one case. Empty when the language has none. */
export function fixtureCases(id: string, area: AreaName): FixtureCase[] {
  const directory = areaDirectory(id, area);
  if (!existsSync(directory)) return [];
  if (fixtureAreas[area].cases === "single") return [{ name: area, directory }];
  return folders(directory).map((name) => ({ name, directory: `${directory}${name}/` }));
}

export function readExpected<T>(fixture: FixtureCase): T {
  return JSON.parse(readFileSync(`${fixture.directory}expected.json`, "utf8")) as T;
}

/** The directories of the lexical agreement corpus of a language: every area flagged as corpus that it has. */
export function corpusDirectories(id: string): string[] {
  return areaNames.filter((area) => fixtureAreas[area].corpus && existsSync(areaDirectory(id, area))).map((area) => areaDirectory(id, area));
}

/** The structural units the lexer is known to miss, as `area/path#name` relative to the language folder, from `agreement.json`. */
export function expectedMisses(id: string): string[] {
  const file = `${languageDirectory(id)}agreement.json`;
  if (!existsSync(file)) return [];
  return (JSON.parse(readFileSync(file, "utf8")) as { expectedMisses?: string[] }).expectedMisses ?? [];
}

/**
 * What a language lacks to be called supported: a required area with no case, or a case with no
 * `expected.json`. Empty means the fixtures are all there; whether they pass is for each plugin's suite.
 */
export function fixtureGaps(id: string): string[] {
  const gaps: string[] = [];
  for (const area of areaNames) {
    const { required, pins } = fixtureAreas[area];
    const cases = fixtureCases(id, area);
    if (cases.length === 0) {
      if (required) gaps.push(`fixtures/languages/${id}/${area}/ has no case: add one that pins ${pins}`);
      continue;
    }
    for (const fixture of cases) {
      if (area === "agreement") continue;
      if (!existsSync(`${fixture.directory}expected.json`)) gaps.push(`fixtures/languages/${id}/${area}/${fixture.name === area ? "" : `${fixture.name}/`}expected.json is missing`);
    }
  }
  if (!existsSync(`${languageDirectory(id)}agreement.json`)) gaps.push(`fixtures/languages/${id}/agreement.json is missing: record the units the lexer is known to miss, even if none`);
  return gaps;
}

/** The language folders that exist, so a fixture folder with no adapter is noticed. */
export function languageFolders(): string[] {
  return folders(languagesRoot);
}

/** True when an executable is on the PATH. External tools (Roslyn LSP, clangd, rope, gopls, jdtls, Kotlin LSP, rust-analyzer) are optional. */
export function toolInstalled(executable: string): boolean {
  return spawnSync(process.platform === "win32" ? "where" : "which", [executable], { stdio: "ignore" }).status === 0;
}

/**
 * A `describe` that runs only when the external tool is installed. When it is not, the suite is skipped
 * and the notice says which tool would run it, so a skipped confirmation is never mistaken for a pass.
 */
export function describeWithTool(executable: string, name: string, body: () => void): void {
  const installed = toolInstalled(executable);
  if (!installed) console.warn(`SKIPPED "${name}": ${executable} is not installed. Install it to run these checks; the rest of the suite does not need it.`);
  describe.skipIf(!installed)(`${name} (needs ${executable})`, body);
}
