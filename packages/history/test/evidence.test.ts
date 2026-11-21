import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { GitFixture, type Change, type Step } from "@code-health/fixtures/git-fixture";
import { analyseHistory, monthsBefore, type EvidenceThresholds } from "../src/evidence.ts";
import { refresh } from "../src/refresh.ts";

// Fixture repos run real processes many times, which is slow on a loaded machine.
vi.setConfig({ testTimeout: 180_000 });

const fixtures: GitFixture[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function build(steps: Step[]) {
  const f = GitFixture.build(steps);
  fixtures.push(f);
  return f;
}

const alice = { name: "Alice", email: "alice@example.com" };
const bob = { name: "Bob", email: "bob@example.com" };

function edit(date: string, path: string, n: number, author = alice): Step {
  return { type: "commit", message: `edit ${path} ${n}`, date, author, changes: [{ op: "add", path, content: `${n}\n` }] };
}

const thresholds: EvidenceThresholds = {
  strong: { months: 12, logicalChanges: 6, contributors: 2 },
  moderate: { months: 3, logicalChanges: 3, contributors: 1 },
};

test("months are counted back from the head commit's date, not the wall clock", () => {
  const anchor = Date.parse("2024-03-31T00:00:00Z") / 1000;
  expect(new Date(monthsBefore(anchor, 1) * 1000).toISOString().slice(0, 7)).toBe("2024-03");
  expect(new Date(monthsBefore(Date.parse("2024-06-15T00:00:00Z") / 1000, 12) * 1000).toISOString().slice(0, 10)).toBe("2023-06-15");
});

test("a long, busy, multi-author history grades strong", async () => {
  const steps: Step[] = [];
  for (let i = 0; i < 8; i++) {
    const month = String(i + 1).padStart(2, "0");
    steps.push(edit(`2023-${month}-10T10:00:00Z`, `f${i}`, i, i % 2 ? bob : alice));
  }
  steps.push(edit("2024-02-10T10:00:00Z", "last", 1, bob), edit("2024-03-10T10:00:00Z", "last2", 1, alice));
  const repo = build(steps);
  await refresh(repo.path);
  const { evidence } = await analyseHistory(repo.path, { evidence: { thresholds, windowMonths: 12 } });
  expect(evidence.usableHistoryMonths).toBeGreaterThanOrEqual(12);
  // the January and February 2023 commits fall before the 12 month window
  expect(evidence.logicalChangesInWindow).toBe(8);
  expect(evidence.activeContributors).toBe(2);
  expect(evidence.grade).toBe("strong");
  expect(evidence.truncated).toEqual({ shallow: false, boundaryCommits: 0, availableSince: null });
  expect(evidence.window.until).toBe(Date.parse("2024-03-10T10:00:00Z") / 1000);
});

test("grade falls back to moderate and weak as evidence thins", async () => {
  const repo = build([
    edit("2024-01-01T10:00:00Z", "a", 1),
    edit("2024-03-01T10:00:00Z", "b", 1),
    edit("2024-05-01T10:00:00Z", "c", 1),
  ]);
  await refresh(repo.path);
  const moderate = await analyseHistory(repo.path, { evidence: { thresholds } });
  expect(moderate.evidence.grade).toBe("moderate");
  const weak = await analyseHistory(repo.path, {
    evidence: { thresholds: { ...thresholds, moderate: { months: 6, logicalChanges: 3, contributors: 1 } } },
  });
  expect(weak.evidence.grade).toBe("weak");
});

test("only changes inside the window count, but usable history is not clipped to it", async () => {
  const repo = build([edit("2022-01-01T10:00:00Z", "a", 1), edit("2024-05-01T10:00:00Z", "b", 1, bob)]);
  await refresh(repo.path);
  const { evidence } = await analyseHistory(repo.path, { evidence: { windowMonths: 3 } });
  expect(evidence.logicalChangesInWindow).toBe(1);
  expect(evidence.activeContributors).toBe(1);
  expect(evidence.usableHistoryMonths).toBeGreaterThan(24);
});

test("bots and filtered-out noise do not count as contributors or changes", async () => {
  const bot = { name: "renovate[bot]", email: "bot@example.com" };
  const repo = build([edit("2024-01-01T10:00:00Z", "a", 1), edit("2024-01-02T10:00:00Z", "b", 1, bot)]);
  await refresh(repo.path);
  const { evidence } = await analyseHistory(repo.path, { noise: { botPatterns: ["\\[bot\\]"] } });
  expect(evidence.logicalChangesInWindow).toBe(1);
  expect(evidence.activeContributors).toBe(1);
});

test("an imported first commit does not extend the usable history", async () => {
  const bulk: Change[] = Array.from({ length: 25 }, (_, i) => ({ op: "add", path: `legacy/f${i}`, content: "x\n" }));
  const repo = build([
    { type: "commit", message: "Initial import", date: "2015-01-01T00:00:00Z", changes: bulk },
    edit("2024-01-01T10:00:00Z", "new1", 1),
    edit("2024-02-01T10:00:00Z", "new2", 1),
  ]);
  await refresh(repo.path);
  const { evidence } = await analyseHistory(repo.path);
  expect(evidence.importedHistory).toHaveLength(1);
  expect(evidence.usableHistoryMonths).toBeLessThan(2);
});

test("a shallow clone reports its truncated window", async () => {
  const source = build([
    edit("2024-01-01T10:00:00Z", "a", 1),
    edit("2024-02-01T10:00:00Z", "b", 1),
    edit("2024-03-01T10:00:00Z", "c", 1),
    edit("2024-04-01T10:00:00Z", "d", 1),
  ]);
  const dir = mkdtempSync(join(tmpdir(), "code-health-clone-"));
  dirs.push(dir);
  const clone = join(dir, "clone");
  execFileSync("git", ["clone", "--quiet", "--depth=2", `file://${source.path}`, clone], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  const path = realpathSync(clone);
  await refresh(path);
  const { evidence, filtersApplied } = await analyseHistory(path);
  expect(evidence.truncated.shallow).toBe(true);
  expect(evidence.truncated.boundaryCommits).toBe(1);
  expect(evidence.truncated.availableSince).toBe(Date.parse("2024-03-01T10:00:00Z") / 1000);
  // the boundary commit's bogus "added everything" change is not evidence
  expect(filtersApplied.dropped.shallowBoundaryCommits).toBe(1);
  expect(evidence.logicalChangesInWindow).toBe(1);
});
