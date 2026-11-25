import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRoot, pluginDir, schemasDir } from "./layout.mjs";

const templates = join(defaultRoot, "scripts", "templates", "tool");

/** Tool names are kebab-case: a name is a package, a config section, a bundle file and the word typed to run it. */
export function validateToolName(name) {
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name) ? null : `"${name}" is not kebab-case`;
}

const words = (name) => name.split("-");
const pascal = (name) => words(name).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
const camel = (name) => pascal(name)[0].toLowerCase() + pascal(name).slice(1);

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const fill = (text, tokens) => text.replace(/\{\{(\w+)\}\}/g, (_, key) => tokens[key]);
const template = (...path) => readFileSync(join(templates, ...path), "utf8");

/** The schema definitions every tool's `common.schema.json` shares, taken from an existing tool's file so the envelope stays one shape. */
function commonSchema(root, tool) {
  const schemas = join(pluginDir(root), "schemas");
  const source = existsSync(schemas) ? readdirSync(schemas).sort().find((t) => existsSync(join(schemas, t, "common.schema.json"))) : undefined;
  if (source === undefined) throw new Error("no existing tool has a schemas/<tool>/common.schema.json to copy the envelope from");
  const common = JSON.parse(readFileSync(join(schemas, source, "common.schema.json"), "utf8"));
  const defs = { ...common.$defs, envelope: { ...common.$defs.envelope, properties: { ...common.$defs.envelope.properties, tool: { const: tool } } } };
  return { ...common, title: `Shared definitions for ${tool} --json output`, $defs: defs };
}

/**
 * Scaffolds a tool of the plugin: a schemas folder under the plugin, and a
 * package under `packages/<tool>` with a CLI (`src/main.ts`, which the bundler
 * picks up and writes to the plugin's `dist/<tool>.mjs`), one placeholder
 * command and a test. With `parses`, the placeholder command parses a file, so
 * the bundle loads grammars from `dist/grammars`.
 *
 * @param {{ root?: string, name: string, parses?: boolean }} options
 * @returns {string[]} the files written, relative to the root
 */
export function scaffoldTool({ root = defaultRoot, name, parses = false }) {
  const invalid = validateToolName(name);
  if (invalid) throw new Error(invalid);
  const schemas = schemasDir(name, root);
  const packageDir = join(root, "packages", name);
  if (existsSync(schemas) || existsSync(packageDir)) throw new Error(`a tool or package named ${name} already exists`);

  const command = parses ? "parse" : "describe";
  const tokens = {
    tool: name,
    camel: camel(name),
    pascal: pascal(name),
    command,
    commandModule: command,
    testArguments: parses ? '"parse", "src/answer.ts"' : '"describe"',
  };
  const created = [];
  const emit = (path, text) => {
    write(path, text);
    created.push(path.slice(root.length + 1));
  };

  emit(join(schemas, "common.schema.json"), json(commonSchema(root, name)));
  emit(
    join(schemas, `${command}.schema.json`),
    json({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: `${command}.schema.json`,
      title: `${name} ${command} --json`,
      allOf: [{ $ref: "common.schema.json#/$defs/envelope" }],
      type: "object",
      properties: {
        command: { const: command },
        results: parses
          ? {
              type: "object",
              properties: {
                file: { type: "string" },
                grammar: { type: "string" },
                rootType: { type: "string" },
                namedChildren: { $ref: "common.schema.json#/$defs/count" },
                hasErrors: { type: "boolean" },
              },
              required: ["file", "grammar", "rootType", "namedChildren", "hasErrors"],
              additionalProperties: false,
            }
          : {
              type: "object",
              properties: { tool: { const: name }, head: { $ref: "common.schema.json#/$defs/sha" } },
              required: ["tool", "head"],
              additionalProperties: false,
            },
      },
      unevaluatedProperties: false,
    }),
  );

  emit(
    join(packageDir, "package.json"),
    json({
      name: `@code-health/${name}`,
      version: "0.0.0",
      scripts: { typecheck: "tsc -p tsconfig.json" },
      type: "module",
      private: true,
      dependencies: { "@code-health/cli-kit": "^0.0.0", ...(parses ? { "@code-health/parse": "^0.0.0" } : {}) },
      devDependencies: { "@code-health/fixtures": "^0.0.0" },
    }),
  );
  emit(join(packageDir, "tsconfig.json"), json({ extends: "../../tsconfig.base.json", include: ["src", "test"] }));
  for (const file of ["main", "cli", "tool", "config", "commands"]) {
    emit(join(packageDir, "src", `${file}.ts`), fill(template("src", `${file}.ts.tmpl`), tokens));
  }
  emit(join(packageDir, "src", "commands", `${command}.ts`), fill(template("src", "commands", `${command}.ts.tmpl`), tokens));
  emit(join(packageDir, "test", "support", "run.ts"), fill(template("test", "support", "run.ts.tmpl"), tokens));
  emit(join(packageDir, "test", `${command}.test.ts`), fill(template("test", "command.test.ts.tmpl"), tokens));
  return created;
}

function parseArguments(argv) {
  const options = { parses: false };
  const positionals = [];
  for (const arg of argv) {
    if (arg === "--parses") options.parses = true;
    else positionals.push(arg);
  }
  return { name: positionals[0], ...options };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  try {
    if (!options.name) throw new Error("usage: npm run new-tool -- <name> [--parses]");
    for (const file of scaffoldTool(options)) console.log(`wrote ${file}`);
    console.log("next: npm install, npm run build, npm test");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
