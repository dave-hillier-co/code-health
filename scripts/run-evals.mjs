import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEvalPins } from "./check-evals.mjs";

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The `claude plugin eval` arguments for one plugin. The model, judge model and
 * cost ceiling always come from `shared/evals.json`. Results and the report go
 * under `.cache/evals/<plugin>/`, outside the plugin folder that users install.
 *
 * @param {string} plugin
 * @param {{ root?: string, validateOnly?: boolean, passthrough?: string[] }} [options]
 *   `validateOnly` sets the cost ceiling to 0, so every case is loaded and
 *   validated by Claude Code itself and no run is made or billed.
 */
export function evalArguments(plugin, { root = defaultRoot, validateOnly = false, passthrough = [] } = {}) {
  const pins = readEvalPins(root);
  const output = join(root, ".cache", "evals", plugin);
  return [
    "plugin",
    "eval",
    join(root, "plugins", plugin),
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
 * Usage: `npm run evals -- <plugin> [--validate] [-- <claude plugin eval options>]`
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
  const plugin = own.find((arg) => !arg.startsWith("--"));
  if (!plugin || !existsSync(join(defaultRoot, "plugins", plugin, "evals"))) {
    console.error("usage: npm run evals -- <plugin> [--validate] [-- <claude plugin eval options>]\nthe plugin must have an evals/ directory");
    return 1;
  }
  const run = spawnSync("claude", evalArguments(plugin, { validateOnly, passthrough }), { stdio: "inherit" });
  return run.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2), process.env));
