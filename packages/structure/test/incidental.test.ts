import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { encodeProjectDir } from "@code-health/transcripts/measure-repo";
import { SyntheticSession, edit, read } from "../../transcripts/test/synthetic-transcript.ts";
import { expectGolden } from "./support/golden.ts";
import { incidentalRepository } from "./support/incidental-scenarios.ts";
import { runStructure } from "./support/run.ts";

let repo: GitFixture;
let projects: string;

beforeAll(() => {
  repo = incidentalRepository();
  projects = mkdtempSync(join(tmpdir(), "incidental-projects-"));
  const root = realpathSync(repo.path);
  const directory = join(projects, encodeProjectDir(root));
  mkdirSync(directory, { recursive: true });
  // Three tasks edit the caller and open the callee only to follow the dependency.
  const session = new SyntheticSession({ cwd: root, start: "2024-02-20T10:00:00.000Z" });
  for (let task = 0; task < 3; task++) {
    session.prompt();
    session.assistant(`m${task}`, [read(`${root}/src/burdenlib/callee.ts`), edit(`${root}/src/burden/caller.ts`)], { output: 100 });
  }
  writeFileSync(join(directory, "burden.jsonl"), session.toJsonl());
  // Tasks that edit the caller and open a file of the other side that nothing imports are not following the dependency.
  const wander = new SyntheticSession({ cwd: root, start: "2024-02-21T10:00:00.000Z", sessionId: "wander" });
  for (let task = 0; task < 4; task++) {
    wander.prompt();
    wander.assistant(`w${task}`, [read(`${root}/src/burdenlib/unrelated.ts`), edit(`${root}/src/burden/caller.ts`)], { output: 100 });
  }
  writeFileSync(join(directory, "wander.jsonl"), wander.toJsonl());
});
afterAll(() => {
  repo.dispose();
  rmSync(projects, { recursive: true, force: true });
});

interface Row {
  id: string;
  quadrant: string;
  staticCoupling: { sites: number };
  incidental?: { rank: "high" | "low"; reasons: string[]; agentReads: number | null };
}

function writeLocalityReport(): void {
  const directory = join(repo.path, ".cache", "code-health", "reports");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "locality.analyse.json"),
    JSON.stringify({
      tool: "locality",
      command: "analyse",
      repo: { head: repo.git("rev-parse", "HEAD"), dirty: false },
      config: "0123456789abcdef",
      results: [
        {
          path: "src/blocked/leaf.ts",
          blockers: [{ path: "src/blockedlib/dep.ts", from: ["src/blocked/user.ts"], kind: "dependency", weight: 1, otherConsumers: 0, coChange: null, unblockedGain: 4 }],
        },
      ],
    }),
  );
}

