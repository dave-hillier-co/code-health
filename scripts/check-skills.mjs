import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { tools } from "./layout.mjs";
import { skillDirectories } from "./sync-red-flags.mjs";

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** SKILL.md is loaded into context whenever the skill fires, so its size is a recurring cost. */
export const MAX_SKILL_LINES = 500;
/** The Agent Skills limit on a description. */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** The one thing a skill may pre-approve: one of the plugin's bundled CLIs. */
export const allowedToolFor = (tool) => `Bash(node \${CLAUDE_PLUGIN_ROOT}/dist/${tool}.mjs *)`;

/** Splits a SKILL.md into its parsed frontmatter and body. `frontmatter` is null when there is none or it is not YAML. */
export function splitFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { frontmatter: null, body: text };
  try {
    const parsed = parse(match[1]);
    return { frontmatter: parsed !== null && typeof parsed === "object" ? parsed : null, body: text.slice(match[0].length) };
  } catch {
    return { frontmatter: null, body: text };
  }
}

/** The tools in an `allowed-tools` value, which Claude Code accepts as a space-separated string or a list. */
function toolList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.match(/[A-Za-z_]+(?:\([^)]*\))?/g) ?? [];
  return [];
}

/**
 * Checks every skill under `plugins/<plugin>/skills/<skill>` against the suite's
 * skill conventions (CONTRIBUTING.md "Skills"):
 *
 * - `SKILL.md` exists, is at most 500 lines, and has YAML frontmatter
 * - `name` equals the folder name; `description` is present and at most 1024 characters
 * - `allowed-tools` is exactly one of the plugin's CLIs, `Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/<tool>.mjs *)`,
 *   where `<tool>` is a package with a CLI source (`packages/<tool>/src/main.ts`)
 * - `references/` holds only Markdown, includes the generated `red-flags.md`, and every
 *   `references/...` link in SKILL.md resolves
 *
 * @param {string} [root] repository root
 * @returns {{ skills: number, problems: string[] }}
 */
export function checkSkills(root = defaultRoot) {
  const problems = [];
  const dirs = skillDirectories(root);
  const allowed = tools(root).map(allowedToolFor);
  for (const dir of dirs) {
    const [plugin, , skill] = dir.slice(join(root, "plugins").length + 1).split(/[\\/]/);
    const where = `plugins/${plugin}/skills/${skill}`;
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) {
      problems.push(`${where}: SKILL.md is missing`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    const lines = text.replace(/\n$/, "").split("\n").length;
    if (lines > MAX_SKILL_LINES) problems.push(`${where}/SKILL.md has ${lines} lines; the limit is ${MAX_SKILL_LINES}, move detail into references/`);

    const { frontmatter, body } = splitFrontmatter(text);
    if (frontmatter === null) {
      problems.push(`${where}/SKILL.md has no YAML frontmatter`);
    } else {
      if (frontmatter.name !== skill) problems.push(`${where}/SKILL.md: name must be "${skill}", the folder name`);
      const description = frontmatter.description;
      if (typeof description !== "string" || description.trim() === "") {
        problems.push(`${where}/SKILL.md: description is required`);
      } else if (description.length > MAX_DESCRIPTION_LENGTH) {
        problems.push(`${where}/SKILL.md: description is ${description.length} characters; the limit is ${MAX_DESCRIPTION_LENGTH}`);
      }
      const listed = toolList(frontmatter["allowed-tools"]);
      if (listed.length !== 1 || !allowed.includes(listed[0])) {
        problems.push(`${where}/SKILL.md: allowed-tools must be exactly one of ${allowed.join(", ") || allowedToolFor("<tool>")}`);
      }
    }

    const references = join(dir, "references");
    const present = existsSync(references) ? readdirSync(references, { withFileTypes: true }) : [];
    if (!present.some((e) => e.isFile() && e.name === "red-flags.md")) {
      problems.push(`${where}/references/red-flags.md is missing; run npm run build`);
    }
    for (const entry of present) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) problems.push(`${where}/references/${entry.name}: references holds Markdown files only`);
    }
    for (const link of new Set([...body.matchAll(/\]\((references\/[^)#\s]+)/g)].map((m) => m[1]))) {
      if (!existsSync(join(dir, link))) problems.push(`${where}/SKILL.md links to ${link}, which does not exist`);
    }
  }
  return { skills: dirs.length, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { skills, problems } = checkSkills();
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`${skills} skill(s) follow the skill conventions`);
}
