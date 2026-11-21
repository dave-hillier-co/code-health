import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden, withoutMeta } from "./support/golden.ts";
import { bury, relocationApp, Sessions, sessionsAfter, sessionsBefore, tidyUp } from "./support/measure-scenarios.ts";
import { runLocality } from "./support/run.ts";

const disposables: Array<{ dispose(): void }> = [];
afterAll(() => disposables.forEach((item) => item.dispose()));

async function measure(repo: GitFixture, sessions: Sessions, args: string[]) {
  const run = await runLocality(repo.path, ["measure", ...args, "--projects-dir", sessions.directory, "--json"]);
  return { run, document: run.code === ExitCode.Success ? JSON.parse(run.stdout) : null };
}

function fresh() {
  const repo = relocationApp();
  const sessions = new Sessions(repo.path);
  disposables.push(repo, sessions);
  return { repo, sessions };
}

describe("measure baseline", () => {
  let repo: GitFixture;
  let sessions: Sessions;
  let first: Awaited<ReturnType<typeof measure>>;
  beforeAll(async () => {
    ({ repo, sessions } = fresh());
    sessionsBefore(sessions);
    first = await measure(repo, sessions, ["baseline"]);
  }, 60_000);

  test("records change spread over the twelve months back from HEAD, and the agent effort of the same days", () => {
    expect(first.run.stderr).toBe("");
    expect(first.run.code).toBe(ExitCode.Success);
    const { results } = first.document;
    expect(results.window).toEqual({ from: "2023-01-01", to: "2024-01-02" });
    // 6 features changing 7, 6, 5, 4, 3 and 2 times, plus the first commit that adds them all: spread is measured per change.
    expect(results.spread).toMatchObject({ changes: 28, measured: 28, oversized: 0 });
    expect(results.effort).toMatchObject({ tasks: 24, sessions: { measured: 6, notMeasured: 0 } });
    expect(first.document.inputs.transcripts.tasks).toBe(24);
  });

  test("ranks the candidates and records the files around each, before anything moves", () => {
    // The helpers, and each feature file that its only consumer, main, could take.
    expect(first.document.results.candidates).toEqual({ recorded: 18, ranked: 18 });
    const stored = JSON.parse(readFileSync(join(repo.path, first.document.results.file), "utf8"));
    const helpers = stored.candidates.filter((c: { path: string }) => c.path.startsWith("src/shared/utils/"));
    expect(helpers.map((c: { path: string }) => c.path)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `src/shared/utils/h${n}.ts`));
    expect(stored.candidates.map((c: { rank: number }) => c.rank)).toEqual(Array.from({ length: 18 }, (_, index) => index + 1));
    expect(stored.candidates[0]).toMatchObject({ files: ["src/shared/utils/h1.ts"], consumers: ["src/f1/a.ts", "src/f1/b.ts"] });
    expect(stored.head).toBe(repo.git("rev-parse", "HEAD"));
  });

  test("records the leading indicator and the gaming check's figures as the structure stood", () => {
    expect(first.document.results.structure).toEqual({ totalWeightedDistance: expect.any(Number), singleFileFolders: 1, maxDepth: 3 });
    expect(first.document.results.structure.totalWeightedDistance).toBeGreaterThan(0);
  });

  test("keeps the tasks as paths and counts, never what was said", () => {
    const stored = readFileSync(join(repo.path, first.document.results.file), "utf8");
    expect(stored).not.toContain("synthetic");
    expect(JSON.parse(stored).effort.tasks[0]).toHaveProperty("readPaths");
  });

  test("lives in .code-health/local, which ignores itself, and not in the cache", () => {
    expect(first.document.results.file).toBe(".code-health/local/locality.baseline.default.json");
    expect(readFileSync(join(repo.path, ".code-health", "local", ".gitignore"), "utf8")).toBe("*\n");
    expect(repo.git("status", "--porcelain")).toBe("");
    expect(existsSync(join(repo.path, ".cache", "code-health", "locality.baseline.default.json"))).toBe(false);
  });

  test("refuses to replace a baseline, since it cannot be regenerated once code has moved", async () => {
    const again = await measure(repo, sessions, ["baseline"]);
    expect(again.run.code).toBe(ExitCode.Usage);
    expect(again.run.stderr).toMatch(/already exists/);
  });

  test("replaces it with --force, and the same inputs give the same output", async () => {
    const forced = await measure(repo, sessions, ["baseline", "--force"]);
    expect(forced.run.code).toBe(ExitCode.Success);
    expect(withoutMeta(forced.run.stdout)).toBe(withoutMeta(first.run.stdout));
    expectGolden("measure", "measure.baseline", first.run.stdout);
  });

  test("a baseline of another name is kept beside it", async () => {
    const other = await measure(repo, sessions, ["baseline", "--name", "second"]);
    expect(other.document.results.file).toBe(".code-health/local/locality.baseline.second.json");
    expect(existsSync(join(repo.path, first.document.results.file))).toBe(true);
  });

  test("a name that is not a file name is a usage error", async () => {
    const bad = await measure(repo, sessions, ["baseline", "--name", "../x"]);
    expect(bad.run.code).toBe(ExitCode.Usage);
  });

  test("with no transcripts it still records spread and candidates, and says there are no tasks", async () => {
    const empty = new Sessions(repo.path);
    disposables.push(empty);
    const run = await measure(repo, empty, ["baseline", "--name", "no-sessions"]);
    expect(run.document.results.effort).toMatchObject({ tasks: 0, filesRead: null });
    expect(run.document.results.spread.measured).toBe(28);
  });
});

