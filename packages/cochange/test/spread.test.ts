import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { reportPath } from "../src/reports.ts";
import { expectGolden } from "./support/golden.ts";
import { runCochange } from "./support/run.ts";
import { spreadHistory } from "./support/spread-scenario.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = spreadHistory();
});
afterAll(() => repo.dispose());
beforeEach(() => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
  writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"maxChangesetSize":4}}\n');
  repo.git("checkout", "--quiet", "--", ".");
});

const spread = (...args: string[]) => runCochange(repo.path, ["spread", ...args]);
const json = async (...args: string[]) => {
  const { code, stdout, stderr } = await spread(...args);
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  return JSON.parse(stdout);
};

interface Row {
  bucket: string;
  [key: string]: unknown;
}
const bucket = (document: { results: { buckets: Row[] } }, label: string): Row => {
  const row = document.results.buckets.find((b) => b.bucket === label);
  if (!row) throw new Error(`no bucket ${label}`);
  return row;
};

test("monthly distribution of the scenario, byte for byte", async () => {
  const { stdout } = await spread();
  expectGolden("spread", "spread", stdout);
});

test("weekly distribution of the scenario, byte for byte", async () => {
  const { stdout } = await spread("--bucket", "week");
  expectGolden("spread", "spread.week", stdout);
});

test("the distribution of a bucket is over the mean pairwise distance of each change", async () => {
  const document = await json();
  expect(bucket(document, "2024-01")).toMatchObject({
    logicalChanges: 2,
    measured: 2,
    singleFile: 1,
    mean: 1.333333,
    median: 1.333333,
    p75: 2,
    p90: 2.4,
    max: 2.666667,
  });
  expect(bucket(document, "2024-02")).toMatchObject({ measured: 1, median: 2, p75: 2, p90: 2, max: 2 });
  expect(bucket(document, "2024-05")).toMatchObject({ measured: 1, median: 2, singleFile: 0 });
});

test("a file is placed at its path as of the change, so a later move does not rewrite earlier spread", async () => {
  const document = await json();
  // February: the summary was in src/reports, two from the invoice. It moved beside the invoice on 2024-02-20.
  expect(bucket(document, "2024-02").max).toBe(2);
  // April: the same two files are now siblings.
  expect(bucket(document, "2024-04")).toMatchObject({ measured: 1, max: 0, median: 0 });
});

test("commits with a Code-Health trailer are left out and counted", async () => {
  const document = await json();
  // The trailer commit would have measured 2 (the moved summary against the invoice) in February.
  expect(bucket(document, "2024-02")).toMatchObject({ logicalChanges: 1, measured: 1, excludedByTrailer: 1 });
  expect(document.results.overall.excludedByTrailer).toBe(1);
});

test("changes over the maximum changeset size are counted, with their share, and not measured", async () => {
  const document = await json();
  expect(bucket(document, "2024-04")).toMatchObject({ logicalChanges: 2, measured: 1, oversized: 1, oversizedShare: 0.5 });
  expect(document.results.overall).toMatchObject({ logicalChanges: 6, measured: 5, oversized: 1 });
  expect(document.results.overall.oversizedShare).toBeCloseTo(1 / 6, 6);
});

test("the overall distribution is over every measured change in the window", async () => {
  const { overall } = (await json()).results;
  // spreads: 8/3, 0, 2, 0, 2. The README is at the root, two folders from src/billing.
  expect(overall).toMatchObject({ measured: 5, singleFile: 1, median: 2, p75: 2, p90: 2.4, max: 2.666667, mean: 1.333333 });
});

test("empty buckets between the first change and the end of the window are listed with no distribution", async () => {
  const document = await json();
  expect(document.results.buckets.map((b: Row) => b.bucket)).toEqual([
    "2024-01",
    "2024-02",
    "2024-03",
    "2024-04",
    "2024-05",
  ]);
  expect(bucket(document, "2024-03")).toMatchObject({
    logicalChanges: 0,
    measured: 0,
    oversizedShare: null,
    mean: null,
    median: null,
    p75: null,
    p90: null,
    max: null,
  });
});

test("weeks start on Monday and are labelled by that date", async () => {
  const document = await json("--bucket", "week");
  const labels = document.results.buckets.map((b: Row) => b.bucket);
  expect(labels[0]).toBe("2024-01-08");
  expect(labels).toContain("2024-01-15");
  expect(labels.at(-1)).toBe("2024-05-20");
  expect(bucket(document, "2024-01-08")).toMatchObject({ measured: 1, max: 2.666667 });
  // 2024-04-01 week holds the April 2 change and the April 3 oversized one.
  expect(bucket(document, "2024-04-01")).toMatchObject({ logicalChanges: 2, oversized: 1 });
  expect(bucket(document, "2024-03-04")).toMatchObject({ logicalChanges: 0 });
});

