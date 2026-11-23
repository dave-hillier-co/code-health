import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GitFixture, type Identity } from "@code-health/fixtures/git-fixture";
import { groupByLanding, landedText, landingOf, readLandings } from "../src/landings.ts";

describe("landedText", () => {
  test("takes a GitHub merge's title from the body", () => {
    expect(landedText("Merge pull request #12 from owner/branch\n\nFix the crash\n\nDetails")).toEqual({ title: "Fix the crash", text: "Fix the crash\n\nDetails" });
  });

  test("takes the title from the subject in the form Merge pull request #N: title", () => {
    expect(landedText("Merge pull request #681: Fix the crash")).toMatchObject({ title: "Fix the crash" });
    expect(landedText("Merge pull request #681 - Fix the crash")).toMatchObject({ title: "Fix the crash" });
  });

  test("takes a GitLab merge's title from the first line that is not the merge request link", () => {
    expect(landedText("Merge branch 'x' into 'main'\n\nFix the crash\n\nSee merge request g/p!4").title).toBe("Fix the crash");
    expect(landedText("Merge branch 'x' into 'main'\n\nSee merge request g/p!4").title).toBeNull();
  });

  test("reads CRLF messages", () => {
    expect(landedText("Merge pull request #1 from o/b\r\n\r\nFix it\r\n").title).toBe("Fix it");
  });

  test("a merge that names no title, and any other commit, is classified by its own message", () => {
    expect(landedText("Merge branch 'fix/crash'")).toEqual({ title: null, text: "Merge branch 'fix/crash'" });
    expect(landedText("Merge pull request #5 from o/b")).toMatchObject({ title: null });
    expect(landedText("Fix crash (#12)\n\nbody")).toEqual({ title: null, text: "Fix crash (#12)\n\nbody" });
  });
});

describe("readLandings", () => {
  const author: Identity = { name: "A", email: "a@example.com" };
  let repo: GitFixture;
  beforeAll(() => {
    repo = GitFixture.build([
      { type: "commit", message: "Root", date: "2024-01-01T09:00:00Z", author, changes: [{ op: "add", path: "a.txt", content: "0\n" }] },
      { type: "branch", name: "topic", from: "main" },
      { type: "commit", message: "Step one", date: "2024-01-02T09:00:00Z", author, changes: [{ op: "modify", path: "a.txt", content: "1\n" }] },
      { type: "commit", message: "fix: step two", date: "2024-01-03T09:00:00Z", author, changes: [{ op: "modify", path: "a.txt", content: "2\n" }] },
      { type: "checkout", name: "main" },
      { type: "merge", branch: "topic", message: "Merge pull request #1 from o/topic\n\nAdd a thing", date: "2024-01-04T09:00:00Z", author },
      { type: "commit", message: "Fix crash (#2)", date: "2024-01-05T09:00:00Z", author, changes: [{ op: "modify", path: "a.txt", content: "3\n" }] },
    ]);
  });
  afterAll(() => repo.dispose());

  test("a merge and the commits only its later parent reaches are one landed change, and a commit on the line is its own", async () => {
    const landings = await readLandings(repo.path, "HEAD");
    expect(landings.map((l) => [l.how, l.title, l.members.length])).toEqual([["direct", "Root", 1], ["merge", "Add a thing", 2], ["direct", "Fix crash (#2)", 1]]);
    expect(landings[1]!.branch.map((c) => c.message)).toEqual(["Step one", "fix: step two"]);
    const of = landingOf(landings);
    expect(of.get(landings[1]!.members[1]!)).toBe(landings[1]);
  });
});

describe("the work of reading landings", () => {
  const author: Identity = { name: "A", email: "a@example.com" };
  const day = (n: number): string => new Date(Date.UTC(2024, 0, 1) + n * 86_400_000).toISOString();

  /** A repository with `merges` pull requests of two commits each, merged one after another. */
  function withMerges(merges: number): GitFixture {
    const steps: Parameters<typeof GitFixture.build>[0] = [
      { type: "commit", message: "Root", date: day(0), author, changes: [{ op: "add", path: "a.txt", content: "0\n" }] },
    ];
    for (let i = 1; i <= merges; i++) {
      steps.push(
        { type: "branch", name: `topic-${i}`, from: "main" },
        { type: "commit", message: `Step ${i}`, date: day(i * 3), author, changes: [{ op: "modify", path: "a.txt", content: `${i}a\n` }] },
        { type: "commit", message: `fix: step ${i}`, date: day(i * 3 + 1), author, changes: [{ op: "add", path: `f${i}.txt`, content: `${i}\n` }] },
        { type: "checkout", name: "main" },
        { type: "merge", branch: `topic-${i}`, message: `Merge pull request #${i} from o/topic-${i}\n\nChange ${i}`, date: day(i * 3 + 2), author },
      );
    }
    return GitFixture.build(steps);
  }

  /** Runs `work` with a `git` in front of the real one on PATH that records every invocation, and returns the invocations. */
  async function gitInvocations(work: () => Promise<unknown>): Promise<string[]> {
    const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const dir = mkdtempSync(join(tmpdir(), "git-shim-"));
    const log = join(dir, "log");
    writeFileSync(join(dir, "git"), `#!/bin/sh\necho "$1" >> '${log}'\nexec '${real}' "$@"\n`);
    chmodSync(join(dir, "git"), 0o755);
    writeFileSync(log, "");
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    try {
      await work();
    } finally {
      process.env.PATH = path;
    }
    const lines = readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
    rmSync(dir, { recursive: true, force: true });
    return lines;
  }

  test("reading the landings starts the same few git processes however many merges there are", async () => {
    const small = withMerges(3);
    const large = withMerges(40);
    try {
      const few = await gitInvocations(() => readLandings(small.path, "HEAD"));
      let landings: Awaited<ReturnType<typeof readLandings>> = [];
      const many = await gitInvocations(async () => {
        landings = await readLandings(large.path, "HEAD");
      });
      expect(landings).toHaveLength(41);
      expect(landings.filter((l) => l.how === "merge").every((l) => l.members.length === 2)).toBe(true);
      expect(few.length).toBeGreaterThan(0);
      expect(many.length).toBeLessThanOrEqual(3);
      expect(many.length).toBe(few.length);
    } finally {
      small.dispose();
      large.dispose();
    }
  });

  test("grouping changes by landing starts no git process", async () => {
    const repo = withMerges(10);
    try {
      const landings = await readLandings(repo.path, "HEAD");
      const changes = landings.flatMap((l) => l.members.map((sha) => ({ shas: [sha] })));
      const invocations = await gitInvocations(async () => {
        expect(groupByLanding(changes, landings)).toHaveLength(landings.length);
      });
      expect(invocations).toEqual([]);
    } finally {
      repo.dispose();
    }
  });
});
