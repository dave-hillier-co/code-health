import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where every skill keeps its copy of the red flags, relative to the skill folder. */
export const COPY_PATH = join("references", "red-flags.md");

/**
 * The shared references every skill carries a byte for byte copy of, by file name under `shared/` and in
 * each skill's `references/`. The red flags are required. A shared reference with no source file is skipped.
 */
export const SHARED_REFERENCES = ["red-flags.md", "reports.md"];

const sources = (root) => SHARED_REFERENCES.filter((name, i) => i === 0 || existsSync(join(root, "shared", name)));

/** The skill folders of every plugin: `plugins/<plugin>/skills/<skill>`, sorted. A skill folder is any directory under `skills/`. */
export function skillDirectories(root = defaultRoot) {
  const plugins = join(root, "plugins");
  if (!existsSync(plugins)) return [];
  const out = [];
  for (const plugin of readdirSync(plugins, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const skills = join(plugins, plugin.name, "skills");
    if (!existsSync(skills)) continue;
    for (const skill of readdirSync(skills, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      out.push(join(skills, skill.name));
    }
  }
  return out.sort();
}

/** Copies each shared reference into every skill's references. Returns the files written or already current. */
export function syncRedFlags(root = defaultRoot) {
  const written = [];
  for (const name of sources(root)) {
    const text = readFileSync(join(root, "shared", name), "utf8");
    for (const skill of skillDirectories(root)) {
      const target = join(skill, "references", name);
      mkdirSync(dirname(target), { recursive: true });
      if (!existsSync(target) || readFileSync(target, "utf8") !== text) writeFileSync(target, text);
      written.push(target);
    }
  }
  return written;
}

/** Skill copies that are missing or differ from their file under `shared/`. */
export function staleRedFlags(root = defaultRoot) {
  return sources(root).flatMap((name) => {
    const text = readFileSync(join(root, "shared", name), "utf8");
    return skillDirectories(root)
      .map((skill) => join(skill, "references", name))
      .filter((target) => !existsSync(target) || readFileSync(target, "utf8") !== text);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const stale = staleRedFlags().map((path) => path.slice(defaultRoot.length + 1));
    if (stale.length > 0) {
      console.error(`shared reference copies are out of date: ${stale.join(", ")}; edit the files in shared/ only, run npm run build and commit the result`);
      process.exit(1);
    }
    console.log("shared reference copies match shared/");
  } else {
    for (const path of syncRedFlags()) console.log(`copied shared reference to ${path.slice(defaultRoot.length + 1)}`);
  }
}
