import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { GitFixture, type Step } from "./git-fixture.ts";

const fixtures: GitFixture[] = [];

function create(): GitFixture {
  const fixture = GitFixture.create();
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

const alice = { name: "Alice", email: "alice@example.com" };
const bob = { name: "Bob", email: "bob@example.com" };

test("commits carry the fixed identities and dates", () => {
  const repo = create();
  repo.commit({
    message: "add a",
    date: "2024-01-01T10:00:00Z",
    author: alice,
    committer: bob,
    changes: [{ op: "add", path: "a.txt", content: "one\n" }],
  });

  expect(repo.git("log", "-1", "--format=%an|%ae|%aI|%cn|%ce|%cI")).toBe(
    "Alice|alice@example.com|2024-01-01T10:00:00Z|Bob|bob@example.com|2024-01-01T10:00:00Z",
  );
});

test("add, modify and delete change the working tree and history", () => {
  const repo = create();
  repo.commit({ message: "add", date: "2024-01-01T00:00:00Z", changes: [{ op: "add", path: "src/a.txt", content: "1\n" }] });
  repo.commit({ message: "modify", date: "2024-01-02T00:00:00Z", changes: [{ op: "modify", path: "src/a.txt", content: "2\n" }] });
  repo.commit({ message: "delete", date: "2024-01-03T00:00:00Z", changes: [{ op: "delete", path: "src/a.txt" }] });

  expect(repo.git("log", "--format=%s", "--name-status")).toBe(
    ["delete", "", "D\tsrc/a.txt", "modify", "", "M\tsrc/a.txt", "add", "", "A\tsrc/a.txt"].join("\n"),
  );
  expect(existsSync(join(repo.path, "src/a.txt"))).toBe(false);
});

test("rename is detected by git as a rename", () => {
  const repo = create();
  const content = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";
  repo.commit({ message: "add", date: "2024-01-01T00:00:00Z", changes: [{ op: "add", path: "old/name.txt", content }] });
  repo.commit({ message: "rename", date: "2024-01-02T00:00:00Z", changes: [{ op: "rename", from: "old/name.txt", path: "new/name.txt" }] });

  expect(repo.git("log", "-1", "-M", "--format=", "--name-status")).toBe("R100\told/name.txt\tnew/name.txt");
});

test("the head committer date is the date of the last commit", () => {
  const repo = create();
  repo.commit({ message: "one", date: "2024-03-01T00:00:00Z", changes: [{ op: "add", path: "a", content: "a" }] });
  repo.commit({ message: "two", date: "2024-03-05T12:30:00Z", changes: [{ op: "modify", path: "a", content: "b" }] });

  expect(repo.git("log", "-1", "--format=%cI")).toBe("2024-03-05T12:30:00Z");
});

test("branches and merges produce a merge commit with two parents", () => {
  const repo = create();
  const steps: Step[] = [
    { type: "commit", message: "base", date: "2024-01-01T00:00:00Z", changes: [{ op: "add", path: "a", content: "a\n" }] },
    { type: "branch", name: "feature" },
    { type: "commit", message: "feature work", date: "2024-01-02T00:00:00Z", changes: [{ op: "add", path: "f", content: "f\n" }] },
    { type: "checkout", name: "main" },
    { type: "commit", message: "main work", date: "2024-01-03T00:00:00Z", changes: [{ op: "add", path: "m", content: "m\n" }] },
    { type: "merge", branch: "feature", message: "merge feature", date: "2024-01-04T00:00:00Z" },
  ];
  repo.apply(steps);

  expect(repo.git("log", "-1", "--format=%s|%P").split("|")[1]?.split(" ")).toHaveLength(2);
  expect(repo.git("ls-files").split("\n")).toEqual(["a", "f", "m"]);
  expect(repo.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
});

test("identical scripts produce identical commit hashes", () => {
  const steps: Step[] = [
    { type: "commit", message: "base", date: "2024-01-01T00:00:00Z", changes: [{ op: "add", path: "a", content: "a\n" }] },
    { type: "commit", message: "next", date: "2024-01-02T00:00:00Z", changes: [{ op: "modify", path: "a", content: "b\n" }] },
  ];
  const first = create();
  first.apply(steps);
  const second = create();
  second.apply(steps);

  expect(first.git("rev-parse", "HEAD")).toBe(second.git("rev-parse", "HEAD"));
});

test("git variables leaking in from the environment do not reach the fixture's repository", () => {
  const outer = create();
  outer.commit({ message: "outer", date: "2024-01-01T00:00:00Z", changes: [{ op: "add", path: "o.txt", content: "o\n" }] });
  const leaked = {
    GIT_DIR: join(outer.path, ".git"),
    GIT_OBJECT_DIRECTORY: join(outer.path, "stray-objects"),
    GIT_INDEX_FILE: join(outer.path, "stray-index"),
    GIT_WORK_TREE: outer.path,
  };
  const previous = Object.fromEntries(Object.keys(leaked).map((k) => [k, process.env[k]]));
  Object.assign(process.env, leaked);
  try {
    const inner = create();
    inner.commit({ message: "one", date: "2024-01-01T00:00:00Z", changes: [{ op: "add", path: "a.txt", content: "1\n" }] });
    inner.commit({ message: "two", date: "2024-01-02T00:00:00Z", changes: [{ op: "modify", path: "a.txt", content: "2\n" }] });
    expect(inner.git("rev-list", "--count", "HEAD")).toBe("2");
    expect(inner.git("rev-parse", "--git-dir")).toBe(".git");
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  expect(outer.git("rev-list", "--count", "HEAD")).toBe("1");
});

test("a fixture runs no background maintenance that could touch its repository while a test builds or removes it", () => {
  const repo = create();
  expect(repo.git("config", "--get", "maintenance.auto")).toBe("false");
  expect(repo.git("config", "--get", "gc.auto")).toBe("0");
});
