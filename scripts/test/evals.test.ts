import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { checkEvals, readEvalPins } from "../check-evals.mjs";
import { evalArguments } from "../run-evals.mjs";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "evals-"));
  mkdirSync(join(root, "shared"));
  writeFileSync(join(root, "shared", "evals.json"), JSON.stringify({ model: "m-1", judgeModel: "j-1", maxCostUsd: 2 }));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "eval-case.schema.json"), readFileSync(join(repository, "scripts", "eval-case.schema.json")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const valid = (name: string, model = "m-1") =>
  [
    'schema_version: "1.0"',
    `name: ${name}`,
    "execution:",
    "  prompt: Say hello",
    `  model: ${model}`,
    "graders:",
    "  - type: regex",
    "    name: greets",
    "    pattern: hello",
    "",
  ].join("\n");

function writeCase(tool: string, dir: string, text: string) {
  mkdirSync(join(root, "plugins", "code-health", "evals", tool, dir), { recursive: true });
  writeFileSync(join(root, "plugins", "code-health", "evals", tool, dir, "case.yaml"), text);
}

test("a case in the claude plugin eval format validates", () => {
  writeCase("p", "greeting", valid("greeting"));
  expect(checkEvals(root)).toEqual({ cases: 1, problems: [] });
});

test("the repository's own cases validate", () => {
  const { cases, problems } = checkEvals(repository);
  expect(problems).toEqual([]);
  expect(cases).toBeGreaterThan(0);
});

test("a case without graders, with an unknown grader type or a missing prompt is rejected", () => {
  writeCase("p", "a", valid("a").replace(/graders:[\s\S]*/, "graders: []\n"));
  writeCase("p", "b", valid("b").replace("type: regex", "type: vibes"));
  writeCase("p", "c", valid("c").replace("  prompt: Say hello\n", ""));
  const problems = checkEvals(root).problems;
  expect(problems.filter((p) => p.includes("/a/")).length).toBeGreaterThan(0);
  expect(problems.filter((p) => p.includes("/b/")).length).toBeGreaterThan(0);
  expect(problems.filter((p) => p.includes("/c/")).length).toBeGreaterThan(0);
});

test("the model must be the pinned one, so no case runs on a default", () => {
  writeCase("p", "drift", valid("drift", "other-model"));
  writeCase("p", "unpinned", valid("unpinned").replace("  model: m-1\n", ""));
  const problems = checkEvals(root).problems.join("\n");
  expect(problems).toContain("execution.model must be m-1");
  expect(problems).toContain("must have required property 'model'");
});

test("the folder must match the name, graders must be unique and prompt.md cases are refused", () => {
  writeCase("p", "folder", valid("other"));
  writeCase("p", "twice", valid("twice") + "  - type: regex\n    name: greets\n    pattern: hi\n");
  mkdirSync(join(root, "plugins", "code-health", "evals", "p", "prompt-only"));
  writeFileSync(join(root, "plugins", "code-health", "evals", "p", "prompt-only", "prompt.md"), "hi");
  const problems = checkEvals(root).problems.join("\n");
  expect(problems).toContain('name must be "folder"');
  expect(problems).toContain('duplicate grader name "greets"');
  expect(problems).toContain("p/prompt-only: case.yaml is missing");
});

test("results output is not a case, beside the tools' folders or inside one", () => {
  mkdirSync(join(root, "plugins", "code-health", "evals", "results"), { recursive: true });
  mkdirSync(join(root, "plugins", "code-health", "evals", "p", "results"), { recursive: true });
  expect(checkEvals(root)).toEqual({ cases: 0, problems: [] });
});

test("a case outside a tool's folder is reported", () => {
  mkdirSync(join(root, "plugins", "code-health", "evals", "stray"), { recursive: true });
  writeFileSync(join(root, "plugins", "code-health", "evals", "stray", "case.yaml"), valid("stray"));
  expect(checkEvals(root).problems).toEqual(["plugins/code-health/evals/stray: a case belongs in a tool's folder, evals/<tool>/stray"]);
});

test("the runner loads the whole plugin, runs one tool's cases, pins model, judge model and cost ceiling and keeps results out of the plugin", () => {
  const args = evalArguments("p", { root });
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  expect(args.slice(0, 2)).toEqual(["plugin", "eval"]);
  expect(args[2]).toBe(join(root, "plugins", "code-health"));
  expect(value("--eval-dir")).toBe("evals/p");
  expect(value("--model")).toBe("m-1");
  expect(value("--judge-model")).toBe("j-1");
  expect(value("--max-cost-usd")).toBe("2");
  expect(value("--output-dir").startsWith(join(root, ".cache"))).toBe(true);
  expect(args).toContain("--no-publish");
});

test("validate-only sets a zero cost ceiling, and extra options are passed through", () => {
  const args = evalArguments("p", { root, validateOnly: true, passthrough: ["--case", "smoke"] });
  expect(args[args.indexOf("--max-cost-usd") + 1]).toBe("0");
  expect(args.slice(-2)).toEqual(["--case", "smoke"]);
});

test("the runner refuses to run in CI", () => {
  const run = spawnSync("node", [join(repository, "scripts", "run-evals.mjs"), "cochange"], { env: { ...process.env, CI: "1" }, encoding: "utf8" });
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("never run in CI");
});

test("no workflow runs evals", () => {
  const workflows = join(repository, ".github", "workflows");
  for (const file of readdirSync(workflows)) {
    expect(readFileSync(join(workflows, file), "utf8")).not.toMatch(/run-evals|plugin eval|npm run evals/);
  }
});

test("the pins name a model, a judge model and a positive ceiling", () => {
  const pins = readEvalPins(repository);
  expect(pins.model).toBeTruthy();
  expect(pins.judgeModel).toBeTruthy();
  expect(pins.maxCostUsd).toBeGreaterThan(0);
});

/** A skill of the plugin whose `allowed-tools` names the CLI of `tool`. */
function writeSkill(name: string, tool: string) {
  mkdirSync(join(root, "plugins", "code-health", "skills", name), { recursive: true });
  writeFileSync(join(root, "plugins", "code-health", "skills", name, "SKILL.md"), `---\nname: ${name}\nallowed-tools: Bash(node \${CLAUDE_PLUGIN_ROOT}/dist/${tool}.mjs *)\n---\n`);
}

test("the cases of a tool that a skill runs need trigger, negative and behaviour tags", () => {
  writeSkill("briefing", "p");
  writeCase("p", "greeting", valid("greeting").replace("name: greeting", "name: greeting\ntags: [trigger]"));
  expect(checkEvals(root).problems).toEqual([
    'plugins/code-health/evals/p: no case is tagged "negative"; a skill needs trigger, negative and behaviour cases',
    'plugins/code-health/evals/p: no case is tagged "behaviour"; a skill needs trigger, negative and behaviour cases',
  ]);
  writeCase("p", "declines", valid("declines").replace("name: declines", "name: declines\ntags: [negative, behaviour]"));
  expect(checkEvals(root).problems).toEqual([]);
});

test("a skill whose tool has no folder of cases is a problem, whatever cases another tool has", () => {
  writeSkill("briefing", "p");
  writeSkill("review", "q");
  writeCase("q", "greeting", valid("greeting").replace("name: greeting", "name: greeting\ntags: [trigger, negative, behaviour]"));
  expect(checkEvals(root).problems).toEqual(["plugins/code-health: ships a skill that runs p but has no evals/p"]);
});

test("every tool has a case in which the skill must decline: tagged as behaviour and negative", () => {
  const groups = join(repository, "plugins", "code-health", "evals");
  for (const tool of readdirSync(groups)) {
    const evals = join(groups, tool);
    const declines = readdirSync(evals, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => {
        const text = readFileSync(join(evals, entry.name, "case.yaml"), "utf8");
        const tags = /^tags: \[(.*)\]/m.exec(text)?.[1]?.split(",").map((tag) => tag.trim()) ?? [];
        return tags.includes("behaviour") && tags.includes("negative");
      });
    expect(declines.length, `${tool} has a decline case`).toBeGreaterThan(0);
  }
});

test("the structure tool has a decline for each of its skills: the structure skill and the packaging skill", () => {
  const evals = join(repository, "plugins", "code-health", "evals", "structure");
  const text = (name: string) => readFileSync(join(evals, name, "case.yaml"), "utf8");
  // The structure skill declines to name a pattern; the packaging skill declines to merge on co-change alone.
  expect(text("no-named-pattern-by-default")).toMatch(/input_match: structure/);
  expect(text("decline-merge-on-cochange-alone")).toMatch(/input_match: packaging/);
  expect(text("decline-merge-on-cochange-alone")).toMatch(/tags: \[behaviour, negative\]/);
});
