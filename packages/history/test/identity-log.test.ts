import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { GitFixture, type Identity } from "@code-health/fixtures/git-fixture";
import { blameLineCounts, parseIncrementalBlame } from "../src/blame-lines.ts";
import { gatherIdentityFacts } from "../src/identity-log.ts";
import { mapThroughMailmap } from "../src/identity-mapping.ts";
import { readHistory } from "../src/read.ts";
import { refresh } from "../src/refresh.ts";

vi.setConfig({ testTimeout: 180_000 });

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
});

const jo: Identity = { name: "Jo K", email: "jo@home.net" };
const joWork: Identity = { name: "Jo K", email: "jo@corp.com" };
const github: Identity = { name: "GitHub", email: "noreply@github.com" };

function history() {
  const f = GitFixture.build([
    { type: "commit", message: "one\n\nCo-Authored-By: Claude <noreply@anthropic.com>", date: "2024-01-01T10:00:00Z", author: jo, committer: joWork, changes: [{ op: "add", path: "src/a.ts", content: "a1\na2\na3\n" }] },
    { type: "commit", message: "two", date: "2024-01-08T10:00:00Z", author: jo, committer: joWork, changes: [{ op: "add", path: "docs/b.md", content: "b1\nb2\n" }] },
    { type: "commit", message: "three", date: "2024-01-09T10:00:00Z", author: jo, committer: github, changes: [{ op: "modify", path: "src/a.ts", content: "a1\na2\na3\na4\n" }] },
  ]);
  fixtures.push(f);
  return f;
}

test("facts list each author as written, with activity, committers and agent trailers", async () => {
  const repo = history();
  await refresh(repo.path);
  const view = await readHistory(repo.path);
  const facts = await gatherIdentityFacts(repo.path, view, { windowSince: 0 });
  expect(facts.raws).toHaveLength(1);
  const [raw] = facts.raws;
  expect(raw).toMatchObject({ name: "Jo K", email: "jo@home.net", commits: 3 });
  expect([...raw!.files].sort()).toEqual(["docs/b.md", "src/a.ts"]);
  expect([...raw!.areaCounts.keys()].sort()).toEqual(["docs", "src"]);
  // The platform committer is left out of pairing.
  expect(facts.pairing.committersOfAuthor.get("jo@home.net")).toEqual(new Map([["jo@corp.com", 2]]));
  expect(facts.pairing.authorsOfCommitter.get("jo@corp.com")).toEqual(new Set(["jo@home.net"]));
  expect(facts.agents).toEqual([{ value: "Claude <noreply@anthropic.com>", pattern: "\\bclaude\\b", commits: 1 }]);
  expect(facts.windowCommits.get("Jo K <jo@home.net>")).toBe(3);
});

test("identities are mapped through the working tree mailmap and a local file, before anything is committed", async () => {
  const repo = history();
  writeFileSync(join(repo.path, ".mailmap"), "Joanna K <jo@corp.com> Jo K <jo@home.net>\n");
  const mapped = await mapThroughMailmap(repo.path, [jo, joWork]);
  expect(mapped.get("Jo K <jo@home.net>")).toEqual({ name: "Joanna K", email: "jo@corp.com" });
  expect(mapped.get("Jo K <jo@corp.com>")).toEqual({ name: "Jo K", email: "jo@corp.com" });
  const local = join(repo.path, "local-mailmap");
  writeFileSync(local, "Jo Local <jo@local> Jo K <jo@corp.com>\n");
  expect((await mapThroughMailmap(repo.path, [joWork], local)).get("Jo K <jo@corp.com>")).toEqual({ name: "Jo Local", email: "jo@local" });
});

test("blame counts the lines at a commit by the commit that last wrote them", async () => {
  const repo = history();
  const head = repo.git("rev-parse", "HEAD");
  const blamed = await blameLineCounts(repo.path, head);
  expect(blamed.lines).toBe(6);
  expect(blamed.files).toBe(2);
  const shas = repo.git("log", "--format=%H", "--reverse").split("\n");
  // one wrote a1..a3, two wrote b1..b2, three wrote a4.
  expect(blamed.bySha.get(shas[0]!)).toBe(3);
  expect(blamed.bySha.get(shas[1]!)).toBe(2);
  expect(blamed.bySha.get(shas[2]!)).toBe(1);
});

test("excluded paths are not blamed", async () => {
  const repo = history();
  const blamed = await blameLineCounts(repo.path, repo.git("rev-parse", "HEAD"), { exclude: ["docs/**"] });
  expect(blamed.lines).toBe(4);
});

test("incremental blame output is read by header lines only", () => {
  const sha = "a".repeat(40);
  const into = new Map<string, number>();
  expect(parseIncrementalBlame(`${sha} 1 1 2\nauthor X\nsummary s\nfilename f\n\tline\n${sha} 5 3 1\n`, into)).toBe(3);
  expect(into.get(sha)).toBe(3);
});
