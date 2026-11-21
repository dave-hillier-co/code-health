import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { GitFixture, type CommitOptions, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { commitsInSnapshot, lineShares, resolveOwners, shareHeldBy } from "../src/blame-owners.ts";
import { readBlame } from "../src/blame-read.ts";
import { refreshBlame } from "../src/blame-refresh.ts";
import { createDatabase } from "../src/sqlite.ts";
import { locateCache } from "../src/cache-location.ts";
import { createNonPersonMatcher } from "../src/identity-classify.ts";

vi.setConfig({ testTimeout: 180_000 });

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
});

const ana: Identity = { name: "Ana A", email: "ana@home.net" };
const anaWork: Identity = { name: "Ana A", email: "ana@corp.com" };
const ben: Identity = { name: "Ben B", email: "ben@corp.com" };
const carol: Identity = { name: "Carol C", email: "carol@corp.com" };
const bot: Identity = { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" };

// Git follows moved blocks only when they hold enough alphanumeric characters (40 for -C).
const c2 = "export function secondLongName(argumentOne) { return argumentOne; }";
const c3 = "export function thirdLongName(argumentTwo) { return argumentTwo; }";

const day = (n: number) => `2024-01-${String(n).padStart(2, "0")}T10:00:00Z`;
const commit = (n: number, author: Identity, message: string, changes: CommitOptions["changes"]): CommitOptions => ({
  message,
  date: day(n),
  author,
  changes,
});
const build = (commits: CommitOptions[]): GitFixture => GitFixture.build(commits.map((c): Step => ({ type: "commit", ...c })));

/**
 * Who wrote each line at HEAD, by hand:
 *   src/a.ts  a1 a2 (ana)           x3 x4 (ben, who replaced a3 and a4)
 *   src/b.ts  b1 b2 (ana; ben's reindent is whitespace only)
 *   src/c.ts  c1 (ana at work)
 *   src/d.ts  c2 c3 (ana at work, moved here by ben: followed by -C, credited to ben without it)
 *   deps.txt  d1 (the bot)
 */
function scenario(): GitFixture {
  const f = build([
    commit(1, ana, "ana adds a and b", [
      { op: "add", path: "src/a.ts", content: "a1\na2\na3\na4\n" },
      { op: "add", path: "src/b.ts", content: "b1\nb2\n" },
    ]),
    commit(2, ben, "ben replaces two lines", [{ op: "modify", path: "src/a.ts", content: "a1\na2\nx3\nx4\n" }]),
    commit(3, anaWork, "ana adds c", [{ op: "add", path: "src/c.ts", content: `c1\n${c2}\n${c3}\n` }]),
    commit(4, bot, "bump", [{ op: "add", path: "deps.txt", content: "d1\n" }]),
    commit(5, ben, "reindent b", [{ op: "modify", path: "src/b.ts", content: "  b1\n  b2\n" }]),
    commit(6, ben, "move two lines of c into d", [
      { op: "modify", path: "src/c.ts", content: "c1\n" },
      { op: "add", path: "src/d.ts", content: `${c2}\n${c3}\n` },
    ]),
  ]);
  fixtures.push(f);
  return f;
}

const shas = (f: GitFixture) => f.git("log", "--format=%H", "--reverse").split("\n");
const ranges = (snapshot: Awaited<ReturnType<typeof readBlame>>, path: string) =>
  snapshot.files.get(path)!.ranges.map(({ start, count, sha }) => [start, count, sha]);

test("a refresh stores who last wrote each line range, and a read returns the ranges", async () => {
  const f = scenario();
  const [one, two, three, four] = shas(f);
  const result = await refreshBlame(f.path);
  expect(result).toMatchObject({ files: 5, blamed: 5, reused: 0, noText: 0, failed: [], pruned: 0, rebuilt: false, aborted: false, headSha: f.git("rev-parse", "HEAD") });

  const snapshot = await readBlame(f.path);
  expect(snapshot.missing).toEqual([]);
  expect([...snapshot.files.keys()]).toEqual(["deps.txt", "src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
  expect(ranges(snapshot, "src/a.ts")).toEqual([[1, 2, one], [3, 2, two]]);
  expect(ranges(snapshot, "src/b.ts")).toEqual([[1, 2, one]]); // -w: the reindent is not authorship
  expect(ranges(snapshot, "src/c.ts")).toEqual([[1, 1, three]]);
  expect(ranges(snapshot, "src/d.ts")).toEqual([[1, 2, three]]); // -C follows the moved lines
  expect(ranges(snapshot, "deps.txt")).toEqual([[1, 1, four]]);
  expect(snapshot.files.get("src/a.ts")).toMatchObject({ lines: 4 });
  expect(commitsInSnapshot(snapshot)).toEqual(new Set([one, two, three, four]));
});

test("without copy detection the commit that moved lines is their author, and the two blames never mix", async () => {
  const f = scenario();
  const six = shas(f)[5]!;
  await refreshBlame(f.path, { copyDetection: false });
  const off = await readBlame(f.path, { copyDetection: false });
  expect(ranges(off, "src/d.ts")).toEqual([[1, 2, six]]);
  // The cache holds blames made with -C-less options only, so a read with the defaults finds none.
  const on = await readBlame(f.path);
  expect(on.files.size).toBe(0);
  expect(on.missing).toHaveLength(5);
  expect(on.optionsId).not.toBe(off.optionsId);
});

test("a mover's commits keep authorship: a renamed file, a file moved across folders with an edit, and a file split in two", async () => {
  const body = [c2, c3, "export const kept = 1;", "export const alsoKept = 2;"];
  const text = (...lines: string[]) => lines.join("\n") + "\n";
  const f = build([
    commit(1, ana, "ana writes the module", [{ op: "add", path: "src/old/module.ts", content: text(...body) }]),
    commit(2, carol, "carol writes the helper", [{ op: "add", path: "src/old/helper.ts", content: text(c2.replace("second", "helper"), c3.replace("third", "helperTwo")) }]),
    { ...commit(3, ben, "move the module next to its users\n\nCode-Health: locality/move-to-neighbour", [{ op: "rename", from: "src/old/module.ts", path: "src/users/module.ts", content: text(...body) }]) },
    { ...commit(4, ben, "move the helper and touch one line\n\nCode-Health: locality/move-to-neighbour", [{ op: "rename", from: "src/old/helper.ts", path: "src/users/helper.ts", content: text(c2.replace("second", "helper"), "export const touched = 3;") }]) },
    { ...commit(5, ben, "split the module", [
      { op: "modify", path: "src/users/module.ts", content: text(body[2]!, body[3]!) },
      { op: "add", path: "src/users/pieces.ts", content: text(c2, c3) },
    ]) },
  ]);
  fixtures.push(f);
  const [one, two, , four] = shas(f);
  await refreshBlame(f.path);
  const snapshot = await readBlame(f.path);
  // Renamed unchanged: every line is still the author's, not the mover's.
  expect(ranges(snapshot, "src/users/module.ts")).toEqual([[1, 2, one]]);
  // Moved with one line replaced: the kept line follows its author, the new one is the mover's.
  expect(ranges(snapshot, "src/users/helper.ts")).toEqual([[1, 1, two], [2, 1, four]]);
  // Lines split out into a new file are followed by -C to where they were written.
  expect(ranges(snapshot, "src/users/pieces.ts")).toEqual([[1, 2, one]]);
});

test("a refresh blames only the files whose blob changed", async () => {
  const f = scenario();
  await refreshBlame(f.path);
  const again = await refreshBlame(f.path);
  expect(again).toMatchObject({ files: 5, blamed: 0, reused: 5 });

  f.commit(commit(7, carol, "carol adds a line to a", [{ op: "modify", path: "src/a.ts", content: "a1\na2\nx3\nx4\ncarol\n" }]));
  const next = await refreshBlame(f.path);
  expect(next).toMatchObject({ files: 5, blamed: 1, reused: 4, pruned: 1 });
  const snapshot = await readBlame(f.path);
  expect(snapshot.files.get("src/a.ts")!.ranges.at(-1)).toEqual({ start: 5, count: 1, sha: f.git("rev-parse", "HEAD") });
  // The untouched files still point at the commits that wrote them.
  expect(snapshot.files.get("src/d.ts")!.ranges[0]!.sha).toBe(shas(f)[2]);
});

test("a file reverted to earlier content is blamed on the revert, whichever commit it was first blamed at", async () => {
  const f = build([
    commit(1, ana, "write", [{ op: "add", path: "x.ts", content: "one\n" }]),
    commit(2, ben, "change", [{ op: "modify", path: "x.ts", content: "two\n" }]),
  ]);
  fixtures.push(f);
  await refreshBlame(f.path, { ref: "HEAD~1" });
  f.commit({ ...commit(3, carol, "revert", [{ op: "modify", path: "x.ts", content: "one\n" }]) } as never);
  const revert = f.git("rev-parse", "HEAD");
  // The blob at HEAD is the blob stored for the first commit, but its blame has changed.
  expect((await readBlame(f.path)).missing).toEqual(["x.ts"]);
  const result = await refreshBlame(f.path);
  expect(result).toMatchObject({ blamed: 1, reused: 0 });
  expect(ranges(await readBlame(f.path), "x.ts")).toEqual([[1, 1, revert]]);
});

test("revisions in the ignore-revs file at the ref are skipped, and listing one changes the options", async () => {
  const f = build([
    commit(1, ana, "write", [{ op: "add", path: "src/a.ts", content: "a1\na2\na3\n" }]),
    commit(2, carol, "rename a2", [{ op: "modify", path: "src/a.ts", content: "a1\na2x\na3\n" }]),
  ]);
  fixtures.push(f);
  const [one, two] = shas(f) as [string, string];
  await refreshBlame(f.path, { paths: ["src/a.ts"] });
  const before = await readBlame(f.path, { paths: ["src/a.ts"] });
  expect(ranges(before, "src/a.ts")).toEqual([[1, 1, one], [2, 1, two], [3, 1, one]]);

  // An abbreviated revision and a comment: both are understood. A revision that does not exist is dropped.
  f.commit(commit(3, ben, "ignore the rename", [{ op: "add", path: ".git-blame-ignore-revs", content: `# renames\n${two.slice(0, 10)}\n${"0".repeat(40)}\n` }]));
  expect((await readBlame(f.path, { paths: ["src/a.ts"] })).missing).toEqual(["src/a.ts"]);
  await refreshBlame(f.path, { paths: ["src/a.ts"] });
  const after = await readBlame(f.path, { paths: ["src/a.ts"] });
  expect(ranges(after, "src/a.ts")).toEqual([[1, 3, one]]);
  expect(after.optionsId).not.toBe(before.optionsId);
});

test("binary, empty, lockfile, excluded and generated files hold no authorship", async () => {
  const f = build([
    commit(1, ana, "files", [
      { op: "add", path: "src/a.ts", content: "a1\n" },
      { op: "add", path: "empty.txt", content: "" },
      { op: "add", path: "image.bin", content: "\0\0\0binary\0" },
      { op: "add", path: "package-lock.json", content: "{}\n" },
      { op: "add", path: "docs/notes.md", content: "n1\n" },
      { op: "add", path: "gen/out.ts", content: "g1\n" },
      { op: "add", path: ".gitattributes", content: "gen/** linguist-generated\n" },
    ]),
  ]);
  fixtures.push(f);
  const result = await refreshBlame(f.path, { exclude: ["docs/**"] });
  // .gitattributes itself is authored text: src/a.ts, .gitattributes, plus the two with no lines.
  expect(result).toMatchObject({ files: 4, blamed: 2, noText: 2 });
  const snapshot = await readBlame(f.path, { exclude: ["docs/**"] });
  expect([...snapshot.files.keys()]).toEqual([".gitattributes", "src/a.ts"]);
  expect(snapshot.missing).toEqual([]);
  // Files without lines are remembered, so the next refresh does not look at them again.
  expect(await refreshBlame(f.path, { exclude: ["docs/**"] })).toMatchObject({ blamed: 0, reused: 4, noText: 0 });
});

test("an interrupted refresh keeps the files that finished and the next one resumes", async () => {
  const f = scenario();
  const controller = new AbortController();
  const first = await refreshBlame(f.path, {
    concurrency: 1,
    batchSize: 1,
    signal: controller.signal,
    onProgress: ({ done, total }) => {
      expect(total).toBe(5);
      if (done === 2) controller.abort();
    },
  });
  expect(first).toMatchObject({ blamed: 2, aborted: true, pruned: 0 });
  const resumed = await refreshBlame(f.path);
  expect(resumed).toMatchObject({ files: 5, blamed: 3, reused: 2, aborted: false });
  expect((await readBlame(f.path)).missing).toEqual([]);
});

test("a read never blames: files never refreshed or changed since are missing, not empty", async () => {
  const f = scenario();
  const before = await readBlame(f.path);
  expect(before.files.size).toBe(0);
  expect(before.missing).toEqual(["deps.txt", "src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
  expect(existsSync(join(f.path, ".cache", "code-health", "blame.sqlite"))).toBe(false);

  await refreshBlame(f.path);
  f.commit(commit(7, carol, "edit b", [{ op: "modify", path: "src/b.ts", content: "b1\nb2\nb3\n" }]));
  const snapshot = await readBlame(f.path);
  expect(snapshot.missing).toEqual(["src/b.ts"]);
  expect(snapshot.files.size).toBe(4);
});

test("blames made at a later commit serve an earlier ref for the files unchanged between them", async () => {
  const f = scenario();
  const base = f.git("rev-parse", "HEAD");
  f.commit(commit(7, carol, "edit b", [{ op: "modify", path: "src/b.ts", content: "b1\nb2\nb3\n" }]));
  await refreshBlame(f.path);
  const atBase = await readBlame(f.path, { ref: base });
  expect(atBase.headSha).toBe(base);
  expect(atBase.missing).toEqual(["src/b.ts"]);
  expect(atBase.files.get("src/a.ts")!.lines).toBe(4);
});

test("refreshing chosen paths blames only them and prunes nothing", async () => {
  const f = scenario();
  await refreshBlame(f.path);
  f.commit(commit(7, carol, "edit a and b", [
    { op: "modify", path: "src/a.ts", content: "a1\n" },
    { op: "modify", path: "src/b.ts", content: "b1\n" },
  ]));
  const result = await refreshBlame(f.path, { paths: ["src/a.ts"] });
  expect(result).toMatchObject({ files: 1, blamed: 1, reused: 0, pruned: 0 });
  const snapshot = await readBlame(f.path);
  expect(snapshot.missing).toEqual(["src/b.ts"]);
});

test("an incompatible cache is rebuilt", async () => {
  const f = scenario();
  await refreshBlame(f.path);
  const { blamePath } = await locateCache(f.path);
  const db = createDatabase(blamePath, {});
  db.exec("PRAGMA journal_mode = DELETE");
  db.exec("PRAGMA user_version = 99");
  db.close();
  expect(await refreshBlame(f.path)).toMatchObject({ rebuilt: true, blamed: 5, reused: 0 });
  expect(await refreshBlame(f.path)).toMatchObject({ rebuilt: false, blamed: 0, reused: 5 });
});

test("concurrent refreshes take turns and no file is blamed twice", async () => {
  const f = scenario();
  const results = await Promise.all([refreshBlame(f.path), refreshBlame(f.path), refreshBlame(f.path)]);
  expect(results.reduce((n, r) => n + r.blamed, 0)).toBe(5);
  expect(results.reduce((n, r) => n + r.reused, 0)).toBe(10);
});

test("the cache lives beside the history cache, ignored by git", async () => {
  const f = scenario();
  await refreshBlame(f.path);
  expect(existsSync(join(f.path, ".cache", "code-health", "blame.sqlite"))).toBe(true);
  expect(readFileSync(join(f.path, ".cache", "code-health", ".gitignore"), "utf8").trim()).toBe("*");
  expect(f.git("status", "--porcelain")).toBe("");
  expect(existsSync(join(f.path, ".cache", "code-health", "blame.lock"))).toBe(false);
});

test("owners are resolved at query time through the mailmap and the classification, so no identity change needs a re-blame", async () => {
  const f = scenario();
  const [one, two, three, four] = shas(f) as [string, string, string, string];
  await refreshBlame(f.path);
  const snapshot = await readBlame(f.path);
  const matcher = createNonPersonMatcher({ botPatterns: [], servicePatterns: [], agentPatterns: [], decisions: [] });

  const unmapped = await resolveOwners(f.path, commitsInSnapshot(snapshot), { matcher });
  expect(unmapped.get(one)).toMatchObject({ key: "Ana A <ana@home.net>", kind: "person" });
  expect(unmapped.get(three)).toMatchObject({ key: "Ana A <ana@corp.com>", kind: "person" });
  expect(unmapped.get(four)).toMatchObject({ kind: "bot" });

  const all = [...snapshot.files.values()].flatMap((file) => file.ranges);
  const before = lineShares(all, unmapped);
  // 10 lines: ana 4 (a1 a2 b1 b2), ben 2, ana at work 3 (c1 c2 c3), the bot 1.
  expect(before).toMatchObject({ total: 10, people: 9, nonPerson: 1, unattributed: 0 });
  expect(before.byOwner).toEqual(new Map([["Ana A <ana@home.net>", 4], ["Ben B <ben@corp.com>", 2], ["Ana A <ana@corp.com>", 3]]));

  writeFileSync(join(f.path, ".mailmap"), "Ana A <ana@corp.com> <ana@home.net>\n");
  const mapped = await resolveOwners(f.path, commitsInSnapshot(snapshot), { matcher });
  const after = lineShares(all, mapped);
  expect(after.byOwner).toEqual(new Map([["Ana A <ana@corp.com>", 7], ["Ben B <ben@corp.com>", 2]]));
  expect(shareHeldBy(after, new Set(["Ana A <ana@corp.com>"]))).toBeCloseTo(7 / 9, 10);
  expect(shareHeldBy(after, new Set(["Ben B <ben@corp.com>"]))).toBeCloseTo(2 / 9, 10);
  expect(mapped.get(two)).toMatchObject({ key: "Ben B <ben@corp.com>" });
  // The blames are untouched by the new mailmap.
  expect(await refreshBlame(f.path)).toMatchObject({ blamed: 0, reused: 5 });

  // A local-only mailmap and a reviewed classification apply the same way.
  const local = join(f.path, "local-mailmap");
  writeFileSync(local, "Benjamin B <ben@corp.com>\n");
  const decided = createNonPersonMatcher({ botPatterns: [], servicePatterns: [], agentPatterns: [], decisions: [{ identity: "Ben B <ben@corp.com>", kind: "service" }] });
  const reviewed = await resolveOwners(f.path, commitsInSnapshot(snapshot), { localMailmap: local, matcher: decided });
  expect(reviewed.get(two)).toMatchObject({ name: "Benjamin B", kind: "service" });
  expect(lineShares(all, reviewed)).toMatchObject({ people: 7, nonPerson: 3 });
});

test("lines whose commit is not among the owners are unattributed, and a file without people has no share", () => {
  const owners = new Map([["a".repeat(40), { key: "Ana A <ana@corp.com>", name: "Ana A", email: "ana@corp.com", kind: "person" as const }]]);
  const shares = lineShares([{ start: 1, count: 3, sha: "a".repeat(40) }, { start: 4, count: 2, sha: "b".repeat(40) }], owners);
  expect(shares).toMatchObject({ total: 5, people: 3, unattributed: 2 });
  expect(shareHeldBy(lineShares([], owners), new Set(["x"]))).toBeNull();
});