async function incidental(...args: string[]) {
  const run = await runStructure(repo.path, ["coupling", "--json", "--quadrant", "incidental", ...args]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  const rows = (JSON.parse(run.stdout) as { results: Row[] }).results;
  return { stdout: run.stdout, rows, byId: (id: string) => rows.find((row) => row.id === `coupling:folder:${id}`) as Row };
}

describe("incidental coupling", () => {
  test("ranks low on its own, however entangled", async () => {
    const { byId, rows } = await incidental();
    expect(rows.every((row) => row.quadrant === "incidental")).toBe(true);
    expect(byId("src/plain->src/plainlib").staticCoupling.sites).toBe(5);
    expect(byId("src/plain->src/plainlib").incidental).toEqual({ rank: "low", reasons: [], agentReads: null });
    // With no other reason it falls behind every pair that has one, though it has the most reference sites.
    const low = rows.filter((row) => row.incidental!.rank === "low");
    expect(low.map((row) => row.id)[0]).toBe("coupling:folder:src/plain->src/plainlib");
    expect(rows.slice(0, 2).every((row) => row.incidental!.rank === "high")).toBe(true);
  });

  test("ranks high when it is part of a cycle or violates a layer rule", async () => {
    const { byId, rows } = await incidental();
    expect(byId("src/cyclic->src/cycliclib").incidental).toMatchObject({ rank: "high", reasons: ["in-cycle"] });
    expect(byId("src/data->src/ui").incidental).toMatchObject({ rank: "high", reasons: ["layer-violation"] });
    expect(rows.slice(0, 2).map((row) => row.id)).toEqual(["coupling:folder:src/cyclic->src/cycliclib", "coupling:folder:src/data->src/ui"]);
  });

  test("ranks high when it blocks a locality move, once a locality report for this commit says so", async () => {
    writeLocalityReport();
    const { byId } = await incidental();
    expect(byId("src/blocked->src/blockedlib").incidental).toMatchObject({ rank: "high", reasons: ["blocks-locality-move"] });
  });

  test("ranks high when tasks open one side only to follow the dependency, from transcripts, and names them in inputs", async () => {
    const without = await runStructure(repo.path, ["coupling", "--json", "--quadrant", "incidental"]);
    expect(JSON.parse(without.stdout).inputs.transcripts).toBe(false);
    expect(JSON.parse(without.stdout).inputs.transcriptStamp).toBeNull();
    const { byId, stdout, rows } = await incidental("--projects-dir", projects);
    expect(JSON.parse(stdout).inputs.transcripts).toBe(true);
    // Different session folders must not give identical inputs.
    const other = mkdtempSync(join(tmpdir(), "no-sessions-"));
    try {
      const empty = await runStructure(repo.path, ["coupling", "--json", "--quadrant", "incidental", "--projects-dir", other]);
      const stamp = JSON.parse(stdout).inputs.transcriptStamp;
      expect(stamp).toMatch(/^[0-9a-f]{16}$/);
      expect(JSON.parse(empty.stdout).inputs.transcriptStamp).not.toBe(stamp);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    expect(byId("src/burden->src/burdenlib").incidental).toEqual({ rank: "high", reasons: ["agent-reads"], agentReads: 3 });
    expect(byId("src/plain->src/plainlib").incidental).toEqual({ rank: "low", reasons: [], agentReads: 0 });
    expect(rows.map((row) => row.incidental?.rank)).toEqual(["high", "high", "high", "high", "low"]);
    expectGolden("incidental", "coupling.incidental", stdout);
  });

  test("counts tasks run in a linked worktree of the repository", async () => {
    const parent = mkdtempSync(join(tmpdir(), "incidental-worktree-"));
    const sessions = mkdtempSync(join(tmpdir(), "incidental-worktree-sessions-"));
    try {
      const linked = join(parent, "linked");
      repo.git("worktree", "add", "--detach", linked);
      const root = realpathSync(linked);
      const directory = join(sessions, encodeProjectDir(root));
      mkdirSync(directory, { recursive: true });
      const session = new SyntheticSession({ cwd: root, start: "2024-02-22T10:00:00.000Z", sessionId: "linked" });
      for (let task = 0; task < 3; task++) {
        session.prompt();
        session.assistant(`l${task}`, [read(`${root}/src/burdenlib/callee.ts`), edit(`${root}/src/burden/caller.ts`)], { output: 100 });
      }
      writeFileSync(join(directory, "linked.jsonl"), session.toJsonl());
      const { byId } = await incidental("--projects-dir", sessions);
      expect(byId("src/burden->src/burdenlib").incidental).toEqual({ rank: "high", reasons: ["agent-reads"], agentReads: 3 });
    } finally {
      repo.git("worktree", "remove", "--force", join(parent, "linked"));
      rmSync(parent, { recursive: true, force: true });
      rmSync(sessions, { recursive: true, force: true });
    }
  });

  test("a missing projects directory is an environment problem, not silence", async () => {
    const run = await runStructure(repo.path, ["coupling", "--json", "--projects-dir", join(projects, "absent")]);
    expect(run.code).not.toBe(ExitCode.Success);
    expect(run.stderr).toContain("absent");
  });
});
