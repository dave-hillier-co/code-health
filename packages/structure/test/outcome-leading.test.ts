import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { encodeProjectDir } from "@code-health/transcripts/measure-repo";
import { SyntheticSession, edit, read } from "../../transcripts/test/synthetic-transcript.ts";
import { expectGolden } from "./support/golden.ts";
import { leadingRepository } from "./support/leading-scenarios.ts";
import { runStructure } from "./support/run.ts";

let repo: GitFixture;
let breakSha: string;
let projects: string;

beforeAll(() => {
  repo = leadingRepository();
  breakSha = repo.git("log", "--format=%H", "--grep=Stop the store").trim();
  projects = mkdtempSync(join(tmpdir(), "leading-projects-"));
  const root = realpathSync(repo.path);
  const directory = join(projects, encodeProjectDir(root));
  mkdirSync(directory, { recursive: true });
  const session = (id: string, start: string, tasks: string[][]) => {
    const s = new SyntheticSession({ cwd: root, start, sessionId: id });
    tasks.forEach((files, index) => {
      s.prompt();
      s.assistant(`m${index}`, [...files.map((file) => read(`${root}/${file}`)), edit(`${root}/${files[0]}`)], { output: 100 });
    });
    writeFileSync(join(directory, `${id}.jsonl`), s.toJsonl());
  };
  // Before the break a task on one side reads three files to follow the dependency; afterwards one.
  session("before", "2024-02-10T10:00:00.000Z", [
    ["src/ui/view.ts", "src/data/store.ts", "src/data/other.ts"],
    ["src/data/store.ts", "src/ui/view.ts", "src/ui/other.ts"],
  ]);
  session("after", "2024-03-10T10:00:00.000Z", [["src/ui/view.ts"], ["src/data/store.ts"]]);
  // A task that touches neither side is not counted.
  session("elsewhere", "2024-02-11T10:00:00.000Z", [["src/misc/x.ts"]]);
});
afterAll(() => {
  repo.dispose();
  rmSync(projects, { recursive: true, force: true });
});

interface Document {
  results: {
    leading: { cycles: { before: number; after: number }; layerViolations: { before: number; after: number } | null };
    agentEffort:
      | { status: "measured"; before: { tasks: number; filesRead: { mean: number } | null }; after: { tasks: number; filesRead: { mean: number } | null } }
      | { status: "not-measured"; reason: string };
  }[];
  inputs: { transcripts: boolean };
}

async function outcome(...args: string[]) {
  const run = await runStructure(repo.path, ["outcome", "--json", "--at", breakSha, "src/data->src/ui", ...args]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return { stdout: run.stdout, document: JSON.parse(run.stdout) as Document };
}

describe("structure outcome, leading indicators and agent effort", () => {
  test("counts the import cycles and layer violations before and after the break", async () => {
    const { document } = await outcome();
    expect(document.results[0]!.leading).toEqual({ cycles: { before: 1, after: 0 }, layerViolations: { before: 1, after: 0 } });
  });

  test("agent effort is not measured without transcripts", async () => {
    const { document } = await outcome();
    expect(document.inputs.transcripts).toBe(false);
    expect(document.results[0]!.agentEffort).toEqual({ status: "not-measured", reason: "no --projects-dir was given" });
  });

  test("agent effort on tasks that touch either side, before and after, from transcripts", async () => {
    const { document, stdout } = await outcome("--projects-dir", projects);
    expect(document.inputs.transcripts).toBe(true);
    const effort = document.results[0]!.agentEffort;
    expect(effort).toMatchObject({ status: "measured", before: { tasks: 2, filesRead: { mean: 3 } }, after: { tasks: 2, filesRead: { mean: 1 } } });
    expectGolden("leading", "outcome.leading", stdout);
  });
});
