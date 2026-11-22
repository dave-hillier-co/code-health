import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { encodeProjectDir, measureRepo } from "../src/measure-repo.ts";
import { parseWindow } from "../src/time-window.ts";
import { SyntheticSession, edit, read } from "./synthetic-transcript.ts";

const repo = "/work/my.repo";
const R = `${repo}/`;
let projects: string;

beforeEach(() => {
  projects = mkdtempSync(join(tmpdir(), "transcripts-"));
});
afterEach(() => {
  rmSync(projects, { recursive: true, force: true });
});

function addSession(root: string, id: string, session: SyntheticSession): void {
  const dir = join(projects, encodeProjectDir(root));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), session.toJsonl());
}

function simple(start: string, ...files: string[]): SyntheticSession {
  const session = new SyntheticSession({ cwd: repo, start });
  session.prompt();
  files.forEach((file, i) => session.assistant(`m${i}`, [read(`${R}${file}`), edit(`${R}${file}`)], { output: 10 }));
  return session;
}

const march = parseWindow("2026-03-01", "2026-04-01");

test("the project directory name replaces every non-alphanumeric character with a dash", () => {
  expect(encodeProjectDir("/Users/me/repos/code-health")).toBe("-Users-me-repos-code-health");
  expect(encodeProjectDir("/work/my.repo/.claude/worktrees/w1")).toBe("-work-my-repo--claude-worktrees-w1");
});

test("tasks come from every session of the repo, ordered by start time then session", () => {
  addSession(repo, "b", simple("2026-03-10T00:00:00.000Z", "a.ts"));
  addSession(repo, "a", simple("2026-03-02T00:00:00.000Z", "x/b.ts"));
  const report = measureRepo({ projectsDir: projects, repoRoots: [repo], window: march });
  expect(report.tasks.map((t) => t.sessionId)).toEqual(["a", "b"]);
  expect(report.sessions).toEqual({ measured: 2, notMeasured: [], subagents: { measured: 0, notMeasured: 0 } });
});

test("only tasks that started inside the window are kept", () => {
  addSession(repo, "s", simple("2026-02-28T23:00:00.000Z", "a.ts"));
  addSession(repo, "t", simple("2026-04-01T00:00:00.000Z", "a.ts"));
  addSession(repo, "u", simple("2026-03-15T00:00:00.000Z", "a.ts"));
  const report = measureRepo({ projectsDir: projects, repoRoots: [repo], window: march });
  expect(report.tasks.map((t) => t.sessionId)).toEqual(["u"]);
});

test("sessions in an unrecognised format are listed as not measured, if they fall in the window", () => {
  addSession(repo, "old", new SyntheticSession({ cwd: repo, version: "7.0.0", start: "2026-03-05T00:00:00.000Z" }).prompt());
  addSession(repo, "outside", new SyntheticSession({ cwd: repo, version: "7.0.0", start: "2026-06-05T00:00:00.000Z" }).prompt());
  const report = measureRepo({ projectsDir: projects, repoRoots: [repo], window: march });
  expect(report.tasks).toEqual([]);
  expect(report.sessions).toEqual({
    measured: 0,
    notMeasured: [{ sessionId: "old", version: "7.0.0", reason: "unrecognised transcript version" }],
    subagents: { measured: 0, notMeasured: 0 },
  });
});

test("worktree sessions of the same repo are read when their root is listed", () => {
  const worktree = `${repo}/.claude/worktrees/w1`;
  const session = new SyntheticSession({ cwd: worktree, start: "2026-03-03T00:00:00.000Z" }).prompt().assistant("m", [
    edit(`${worktree}/src/a.ts`),
  ]);
  addSession(worktree, "w", session);
  const report = measureRepo({ projectsDir: projects, repoRoots: [repo, worktree], window: march });
  expect(report.tasks[0]?.editedPaths).toEqual(["src/a.ts"]);
});

test("another repo's sessions are never read", () => {
  addSession("/work/other", "o", simple("2026-03-03T00:00:00.000Z", "a.ts"));
  const report = measureRepo({ projectsDir: projects, repoRoots: [repo], window: march });
  expect(report.tasks).toEqual([]);
});

test("a missing projects directory gives an empty report", () => {
  const report = measureRepo({ projectsDir: join(projects, "absent"), repoRoots: [repo], window: march });
  expect(report.tasks).toEqual([]);
  expect(report.sessions.measured).toBe(0);
});

