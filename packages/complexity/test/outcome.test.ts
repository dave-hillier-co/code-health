import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture, type Step } from "@code-health/fixtures/git-fixture";
import { encodeProjectDir } from "@code-health/transcripts/measure-repo";
import { edit, read, SyntheticSession } from "../../transcripts/test/synthetic-transcript.ts";
import type { Outcome } from "../src/outcome.ts";
import { expectGolden, withoutMeta } from "./support/golden.ts";
import { buildOutcomeRepo, outcomeSteps, splitHot } from "./support/outcome-scenario.ts";
import { runComplexity } from "./support/run.ts";

let repo: GitFixture;
let flattenSha: string;
beforeAll(() => {
  repo = buildOutcomeRepo();
  flattenSha = repo.git("log", "--format=%H", "--grep=Flatten hot").trim();
});
afterAll(() => repo.dispose());

async function outcome(...args: string[]) {
  const run = await runComplexity(repo.path, ["outcome", "--json", flattenSha, ...args]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return { stdout: run.stdout, result: JSON.parse(run.stdout).results as Outcome };
}

describe("complexity outcome", () => {
  test("measures the change cost of the acted-on file before and after, and sets it beside a file left alone", async () => {
    const { result, stdout } = await outcome();
    expect(result.actedOn.files).toEqual([{ path: "src/hot.ts", earlierPath: "src/hot.ts" }]);
    expect(result.comparison.files).toEqual(["src/warm.ts"]);
    // Four changes before (the first adds the file), then one: the simplification's own commit is left out of both windows.
    expect(result.changeCost.actedOn).toMatchObject({
      before: { changes: 4, linesChurnedPerChange: 7, fixCommitRate: 0.25 },
      after: { changes: 1, linesChurnedPerChange: 4, fixCommitRate: 0 },
    });
    expect(result.changeCost.comparison).toMatchObject({
      before: { changes: 4, linesChurnedPerChange: 7, fixCommitRate: 0.25 },
      after: { changes: 4, linesChurnedPerChange: 4, fixCommitRate: 0.5 },
    });
    // The comparison group's movement is taken off, so what both groups did alike is not credited to the simplification.
    expect(result.difference).toMatchObject({ linesChurnedPerChange: 0, fixCommitRate: -0.5, changes: -3 });
    // Every fix rate keeps the commits behind it, each with the pattern that matched.
    expect(result.changeCost.actedOn.before.fixCommits).toMatchObject({ fixes: 1, omitted: 0, byPattern: [{ count: 1 }] });
    expect(result.changeCost.actedOn.before.fixCommits.commits).toHaveLength(1);
    expect(result.fixConvention).toMatchObject({ followsConvention: false });
    expect(result.fixConvention.note).toMatch(/probably do not follow a convention/);
    expectGolden("outcome", "outcome", stdout);
  });

  test("ranks the acted-on functions before and after, as a leading indicator", async () => {
    const { result } = await outcome();
    const { before, after } = result.rank.actedOn;
    expect(before.functions).toBe(1);
    expect(after.functions).toBe(1);
    expect(before.meanComplexityScore).not.toBeNull();
    expect(after.meanScore!).toBeLessThanOrEqual(before.meanScore!);
  });

  test("reports function count and mean interface depth as the gaming check, and does not suspect a plain flattening", async () => {
    const { result } = await outcome();
    expect(result.gamingCheck.actedOn.before.functions).toBe(1);
    expect(result.gamingCheck.actedOn.after.functions).toBe(1);
    expect(result.gamingCheck.suspected).toBe(false);
  });

  test("says agent effort was not measured without a projects directory, or with no session that edited the files", async () => {
    expect((await outcome()).result.agentEffort).toEqual({ status: "not-measured", reason: "no --projects-dir was given" });
    const empty = mkdtempSync(join(tmpdir(), "no-sessions-"));
    try {
      expect((await outcome("--projects-dir", empty)).result.agentEffort).toEqual({ status: "not-measured", reason: "no session in the windows edited the acted-on files" });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("measures the agent's reads in tasks that edited the acted-on files, against tasks that edited the comparison files", async () => {
    const root = realpathSync(repo.path);
    const projects = mkdtempSync(join(tmpdir(), "outcome-sessions-"));
    try {
      const task = (session: SyntheticSession, file: string, extraReads: string[]) =>
        session.prompt().assistant(`m-${file}-${extraReads.length}`, [...extraReads.map((name) => read(`${root}/src/${name}`)), read(`${root}/src/${file}`), edit(`${root}/src/${file}`)], { output: 10 });
      // Before the simplification the agent read around hot.ts: two other files and then hot.ts. Afterwards it reads only hot.ts.
      const before = new SyntheticSession({ cwd: root, sessionId: "before", start: "2024-05-01T09:00:00.000Z" });
      task(before, "hot.ts", ["flat.ts", "warm.ts"]);
      task(before, "warm.ts", ["flat.ts", "hot.ts"]);
      const after = new SyntheticSession({ cwd: root, sessionId: "after", start: "2024-07-10T09:00:00.000Z" });
      task(after, "hot.ts", []);
      task(after, "warm.ts", ["flat.ts", "hot.ts"]);
      mkdirSync(join(projects, encodeProjectDir(root)), { recursive: true });
      writeFileSync(join(projects, encodeProjectDir(root), "before.jsonl"), before.toJsonl());
      writeFileSync(join(projects, encodeProjectDir(root), "after.jsonl"), after.toJsonl());

      const { result, stdout } = await outcome("--projects-dir", projects);
      expectGolden("outcome", "outcome.measured", stdout);
      // Reproducible: the same inputs give the same bytes, whatever order the session files are read in.
      expect(withoutMeta((await outcome("--projects-dir", projects)).stdout)).toBe(withoutMeta(stdout));
      const inputs = JSON.parse(stdout).inputs;
      expect(inputs.transcriptStamp).toMatch(/^[0-9a-f]{16}$/);
      const none = mkdtempSync(join(tmpdir(), "no-sessions-"));
      try {
        expect(JSON.parse((await outcome("--projects-dir", none)).stdout).inputs.transcriptStamp).not.toBe(inputs.transcriptStamp);
      } finally {
        rmSync(none, { recursive: true, force: true });
      }
      if (result.agentEffort.status !== "measured") throw new Error(`agent effort was not measured: ${result.agentEffort.reason}`);
      expect(result.agentEffort.actedOn.before.tasks).toBe(1);
      expect(result.agentEffort.actedOn.before.filesRead).toEqual({ mean: 3, median: 3 });
      expect(result.agentEffort.actedOn.after.filesRead).toEqual({ mean: 1, median: 1 });
      expect(result.agentEffort.comparison.after.filesRead).toEqual({ mean: 3, median: 3 });
    } finally {
      rmSync(projects, { recursive: true, force: true });
    }
  });

  describe("the instruments' other branches", () => {
    const flatten = (steps: Step[], content: string): Step[] =>
      steps.map((step) => (step.type === "commit" && step.message.startsWith("Flatten hot") ? { ...step, changes: [{ op: "modify" as const, path: "src/hot.ts", content }] } : step));

    test("suspects gaming when functions were added while the interfaces got shallower", async () => {
      const split = GitFixture.build(flatten(outcomeSteps(), splitHot));
      try {
        const sha = split.git("log", "--format=%H", "--grep=Flatten hot").trim();
        const result = JSON.parse((await runComplexity(split.path, ["outcome", "--json", sha])).stdout).results as Outcome;
        expect(result.gamingCheck.actedOn.after.functions).toBeGreaterThan(result.gamingCheck.actedOn.before.functions);
        expect(result.gamingCheck.suspected).toBe(true);
      } finally {
        split.dispose();
      }
    });

    test("with no other file to compare with, the comparison group is empty and the difference is not computed", async () => {
      const alone = GitFixture.build(outcomeSteps().filter((step) => !(step.type === "commit" && /warm|Fix off|Tune warm|rounding|edge case in warm/.test(step.message))).map((step) =>
        step.type === "commit" && step.message === "Add modules" ? { ...step, changes: step.changes.filter((change) => change.path !== "src/warm.ts" && change.path !== "src/flat.ts") } : step,
      ));
      try {
        const sha = alone.git("log", "--format=%H", "--grep=Flatten hot").trim();
        const run = await runComplexity(alone.path, ["outcome", "--json", sha]);
        const result = JSON.parse(run.stdout).results as Outcome;
        expect(result.comparison.files).toEqual([]);
        expect(result.changeCost.comparison.before.changes).toBe(0);
        expect(result.difference.linesChurnedPerChange).toBeNull();
        expectGolden("outcome", "outcome.nocomparison", run.stdout);
      } finally {
        alone.dispose();
      }
    });
  });

  describe("with history long after the simplification", () => {
    let long: GitFixture;
    let sha: string;
    beforeAll(() => {
      long = GitFixture.build([
        ...outcomeSteps(),
        { type: "commit", message: "Much later change to warm", date: "2026-05-01T09:00:00+00:00", changes: [{ op: "modify", path: "src/warm.ts", content: "export function warm(a: number): number {\n  return a;\n}\n" }] },
      ]);
      sha = long.git("log", "--format=%H", "--grep=Flatten hot").trim();
    });
    afterAll(() => long.dispose());

    test("caps the after window at the length of the before window, so the two compare like with like", async () => {
      const run = await runComplexity(long.path, ["outcome", "--json", sha]);
      const result = JSON.parse(run.stdout).results as Outcome;
      expect(result.windows.before).toEqual({ since: "2023-06-01T09:00:00.000Z", until: "2024-06-01T09:00:00.000Z" });
      expect(result.windows.after).toEqual({ since: "2024-06-01T09:00:00.000Z", until: "2025-06-01T09:00:00.000Z", complete: true });
      // The 2026 change is outside the capped window, so the counts are over the same span.
      expect(result.changeCost.comparison.after.changes).toBe(4);
    });

    test("says the after window is incomplete when the history ends before it would", async () => {
      const run = await runComplexity(repo.path, ["outcome", "--json", flattenSha]);
      const result = JSON.parse(run.stdout).results as Outcome;
      expect(result.windows.after.complete).toBe(false);
    });

    test("leaves the session that made the simplification out of the after window", async () => {
      const root = realpathSync(long.path);
      const projects = mkdtempSync(join(tmpdir(), "outcome-own-session-"));
      try {
        // Started on the commit day, before the 09:00 commit: this is the session that flattened hot.ts.
        const own = new SyntheticSession({ cwd: root, sessionId: "own", start: "2024-06-01T01:00:00.000Z" });
        own.prompt().assistant("m1", [read(`${root}/src/a.ts`), read(`${root}/src/b.ts`), read(`${root}/src/c.ts`), edit(`${root}/src/hot.ts`)], { output: 10 });
        const later = new SyntheticSession({ cwd: root, sessionId: "later", start: "2024-07-10T09:00:00.000Z" });
        later.prompt().assistant("m2", [read(`${root}/src/hot.ts`), edit(`${root}/src/hot.ts`)], { output: 10 });
        mkdirSync(join(projects, encodeProjectDir(root)), { recursive: true });
        writeFileSync(join(projects, encodeProjectDir(root), "own.jsonl"), own.toJsonl());
        writeFileSync(join(projects, encodeProjectDir(root), "later.jsonl"), later.toJsonl());
        const run = await runComplexity(long.path, ["outcome", "--json", sha, "--projects-dir", projects]);
        const result = JSON.parse(run.stdout).results as Outcome;
        if (result.agentEffort.status !== "measured") throw new Error(result.agentEffort.reason);
        expect(result.agentEffort.actedOn.after.tasks).toBe(1);
        expect(result.agentEffort.actedOn.before.tasks).toBe(0);
      } finally {
        rmSync(projects, { recursive: true, force: true });
      }
    });
  });

  test("is a usage error without a revision, for an unknown revision, and when nothing with functions changed", async () => {
    const none = await runComplexity(repo.path, ["outcome", "--json"]);
    expect(none.code).toBe(ExitCode.Usage);
    const unknown = await runComplexity(repo.path, ["outcome", "--json", "no-such-revision"]);
    expect(unknown.code).toBe(ExitCode.Usage);
    expect(unknown.stderr).toContain("is not a revision");
    const first = repo.git("rev-list", "--max-parents=0", "HEAD").trim();
    const root = await runComplexity(repo.path, ["outcome", "--json", first]);
    expect(root.code).toBe(ExitCode.Usage);
  });
});