test("--since is inclusive and --until exclusive, both from the committer date, and either makes the window stated", async () => {
  const document = await json("--since", "2024-02-12", "--until", "2024-05-20");
  expect(document.window).toEqual({ since: "2024-02-12T00:00:00.000Z", until: "2024-05-20T00:00:00.000Z" });
  expect(document.results.overall).toMatchObject({ logicalChanges: 3, measured: 2, excludedByTrailer: 1 });
  expect(document.results.buckets.map((b: Row) => b.bucket)).toEqual([
    "2024-02",
    "2024-03",
    "2024-04",
    "2024-05", // the window ends on 2024-05-20 00:00, so May 1 to 19 is in it, with nothing in them
  ]);
  expect(bucket(document, "2024-05")).toMatchObject({ logicalChanges: 0, measured: 0, median: null });
});

test("--until alone looks back the configured window from that date, not from the head", async () => {
  const document = await json("--until", "2024-02-01");
  expect(document.window.since).toBe("2023-02-01T00:00:00.000Z");
  expect(document.results.overall).toMatchObject({ logicalChanges: 2, measured: 2 });
});

test("a window with no changes has no buckets and says so with its sample size", async () => {
  const document = await json("--since", "2025-01-01");
  expect(document.results.buckets).toEqual([]);
  expect(document.results.overall).toMatchObject({ logicalChanges: 0, measured: 0, median: null });
});

test("the window default is anchored to the head commit, not the wall clock", async () => {
  const document = await json();
  expect(document.window).toEqual({ since: "2023-05-20T09:00:00.000Z", until: "2024-05-20T09:00:00.000Z" });
});

test("--bucket must be week or month", async () => {
  const { code, stderr } = await spread("--bucket", "year");
  expect(code).toBe(ExitCode.Usage);
  expect(stderr).toContain("--bucket");
});

test("unparseable dates, and a window that ends before it starts, are usage errors", async () => {
  expect((await spread("--since", "last week")).code).toBe(ExitCode.Usage);
  expect((await spread("--until", "2024-02-30")).code).toBe(ExitCode.Usage);
  expect((await spread("--since", "2024-03-01", "--until", "2024-03-01")).code).toBe(ExitCode.Usage);
});

test("output is byte identical between runs apart from meta", async () => {
  const strip = (stdout: string) => {
    const { meta: _meta, ...rest } = JSON.parse(stdout);
    return JSON.stringify(rest);
  };
  expect(strip((await spread()).stdout)).toBe(strip((await spread()).stdout));
});

test("the default run is stored as a report, a bounded or re-bucketed run is not", async () => {
  await spread("--since", "2024-01-01");
  expect(existsSync(reportPath(repo.path, "spread"))).toBe(false);
  await spread("--bucket", "week");
  expect(existsSync(reportPath(repo.path, "spread"))).toBe(false);
  await spread();
  expect(existsSync(reportPath(repo.path, "spread"))).toBe(true);
});

test("a change dated after the head commit is outside the window, so overall and the buckets agree", async () => {
  const { GitFixture } = await import("@code-health/fixtures/git-fixture");
  const skewed = GitFixture.build([
    {
      type: "commit",
      message: "Rebased commit with a later committer date",
      date: "2024-01-10T09:00:00Z",
      committerDate: "2024-05-10T09:00:00Z",
      changes: [{ op: "add", path: "src/a.ts", content: "a(1);\n" }, { op: "add", path: "docs/b.md", content: "b\n" }],
    },
    {
      type: "commit",
      message: "Head",
      date: "2024-03-19T09:00:00Z",
      committerDate: "2024-03-20T09:00:00Z",
      changes: [{ op: "modify", path: "src/a.ts", content: "a(2);\n" }, { op: "modify", path: "docs/b.md", content: "b2\n" }],
    },
  ]);
  try {
    const { stdout } = await runCochange(skewed.path, ["spread"]);
    const { results, window } = JSON.parse(stdout);
    expect(window.until).toBe("2024-03-20T09:00:00.000Z");
    expect(results.overall.logicalChanges).toBe(results.buckets.reduce((sum: number, b: Row) => sum + (b.logicalChanges as number), 0));
    expect(results.overall.logicalChanges).toBe(1);
  } finally {
    skewed.dispose();
  }
});
