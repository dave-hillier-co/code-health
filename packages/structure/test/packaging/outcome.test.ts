import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { encodeProjectDir } from "@code-health/transcripts/measure-repo";
import { SyntheticSession, edit, read } from "../../../transcripts/test/synthetic-transcript.ts";
import { expectGolden } from "../support/golden.ts";
import { packages, packagesRun } from "./support/run.ts";
import { outcomeRepository, type OutcomeRepository } from "./support/outcome.ts";
import { workspaceRepository } from "./support/workspace.ts";

let repo: OutcomeRepository;
let projects: string;
beforeAll(() => {
  repo = outcomeRepository();
  projects = mkdtempSync(join(tmpdir(), "outcome-projects-"));
  // the sessions record the real path of the working directory, which is where git says the repository is
  const root = realpathSync(repo.fixture.path);
  const dir = join(projects, encodeProjectDir(root));
  mkdirSync(dir, { recursive: true });
  const session = (id: string, start: string, ...files: string[]) => {
    const s = new SyntheticSession({ cwd: root, start });
    files.forEach((file, i) => {
      s.prompt();
      s.assistant(`m${i}`, [read(`${root}/${file}`), edit(`${root}/${file}`)], { output: 100 });
    });
    writeFileSync(join(dir, `${id}.jsonl`), s.toJsonl());
  };
  // before the merge: tasks in the pair take two folders and more reads
  session("before-pair", "2023-03-01T10:00:00.000Z", "packages/left/src/work.ts", "packages/right/src/work.ts");
  session("before-solo", "2023-03-02T10:00:00.000Z", "packages/solo/src/work.ts");
  session("after-merged", "2023-05-01T10:00:00.000Z", "packages/left/src/work.ts");
  session("after-solo", "2023-05-02T10:00:00.000Z", "packages/solo/src/work.ts");
});
afterAll(() => {
  repo.fixture.dispose();
  rmSync(projects, { recursive: true, force: true });
});

async function outcome(...args: string[]) {
  const { document, stdout } = await packages(repo.fixture, "outcome", repo.last, "--from", repo.first, ...args);
  return { result: document.results as any, document, stdout };
}

describe("a merge of two packages", () => {
  test("names what was reshaped: the pair that was replaced and the package that took its place", async () => {
    const { result } = await outcome();
    expect(result.reshaped).toMatchObject({ kind: "merge", replaced: ["packages/left", "packages/right"], created: ["packages/left"], movedFiles: 1, at: repo.last });
  });

  test("the earlier window counts the pair as one unit, so before and after compare like with like", async () => {
    const { result } = await outcome();
    // eight changes touched only the pair, and the one that added the packages touched every package
    expect(result.before).toMatchObject({ changes: 9, closure: 0.889 });
    expect(result.before.packagesPerChange).toBeCloseTo(1.222, 3);
    // after: eight alone, and two with app
    expect(result.after).toMatchObject({ changes: 10, closure: 0.8 });
    expect(result.after.packagesPerChange).toBeCloseTo(1.2, 3);
  });

  test("for a merge, packages per change and closure show that it took place, so they are flagged as by construction", async () => {
    const { result } = await outcome();
    expect(result.byConstruction).toBe(true);
  });

  test("they are compared with packages of a comparable share that were left alone", async () => {
    const { result } = await outcome();
    expect(result.before.comparable.packages).toEqual(["packages/solo"]);
    expect(result.before.comparable).toMatchObject({ closure: 0.857 });
    expect(result.after.comparable.packages).toEqual(["packages/solo"]);
  });

  test("the commits of the reshaping itself are left out of both windows", async () => {
    const { result } = await outcome();
    // nine before and ten after, with neither merge commit among them
    expect(result.before.changes + result.after.changes).toBe(19);
  });

  test("the gaming check compares the share of the result that its consumers use with the pair's", async () => {
    const { result } = await outcome();
    expect(result.reuse.before).toMatchObject({ consumers: 1 });
    expect(result.reuse.after).toMatchObject({ consumers: 1 });
    expect(typeof result.reuse.tradedOneCostForAnother).toBe("boolean");
    // app used one export of each; it uses both of the merged package's, which is a larger share
    expect(result.reuse.tradedOneCostForAnother).toBe(false);
  });

  test("package count and median distance are leading indicators", async () => {
    const { result } = await outcome();
    expect(result.leading.packages).toEqual({ before: 4, after: 3 });
  });

  test("agent effort is not measured without transcripts", async () => {
    const { result } = await outcome();
    expect(result.agentEffort).toEqual({ status: "not-measured", reason: "no --projects-dir was given" });
  });

  test("agent effort is the independent test: tasks touching the reshaped packages, against tasks that touched others", async () => {
    const { result } = await outcome("--projects-dir", projects);
    expect(result.agentEffort.status).toBe("measured");
    expect(result.agentEffort.before.tasks).toBe(2);
    expect(result.agentEffort.after.tasks).toBe(1);
    expect(result.agentEffort.control.before.tasks).toBe(1);
    expect(result.agentEffort.control.after.tasks).toBe(1);
  });
});

describe("usage", () => {
  test("a revision is required", async () => {
    expect((await packagesRun(repo.fixture, "outcome")).code).toBe(ExitCode.Usage);
  });

  test("a revision that does not exist is a usage error", async () => {
    const run = await packagesRun(repo.fixture, "outcome", "nowhere");
    expect(run.code).toBe(ExitCode.Usage);
    expect(run.stderr).toContain("is not a revision");
  });

  test("a commit that reshaped nothing says so", async () => {
    const run = await packagesRun(repo.fixture, "outcome", "HEAD");
    expect(run.code).toBe(ExitCode.Usage);
    expect(run.stderr).toContain("nothing was reshaped");
  });

  test("a --from that is not an ancestor of the commit is a usage error", async () => {
    const run = await packagesRun(repo.fixture, "outcome", repo.first, "--from", repo.last);
    expect(run.code).toBe(ExitCode.Usage);
  });
});

test("the workspace has no reshaping to measure at its first commit", async () => {
  const fixture = workspaceRepository();
  try {
    const first = fixture.git("rev-list", "--max-parents=0", "HEAD");
    const run = await packagesRun(fixture, "outcome", first);
    expect(run.code).toBe(ExitCode.Usage);
    expect(run.stderr).toContain("has no parent");
  } finally {
    fixture.dispose();
  }
});

test("golden", async () => {
  expectGolden("outcome", "packages.outcome", (await outcome("--projects-dir", projects)).stdout);
});