test("the summary states the sample size and rounds to two places", () => {
  addSession(repo, "a", simple("2026-03-02T00:00:00.000Z", "a.ts"));
  addSession(repo, "b", simple("2026-03-03T00:00:00.000Z", "a.ts", "b.ts", "c.ts"));
  const { summary } = measureRepo({ projectsDir: projects, repoRoots: [repo], window: march });
  expect(summary.tasks).toBe(2);
  expect(summary.filesRead).toEqual({ mean: 2, median: 2 });
  expect(summary.tokens).toEqual({ mean: 20, median: 20 });
});

test("means round to two places and the median of an even sample is the midpoint", () => {
  addSession(repo, "a", simple("2026-03-02T00:00:00.000Z", "a.ts"));
  addSession(repo, "b", simple("2026-03-03T00:00:00.000Z", "a.ts"));
  addSession(repo, "c", simple("2026-03-04T00:00:00.000Z", "a.ts", "b.ts"));
  expect(measureRepo({ projectsDir: projects, repoRoots: [repo], window: march }).summary.filesRead).toEqual({
    mean: 1.33,
    median: 1,
  });
  addSession(repo, "d", simple("2026-03-05T00:00:00.000Z", "a.ts", "b.ts", "c.ts"));
  expect(measureRepo({ projectsDir: projects, repoRoots: [repo], window: march }).summary.filesRead).toEqual({
    mean: 1.75,
    median: 1.5,
  });
});

test("an empty selection summarises to a sample size of zero and no statistics", () => {
  const { summary } = measureRepo({ projectsDir: join(projects, "absent"), repoRoots: [repo], window: march });
  expect(summary).toEqual({
    tasks: 0,
    filesRead: null,
    foldersVisited: null,
    reReads: null,
    edits: null,
    tokens: null,
  });
});

test("the report records its window and is stable across runs", () => {
  addSession(repo, "a", simple("2026-03-02T00:00:00.000Z", "a.ts"));
  const first = measureRepo({ projectsDir: projects, repoRoots: [repo], window: march });
  const second = measureRepo({ projectsDir: projects, repoRoots: [repo], window: march });
  expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  expect(first.window).toEqual({ from: "2026-03-01", to: "2026-04-01" });
});

test("a sibling repo whose directory name encodes the same is not attributed to this repo", () => {
  expect(encodeProjectDir("/work/my-repo")).toBe(encodeProjectDir("/work/my.repo"));
  const stranger = new SyntheticSession({ cwd: "/work/my-repo", start: "2026-03-03T00:00:00.000Z" })
    .prompt()
    .assistant("m", [edit("/work/my-repo/a.ts")]);
  addSession(repo, "stranger", stranger);
  addSession(repo, "mine", simple("2026-03-04T00:00:00.000Z", "a.ts"));
  const report = measureRepo({ projectsDir: projects, repoRoots: [repo], window: march });
  expect(report.tasks.map((t) => t.sessionId)).toEqual(["mine"]);
});

test("files that are not session transcripts, and unreadable ones, are ignored", () => {
  addSession(repo, "good", simple("2026-03-04T00:00:00.000Z", "a.ts"));
  const dir = join(projects, encodeProjectDir(repo));
  writeFileSync(join(dir, "notes.txt"), "not a transcript");
  mkdirSync(join(dir, "subdir.jsonl"));
  const report = measureRepo({ projectsDir: projects, repoRoots: [repo], window: march });
  expect(report.tasks.map((t) => t.sessionId)).toEqual(["good"]);
});

test("ties at the same start time are ordered by session id whatever order files were written in", () => {
  for (const id of ["c", "a", "b"]) addSession(repo, id, simple("2026-03-04T00:00:00.000Z", "a.ts"));
  const report = measureRepo({ projectsDir: projects, repoRoots: [repo], window: march });
  expect(report.tasks.map((t) => t.sessionId)).toEqual(["a", "b", "c"]);
});

test("not-measured sessions are listed in session order whatever order files were written in", () => {
  for (const id of ["z", "m", "a"]) {
    addSession(repo, id, new SyntheticSession({ cwd: repo, version: "7.0.0", start: "2026-03-05T00:00:00.000Z" }).prompt());
  }
  const report = measureRepo({ projectsDir: projects, repoRoots: [repo], window: march });
  expect(report.sessions.notMeasured.map((n) => n.sessionId)).toEqual(["a", "m", "z"]);
});
