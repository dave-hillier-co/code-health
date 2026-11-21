import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const directories = (path) =>
  existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
const files = (path, suffix) =>
  existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(suffix)).map((e) => e.name).sort() : [];
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/**
 * Compiles every plugin's JSON Schemas and validates every golden output against
 * the schema of its command.
 *
 * A golden at `packages/<plugin>/test/golden/<scenario>/<command>[.<variant>].json`
 * is validated against `plugins/<plugin>/schemas/<command>.schema.json`.
 * Scenarios whose directory starts with an underscore are exempt, and so are
 * goldens of a package that has no plugin folder.
 *
 * @param {string} [root] repository root
 * @returns {{ schemas: number, goldens: number, problems: string[] }}
 */
export function checkSchemas(root = defaultRoot) {
  const problems = [];
  let schemas = 0;
  let goldens = 0;

  for (const plugin of directories(join(root, "plugins"))) {
    const schemaDir = join(root, "plugins", plugin, "schemas");
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);

    const names = files(schemaDir, ".schema.json");
    for (const name of names) {
      try {
        ajv.addSchema(readJson(join(schemaDir, name)));
      } catch (error) {
        problems.push(`plugins/${plugin}/schemas/${name}: ${error.message}`);
      }
    }
    for (const name of names) {
      try {
        ajv.getSchema(readJson(join(schemaDir, name)).$id);
        schemas++;
      } catch (error) {
        problems.push(`plugins/${plugin}/schemas/${name}: ${error.message}`);
      }
    }

    const goldenRoot = join(root, "packages", plugin, "test", "golden");
    for (const scenario of directories(goldenRoot).filter((s) => !s.startsWith("_"))) {
      for (const file of files(join(goldenRoot, scenario), ".json")) {
        goldens++;
        const where = `packages/${plugin}/test/golden/${scenario}/${file}`;
        const command = basename(file, ".json").split(".")[0];
        const validate = ajv.getSchema(`${command}.schema.json`);
        if (!validate) {
          problems.push(`${where}: no schema plugins/${plugin}/schemas/${command}.schema.json`);
          continue;
        }
        const document = readJson(join(goldenRoot, scenario, file));
        if (document.command !== command) {
          problems.push(`${where}: names command "${document.command}" but its file name says "${command}"`);
        }
        if (!validate(document)) {
          for (const error of validate.errors ?? []) {
            problems.push(`${where}: ${error.instancePath || "/"} ${error.message}`);
          }
        }
      }
    }
  }
  return { schemas, goldens, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { schemas, goldens, problems } = checkSchemas();
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error(`\n${problems.length} schema problem(s)`);
    process.exit(1);
  }
  console.log(`${schemas} schema(s) compile; ${goldens} golden output(s) validate`);
}
