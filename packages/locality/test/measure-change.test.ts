import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture, type Change, type Step } from "@code-health/fixtures/git-fixture";
import { changeDistance, type RevisionEdge } from "../src/change-distance.ts";
import { expectGolden } from "./support/golden.ts";
import { runLocality } from "./support/run.ts";

const edge = (from: string, to: string, weight: number, counted = true): RevisionEdge => ({ from, to, weight, counted });

describe("changeDistance", () => {
  test("splits the difference between two revisions into edges added, removed, moved, reweighted and switched by reachability", () => {
    const before = [
      edge("src/a/one.ts", "src/shared/utils/h.ts", 2), // distance 3: h moves beside its consumer
      edge("src/a/two.ts", "src/b/x.ts", 1), // distance 2: used three times afterwards
      edge("src/a/two.ts", "src/c/gone.ts", 4), // distance 2: removed
      edge("src/dead/d.ts", "src/b/x.ts", 5, false), // not counted: its importer becomes reachable
    ];
    const after = [
      edge("src/a/one.ts", "src/a/h.ts", 2),
      edge("src/a/two.ts", "src/b/x.ts", 3),
      edge("src/a/two.ts", "src/b/deep/new.ts", 2), // distance 3: added
      edge("src/dead/d.ts", "src/b/x.ts", 5),
    ];
    const result = changeDistance(before, after, new Map([["src/shared/utils/h.ts", "src/a/h.ts"]]));

    expect(result.before).toEqual({ totalUseDistance: 16, edges: 3, uses: 7, meanDistancePerUse: 16 / 7 });
    expect(result.after).toMatchObject({ totalUseDistance: 22, edges: 4, uses: 12 });
    expect(result.delta).toBe(6);
    expect(result.parts).toEqual({
      added: { edges: 1, uses: 2, distance: 6, meanDistancePerUse: 3, ratioToCodebaseMean: 3 / (16 / 7) },
      removed: { edges: 1, uses: 4, distance: 8, meanDistancePerUse: 2 },
      moved: { edges: 1, distance: -6 },
      reweighted: { edges: 1, uses: 2, distance: 4 },
      reachability: { edges: 1, distance: 10 },
    });
    const { added, removed, moved, reweighted, reachability } = result.parts;
    expect(added.distance - removed.distance + moved.distance + reweighted.distance + reachability.distance).toBe(result.delta);
    expect(result.edges.map((row) => [row.kind, row.to, row.change])).toEqual([
      ["reachability", "src/b/x.ts", 10],
      ["removed", "src/c/gone.ts", -8],
      ["moved", "src/a/h.ts", -6],
      ["added", "src/b/deep/new.ts", 6],
      ["reweighted", "src/b/x.ts", 4],
    ]);
  });

  test("without the rename, a moved file is edges removed and added, and the difference is the same", () => {
    const before = [edge("src/a/one.ts", "src/shared/utils/h.ts", 2)];
    const after = [edge("src/a/one.ts", "src/a/h.ts", 2)];
    const result = changeDistance(before, after, new Map());
    expect(result.delta).toBe(-6);
    expect(result.parts.removed).toMatchObject({ edges: 1, distance: 6 });
    expect(result.parts.added).toMatchObject({ edges: 1, distance: 0, meanDistancePerUse: 0 });
    expect(result.parts.moved).toEqual({ edges: 0, distance: 0 });
  });

  test("an edge that changes both its distance and its use count is split between moved and reweighted", () => {
    const result = changeDistance([edge("src/a/one.ts", "src/b/c/h.ts", 2)], [edge("src/a/one.ts", "src/a/h.ts", 5)], new Map([["src/b/c/h.ts", "src/a/h.ts"]]));
    expect(result.parts.moved).toEqual({ edges: 1, distance: -6 });
    expect(result.parts.reweighted).toEqual({ edges: 1, uses: 3, distance: 0 });
    expect(result.edges).toEqual([
      { from: "src/a/one.ts", to: "src/a/h.ts", kind: "moved", before: { weight: 2, distance: 3 }, after: { weight: 5, distance: 0 }, change: -6 },
    ]);
  });

  test("two revisions with no edges give null means and nothing to list", () => {
    const result = changeDistance([], [], new Map());
    expect(result).toMatchObject({ delta: 0, edges: [], before: { meanDistancePerUse: null }, parts: { added: { meanDistancePerUse: null, ratioToCodebaseMean: null } } });
  });
});

