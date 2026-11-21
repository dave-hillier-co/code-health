import { afterEach, expect, test, vi } from "vitest";
import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { DEFAULT_ISSUE_PATTERN, groupCommits, mergeFileChanges, type Groupable } from "../src/grouping.ts";
import { filterHistory, InvalidPatternError, type NoiseOptions } from "../src/noise.ts";
import { readHistory, type HistoryChange } from "../src/read.ts";
import { refresh } from "../src/refresh.ts";

vi.setConfig({ testTimeout: 180_000 });

const compile = (pattern: string) => new RegExp(pattern);
const at = (message: string, author: string, hour: number): Groupable => ({ message, author, date: hour * 3600 });

test("with grouping off every commit is a group of its own", () => {
  expect(groupCommits([at("a", "x", 0), at("b", "x", 0)], { mode: "off" }, compile)).toEqual([[0], [1]]);
});

test("commits sharing an issue key form one group, placed where its last commit is", () => {
  const items = [at("ABC-1 start", "x", 0), at("XYZ-9 other", "y", 1), at("ABC-1 more", "x", 2), at("no key", "x", 3)];
  const groups = groupCommits(items, { mode: "issue-key", pattern: DEFAULT_ISSUE_PATTERN }, compile);
  expect(groups).toEqual([[1], [0, 2], [3]]);
});

test("the issue key is the first capture group when the pattern has one", () => {
  const items = [at("[web] fix #12", "x", 0), at("[api] fix #12 again", "y", 1), at("fix #13", "x", 2)];
  expect(groupCommits(items, { mode: "issue-key", pattern: "#(\\d+)" }, compile)).toEqual([[0, 1], [2]]);
});

test("a commit with several keys takes the first one", () => {
  const items = [at("ABC-1 and ABC-2", "x", 0), at("ABC-2", "x", 1)];
  expect(groupCommits(items, { mode: "issue-key", pattern: DEFAULT_ISSUE_PATTERN }, compile)).toEqual([[0], [1]]);
});

test("an author's commits form one group while each follows the last within the window", () => {
  const items = [at("a", "x", 0), at("b", "y", 1), at("c", "x", 2), at("d", "x", 5), at("e", "x", 12)];
  const groups = groupCommits(items, { mode: "author-window", windowSeconds: 3 * 3600 }, compile);
  // x: 0, 2, 5 chain (gaps 2 and 3 hours), 12 is 7 hours later and starts a new group.
  expect(groups).toEqual([[1], [0, 2, 3], [4]]);
});

test("merged file changes add line counts and keep the final path, status and blob", () => {
  const change = (over: Partial<HistoryChange>): HistoryChange => ({
    path: "a.ts", oldPath: null, status: "M", similarity: null, added: 1, deleted: 0, binary: false, blob: "b1", fileId: "a.ts", ...over,
  });
  const merged = mergeFileChanges([
    change({ status: "A", added: 10, blob: "b1" }),
    change({ path: "b.ts", oldPath: "a.ts", status: "R", similarity: 90, added: 2, deleted: 1, blob: "b2", fileId: "a.ts" }),
  ]);
  expect(merged).toMatchObject({ path: "b.ts", status: "A", oldPath: null, added: 12, deleted: 1, blob: "b2" });
  expect(mergeFileChanges([change({ added: null, deleted: null, binary: true }), change({ added: null, deleted: null })])).toMatchObject({ added: null, deleted: null, binary: true });
});

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
});

const alice: Identity = { name: "Alice", email: "alice@example.com" };
const bob: Identity = { name: "Bob", email: "bob@example.com" };
const file = (path: string, content: string): Change => ({ op: "add", path, content });
const edit = (path: string, content: string): Change => ({ op: "modify", path, content });
const step = (message: string, date: string, author: Identity, changes: Change[]): Step => ({ type: "commit", message, date, author, changes });

