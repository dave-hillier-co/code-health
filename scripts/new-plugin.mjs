import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const templates = join(defaultRoot, "scripts", "templates", "plugin");

/** Plugin names are kebab-case and avoid the reserved prefixes (CONTRIBUTING.md "Adding a plugin"). */
export function validatePluginName(name) {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) return `"${name}" is not kebab-case`;
  const prefix = ["claude-", "anthropic-", "cc-plugin-"].find((p) => name.startsWith(p));
  return prefix ? `"${name}" starts with the reserved prefix ${prefix}` : null;
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

/** Author, license, repository and engines are the owner's decision, so a new plugin takes them from the first existing one. */
function inheritedManifestFields(root) {
  const plugins = join(root, "plugins");
  const first = existsSync(plugins) ? readdirSync(plugins).sort().find((p) => existsSync(join(plugins, p, ".claude-plugin", "plugin.json"))) : undefined;
  if (first === undefined) return {};
  const { author, license, repository, engines } = JSON.parse(readFileSync(join(plugins, first, ".claude-plugin", "plugin.json"), "utf8"));
  return { author, license, repository, engines };
}

/** The schema definitions every plugin's `common.schema.json` shares, taken from an existing plugin's file so the envelope stays one shape. */
function commonSchema(root, plugin) {
  const plugins = join(root, "plugins");
  const source = existsSync(plugins) ? readdirSync(plugins).sort().find((p) => existsSync(join(plugins, p, "schemas", "common.schema.json"))) : undefined;
  if (source === undefined) throw new Error("no existing plugin has a schemas/common.schema.json to copy the envelope from");
  const common = JSON.parse(readFileSync(join(plugins, source, "schemas", "common.schema.json"), "utf8"));
  const defs = Object.fromEntries(["sha", "count", "repo", "truncated", "envelope"].map((key) => [key, common.$defs[key]]));
  defs.envelope = { ...defs.envelope, properties: { ...defs.envelope.properties, tool: { const: plugin } } };
  return { ...common, title: `Shared definitions for ${plugin} --json output`, $defs: defs };
}

function addToMarketplace(root, plugin, description) {
  const file = join(root, ".claude-plugin", "marketplace.json");
  const text = readFileSync(file, "utf8");
  const marketplace = JSON.parse(text);
  if (marketplace.plugins.some((p) => p.name === plugin)) throw new Error(`the marketplace already lists ${plugin}`);
  const entry = `    {\n      "name": ${JSON.stringify(plugin)},\n      "source": ${JSON.stringify(`./plugins/${plugin}`)},\n      "description": ${JSON.stringify(description)}\n    }`;
  const end = text.lastIndexOf("\n  ]");
  if (end === -1) throw new Error(`cannot find the end of the plugins list in ${file}`);
  writeFileSync(file, `${text.slice(0, end)},\n${entry}${text.slice(end)}`);
  JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Scaffolds a plugin: its manifest, README and marketplace entry, a schemas folder, and a
 * package under `packages/<plugin>` with a CLI (`src/main.ts`, which the bundler
 * picks up), one placeholder command and a test. With `parses`, the placeholder
 * command parses a file, so the bundle loads grammars from `dist/grammars`.
 *
 * @param {{ root?: string, name: string, description: string, parses?: boolean }} options
 * @returns {string[]} the files written, relative to the root
 */
export function scaffoldPlugin({ root = defaultRoot, name, description, parses = false }) {
  const invalid = validatePluginName(name);
  if (invalid) throw new Error(invalid);
  if (!description || description.trim() === "") throw new Error("a description is required");
  const pluginDir = join(root, "plugins", name);
  const packageDir = join(root, "packages", name);
  if (existsSync(pluginDir) || existsSync(packageDir)) throw new Error(`plugins/${name} or packages/${name} already exists`);

  const command = parses ? "parse" : "describe";
  const tokens = {
    plugin: name,
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

  emit(
    join(pluginDir, ".claude-plugin", "plugin.json"),
    json({
      name,
      displayName: words(name).map((w) => w[0].toUpperCase() + w.slice(1)).join(" "),
      version: "0.1.0",
      description,
      ...inheritedManifestFields(root),
      keywords: ["code-health"],
    }),
  );
  const repository = inheritedManifestFields(root).repository ?? "";
  emit(
    join(pluginDir, "README.md"),
    fill(template("README.md.tmpl"), { plugin: name, description: description.trim(), repository, marketplaceSource: repository.replace(/^https:\/\/github\.com\//, "") }),
  );
  emit(join(pluginDir, "schemas", "common.schema.json"), json(commonSchema(root, name)));
  emit(
    join(pluginDir, "schemas", `${command}.schema.json`),
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
              properties: { plugin: { const: name }, head: { $ref: "common.schema.json#/$defs/sha" } },
              required: ["plugin", "head"],
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

  addToMarketplace(root, name, description);
  created.push(".claude-plugin/marketplace.json");
  return created;
}

function parseArguments(argv) {
  const options = { parses: false };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--parses") options.parses = true;
    else if (argv[i] === "--description") options.description = argv[++i];
    else positionals.push(argv[i]);
  }
  return { name: positionals[0], ...options };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  try {
    if (!options.name) throw new Error('usage: npm run new-plugin -- <name> --description "<one sentence>" [--parses]');
    for (const file of scaffoldPlugin(options)) console.log(`wrote ${file}`);
    console.log("next: npm install, npm run build, npm test");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