const add = (path: string, content: string): Change => ({ op: "add", path, content });
const modify = (path: string, content: string): Change => ({ op: "modify", path, content });
const money = "export const format = (amount: number) => `${amount.toFixed(2)}`;\nexport const round = (amount: number) => Math.round(amount);\n";
const invoice = (from: string) => `import { format, round } from "${from}";\nexport const invoice = (amount: number) => format(round(amount));\n`;

/** An app whose billing code uses a helper in src/shared/utils, and a branch that moves the helper beside it and adds two imports in orders. */
function shop(locality: Record<string, unknown> = {}): GitFixture {
  const steps: Step[] = [
    {
      type: "commit",
      message: "Add the shop",
      date: "2024-01-02T09:00:00Z",
      changes: [
        add("code-health.json", JSON.stringify({ entryPoints: ["src/main.ts"], locality })),
        add("src/main.ts", 'import { invoice } from "./billing/invoice.ts";\nimport { place } from "./orders/place.ts";\nexport const run = () => [invoice(1), place(2)];\n'),
        add("src/billing/invoice.ts", invoice("../shared/utils/money.ts")),
        add("src/shared/utils/money.ts", money),
        add("src/orders/place.ts", "export const place = (amount: number) => amount;\n"),
      ],
    },
    { type: "branch", name: "feature" },
    {
      type: "commit",
      message: "Move money beside billing",
      date: "2024-01-03T09:00:00Z",
      changes: [{ op: "rename", from: "src/shared/utils/money.ts", path: "src/billing/money.ts" }, modify("src/billing/invoice.ts", invoice("./money.ts"))],
    },
    {
      type: "commit",
      message: "Tax orders",
      date: "2024-01-04T09:00:00Z",
      changes: [
        add("src/orders/tax.ts", "export const tax = (amount: number) => amount * 0.2;\n"),
        modify(
          "src/orders/place.ts",
          'import { format } from "../billing/money.ts";\nimport { tax } from "./tax.ts";\nexport const place = (amount: number) => format(amount + tax(amount));\n',
        ),
      ],
    },
  ];
  return GitFixture.build(steps);
}

