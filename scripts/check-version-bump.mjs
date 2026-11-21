import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_JSON = ".claude-plugin/plugin.json";

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitOrNull(root, ...args) {
  try {
    return git(root, ...args);
  } catch {
    return null;
  }
}

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(text ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isGreater(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function versionAt(root, rev, plugin) {
  const text = gitOrNull(root, "show", `${rev}:plugins/${plugin}/${PLUGIN_JSON}`);
  return text === null ? null : (JSON.parse(text).version ?? null);
}

/**
 * Users of a third-party marketplace get an update only when a plugin's version
 * string changes, so a change under `plugins/<plugin>/` must bump the version
 * in that plugin's plugin.json. The comparison is against the merge base of
 * `base` and `head`, so changes made on the base branch since the branch point
 * are not counted. The marketplace entries must not carry a version at all:
 * plugin.json is the only place it is set.
 *
 * @param {{ root?: string, base: string | undefined, head?: string }} options
 * @returns {{ skipped: string | null, problems: string[] }}
 */
export function checkVersionBump({ root = defaultRoot, base, head = "HEAD" }) {
  const problems = [];

  const marketplace = gitOrNull(root, "show", `${head}:.claude-plugin/marketplace.json`);
  if (marketplace !== null) {
    for (const entry of JSON.parse(marketplace).plugins ?? []) {
      if ("version" in entry) {
        problems.push(`marketplace entry "${entry.name}" sets a version; set it in plugin.json only`);
      }
    }
  }

  if (!base || /^0+$/.test(base)) return { skipped: "no base revision to compare against", problems };
  const mergeBase = gitOrNull(root, "merge-base", base, head);
  if (mergeBase === null) return { skipped: `no merge base between ${base} and ${head}`, problems };

  const changed = git(root, "diff", "--name-only", mergeBase, head, "--", "plugins")
    .split("\n")
    .filter((line) => line !== "");
  const plugins = [...new Set(changed.map((path) => path.split("/")[1]))].sort();

  for (const plugin of plugins) {
    const now = versionAt(root, head, plugin);
    if (now === null) continue; // the plugin was removed
    const before = versionAt(root, mergeBase, plugin);
    if (before === null) continue; // a new plugin starts at whatever version it declares

    const parsedNow = parseVersion(now);
    const parsedBefore = parseVersion(before);
    if (!parsedNow || !parsedBefore) {
      problems.push(`plugins/${plugin}: version "${now}" (was "${before}") is not major.minor.patch`);
    } else if (!isGreater(parsedNow, parsedBefore)) {
      problems.push(
        `plugins/${plugin} changed since ${mergeBase.slice(0, 8)} but its version is still ${now}` +
          (now === before ? "" : ` (was ${before})`) +
          `; bump version in plugins/${plugin}/${PLUGIN_JSON}`,
      );
    }
  }
  return { skipped: null, problems };
}

/** The base to compare against when none is given: the remote's default branch, when there is one. */
function defaultBase(root) {
  return existsSync(join(root, ".git")) && gitOrNull(root, "rev-parse", "--verify", "--quiet", "origin/main") ? "origin/main" : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf("--base");
  const base = (flag === -1 ? undefined : process.argv[flag + 1]) ?? process.env.BASE_REF ?? defaultBase(defaultRoot);
  const { skipped, problems } = checkVersionBump({ base });
  if (skipped) console.log(`version-bump check skipped: ${skipped}`);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  if (!skipped) console.log("version bumps are in order");
}
