import { afterEach, expect, test, vi } from "vitest";
import { GitFixture, type Step } from "@code-health/fixtures/git-fixture";
import { NoCacheError, readHistory } from "../src/read.ts";
import { refresh } from "../src/refresh.ts";

// Fixture repos run real processes many times, which is slow on a loaded machine.
vi.setConfig({ testTimeout: 180_000 });

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
});

function build(steps: Step[]) {
  const f = GitFixture.build(steps);
  fixtures.push(f);
  return f;
}

function add(message: string, day: number, path: string, content = "1\n"): Step {
  return {
    type: "commit",
    message,
    date: `2024-02-${String(day).padStart(2, "0")}T10:00:00Z`,
    changes: [{ op: "add", path, content }],
  };
}

const messages = async (path: string, options: Parameters<typeof readHistory>[1] = {}) =>
  (await readHistory(path, options)).commits.map((c) => c.message);

test("reading before any refresh asks for a refresh", async () => {
  const repo = build([add("one", 1, "a")]);
  await expect(readHistory(repo.path)).rejects.toBeInstanceOf(NoCacheError);
});

test("queries select by reachability from the ref, so a branch switch needs no rebuild", async () => {
  const repo = build([
    add("base", 1, "a"),
    { type: "branch", name: "feature" },
    add("feat-1", 2, "f1"),
    add("feat-2", 3, "f2"),
    { type: "checkout", name: "main" },
    add("main-1", 4, "m1"),
  ]);
  await refresh(repo.path, { ref: "main" });
  await refresh(repo.path, { ref: "feature" });
  expect(await messages(repo.path, { ref: "main" })).toEqual(["base", "main-1"]);
  expect(await messages(repo.path, { ref: "feature" })).toEqual(["base", "feat-1", "feat-2"]);
  expect(await messages(repo.path, { ref: "main" })).toEqual(["base", "main-1"]);
});

test("after a history rewrite, orphaned commits are stored but not selected", async () => {
  const repo = build([add("one", 1, "a"), add("two", 2, "b"), add("three", 3, "c")]);
  await refresh(repo.path);
  repo.git("reset", "--quiet", "--hard", "HEAD~1");
  repo.apply([add("three-b", 5, "d")]);
  await refresh(repo.path);
  expect(await messages(repo.path)).toEqual(["one", "two", "three-b"]);
});

test("parents come before children even when committer dates disagree", async () => {
  const repo = build([
    add("parent", 10, "a"),
    {
      type: "commit",
      message: "child with an earlier date",
      date: "2024-02-01T10:00:00Z",
      changes: [{ op: "add", path: "b", content: "1\n" }],
    },
  ]);
  await refresh(repo.path);
  expect(await messages(repo.path)).toEqual(["parent", "child with an earlier date"]);
});

const mergeSteps: Step[] = [
  add("base", 1, "a"),
  { type: "branch", name: "feature" },
  add("feat-1", 2, "f1"),
  { type: "checkout", name: "main" },
  add("main-1", 3, "m1"),
  { type: "merge", branch: "feature", message: "merge feature", date: "2024-02-04T10:00:00Z" },
  add("after", 5, "z"),
];

test("merge commits are never revisions, and all branches count without first-parent", async () => {
  const repo = build(mergeSteps);
  await refresh(repo.path);
  expect(await messages(repo.path)).toEqual(["base", "feat-1", "main-1", "after"]);
});

test("first-parent mode follows only the mainline", async () => {
  const repo = build(mergeSteps);
  await refresh(repo.path);
  expect(await messages(repo.path, { firstParent: true })).toEqual(["base", "main-1", "after"]);
});

test("the view is anchored to the head commit's committer date", async () => {
  const repo = build([add("one", 1, "a"), add("two", 9, "b")]);
  await refresh(repo.path);
  const view = await readHistory(repo.path);
  expect(view.headDate).toBe(Date.parse("2024-02-09T10:00:00Z") / 1000);
  expect(view.headSha).toBe(repo.git("rev-parse", "HEAD"));
});

const body = "a\nb\nc\nd\ne\nf\ng\nh\n";

test("renames give moved files a stable identity", async () => {
  const repo = build([
    add("create", 1, "src/old.ts", body),
    { type: "commit", message: "edit", date: "2024-02-02T00:00:00Z", changes: [{ op: "modify", path: "src/old.ts", content: body + "i\n" }] },
    { type: "commit", message: "move", date: "2024-02-03T00:00:00Z", changes: [{ op: "rename", from: "src/old.ts", path: "lib/mid.ts" }] },
    { type: "commit", message: "edit again", date: "2024-02-04T00:00:00Z", changes: [{ op: "modify", path: "lib/mid.ts", content: body + "j\n" }] },
    { type: "commit", message: "move again", date: "2024-02-05T00:00:00Z", changes: [{ op: "rename", from: "lib/mid.ts", path: "lib/new.ts" }] },
  ]);
  await refresh(repo.path);
  const view = await readHistory(repo.path);
  const ids = view.commits.flatMap((c) => c.changes.map((ch) => ch.fileId));
  expect(new Set(ids)).toEqual(new Set(["lib/new.ts"]));
  // the path as of each change is kept for spread and distance calculations
  expect(view.commits.map((c) => c.changes[0]!.path)).toEqual(["src/old.ts", "src/old.ts", "lib/mid.ts", "lib/mid.ts", "lib/new.ts"]);
});

