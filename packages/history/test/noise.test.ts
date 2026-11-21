import { afterEach, expect, test, vi } from "vitest";
import { GitFixture, type Change, type Step } from "@code-health/fixtures/git-fixture";
import { filterHistory, InvalidPatternError, type NoiseOptions } from "../src/noise.ts";
import { parseBlameIgnoreRevs } from "../src/tree.ts";
import { readHistory } from "../src/read.ts";
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

function commit(message: string, day: number, changes: Change[], author?: { name: string; email: string }): Step {
  return { type: "commit", message, date: `2024-03-${String(day).padStart(2, "0")}T10:00:00Z`, changes, ...(author ? { author } : {}) };
}
const file = (path: string, content = "x\n"): Change => ({ op: "add", path, content });

async function filtered(repo: GitFixture, options: NoiseOptions = {}) {
  await refresh(repo.path);
  const view = await readHistory(repo.path);
  return filterHistory(repo.path, view, options);
}

const paths = (r: Awaited<ReturnType<typeof filtered>>) => r.changes.map((c) => c.files.map((f) => f.path).sort());

test("without noise every commit is a logical change of its own", async () => {
  const repo = build([commit("one", 1, [file("a"), file("b")]), commit("two", 2, [{ op: "modify", path: "a", content: "y\n" }])]);
  const result = await filtered(repo);
  expect(paths(result)).toEqual([["a", "b"], ["a"]]);
  expect(result.changes.every((c) => !c.oversized && c.shas.length === 1)).toBe(true);
});

test("shared exclude globs drop paths, and commits left empty are not revisions", async () => {
  const repo = build([
    commit("src", 1, [file("src/a.ts"), file("dist/bundle.js")]),
    commit("only dist", 2, [{ op: "modify", path: "dist/bundle.js", content: "z\n" }]),
  ]);
  const result = await filtered(repo, { exclude: ["dist/**"] });
  expect(paths(result)).toEqual([["src/a.ts"]]);
  expect(result.filtersApplied.dropped).toMatchObject({ excludedByGlob: 2, emptyAfterFiltering: 1 });
});

test("lockfiles are dropped by default and can be kept", async () => {
  const repo = build([commit("dep bump", 1, [file("package.json"), file("web/package-lock.json"), file("Cargo.lock")])]);
  expect(paths(await filtered(repo))).toEqual([["package.json"]]);
  expect(paths(await filtered(repo, { lockfiles: false }))).toEqual([["Cargo.lock", "package.json", "web/package-lock.json"]]);
});

test("linguist-generated and linguist-vendored paths are dropped, as git evaluates them", async () => {
  const repo = build([
    commit("attrs", 1, [
      file(".gitattributes", "*.pb.go linguist-generated\nthird_party/** linguist-vendored\nthird_party/ours.c -linguist-vendored\n"),
      file("api/x.pb.go"),
      file("third_party/lib.c"),
      file("third_party/ours.c"),
      file("src/real.go"),
    ]),
  ]);
  const result = await filtered(repo);
  expect(paths(result)).toEqual([[".gitattributes", "src/real.go", "third_party/ours.c"]]);
  expect(result.filtersApplied.dropped).toMatchObject({ generated: 1, vendored: 1 });
  const off = await filtered(repo, { gitattributes: false });
  expect(paths(off)[0]).toContain("api/x.pb.go");
});

test("nested .gitattributes files apply", async () => {
  const repo = build([
    commit("attrs", 1, [file("gen/.gitattributes", "* linguist-generated\n"), file("gen/out.txt"), file("keep.txt")]),
  ]);
  // the nested pattern `*` also matches its own .gitattributes file
  expect(paths(await filtered(repo))).toEqual([["keep.txt"]]);
});

test("commits listed in .git-blame-ignore-revs are dropped", async () => {
  const repo = build([commit("real", 1, [file("a")]), commit("format sweep", 2, [{ op: "modify", path: "a", content: "formatted\n" }])]);
  const sweep = repo.git("rev-parse", "HEAD");
  repo.apply([commit("add ignore file", 3, [file(".git-blame-ignore-revs", `# formatting\n${sweep} # prettier\n`)])]);
  const result = await filtered(repo);
  expect(result.changes.map((c) => c.files.map((f) => f.path))).toEqual([["a"], [".git-blame-ignore-revs"]]);
  expect(result.filtersApplied.dropped.blameIgnoredCommits).toBe(1);
  const off = await filtered(repo, { blameIgnoreRevs: false });
  expect(off.changes).toHaveLength(3);
});

test("blame-ignore-revs parsing skips comments and malformed lines", () => {
  expect(parseBlameIgnoreRevs("# c\n\nABCDEF1234567\nnot-a-sha\n0123456789abcdef0123456789abcdef01234567 # x\n")).toEqual([
    "abcdef1234567",
    "0123456789abcdef0123456789abcdef01234567",
  ]);
});