describe("measure change", () => {
  let repo: GitFixture;
  const change = async (...args: string[]) => {
    const run = await runLocality(repo.path, ["measure", "change", ...args, "--json"]);
    return { run, results: run.code === ExitCode.Success ? JSON.parse(run.stdout).results : null };
  };
  beforeAll(() => {
    repo = shop();
  });
  afterAll(() => repo.dispose());

  test("with no range, measures the branch against its merge base with the main branch", async () => {
    const { run, results } = await change();
    expect(run.stderr).toBe("");
    expect(results).toMatchObject({ status: "change", against: "main", base: repo.git("rev-parse", "main"), head: repo.git("rev-parse", "feature"), renamedFiles: 1 });
    expect(results.delta).toBe(results.after.totalUseDistance - results.before.totalUseDistance);
    const { added, removed, moved, reweighted, reachability } = results.parts;
    expect(added.distance - removed.distance + moved.distance + reweighted.distance + reachability.distance).toBe(results.delta);
    expectGolden("measure", "measure.change", run.stdout);
  });

  test("a moved file keeps its edge, and the distance it lost is the moved part", async () => {
    const { results } = await change("main..feature~1");
    expect(results.parts).toMatchObject({ added: { edges: 0 }, removed: { edges: 0 }, moved: { edges: 1 } });
    expect(results.parts.moved.distance).toBeLessThan(0);
    expect(results.delta).toBe(results.parts.moved.distance);
    expect(results.edges).toEqual([
      expect.objectContaining({ from: "src/billing/invoice.ts", to: "src/billing/money.ts", kind: "moved", before: expect.objectContaining({ distance: 3 }), after: expect.objectContaining({ distance: 0 }) }),
    ]);
  });

  test("new imports are the added part, with their mean distance per use set against the codebase's", async () => {
    const { results } = await change("feature~1..feature");
    expect(results.parts.added).toMatchObject({ edges: 2 });
    expect(results.edges.map((row: { kind: string; to: string; after: { distance: number } }) => [row.kind, row.to, row.after.distance])).toEqual([
      ["added", "src/billing/money.ts", 2],
      ["added", "src/orders/tax.ts", 0],
    ]);
    expect(results.parts.added.meanDistancePerUse).toBe(results.parts.added.distance / results.parts.added.uses);
    expect(results.parts.added.ratioToCodebaseMean).toBeCloseTo(results.parts.added.meanDistancePerUse / results.before.meanDistancePerUse, 5);
  });

  test("--edges limits the edges listed and counts the rest", async () => {
    const { results } = await change("--edges", "1");
    expect(results.edges).toHaveLength(1);
    expect(results.edgesOmitted).toBe(2);
    expect((await change("--edges", "all")).results.edgesOmitted).toBe(0);
    expect((await change("--edges", "none")).run.code).toBe(ExitCode.Usage);
  });

  test("on the main branch with no range, measures the last commit against its first parent", async () => {
    repo.git("checkout", "--quiet", "main");
    repo.git("merge", "--quiet", "--ff-only", "feature");
    const { results } = await change();
    expect(results).toMatchObject({ against: "the first parent of HEAD", base: repo.git("rev-parse", "HEAD~1"), head: repo.git("rev-parse", "HEAD") });
    expect(results.parts.added.edges).toBe(2);
  });

  test("refuses a range that is no change, a ref that is no commit, and a second argument", async () => {
    for (const [args, message] of [
      [["HEAD"], /contains "HEAD", so there is no change/],
      [["nowhere"], /"nowhere" is not a commit/],
      [["HEAD~1", "HEAD"], /usage: measure change \[BASE\[\.\.HEAD\]\]/],
    ] as const) {
      const { run } = await change(...args);
      expect(run.code).toBe(ExitCode.Usage);
      expect(JSON.parse(run.stderr).error.message).toMatch(message);
    }
  });
});

describe("measure change, when distance falls by burying a file", () => {
  let repo: GitFixture;
  beforeAll(() => {
    repo = shop({ useHistory: false });
    repo.apply([
      { type: "checkout", name: "main" },
      { type: "branch", name: "bury" },
      {
        type: "commit",
        message: "Bury money under billing",
        date: "2024-01-05T09:00:00Z",
        changes: [{ op: "rename", from: "src/shared/utils/money.ts", path: "src/billing/impl/core/money.ts" }, modify("src/billing/invoice.ts", invoice("./impl/core/money.ts"))],
      },
    ]);
  });
  afterAll(() => repo.dispose());

  test("the gaming check says the tree got deeper while the distance fell", async () => {
    const run = await runLocality(repo.path, ["measure", "change", "--json"]);
    const { results } = JSON.parse(run.stdout);
    expect(results.delta).toBeLessThan(0);
    expect(results.structure.gaming.flagged).toBe(true);
    expect(results.structure.gaming.reasons.join(" ")).toMatch(/maximum folder depth rose from 3 to 4/);
    expect(results.structure).toMatchObject({ before: { maxDepth: 3 }, after: { maxDepth: 4 } });
  });

  test("with history off, the later revision's total is the one analyse reports", async () => {
    const { results } = JSON.parse((await runLocality(repo.path, ["measure", "change", "--json"])).stdout);
    const analysed = JSON.parse((await runLocality(repo.path, ["analyse", "--json"])).stdout);
    expect(results.after.totalUseDistance).toBe(analysed.metrics.totalWeightedDistance);
    expect(results.structure.after).toEqual({ singleFileFolders: analysed.metrics.singleFileFolders, maxDepth: analysed.metrics.maxDepth });
  });
});
