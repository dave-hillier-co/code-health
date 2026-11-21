import { afterEach, expect, test } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { logArgs, parseLog } from "../src/log-parser.ts";
import { runGit } from "../src/git.ts";

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
});

async function logOf(fixture: GitFixture) {
  const shas = fixture.git("rev-list", "HEAD");
  const out = await runGit(fixture.path, logArgs({ similarity: 50, renameLimit: 1000 }), { input: shas + "\n" });
  return parseLog(out);
}

function build(steps: Parameters<typeof GitFixture.build>[0]) {
  const f = GitFixture.build(steps);
  fixtures.push(f);
  return f;
}

const alice = { name: "Alice", email: "alice@example.com" };

test("parses adds, modifies, deletes, renames and binary files", async () => {
  const f = build([
    {
      type: "commit",
      message: "first\n\nbody line",
      date: "2024-01-01T10:00:00Z",
      author: alice,
      changes: [
        { op: "add", path: "a.txt", content: "a\nb\nc\nd\ne\nf\n" },
        { op: "add", path: "sp ace/x.txt", content: "x\n" },
        { op: "add", path: "bin.dat", content: "\u0000\u0001\u0002binary" },
      ],
    },
    {
      type: "commit",
      message: "second",
      date: "2024-01-02T10:00:00Z",
      changes: [
        { op: "rename", from: "a.txt", path: "dir/b.txt", content: "a\nb\nc\nd\ne\nf\ng\n" },
        { op: "delete", path: "sp ace/x.txt" },
        { op: "modify", path: "bin.dat", content: "\u0000\u0001\u0002other-binary!" },
      ],
    },
  ]);
  const commits = await logOf(f);
  expect(commits).toHaveLength(2);
  const [second, first] = commits;
  expect(first!.message).toBe("first\n\nbody line");
  expect(first!.parents).toEqual([]);
  expect(first!.authorEmail).toBe("alice@example.com");
  expect(first!.committerDate).toBe(Date.parse("2024-01-01T10:00:00Z") / 1000);
  expect(first!.changes.map((c) => [c.status, c.path]).sort()).toEqual([
    ["A", "a.txt"],
    ["A", "bin.dat"],
    ["A", "sp ace/x.txt"],
  ]);
  expect(first!.changes.find((c) => c.path === "a.txt")).toMatchObject({ added: 6, deleted: 0, binary: false });
  expect(first!.changes.find((c) => c.path === "bin.dat")).toMatchObject({ added: null, deleted: null, binary: true });

  expect(second!.parents).toEqual([first!.sha]);
  const rename = second!.changes.find((c) => c.status === "R")!;
  expect(rename).toMatchObject({ oldPath: "a.txt", path: "dir/b.txt", added: 1, deleted: 0 });
  expect(rename.similarity).toBeGreaterThanOrEqual(50);
  expect(second!.changes.find((c) => c.status === "D")).toMatchObject({ path: "sp ace/x.txt", blob: null, deleted: 1 });
});

test("merge commits are recorded with parents and no changes", async () => {
  const f = build([
    { type: "commit", message: "base", date: "2024-01-01T00:00:00Z", changes: [{ op: "add", path: "a", content: "1\n" }] },
    { type: "branch", name: "feature" },
    { type: "commit", message: "feat", date: "2024-01-02T00:00:00Z", changes: [{ op: "add", path: "f", content: "1\n" }] },
    { type: "checkout", name: "main" },
    { type: "commit", message: "main", date: "2024-01-03T00:00:00Z", changes: [{ op: "add", path: "m", content: "1\n" }] },
    { type: "merge", branch: "feature", message: "merge", date: "2024-01-04T00:00:00Z" },
  ]);
  const commits = await logOf(f);
  const merge = commits.find((c) => c.message === "merge")!;
  expect(merge.parents).toHaveLength(2);
  expect(merge.changes).toEqual([]);
});

test("control bytes in paths and messages do not break record splitting", async () => {
  const f = build([
    {
      type: "commit",
      message: "has\x1erecord\x1fseparators",
      date: "2024-01-01T10:00:00Z",
      changes: [{ op: "add", path: "rs\x1ename.txt", content: "x\n" }],
    },
  ]);
  const commits = await logOf(f);
  expect(commits).toHaveLength(1);
  expect(commits[0]!.message).toBe("has\x1erecord\x1fseparators");
  expect(commits[0]!.changes[0]!.path).toBe("rs\x1ename.txt");
});
