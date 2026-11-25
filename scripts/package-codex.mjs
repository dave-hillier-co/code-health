import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codexInstructions, codexReference } from "./codex-instructions.mjs";
import { distDir, pluginDir, schemasDir } from "./layout.mjs";

export { codexInstructions } from "./codex-instructions.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const codexSkills = {
  cochange: { tool: "cochange", title: "Co-change", description: "Find hotspots and files that change together" },
  "change-risk": { tool: "cochange", title: "Change risk", description: "Review branch risk using history and ownership" },
  abandonment: { tool: "cochange", title: "Abandonment risk", description: "Assess knowledge loss with repository opt-in" },
  identities: { tool: "cochange", title: "Identities", description: "Review and resolve Git author identity mappings" },
  complexity: { tool: "complexity", title: "Complexity", description: "Measure complexity and guide local simplifications" },
  locality: { tool: "locality", title: "Locality", description: "Place code closer to its consumers with evidence" },
  structure: { tool: "structure", title: "Structure", description: "Find cycles and dependencies expensive to change" },
  packaging: { tool: "structure", title: "Packaging", description: "Evaluate package boundaries and reshaping options" },
};

/**
 * The files in the plugin's `dist/` that one tool's CLI runs with: its bundle, every chunk the bundle
 * reaches by a static or on-demand import, the grammars and the notices. The plugin's `dist/` holds
 * every tool's bundle, and a standalone skill carries only its own.
 */
export function toolRuntimeFiles(tool, sourceRoot = root) {
  const dist = distDir(sourceRoot);
  const reached = new Set();
  const queue = [`${tool}.mjs`];
  while (queue.length > 0) {
    const name = queue.pop();
    if (reached.has(name)) continue;
    reached.add(name);
    for (const match of readFileSync(join(dist, name), "utf8").matchAll(/["']\.\/(chunk-[A-Z0-9]+\.mjs)["']/g)) queue.push(match[1]);
  }
  return [...reached, "THIRD_PARTY_NOTICES.md", "grammars"].filter((name) => existsSync(join(dist, name))).sort();
}

/** Creates one standalone installation; never overwrites an existing directory. */
export function packageCodex(destination, sourceRoot = root, name = "cochange") {
  const metadata = codexSkills[name];
  if (!metadata) throw new Error(`Unknown Codex skill: ${name}`);
  if (existsSync(destination)) throw new Error(`Destination already exists: ${destination}`);
  const skill = join(pluginDir(sourceRoot), "skills", name);
  const instructions = codexInstructions(readFileSync(join(skill, "SKILL.md"), "utf8"), name, metadata.tool);
  const references = readdirSync(join(skill, "references")).map((file) => {
    if (!file.endsWith(".md")) throw new Error(`Unexpected reference: ${file}`);
    return [file, codexReference(readFileSync(join(skill, "references", file), "utf8"), name, file, metadata.tool)];
  });
  mkdirSync(join(destination, "references"), { recursive: true });
  writeFileSync(join(destination, "SKILL.md"), instructions);
  for (const [file, text] of references) writeFileSync(join(destination, "references", file), text);
  mkdirSync(join(destination, "scripts", "dist"), { recursive: true });
  for (const file of toolRuntimeFiles(metadata.tool, sourceRoot)) cpSync(join(distDir(sourceRoot), file), join(destination, "scripts", "dist", file), { recursive: true });
  cpSync(schemasDir(metadata.tool, sourceRoot), join(destination, "schemas"), { recursive: true });
  for (const file of ["LICENSE", "LICENSING.md"]) cpSync(join(sourceRoot, file), join(destination, file));
  // Preserve cwd, argv, exit status, and relative chunk/grammar loading.
  writeFileSync(join(destination, "scripts", `${metadata.tool}.mjs`), `await import("./dist/${metadata.tool}.mjs");\n`);
  mkdirSync(join(destination, "agents"));
  writeFileSync(join(destination, "agents", "openai.yaml"), `interface:\n  display_name: ${JSON.stringify(metadata.title)}\n  short_description: ${JSON.stringify(metadata.description)}\n`);
  return destination;
}

/** Each folder can be installed alone, including skills that run the same tool. */
export function packageAllCodex(destination, sourceRoot = root) {
  if (existsSync(destination)) throw new Error(`Destination already exists: ${destination}`);
  mkdirSync(dirname(destination), { recursive: true });
  const stage = mkdtempSync(join(dirname(destination), ".codex-package-"));
  try {
    for (const name of Object.keys(codexSkills)) packageCodex(join(stage, name), sourceRoot, name);
    renameSync(stage, destination);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const name = args[0] === "--skill" ? args.splice(0, 2)[1] : undefined;
  if (args.length > 1 || args.some((arg) => arg.startsWith("--")) || (process.argv[2] === "--skill" && !name)) {
    throw new Error("usage: node scripts/package-codex.mjs [--skill NAME] [new-output-directory]");
  }
  const output = resolve(args[0] ?? join(root, ".cache", "codex", "skills", ...(name ? [name] : [])));
  console.log(name ? packageCodex(output, root, name) : packageAllCodex(output));
}
