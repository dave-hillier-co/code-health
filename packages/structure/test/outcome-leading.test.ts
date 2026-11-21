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
  // The pair left alone, over the same windows: it drifted the other way, so the break is not credited with what everything did.
  session("elsewhere", "2024-02-11T10:00:00.000Z", [["src/misc/x.ts"]]);
  session("elsewhere-after", "2024-03-11T10:00:00.000Z", [["src/misc/x.ts", "src/util/y.ts"]]);
  // A task that touches neither pair is not counted.
  session("unrelated", "2024-02-12T10:00:00.000Z", [["src/other/z.ts"]]);
});
afterAll(() => {
  repo.dispose();
  rmSync(projects, { recursive: true, force: true });
});

interface Document {
  results: {
    leading: { cycles: { before: number; after: number }; layerViolations: { before: number; after: number } | null };
    agentEffort:
      | {
          status: "measured";
          before: { tasks: number; filesRead: { mean: number } | null };
          after: { tasks: number; filesRead: { mean: number } | null };
          comparison: { pair: [string, string]; before: { tasks: number; filesRead: { mean: number } | null }; after: { tasks: number; filesRead: { mean: number } | null } } | null;
          difference: { filesRead: number | null; tokens: number | null };
        }
      | { status: "not-measured"; reason: string };
  }[];
  inputs: { transcripts: boolean; transcriptStamp: string | null };
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
    expect(document.inputs.transcriptStamp).toBeNull();
    expect(document.results[0]!.agentEffort).toEqual({ status: "not-measured", reason: "no --projects-dir was given" });
  });

  test("agent effort on tasks that touch either side, before and after, from transcripts", async () => {
    const { document, stdout } = await outcome("--projects-dir", projects);
    expect(document.inputs.transcripts).toBe(true);
    expect(document.inputs.transcriptStamp).toMatch(/^[0-9a-f]{16}$/);
    // Another session folder must not give the same inputs.
    const other = mkdtempSync(join(tmpdir(), "no-sessions-"));
    try {
      expect((await outcome("--projects-dir", other)).document.inputs.transcriptStamp).not.toBe(document.inputs.transcriptStamp);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    const effort = document.results[0]!.agentEffort;
    expect(effort).toMatchObject({ status: "measured", before: { tasks: 2, filesRead: { mean: 3 } }, after: { tasks: 2, filesRead: { mean: 1 } } });
    if (effort.status !== "measured") throw new Error("not measured");
    // Set beside the pair that was left alone, matched by static coupling at the break's parent.
    expect(effort.comparison).toMatchObject({ pair: ["src/misc", "src/util"], before: { tasks: 1, filesRead: { mean: 1 } }, after: { tasks: 1, filesRead: { mean: 2 } } });
    expect(effort.difference.filesRead).toBe(-3);
    expectGolden("leading", "outcome.leading", stdout);
  });

  test("the session that made the break is in neither window", async () => {
    const root = realpathSync(repo.path);
    const own = mkdtempSync(join(tmpdir(), "leading-own-"));
    try {
      const directory = join(own, encodeProjectDir(root));
      mkdirSync(directory, { recursive: true });
      // Started on the break's day, before the 09:00 commit: the session that removed the import.
      const made = new SyntheticSession({ cwd: root, start: "2024-03-01T01:00:00.000Z", sessionId: "made" });
      made.prompt();
      made.assistant("m0", [read(`${root}/src/ui/view.ts`), read(`${root}/src/data/other.ts`), edit(`${root}/src/data/store.ts`)], { output: 100 });
      writeFileSync(join(directory, "made.jsonl"), made.toJsonl());
      const later = new SyntheticSession({ cwd: root, start: "2024-03-10T10:00:00.000Z", sessionId: "later" });
      later.prompt();
      later.assistant("m1", [edit(`${root}/src/data/store.ts`)], { output: 100 });
      writeFileSync(join(directory, "later.jsonl"), later.toJsonl());
      const effort = (await outcome("--projects-dir", own)).document.results[0]!.agentEffort;
      expect(effort).toMatchObject({ status: "measured", before: { tasks: 0 }, after: { tasks: 1 } });
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });
});