async function grouped(steps: Step[], options: NoiseOptions) {
  const repo = GitFixture.build(steps);
  fixtures.push(repo);
  await refresh(repo.path);
  return filterHistory(repo.path, await readHistory(repo.path), options);
}

const feature: Step[] = [
  step("ABC-1 model", "2024-03-01T09:00:00Z", alice, [file("src/model.ts", "a\nb\nc\n")]),
  step("DEF-2 unrelated", "2024-03-01T10:00:00Z", bob, [file("lib/other.ts", "x\n")]),
  step("ABC-1 view", "2024-03-02T09:00:00Z", alice, [file("ui/view.ts", "v\n"), edit("src/model.ts", "a\nb\nc\nd\n")]),
];

test("grouping by issue key merges commits into one logical change with the union of their files", async () => {
  const result = await grouped(feature, { grouping: { mode: "issue-key", pattern: DEFAULT_ISSUE_PATTERN } });
  expect(result.changes).toHaveLength(2);
  const abc = result.changes.find((c) => c.files.some((f) => f.path === "ui/view.ts"))!;
  expect(abc.shas).toHaveLength(2);
  expect(abc.files.map((f) => f.path).sort()).toEqual(["src/model.ts", "ui/view.ts"]);
  // The model file was created and then edited: one addition, with both commits' lines.
  expect(abc.files.find((f) => f.path === "src/model.ts")).toMatchObject({ status: "A", added: 4, deleted: 0 });
  expect(abc.committerDate).toBe(Date.parse("2024-03-02T09:00:00Z") / 1000);
  expect(result.filtersApplied.grouping).toEqual({ mode: "issue-key", issuePattern: DEFAULT_ISSUE_PATTERN, windowSeconds: 90 * 86400, mergedCommits: 1 });
});

test("oversized is judged on the merged change, so a split bulk edit is still bulk", async () => {
  const half = (from: number) => Array.from({ length: 3 }, (_, i) => file(`bulk/f${from + i}.ts`, "x\n"));
  const steps = [step("BULK-1 part one", "2024-03-01T09:00:00Z", alice, half(0)), step("BULK-1 part two", "2024-03-01T09:30:00Z", alice, half(3))];
  expect((await grouped(steps, { maxChangesetSize: 4 })).changes.map((c) => c.oversized)).toEqual([false, false]);
  expect((await grouped(steps, { maxChangesetSize: 4, grouping: { mode: "issue-key", pattern: DEFAULT_ISSUE_PATTERN } })).changes.map((c) => c.oversized)).toEqual([true]);
});

test("grouping by author window merges a burst and leaves the other author's commit apart", async () => {
  const result = await grouped(
    [
      step("one", "2024-03-01T09:00:00Z", alice, [file("a.ts", "1\n")]),
      step("two", "2024-03-01T09:40:00Z", bob, [file("b.ts", "1\n")]),
      step("three", "2024-03-01T10:20:00Z", alice, [file("c.ts", "1\n")]),
      step("four", "2024-03-03T10:20:00Z", alice, [file("d.ts", "1\n")]),
    ],
    { grouping: { mode: "author-window", windowSeconds: 3600 * 2 } },
  );
  expect(result.changes.map((c) => c.files.map((f) => f.path).sort())).toEqual([["b.ts"], ["a.ts", "c.ts"], ["d.ts"]]);
  expect(result.filtersApplied.grouping).toMatchObject({ mode: "author-window", issuePattern: null, windowSeconds: 7200, mergedCommits: 1 });
});

test("with grouping off the report says so and nothing merges", async () => {
  const result = await grouped(feature, {});
  expect(result.changes).toHaveLength(3);
  expect(result.filtersApplied.grouping).toEqual({ mode: "off", issuePattern: null, windowSeconds: null, mergedCommits: 0 });
});

test("an invalid issue pattern is a pattern error", async () => {
  await expect(grouped(feature, { grouping: { mode: "issue-key", pattern: "(" } })).rejects.toBeInstanceOf(InvalidPatternError);
});
