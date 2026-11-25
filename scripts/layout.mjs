import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The one plugin the repository ships. Its folder holds every skill and every tool's bundled CLI. */
export const PLUGIN = "code-health";

export const pluginDir = (root = defaultRoot) => join(root, "plugins", PLUGIN);

/** Where every tool's bundle, their chunks, the grammars and the notices file are written. */
export const distDir = (root = defaultRoot) => join(pluginDir(root), "dist");

/** The JSON Schemas of one tool's commands. */
export const schemasDir = (tool, root = defaultRoot) => join(pluginDir(root), "schemas", tool);

/** The eval cases, one folder per tool: `evals/<tool>/<case>/case.yaml`. */
export const evalsDir = (root = defaultRoot) => join(pluginDir(root), "evals");

/** The tools: the packages with a CLI entry at `packages/<tool>/src/main.ts`, sorted. Each is bundled to `dist/<tool>.mjs`. */
export function tools(root = defaultRoot) {
  const packages = join(root, "packages");
  if (!existsSync(packages)) return [];
  return readdirSync(packages, { withFileTypes: true })
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && existsSync(join(packages, e.name, "src", "main.ts")))
    .map((e) => e.name)
    .sort();
}