describe("measure compare", () => {
  let repo: GitFixture;
  let sessions: Sessions;
  beforeAll(async () => {
    ({ repo, sessions } = fresh());
    sessionsBefore(sessions);
    const baseline = await measure(repo, sessions, ["baseline"]);
    expect(baseline.run.code).toBe(ExitCode.Success);
  }, 60_000);

  test("before anything moves there is nothing acted on, and nothing to compare", async () => {
    const run = await measure(repo, sessions, ["compare"]);
    expect(run.run.code).toBe(ExitCode.Success);
    expect(run.document.results).toMatchObject({ status: "nothing-acted-on", suite: { commits: 0, actedOn: 0 } });
    expectGolden("measure", "measure.nothing", run.run.stdout);
  });

  test("a baseline that was never recorded is a usage error that says what to run", async () => {
    const run = await measure(repo, sessions, ["compare", "--name", "never"]);
    expect(run.run.code).toBe(ExitCode.Usage);
    expect(run.run.stderr).toMatch(/measure baseline/);
  });

  describe("after two helpers were moved", () => {
    beforeAll(() => {
      tidyUp(repo, [1, 2]);
      sessionsAfter(sessions, [1, 2]);
    });

    test("sets the acted-on files beside candidates of the nearest rank that were left alone", async () => {
      const { document } = await measure(repo, sessions, ["compare"]);
      expect(document.results.status).toBe("compared");
      // The consumers of a moved helper are candidates in their own right, and four of them are files whose neighbourhood the moves changed.
      expect(document.results.suite).toEqual({ commits: 2, actedOn: 2, comparison: 2, overlapping: 4 });
      expect(document.results.pairs).toEqual([
        { actedOn: { path: "src/shared/utils/h1.ts", rank: 1 }, comparison: { path: "src/shared/utils/h3.ts", rank: 3 } },
        { actedOn: { path: "src/shared/utils/h2.ts", rank: 2 }, comparison: { path: "src/shared/utils/h4.ts", rank: 4 } },
      ]);
      expect(document.results.comparison.candidates).toEqual(["src/shared/utils/h3.ts", "src/shared/utils/h4.ts"]);
    });

    test("measures the matching window: the same number of days, starting the day after the last suite commit", async () => {
      const { document } = await measure(repo, sessions, ["compare"]);
      expect(document.results.after).toEqual({ from: "2024-01-11", to: "2025-01-11", complete: true, days: 366, matchingDays: 366 });
      expect(document.results.spreadReproduced).toBe(true);
    });

    test("reports change spread and agent effort for both groups with their sample sizes", async () => {
      const { document } = await measure(repo, sessions, ["compare"]);
      const { actedOn, comparison } = document.results;
      // A change to a moved feature touches three files in one folder, so its spread is 0 afterwards.
      expect(actedOn.after.spread.mean).toBe(0);
      expect(actedOn.before.spread.mean).toBeGreaterThan(0);
      expect(comparison.after.spread.mean).toBe(comparison.before.spread.mean);
      expect(actedOn.before.effort).toMatchObject({ tasks: 8 });
      expect(actedOn.after.effort).toMatchObject({ tasks: 8, foldersVisited: { mean: 1 }, reReads: { mean: 0 } });
      expect(comparison.after.effort).toMatchObject({ tasks: 8, foldersVisited: { mean: 2 }, reReads: { mean: 1 } });
    });

    test("reports the difference between the groups, not the raw before and after", async () => {
      const { document } = await measure(repo, sessions, ["compare"]);
      const { effort } = document.results;
      expect(effort.foldersVisited).toMatchObject({ actedOn: { change: -1 }, comparison: { change: 0 }, difference: -1, conclusion: "lower" });
      expect(effort.filesRead).toMatchObject({ difference: 0, conclusion: "no-change" });
      expect(effort.tokens).toMatchObject({ difference: -2000, conclusion: "lower" });
      expect(effort.conclusion).toBe("lower");
      expect(document.results.claim).toBe("cheaper");
    });

    test("reports the leading indicator before and after, and finds nothing buried when code moved next to its consumers", async () => {
      const { document } = await measure(repo, sessions, ["compare"]);
      const { structure } = document.results;
      expect(structure.after.totalWeightedDistance).toBeLessThan(structure.before.totalWeightedDistance);
      expect(structure.gaming).toEqual({ flagged: false, reasons: [] });
    });

    test("is byte for byte reproducible, and matches its golden", async () => {
      const first = await measure(repo, sessions, ["compare"]);
      const second = await measure(repo, sessions, ["compare"]);
      expect(withoutMeta(second.run.stdout)).toBe(withoutMeta(first.run.stdout));
      expectGolden("measure", "measure.compare", first.run.stdout);
    });

    test("concludes nothing from fewer tasks than locality.measureMinSamples", async () => {
      const config = JSON.parse(readFileSync(join(repo.path, "code-health.json"), "utf8"));
      writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ ...config, locality: { measureMinSamples: 100 } }));
      try {
        const { document } = await measure(repo, sessions, ["compare"]);
        expect(document.results.effort.conclusion).toBe("insufficient-sample");
        expect(document.results.spread.conclusion).toBe("insufficient-sample");
        expect(document.results.claim).toBe("unproven");
      } finally {
        writeFileSync(join(repo.path, "code-health.json"), JSON.stringify(config));
      }
    });

    test("a spread that fell with no fall in effort is not called cheaper", async () => {
      const flat = new Sessions(repo.path);
      disposables.push(flat);
      sessionsBefore(flat);
      // After the move the moved features cost exactly what they did before.
      sessionsAfter(flat, []);
      const { document } = await measure(repo, flat, ["compare"]);
      expect(document.results.spread.conclusion).toBe("lower");
      expect(document.results.effort.conclusion).toBe("no-change");
      expect(document.results.claim).toBe("spread-without-effort");
    });

    test("--since starts the window on a day of its own choosing, and a short window is said to be incomplete", async () => {
      const { document } = await measure(repo, sessions, ["compare", "--since", "2024-12-01"]);
      expect(document.results.after).toMatchObject({ from: "2024-12-01", to: "2025-01-21", complete: false, days: 51, matchingDays: 366 });
    });
  });
});

