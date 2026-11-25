import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where code-health.json's `$schema` points, relative to the repository root. */
export const SCHEMA_FILE = "code-health.schema.json";

/** Every plugin's config spec, in one module that the build below bundles. */
const entry = `
export { buildConfigSchema } from "./packages/cli-kit/src/config-schema.ts";
export { cochangeConfig } from "./packages/cochange/src/config.ts";
export { complexityConfig } from "./packages/complexity/src/config.ts";
export { localityConfig } from "./packages/locality/src/config.ts";
export { structureConfig } from "./packages/structure/src/config.ts";
`;

/**
 * The JSON Schema of code-health.json, generated from the config section of every plugin, as the text the
 * committed file holds. The sources are TypeScript, so they are bundled in memory and imported from there.
 *
 * @param {string} [root] repository root
 * @returns {Promise<string>}
 */
export async function generateConfigSchema(root = defaultRoot) {
  const result = await build({
    stdin: { contents: entry, resolveDir: root, loader: "ts", sourcefile: "config-schema-entry.ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const directory = mkdtempSync(join(tmpdir(), "config-schema-"));
  let specs;
  try {
    const file = join(directory, "specs.mjs");
    writeFileSync(file, result.outputFiles[0].text);
    specs = await import(pathToFileURL(file).href);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const schema = specs.buildConfigSchema([specs.cochangeConfig, specs.complexityConfig, specs.localityConfig, specs.structureConfig]);
  return `${JSON.stringify(schema, null, 2)}\n`;
}

/**
 * Compares the committed schema with what the code generates.
 *
 * @param {string} [root] repository root holding the committed file
 * @param {string} [sourceRoot] repository root whose config sections generate the expected one
 * @returns {Promise<string[]>} problems, empty when the committed file is current
 */
export async function checkConfigSchema(root = defaultRoot, sourceRoot = root) {
  const expected = await generateConfigSchema(sourceRoot);
  let actual;
  try {
    actual = readFileSync(join(root, SCHEMA_FILE), "utf8");
  } catch {
    return [`${SCHEMA_FILE} does not exist: run npm run config-schema`];
  }
  return actual === expected ? [] : [`${SCHEMA_FILE} is not what the tools' config sections generate: run npm run config-schema and commit it`];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const problems = await checkConfigSchema();
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) process.exit(1);
    console.log(`${SCHEMA_FILE} matches the tools' config sections`);
  } else {
    writeFileSync(join(defaultRoot, SCHEMA_FILE), await generateConfigSchema());
    console.log(`wrote ${SCHEMA_FILE}`);
  }
}