test("reusing a path after a rename starts a new identity", async () => {
  const repo = build([
    add("create a", 1, "a.ts", body),
    { type: "commit", message: "move a to b", date: "2024-02-02T00:00:00Z", changes: [{ op: "rename", from: "a.ts", path: "b.ts" }] },
    add("new a", 3, "a.ts", "completely different\ncontent\nhere\n"),
  ]);
  await refresh(repo.path);
  const view = await readHistory(repo.path);
  expect(view.commits.map((c) => c.changes[0]!.fileId)).toEqual(["b.ts", "b.ts", "a.ts"]);
});

test("a deleted file and a later file reusing its path are different identities once the new one is renamed", async () => {
  const repo = build([
    add("add p", 1, "p.txt", "one\n"),
    { type: "commit", message: "modify p", date: "2024-02-02T00:00:00Z", changes: [{ op: "modify", path: "p.txt", content: "two\n" }] },
    { type: "commit", message: "delete p", date: "2024-02-03T00:00:00Z", changes: [{ op: "delete", path: "p.txt" }] },
    add("add other p", 4, "p.txt", "completely different\n"),
    { type: "commit", message: "move p to q", date: "2024-02-05T00:00:00Z", changes: [{ op: "rename", from: "p.txt", path: "q.txt" }] },
  ]);
  await refresh(repo.path);
  const view = await readHistory(repo.path);
  const ids = view.commits.map((c) => c.changes[0]!.fileId);
  expect(ids).toEqual(["p.txt", "p.txt", "p.txt", "q.txt", "q.txt"]);
});

test("the mailmap is applied at read time from the tree at the ref, so editing it needs no re-ingest", async () => {
  const old = { name: "Al", email: "al@old.example" };
  const repo = build([
    { type: "commit", message: "by al", date: "2024-02-01T00:00:00Z", author: old, changes: [{ op: "add", path: "a", content: "1\n" }] },
    { type: "branch", name: "mapped" },
    {
      type: "commit",
      message: "add mailmap",
      date: "2024-02-02T00:00:00Z",
      author: old,
      changes: [{ op: "add", path: ".mailmap", content: "Alice <alice@example.com> <al@old.example>\n" }],
    },
    { type: "checkout", name: "main" },
  ]);
  await refresh(repo.path, { ref: "main" });
  await refresh(repo.path, { ref: "mapped" });
  const unmapped = await readHistory(repo.path, { ref: "main" });
  const mapped = await readHistory(repo.path, { ref: "mapped" });
  expect(unmapped.commits[0]).toMatchObject({ mappedName: "Al", mappedEmail: "al@old.example", authorEmail: "al@old.example" });
  expect(mapped.commits[0]).toMatchObject({ mappedName: "Alice", mappedEmail: "alice@example.com", authorEmail: "al@old.example" });
  expect(mapped.commits[1]).toMatchObject({ mappedName: "Alice", mappedEmail: "alice@example.com" });
});

test("a rename below the similarity threshold is a delete and an add with a new identity", async () => {
  const repo = build([
    add("add old", 1, "old.txt", "a\nb\nc\nd\ne\nf\n"),
    { type: "commit", message: "rewrite as new", date: "2024-02-02T00:00:00Z", changes: [{ op: "rename", from: "old.txt", path: "new.txt", content: "completely\ndifferent\ntext\nhere\nnow\nok\n" }] },
  ]);
  await refresh(repo.path);
  const view = await readHistory(repo.path);
  const statuses = view.commits[1]!.changes.map((c) => c.status).sort();
  expect(statuses).toEqual(["A", "D"]);
  expect(view.commits[0]!.changes[0]!.fileId).toBe("old.txt");
  expect(view.commits[1]!.changes.find((c) => c.status === "A")!.fileId).toBe("new.txt");
});

test("paths with spaces, quotes and unicode survive ingestion", async () => {
  const names = ["sp ace/x y.txt", 'quo"te.txt', "caf\u00e9/\u65e5\u672c.txt"];
  const repo = build([
    { type: "commit", message: "odd names", date: "2024-02-01T00:00:00Z", changes: names.map((path) => ({ op: "add" as const, path, content: "1\n" })) },
  ]);
  await refresh(repo.path);
  const view = await readHistory(repo.path);
  expect(view.commits[0]!.changes.map((c) => c.path).sort()).toEqual([...names].sort());
});

test("binary changes have no line counts", async () => {
  const repo = build([add("bin", 1, "x.bin", "\u0000\u0001\u0002\u0003")]);
  await refresh(repo.path);
  const view = await readHistory(repo.path);
  expect(view.commits[0]!.changes[0]).toMatchObject({ binary: true, added: null, deleted: null });
});