describe("measure compare, where the move buried code", () => {
  test("the distance falls, but the single-file folders and depth that rose are flagged as gaming", async () => {
    const { repo, sessions } = fresh();
    sessionsBefore(sessions);
    expect((await measure(repo, sessions, ["baseline"])).run.code).toBe(ExitCode.Success);
    bury(repo, 1);
    sessionsAfter(sessions, [1]);
    const { document } = await measure(repo, sessions, ["compare"]);
    const { structure } = document.results;
    expect(structure.after.totalWeightedDistance).toBeLessThan(structure.before.totalWeightedDistance);
    expect(structure.after.singleFileFolders).toBeGreaterThan(structure.before.singleFileFolders);
    expect(structure.after.maxDepth).toBeGreaterThan(structure.before.maxDepth);
    expect(structure.gaming.flagged).toBe(true);
    expect(structure.gaming.reasons.join(" ")).toMatch(/single-file folders/);
    expect(structure.gaming.reasons.join(" ")).toMatch(/depth/);
  }, 60_000);
});

describe("measure compare, where the moves did not go through the skill", () => {
  test("commits without a Code-Health trailer are not acted-on files", async () => {
    const { repo, sessions } = fresh();
    sessionsBefore(sessions);
    expect((await measure(repo, sessions, ["baseline"])).run.code).toBe(ExitCode.Success);
    tidyUp(repo, [1], { trailer: false });
    const { document } = await measure(repo, sessions, ["compare"]);
    expect(document.results.status).toBe("nothing-acted-on");
  }, 60_000);

  test("a baseline taken after a tidy-up says so", async () => {
    const { repo, sessions } = fresh();
    tidyUp(repo, [1]);
    const { document } = await measure(repo, sessions, ["baseline"]);
    expect(document.results.priorSuiteCommits).toBe(1);
  }, 60_000);

  test("a baseline of another branch is not compared", async () => {
    const { repo, sessions } = fresh();
    sessionsBefore(sessions);
    expect((await measure(repo, sessions, ["baseline"])).run.code).toBe(ExitCode.Success);
    repo.git("checkout", "--quiet", "--orphan", "other");
    repo.git("commit", "--quiet", "--allow-empty", "-m", "Start again");
    const { run } = await measure(repo, sessions, ["compare"]);
    expect(run.code).toBe(ExitCode.Usage);
    expect(run.stderr).toMatch(/not an ancestor/);
  }, 60_000);
});

