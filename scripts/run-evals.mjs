import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEvalPins } from "./check-evals.mjs";
import { defaultRoot, evalsDir, pluginDir } from "./layout.mjs";

/**
 * The `claude plugin eval` arguments for one tool's cases, `evals/<tool>/`. The run loads the whole
 * plugin, so every skill is present, as it is when installed. The model, judge model and cost ceiling
 * always come from `shared/evals.json`. Results and the report go under `.cache/evals/<tool>/`, outside
 * the plugin folder that users install.
 *
 * @param {string} tool
 * @param {{ root?: string, validateOnly?: boolean, passthrough?: string[] }} [options]
 *   `validateOnly` sets the cost ceiling to 0, so every case is loaded and
 *   validated by Claude Code itself and no run is made or billed.
 */
export function evalArguments(tool, { root = defaultRoot, validateOnly = false, passthrough = [] } = {}) {
  const pins = readEvalPins(root);
  const output = join(root, ".cache", "evals", tool);
  return [
    "plugin",
    "eval",
    pluginDir(root),
    "--eval-dir",
    `evals/${tool}`,
    "--model",
    pins.model,
    "--judge-model",
    pins.judgeModel,
    "--max-cost-usd",
    String(validateOnly ? 0 : pins.maxCostUsd),
    "--output-dir",
    join(output, "results"),
    "--report",
    join(output, "report.html"),
    "--no-publish",
    ...passthrough,
  ];
}

/**
 * Evals are billed, so they run on demand and before release, never in CI.
 * Usage: `npm run evals -- <tool> [--validate] [-- <claude plugin eval options>]`
 */
function main(argv, env) {
  if (env.CI) {
    console.error("evals are billed and never run in CI");
    return 1;
  }
  const dashes = argv.indexOf("--");
  const own = dashes === -1 ? argv : argv.slice(0, dashes);
  const passthrough = dashes === -1 ? [] : argv.slice(dashes + 1);
  const validateOnly = own.includes("--validate");
  const tool = own.find((arg) => !arg.startsWith("--"));
  if (!tool || !existsSync(join(evalsDir(), tool))) {
    console.error("usage: npm run evals -- <tool> [--validate] [-- <claude plugin eval options>]\nthe tool must have a folder of cases under the plugin's evals/");
    return 1;
  }
  const run = spawnSync("claude", evalArguments(tool, { validateOnly, passthrough }), { stdio: "inherit" });
  return run.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2), process.env));
