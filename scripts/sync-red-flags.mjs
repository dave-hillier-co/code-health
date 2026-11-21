import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where every skill keeps its copy, relative to the skill folder. */
export const COPY_PATH = join("references", "red-flags.md");

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

const source = (root) => join(root, "shared", "red-flags.md");

/** Copies `shared/red-flags.md` into every skill's references. Returns the files written. */
export function syncRedFlags(root = defaultRoot) {
  const text = readFileSync(source(root), "utf8");
  const written = [];
  for (const skill of skillDirectories(root)) {
    const target = join(skill, COPY_PATH);
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target) || readFileSync(target, "utf8") !== text) writeFileSync(target, text);
    written.push(target);
  }
  return written;
}

/** Skill copies that are missing or differ from `shared/red-flags.md`. */
export function staleRedFlags(root = defaultRoot) {
  const text = readFileSync(source(root), "utf8");
  return skillDirectories(root)
    .map((skill) => join(skill, COPY_PATH))
    .filter((target) => !existsSync(target) || readFileSync(target, "utf8") !== text);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const stale = staleRedFlags().map((path) => path.slice(defaultRoot.length + 1));
    if (stale.length > 0) {
      console.error(`red-flags copies are out of date: ${stale.join(", ")}; edit shared/red-flags.md only, run npm run build and commit the result`);
      process.exit(1);
    }
    console.log("red-flags copies match shared/red-flags.md");
  } else {
    for (const path of syncRedFlags()) console.log(`copied shared/red-flags.md to ${path.slice(defaultRoot.length + 1)}`);
  }
}
