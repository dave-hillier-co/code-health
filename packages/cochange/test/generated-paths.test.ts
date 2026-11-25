import { afterEach, expect, test, vi } from "vitest";
import { GitFixture, type Change, type Step } from "@code-health/fixtures/git-fixture";
import { runCochange, runCochangeOnTerminal } from "./support/run.ts";

vi.setConfig({ testTimeout: 180_000 });

const rust = (n: number) => `pub struct Config {\n    pub size: u32,\n}\n\npub fn size() -> u32 {\n    if ${n} > 1 {\n        return ${n};\n    }\n    0\n}\n`;
const cue = (n: number) => `package metadata\n\ngenerated: components: sinks: vector: size: ${n}\n`;

function step(day: number, changes: Change[]): Step {
  return { type: "commit", message: `change ${day}`, date: `2024-03-${String(day).padStart(2, "0")}T10:00:00Z`, changes };
}

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

/** A Rust config struct whose reference page is written from it, and an example, all changing together. */
function repo(config?: unknown): GitFixture {
  const first: Change[] = [
    { op: "add", path: "src/sinks/vector/config.rs", content: rust(1) },
    { op: "add", path: "website/cue/reference/components/sinks/generated/vector.cue", content: cue(1) },
    { op: "add", path: "website/assets/player.min.js", content: "var a=1;\n" },
    { op: "add", path: "examples/demo.rs", content: rust(1) },
  ];
  if (config !== undefined) first.push({ op: "add", path: "code-health.json", content: `${JSON.stringify(config)}\n` });
  const steps: Step[] = [step(1, first)];
  for (let day = 2; day <= 6; day++) {
    steps.push(
      step(day, [
        { op: "modify", path: "src/sinks/vector/config.rs", content: rust(day) },
        { op: "modify", path: "website/cue/reference/components/sinks/generated/vector.cue", content: cue(day) },
        { op: "modify", path: "website/assets/player.min.js", content: `var a=${day};\n` },
        { op: "modify", path: "examples/demo.rs", content: rust(day) },
      ]),
    );
  }
  const fixture = GitFixture.build(steps);
  fixtures.push(fixture);
  return fixture;
}

async function run(fixture: GitFixture, ...argv: string[]) {
  const { code, stdout, stderr } = await runCochange(fixture.path, [...argv, "--limit", "all", "--json"]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  return JSON.parse(stdout);
}

const namesOf = (document: { results: { path: string; with: string }[] }) => new Set(document.results.flatMap((row) => [row.path, row.with]));

test("coupling leaves out files below a generated folder and minified files, and counts them as generated", async () => {
  const document = await run(repo(), "coupling", "--min-support", "1");
  const names = namesOf(document);
  expect(names.has("website/cue/reference/components/sinks/generated/vector.cue")).toBe(false);
  expect(names.has("website/assets/player.min.js")).toBe(false);
  expect(names.has("src/sinks/vector/config.rs")).toBe(true);
  expect(document.dropped).toEqual({ generated: 2 });
  expect(document.filtersApplied.dropped.generated).toBeGreaterThan(0);
});

test("a negated generatedPatterns entry keeps the files of generated folders in the history", async () => {
  const document = await run(repo({ generatedPatterns: ["!generated"] }), "coupling", "--min-support", "1");
  expect(namesOf(document).has("website/cue/reference/components/sinks/generated/vector.cue")).toBe(true);
  expect(document.dropped).toEqual({ generated: 1 });
});

test("hotspots names the examples folder and its share of the production files it ranks", async () => {
  const fixture = repo();
  const document = await run(fixture, "hotspots");
  expect(document.results.map((row: { path: string }) => row.path).sort()).toEqual(["examples/demo.rs", "src/sinks/vector/config.rs"]);
  expect(document.possibleNonProductionFolders).toEqual({ productionFiles: 2, folders: [{ folder: "examples", files: 1, share: 0.5 }] });
  const { stdout } = await runCochangeOnTerminal(fixture.path, ["hotspots"]);
  expect(stdout).toContain("Notice: 1 of 2 production files (50.0%) are in folders that often hold examples");
});
