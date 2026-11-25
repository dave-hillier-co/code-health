import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";
import { splitFrontmatter } from "./check-skills.mjs";
import { skillDirectories } from "./sync-red-flags.mjs";

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const readEvalPins = (root = defaultRoot) => JSON.parse(readFileSync(join(root, "shared", "evals.json"), "utf8"));

/** The tool whose CLI a skill pre-approves (`dist/<tool>.mjs` in its `allowed-tools`), or null when it names none. */
function toolOfSkill(skillDir) {
  const file = join(skillDir, "SKILL.md");
  if (!existsSync(file)) return null;
  const allowed = splitFrontmatter(readFileSync(file, "utf8")).frontmatter?.["allowed-tools"];
  return /\/dist\/([a-z0-9-]+)\.mjs/.exec(Array.isArray(allowed) ? allowed.join(" ") : String(allowed ?? ""))?.[1] ?? null;
}

/**
 * Validates every eval case at `plugins/<plugin>/evals/<tool>/<case>/case.yaml`
 * without running (and so without billing) anything. Cases are grouped by the
 * tool whose skills they exercise, one folder per tool:
 *
 * - the file parses and matches `scripts/eval-case.schema.json`, which mirrors the
 *   case format `claude plugin eval` loads (a case that fails to load there fails here)
 * - the case directory name equals `name`, and grader names are unique
 * - `execution.model` is the model pinned in `shared/evals.json`
 *
 * - every tool a skill runs has a folder of cases, with cases tagged `trigger` (the skill loads when it
 *   should), `negative` (it stays out of the way or declines) and `behaviour` (what it does once loaded),
 *   as CONTRIBUTING.md asks
 *
 * Cases are `case.yaml` files only. The `prompt.md` form cannot pin a model.
 * A `results/` folder is output and is skipped.
 *
 * @param {string} [root] repository root
 * @returns {{ cases: number, problems: string[] }}
 */
export function checkEvals(root = defaultRoot) {
  const problems = [];
  const pins = readEvalPins(root);
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
    JSON.parse(readFileSync(join(root, "scripts", "eval-case.schema.json"), "utf8")),
  );
  let cases = 0;
  const directories = (path) =>
    readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "results")
      .map((entry) => entry.name)
      .sort();
  const plugins = join(root, "plugins");
  for (const plugin of existsSync(plugins) ? readdirSync(plugins).sort() : []) {
    const evals = join(plugins, plugin, "evals");
    const skillTools = new Set(
      skillDirectories(root)
        .filter((dir) => dir.startsWith(join(plugins, plugin, "skills")))
        .map((dir) => toolOfSkill(dir) ?? basename(dir)),
    );
    const groups = existsSync(evals) ? directories(evals) : [];
    for (const tool of [...skillTools].sort()) {
      if (!groups.includes(tool)) problems.push(`plugins/${plugin}: ships a skill that runs ${tool} but has no evals/${tool}`);
    }
    for (const group of groups) {
      const tags = new Set();
      if (existsSync(join(evals, group, "case.yaml"))) {
        problems.push(`plugins/${plugin}/evals/${group}: a case belongs in a tool's folder, evals/<tool>/${group}`);
        continue;
      }
      for (const name of directories(join(evals, group))) {
        const where = `plugins/${plugin}/evals/${group}/${name}`;
        const file = join(evals, group, name, "case.yaml");
        if (!existsSync(file)) {
          problems.push(`${where}: case.yaml is missing (prompt.md cases cannot pin a model)`);
          continue;
        }
        cases++;
        let document;
        try {
          document = parse(readFileSync(file, "utf8"));
        } catch (error) {
          problems.push(`${where}/case.yaml: not valid YAML: ${error.message}`);
          continue;
        }
        if (!validate(document)) {
          for (const e of validate.errors) problems.push(`${where}/case.yaml: ${e.instancePath || "/"} ${e.message}`);
          continue;
        }
        if (document.name !== name) problems.push(`${where}/case.yaml: name must be "${name}", the folder name`);
        if (document.execution.model !== pins.model) {
          problems.push(`${where}/case.yaml: execution.model must be ${pins.model}, as pinned in shared/evals.json`);
        }
        for (const tag of document.tags ?? []) tags.add(tag);
        const names = document.graders.map((g) => g.name);
        for (const grader of new Set(names.filter((n, i) => names.indexOf(n) !== i))) {
          problems.push(`${where}/case.yaml: duplicate grader name "${grader}"`);
        }
      }
      if (skillTools.has(group)) {
        for (const tag of ["trigger", "negative", "behaviour"]) {
          if (!tags.has(tag)) problems.push(`plugins/${plugin}/evals/${group}: no case is tagged "${tag}"; a skill needs trigger, negative and behaviour cases`);
        }
      }
    }
  }
  return { cases, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { cases, problems } = checkEvals();
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`${cases} eval case(s) are valid`);
}
