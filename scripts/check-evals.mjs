import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const readEvalPins = (root = defaultRoot) => JSON.parse(readFileSync(join(root, "shared", "evals.json"), "utf8"));

/**
 * Validates every eval case at `plugins/<plugin>/evals/<case>/case.yaml`
 * without running (and so without billing) anything:
 *
 * - the file parses and matches `scripts/eval-case.schema.json`, which mirrors the
 *   case format `claude plugin eval` loads (a case that fails to load there fails here)
 * - the case directory name equals `name`, and grader names are unique
 * - `execution.model` is the model pinned in `shared/evals.json`
 *
 * - a plugin that ships a skill has cases tagged `trigger` (it loads when it should), `negative`
 *   (it stays out of the way or declines) and `behaviour` (what it does once loaded), as suite.md asks
 *
 * Cases are `case.yaml` files only. The `prompt.md` form cannot pin a model.
 * `evals/results/` is output and is skipped.
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
  const plugins = join(root, "plugins");
  for (const plugin of existsSync(plugins) ? readdirSync(plugins).sort() : []) {
    const evals = join(plugins, plugin, "evals");
    const tags = new Set();
    const hasSkill = existsSync(join(plugins, plugin, "skills"));
    if (!existsSync(evals)) {
      if (hasSkill) problems.push(`plugins/${plugin}: ships a skill but has no evals`);
      continue;
    }
    for (const entry of readdirSync(evals, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isDirectory() || entry.name === "results") continue;
      const where = `plugins/${plugin}/evals/${entry.name}`;
      const file = join(evals, entry.name, "case.yaml");
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
      if (document.name !== entry.name) problems.push(`${where}/case.yaml: name must be "${entry.name}", the folder name`);
      if (document.execution.model !== pins.model) {
        problems.push(`${where}/case.yaml: execution.model must be ${pins.model}, as pinned in shared/evals.json`);
      }
      for (const tag of document.tags ?? []) tags.add(tag);
      const names = document.graders.map((g) => g.name);
      for (const name of new Set(names.filter((n, i) => names.indexOf(n) !== i))) {
        problems.push(`${where}/case.yaml: duplicate grader name "${name}"`);
      }
    }
    if (hasSkill) {
      for (const tag of ["trigger", "negative", "behaviour"]) {
        if (!tags.has(tag)) problems.push(`plugins/${plugin}/evals: no case is tagged "${tag}"; a skill needs trigger, negative and behaviour cases`);
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