test("authors matching bot patterns are dropped", async () => {
  const bot = { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" };
  const repo = build([commit("human", 1, [file("a")]), commit("bump", 2, [file("b")], bot)]);
  const result = await filtered(repo, { botPatterns: ["\\[bot\\]"] });
  expect(paths(result)).toEqual([["a"]]);
  expect(result.filtersApplied.dropped.botCommits).toBe(1);
});

test("authors the identity classification calls non-person are dropped, by raw or mapped address", async () => {
  const sync = { name: "Sync Robot", email: "sync@corp.com" };
  const repo = build([
    commit("human", 1, [file("a")]),
    commit("sync", 2, [file("b")], sync),
    commit("mapped", 3, [file("c")], { name: "Al", email: "al@old.example" }),
    { type: "commit", message: "map", date: "2024-03-04T10:00:00Z", changes: [{ op: "add", path: ".mailmap", content: "Mapped Bot <bot@corp.com> <al@old.example>\n" }] },
  ]);
  const nonPerson = { isNonPerson: (_name: string, email: string) => email === "sync@corp.com" || email === "bot@corp.com" };
  const result = await filtered(repo, { nonPerson });
  expect(paths(result)).toEqual([["a"], [".mailmap"]]);
  expect(result.filtersApplied.dropped.botCommits).toBe(2);
});

test("pure renames are neither revisions nor coupling, renames with edits stay", async () => {
  const body = "1\n2\n3\n4\n5\n6\n7\n8\n";
  const repo = build([
    commit("create", 1, [file("a.ts", body), file("b.ts", body + "extra\n")]),
    commit("pure move", 2, [{ op: "rename", from: "a.ts", path: "lib/a.ts" }]),
    commit("move and edit", 3, [{ op: "rename", from: "b.ts", path: "lib/b.ts", content: body + "extra\nmore\n" }]),
  ]);
  const result = await filtered(repo);
  expect(result.changes.map((c) => c.files.map((f) => f.path))).toEqual([["a.ts", "b.ts"], ["lib/b.ts"]]);
  expect(result.filtersApplied.dropped.pureRenames).toBe(1);
  expect(result.changes[1]!.files[0]!.fileId).toBe("lib/b.ts");
});

test("oversized logical changes stay in the list but are flagged", async () => {
  const many = Array.from({ length: 5 }, (_, i) => file(`bulk/f${i}`));
  const repo = build([commit("small", 1, [file("a")]), commit("bulk", 2, many)]);
  const result = await filtered(repo, { maxChangesetSize: 4 });
  expect(result.changes.map((c) => c.oversized)).toEqual([false, true]);
  expect(result.filtersApplied.oversizedChanges).toBe(1);
  expect(result.filtersApplied.maxChangesetSize).toBe(4);
});

test("the window selects by committer date", async () => {
  const repo = build([commit("old", 1, [file("a")]), commit("mid", 10, [file("b")]), commit("new", 20, [file("c")])]);
  const result = await filtered(repo, {
    since: Date.parse("2024-03-05T00:00:00Z") / 1000,
    until: Date.parse("2024-03-15T00:00:00Z") / 1000,
  });
  expect(paths(result)).toEqual([["b"]]);
  expect(result.filtersApplied.dropped.outsideWindow).toBe(2);
});

test("a root commit adding most of the current tree is treated as an import and dropped", async () => {
  const bulk = Array.from({ length: 25 }, (_, i) => file(`legacy/f${i}.c`));
  const repo = build([
    commit("Initial import from svn", 1, bulk),
    commit("first real change", 2, [{ op: "modify", path: "legacy/f0.c", content: "changed\n" }]),
    commit("another", 3, [file("new.c")]),
  ]);
  const result = await filtered(repo);
  expect(result.imported).toHaveLength(1);
  expect(result.imported[0]).toMatchObject({ files: 25 });
  expect(result.changes.map((c) => c.files.length)).toEqual([1, 1]);
  const kept = await filtered(repo, { excludeImported: false });
  expect(kept.changes).toHaveLength(3);
});

test("small repositories are never treated as imports", async () => {
  const repo = build([commit("initial", 1, [file("a"), file("b"), file("c")]), commit("next", 2, [file("d")])]);
  const result = await filtered(repo);
  expect(result.imported).toEqual([]);
  expect(result.changes).toHaveLength(2);
});

test("an invalid bot pattern is reported as such, naming the pattern", async () => {
  const repo = build([commit("one", 1, [file("a")])]);
  await expect(filtered(repo, { botPatterns: ["[bot"] })).rejects.toBeInstanceOf(InvalidPatternError);
  await expect(filtered(repo, { botPatterns: ["[bot"] })).rejects.toThrow("[bot");
});

test("a change is oversized above the maximum changeset size, not at it", async () => {
  const many = (n: number, day: number) => commit(`n${n}`, day, Array.from({ length: n }, (_, i) => file(`d${day}/f${i}`)));
  const repo = build([many(3, 1), many(4, 2)]);
  const result = await filtered(repo, { maxChangesetSize: 3 });
  expect(result.changes.map((c) => c.oversized)).toEqual([false, true]);
  expect(result.filtersApplied.oversizedChanges).toBe(1);
});

const suiteMessage = "Move the summary\n\nWhy.\n\nCode-Health: locality/move-to-neighbour";

test("commits with a Code-Health trailer are flagged and kept by default", async () => {
  const repo = build([commit("human", 1, [file("a")]), commit(suiteMessage, 2, [file("b")])]);
  const result = await filtered(repo);
  expect(result.changes.map((c) => c.suiteCommit)).toEqual([false, true]);
  expect(result.filtersApplied.dropped.suiteCommits).toBe(0);
});

test("excludeSuiteCommits drops the suite's own commits and counts them", async () => {
  const repo = build([commit("human", 1, [file("a")]), commit(suiteMessage, 2, [file("b")]), commit("again", 3, [file("c")])]);
  const result = await filtered(repo, { excludeSuiteCommits: true });
  expect(paths(result)).toEqual([["a"], ["c"]]);
  expect(result.filtersApplied.dropped.suiteCommits).toBe(1);
  expect(result.filtersApplied.excludeSuiteCommits).toBe(true);
});

test("a Code-Health line outside the trailer paragraph does not mark a commit", async () => {
  const repo = build([commit("Note\n\nThe Code-Health: trailer marks these.\n\nSigned-off-by: A <a@b>", 1, [file("a")])]);
  const result = await filtered(repo, { excludeSuiteCommits: true });
  expect(paths(result)).toEqual([["a"]]);
  expect(result.filtersApplied.dropped.suiteCommits).toBe(0);
});
