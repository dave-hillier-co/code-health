import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Runs `claude plugin validate --strict` on the marketplace and on every plugin.
 * The claude CLI is not an npm dependency, so without it the check is skipped
 * with a notice rather than failed: CI installs it where it can.
 */
function main() {
  const probe = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    console.log("NOTICE: the claude CLI is not available, so `claude plugin validate --strict` was skipped");
    return 0;
  }

  const targets = [root];
  const plugins = join(root, "plugins");
  if (existsSync(plugins)) {
    for (const entry of readdirSync(plugins, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.isDirectory()) targets.push(join(plugins, entry.name));
    }
  }

  let failed = false;
  for (const target of targets) {
    const run = spawnSync("claude", ["plugin", "validate", "--strict", target], { encoding: "utf8" });
    process.stdout.write(run.stdout ?? "");
    process.stderr.write(run.stderr ?? "");
    if (run.status !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

process.exit(main());