describe("what was said in a session never leaves it", () => {
  const SENTINEL = "SENTINEL-prompt-text-7f3a91";

  function filesUnder(directory: string): string[] {
    if (!existsSync(directory)) return [];
    return readdirSync(directory).flatMap((entry) => {
      const path = join(directory, entry);
      return statSync(path).isDirectory() ? filesUnder(path) : [path];
    });
  }

  test("neither the baseline's nor the comparison's output, stderr or files carry prompt text, including from sessions outside the window and ones that cannot be read", async () => {
    const { repo, sessions } = fresh();
    sessionsBefore(sessions);
    // A session whose prompts hold the sentinel inside the window, one far outside it, and one that is not a transcript.
    sessions.featureTasks(1, { start: "2023-03-01T09:00:00Z", tasks: 2, helper: "src/shared/utils/h1.ts", rereads: false, tokens: 100, prompt: SENTINEL });
    sessions.featureTasks(1, { start: "2019-03-01T09:00:00Z", tasks: 2, helper: "src/shared/utils/h1.ts", rereads: false, tokens: 100, prompt: SENTINEL });
    sessions.corrupt(SENTINEL);
    const runs = [await measure(repo, sessions, ["baseline"])];
    tidyUp(repo, [1, 2]);
    sessionsAfter(sessions, [1, 2]);
    sessions.featureTasks(1, { start: "2024-02-01T09:00:00Z", tasks: 2, helper: "src/f1/h1.ts", rereads: false, tokens: 100, prompt: SENTINEL });
    runs.push(await measure(repo, sessions, ["compare"]));
    // The terminal table, not only the JSON.
    const table = await runLocality(repo.path, ["measure", "compare", "--projects-dir", sessions.directory]);
    for (const { run } of runs) expect(run.code).toBe(ExitCode.Success);
    const everything = [
      ...runs.flatMap(({ run }) => [run.stdout, run.stderr]),
      table.stdout,
      table.stderr,
      ...filesUnder(join(repo.path, ".code-health")).map((file) => readFileSync(file, "utf8")),
      ...filesUnder(join(repo.path, ".cache")).map((file) => readFileSync(file, "utf8")),
    ];
    for (const text of everything) expect(text).not.toContain(SENTINEL);
    expect(filesUnder(join(repo.path, ".code-health")).some((file) => readFileSync(file, "utf8").includes("tasks"))).toBe(true);
  }, 90_000);
});

test("measure needs a subcommand", async () => {
  const { repo, sessions } = fresh();
  const { run } = await measure(repo, sessions, []);
  expect(run.code).toBe(ExitCode.Usage);
}, 60_000);
