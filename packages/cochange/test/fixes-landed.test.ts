import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { GitFixture, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { runCochange, runCochangeOnTerminal } from "./support/run.ts";

const alice: Identity = { name: "Alice", email: "alice@example.com" };
const edit = (path: string, version: number) => ({ op: "modify" as const, path, content: `export const v = ${version};\n` });
const add = (path: string) => ({ op: "add" as const, path, content: "export const v = 0;\n" });
const commit = (message: string, date: string, ...changes: ReturnType<typeof edit>[]): Step => ({ type: "commit", message, date, author: alice, changes });
const merge = (branch: string, message: string, date: string): Step => ({ type: "merge", branch, message, date, author: alice });

/**
 * Six landed changes on the main line:
 * - a merge titled "Add export", whose branch has "fix: review comments" (caught in review, so not a fix),
 * - a squash-merged "Fix crash (#12)",
 * - a merge whose pull request title, in the body, says "Fix the null check", though its branch commit says "Tidy",
 * - a merge with the title in the subject, "Merge pull request #681: Fix retry loop",
 * - a GitLab merge with the title after the blank line,
 * - and the commit that added the files.
 */
function landedHistory(): GitFixture {
  return GitFixture.build([
    { type: "commit", message: "Add modules", date: "2024-01-01T09:00:00Z", author: alice, changes: ["a", "b", "c", "d", "e"].map((name) => add(`src/${name}.ts`)) },
    { type: "branch", name: "feature/export", from: "main" },
    commit("Add export", "2024-01-10T09:00:00Z", edit("src/a.ts", 1)),
    commit("fix: review comments", "2024-01-11T09:00:00Z", edit("src/a.ts", 2)),
    { type: "checkout", name: "main" },
    merge("feature/export", "Merge pull request #1 from owner/feature/export\n\nAdd export", "2024-01-12T09:00:00Z"),
    commit("Fix crash (#12)", "2024-02-01T09:00:00Z", edit("src/b.ts", 1)),
    { type: "branch", name: "tidy", from: "main" },
    commit("Tidy", "2024-03-01T09:00:00Z", edit("src/c.ts", 1)),
    { type: "checkout", name: "main" },
    merge("tidy", "Merge pull request #3 from owner/tidy\n\nFix the null check\n\nLonger description", "2024-03-02T09:00:00Z"),
    { type: "branch", name: "retry", from: "main" },
    commit("Add y", "2024-04-01T09:00:00Z", edit("src/d.ts", 1)),
    { type: "checkout", name: "main" },
    merge("retry", "Merge pull request #681: Fix retry loop", "2024-04-02T09:00:00Z"),
    { type: "branch", name: "gitlab", from: "main" },
    commit("wip", "2024-05-01T09:00:00Z", edit("src/e.ts", 1)),
    commit("Fix lint", "2024-05-02T09:00:00Z", edit("src/e.ts", 2)),
    { type: "checkout", name: "main" },
    merge("gitlab", "Merge branch 'gitlab' into 'main'\n\nFix gitlab thing\n\nSee merge request group/project!5", "2024-05-03T09:00:00Z"),
  ]);
}

let repo: GitFixture;
beforeAll(() => {
  repo = landedHistory();
});
afterAll(() => repo.dispose());
beforeEach(() => rmSync(join(repo.path, ".cache"), { recursive: true, force: true }));

interface Row {
  path: string;
  fixes: number;
  revisions: number;
  landedChanges: number;
  fixShare: number | null;
  reviewFixes: number;
  reviewEvidence: { commits: { subject: string }[]; omitted: number };
  evidence: { commits: { subject: string }[] };
}
const rows = async (command: string, ...args: string[]) => {
  const document = JSON.parse((await runCochange(repo.path, [command, ...args])).stdout);
  return { document, byPath: (path: string) => (document.results as Row[]).find((row) => row.path === path)! };
};

test("a fix made on a branch before it merged is not a fix, and is listed as a fix during review", async () => {
  const { byPath } = await rows("fixes");
  const a = byPath("src/a.ts");
  expect(a).toMatchObject({ fixes: 0, revisions: 3, landedChanges: 2, fixShare: 0, reviewFixes: 1 });
  expect(a.reviewEvidence.commits.map((c) => c.subject)).toEqual(["fix: review comments"]);
});

test("a squash-merged commit is classified by its own subject", async () => {
  const { byPath } = await rows("fixes");
  expect(byPath("src/b.ts")).toMatchObject({ fixes: 1, landedChanges: 2, fixShare: 0.5, reviewFixes: 0 });
  expect(byPath("src/b.ts").evidence.commits.map((c) => c.subject)).toEqual(["Fix crash (#12)"]);
});

test("a merge is classified by the pull request title in its body, not by its branch commits or its subject", async () => {
  const { byPath } = await rows("fixes");
  expect(byPath("src/c.ts")).toMatchObject({ fixes: 1, landedChanges: 2, revisions: 2, reviewFixes: 0 });
  expect(byPath("src/c.ts").evidence.commits.map((c) => c.subject)).toEqual(["Fix the null check"]);
});

test("a merge whose subject carries the title, \"Merge pull request #N: title\", is classified by that title", async () => {
  const { byPath } = await rows("fixes");
  expect(byPath("src/d.ts").evidence.commits.map((c) => c.subject)).toEqual(["Fix retry loop"]);
});

test("a GitLab merge is classified by the title on the line after the blank one, and its excluded branch commit is not a review fix", async () => {
  const { byPath } = await rows("fixes");
  expect(byPath("src/e.ts")).toMatchObject({ fixes: 1, reviewFixes: 0 });
  expect(byPath("src/e.ts").evidence.commits.map((c) => c.subject)).toEqual(["Fix gitlab thing"]);
});

test("the convention check reads the forms of the landed titles, over landed changes", async () => {
  const { document } = await rows("fixes");
  expect(document.fixConvention).toMatchObject({ landedChanges: 6, fixes: 4, followsConvention: true, forms: { conventionalCommits: 0, fixVerb: 4, issueReference: 0 } });
  expect(document.fixConvention.share).toBeCloseTo(0.667, 3);
  expect(document.fixesDuringReview.fixes).toBe(1);
});

test("hotspots carries the landed changes, the fixes among them and the fixes during review", async () => {
  const { byPath } = await rows("hotspots");
  expect(byPath("src/a.ts")).toMatchObject({ frequency: 3, landedChanges: 2, fixes: 0, fixShare: 0, reviewFixes: 1 });
  expect(byPath("src/c.ts")).toMatchObject({ landedChanges: 2, fixes: 1, fixShare: 0.5 });
});

test("a repository whose titles use no recognisable fix form is flagged, with the forms seen and the share beside the verdict", async () => {
  const plain = GitFixture.build([
    { type: "commit", message: "Add modules", date: "2024-01-01T09:00:00Z", author: alice, changes: [add("src/a.ts")] },
    commit("Bug in the tax", "2024-02-01T09:00:00Z", edit("src/a.ts", 1)),
    commit("Tune the page", "2024-03-01T09:00:00Z", edit("src/a.ts", 2)),
  ]);
  try {
    const document = JSON.parse((await runCochange(plain.path, ["fixes"])).stdout);
    expect(document.fixConvention).toMatchObject({ landedChanges: 3, fixes: 1, followsConvention: false, forms: { conventionalCommits: 0, fixVerb: 0, issueReference: 0 } });
    expect(document.fixConvention.share).toBeCloseTo(1 / 3, 3);
    const table = await runCochangeOnTerminal(plain.path, ["fixes"]);
    expect(table.stdout).toContain("Notice: The commit messages probably do not follow a convention this can use: none of the 3 landed changes uses a recognisable fix form");
  } finally {
    plain.dispose();
  }
});

test("conventional commit types are a recognisable form even when the repository has few fixes", async () => {
  const typed = GitFixture.build([
    { type: "commit", message: "feat: add modules", date: "2024-01-01T09:00:00Z", author: alice, changes: [add("src/a.ts")] },
    commit("chore: tidy", "2024-02-01T09:00:00Z", edit("src/a.ts", 1)),
  ]);
  try {
    const document = JSON.parse((await runCochange(typed.path, ["fixes"])).stdout);
    expect(document.fixConvention).toMatchObject({ fixes: 0, followsConvention: true, forms: { conventionalCommits: 2 } });
  } finally {
    typed.dispose();
  }
});
