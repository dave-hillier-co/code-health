import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { outcomeRepository } from "./support/outcome-scenarios.ts";
import { runStructure } from "./support/run.ts";

let repo: GitFixture;
let breakSha: string;
beforeAll(() => {
  repo = outcomeRepository();
  breakSha = repo.git("log", "--format=%H", "--grep=Publish events").trim();
});
afterAll(() => repo.dispose());

interface Side {
  quadrant: string;
  staticCoupling: { sites: number; high: boolean };
  coChange: { shared: number; fromChanges: number; toChanges: number; high: boolean };
  bothActive: boolean;
}
interface Outcome {
  id: string;
  verdict: string;
  before: Side;
  after: Side;
  window: { before: { since: string; until: string }; after: { since: string; until: string } };
}
interface Document {
  results: Outcome[];
  hiddenCreated: { id: string; sitesBefore: number; sitesAfter: number; sharedBefore: number; sharedAfter: number }[];
}

async function outcome(...args: string[]) {
  const run = await runStructure(repo.path, ["outcome", "--json", "--at", breakSha, ...args]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return { stdout: run.stdout, document: JSON.parse(run.stdout) as Document };
}

describe("structure outcome", () => {
  test("a break that removed the import but kept the co-change is hidden, not broken", async () => {
    const { document, stdout } = await outcome("src/p->src/q");
    const [row] = document.results;
    expect(row).toMatchObject({
      id: "outcome:folder:src/p->src/q",
      verdict: "hidden-not-broken",
      before: { quadrant: "real", staticCoupling: { sites: 3, high: true }, coChange: { shared: 7, high: true } },
      after: { quadrant: "hidden", staticCoupling: { sites: 0, high: false }, coChange: { shared: 6, high: true } },
    });
    expectGolden("outcome", "outcome.hidden", stdout);
  });

  test("a break that removed the import and the co-change is broken", async () => {
    const { document } = await outcome("src/r->src/s");
    expect(document.results[0]).toMatchObject({
      verdict: "broken",
      before: { coChange: { high: true } },
      after: { staticCoupling: { sites: 0 }, coChange: { shared: 0, high: false }, bothActive: true },
    });
  });

  test("a pair that did not co-change before has nothing to reduce", async () => {
    const { document } = await outcome("src/v->src/w");
    expect(document.results[0]!.verdict).toBe("no-baseline");
  });

  test("both windows have the same length and stop at the break", async () => {
    const { document } = await outcome("src/p->src/q");
    const { before, after } = document.results[0]!.window;
    expect(Date.parse(before.until) - Date.parse(before.since)).toBe(Date.parse(after.until) - Date.parse(after.since));
    expect(before.until).toBe("2024-03-01T09:00:00.000Z");
    expect(after.since).toBe("2024-03-01T09:00:00.000Z");
  });

  test("lists the pairs that dropped their import and kept their co-change, across the repository", async () => {
    const { document } = await outcome("src/r->src/s");
    expect(document.hiddenCreated).toMatchObject([
      { id: "coupling:folder:src/p->src/q", sitesBefore: 3, sitesAfter: 0, sharedBefore: 7, sharedAfter: 6 },
    ]);
  });

  test("the break must be named, and have a parent", async () => {
    const none = await runStructure(repo.path, ["outcome", "src/p->src/q"]);
    expect(none.code).toBe(ExitCode.Usage);
    expect(none.stderr).toContain("--at");
    const first = repo.git("rev-list", "--max-parents=0", "HEAD").trim();
    const root = await runStructure(repo.path, ["outcome", "--at", first, "src/p->src/q"]);
    expect(root.code).toBe(ExitCode.Usage);
    expect(root.stderr).toContain("parent");
  });

  test("a module that is not in the analysed commit is a usage error", async () => {
    const run = await runStructure(repo.path, ["outcome", "--at", breakSha, "src/p->src/nowhere"]);
    expect(run.code).toBe(ExitCode.Usage);
  });
});
