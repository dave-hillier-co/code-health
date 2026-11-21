import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The analysis commands every plugin runs on a repository, in an order that lets the first one
 * build the shared history cache for the rest. They run one after another because they share it.
 */
export const selfCommands = [
  { plugin: "cochange", command: "hotspots" },
  { plugin: "cochange", command: "coupling" },
  { plugin: "complexity", command: "analyse" },
  { plugin: "locality", command: "analyse" },
  { plugin: "structure", command: "cycles" },
];

function run(bundle, command, cwd) {
  return new Promise((resolveRun) => {
    execFile(
      "node",
      [bundle, command, "--json", "--limit", command === "cycles" ? "all" : "1"],
      { cwd, maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolveRun({ exitCode, stdout, stderr });
      },
    );
  });
}

/**
 * The tracked TypeScript and script files under `packages/` and `scripts/` that the repository's
 * `exclude` globs hide from the analysis. Fixtures, goldens and bundles may be excluded; the
 * suite's own source and tests must not be, or a widened glob would drop them from the gate.
 */
export function excludedSource({ root }) {
  let globs;
  try {
    globs = JSON.parse(readFileSync(join(root, "code-health.json"), "utf8")).exclude ?? [];
  } catch {
    return [];
  }
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "packages", "scripts"], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString()
    .split("\0")
    .filter((path) => /\.(ts|tsx|mjs)$/.test(path));
  return tracked.filter((path) => globs.some((glob) => matchesGlob(path, glob)));
}

/**
 * Runs the bundled CLIs on `root` and says what is wrong: a command that exits non-zero, a source
 * file the parser reports syntax errors in, or an import cycle. Excluded paths never reach the
 * results, because the CLIs apply the repository's own `code-health.json`.
 */
export async function checkSelf({ root, plugins = join(here, "..", "plugins") }) {
  const commands = [];
  const failures = excludedSource({ root }).map((path) => `excluded source ${path}`);
  for (const { plugin, command } of selfCommands) {
    const label = `${plugin} ${command}`;
    const { exitCode, stdout, stderr } = await run(join(plugins, plugin, "dist", `${plugin}.mjs`), command, root);
    commands.push({ plugin, command, exitCode });
    if (exitCode !== 0) {
      failures.push(`${label} exited ${exitCode}: ${(stderr.trim() || stdout.trim()).slice(0, 300)}`);
      continue;
    }
    let document;
    try {
      document = JSON.parse(stdout);
    } catch {
      failures.push(`${label} did not print JSON`);
      continue;
    }
    for (const path of document.filesWithSyntaxErrors ?? []) failures.push(`syntax errors in ${path} (${label})`);
    if (command === "cycles") {
      for (const cycle of document.results ?? []) failures.push(`import cycle of ${cycle.nodes.length}: ${cycle.nodes.join(", ")}`);
    }
  }
  return { commands, failures };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { commands, failures } = await checkSelf({ root: resolve(here, "..") });
  for (const { plugin, command, exitCode } of commands) console.log(`${plugin} ${command}: exit ${exitCode}`);
  if (failures.length > 0) {
    console.error(`\ncheck:self found ${failures.length} problem${failures.length === 1 ? "" : "s"}:`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  }
}
