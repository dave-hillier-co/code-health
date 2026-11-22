import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { encodeProjectDir, measureRepo } from "../src/measure-repo.ts";
import { toRepoPath } from "../src/repo-path.ts";
import { parseWindow } from "../src/time-window.ts";
import { SyntheticSession, edit, read, type ToolCallSpec } from "./synthetic-transcript.ts";

const repo = "/work/app";
const march = parseWindow("2026-03-01", "2026-04-01");
let projects: string;

beforeEach(() => {
  projects = mkdtempSync(join(tmpdir(), "transcripts-subagents-"));
});
afterEach(() => {
  rmSync(projects, { recursive: true, force: true });
});

function mainSession(id: string, session: SyntheticSession): void {
  const dir = join(projects, encodeProjectDir(repo));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), session.toJsonl());
}

function subagent(sessionId: string, agentId: string, session: SyntheticSession, meta?: Record<string, unknown>, nested = ""): void {
  const dir = join(projects, encodeProjectDir(repo), sessionId, "subagents", nested);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${agentId}.jsonl`), session.toJsonl());
  if (meta !== undefined) writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
}

function agent(cwd: string, start: string, calls: ToolCallSpec[], tokens = 100): SyntheticSession {
  return new SyntheticSession({ cwd, start, sidechain: true }).prompt("Do the work").assistant("a1", calls, { input: tokens });
}

const measure = (source?: "main" | "subagent" | "all") => measureRepo({ projectsDir: projects, repoRoots: [repo], window: march, source });

test("one subagent file is one task, measured from its sidechain lines", () => {
  const session = new SyntheticSession({ cwd: repo, start: "2026-03-02T00:00:00.000Z", sidechain: true })
    .prompt("Do the work")
    .assistant("a1", [read(`${repo}/src/a.ts`), read(`${repo}/src/a.ts`), edit(`${repo}/src/a.ts`)], { input: 40 })
    .prompt("A follow-up message")
    .assistant("a2", [read(`${repo}/lib/b.ts`), edit(`${repo}/lib/b.ts`)], { input: 60 });
  subagent("s1", "x1", session, { agentType: "Explore", description: "Tidy the parsers" });
  const [task, ...rest] = measure("subagent").tasks;
  expect(rest).toEqual([]);
  expect(task).toMatchObject({
    source: "subagent",
    sessionId: "s1",
    agentId: "x1",
    agentType: "Explore",
    description: "Tidy the parsers",
    taskIndex: 0,
    reads: 3,
    filesRead: 2,
    reReads: 1,
    edits: 2,
    editedPaths: ["lib/b.ts", "src/a.ts"],
    folders: ["lib", "src"],
  });
  expect(task?.tokens.total).toBe(100);
});

test("a subagent with no meta file has no agent type or description, and nested folders are found", () => {
  subagent("s1", "x1", agent(repo, "2026-03-02T00:00:00.000Z", [edit(`${repo}/a.ts`)]), undefined, "workflows/w1");
  const [task] = measure("subagent").tasks;
  expect(task).toMatchObject({ source: "subagent", agentType: null, description: null });
});

test("sidechain lines are skipped in main sessions and main lines in subagent files, so nothing counts twice", () => {
  const main = new SyntheticSession({ cwd: repo, start: "2026-03-02T00:00:00.000Z" }).prompt().assistant("m1", [edit(`${repo}/a.ts`)], { input: 10 });
  main.raw(
    JSON.stringify({
      type: "assistant",
      isSidechain: true,
      version: "2.1.330",
      timestamp: "2026-03-02T00:01:00.000Z",
      cwd: repo,
      message: { id: "side", content: [{ type: "tool_use", name: "Edit", input: { file_path: `${repo}/side.ts` } }], usage: { input_tokens: 999 } },
    }),
  );
  mainSession("s1", main);
  subagent("s1", "x1", agent(repo, "2026-03-02T00:00:00.000Z", [edit(`${repo}/b.ts`)]));
  const all = measure();
  expect(all.tasks.map((t) => [t.source, t.editedPaths])).toEqual([
    ["main", ["a.ts"]],
    ["subagent", ["b.ts"]],
  ]);
  expect(measure("main").tasks.map((t) => t.source)).toEqual(["main"]);
  expect(measure("subagent").tasks.map((t) => t.source)).toEqual(["subagent"]);
  expect(all.summary.tasks).toBe(2);
});

test("the source defaults to all", () => {
  mainSession("s1", new SyntheticSession({ cwd: repo, start: "2026-03-02T00:00:00.000Z" }).prompt().assistant("m1", [edit(`${repo}/a.ts`)]));
  subagent("s1", "x1", agent(repo, "2026-03-03T00:00:00.000Z", [edit(`${repo}/b.ts`)]));
  expect(measure().tasks).toHaveLength(2);
});

test("paths in a worktree that no longer exists map to the repo, by the path rule and the meta worktree path", () => {
  const gone = `${repo}/.claude/worktrees/wt-1`;
  expect(toRepoPath(`${gone}/src/a.ts`, [repo])).toBe("src/a.ts");
  expect(toRepoPath(gone, [repo])).toBeNull();
  const elsewhere = "/scratch/checkouts/wt-2";
  subagent("s1", "x1", agent(gone, "2026-03-02T00:00:00.000Z", [read(`${gone}/src/a.ts`), edit(`${gone}/src/a.ts`), edit(`${gone}/lib/b.ts`)]));
  subagent("s1", "x2", agent(elsewhere, "2026-03-02T01:00:00.000Z", [edit(`${elsewhere}/src/a.ts`)]), { worktreePath: elsewhere });
  const tasks = measure("subagent").tasks;
  expect(tasks.map((t) => t.editedPaths)).toEqual([["lib/b.ts", "src/a.ts"], ["src/a.ts"]]);
  expect(tasks[0]?.readPaths).toEqual(["src/a.ts"]);
});

test("a subagent whose cwd is another repo is not read", () => {
  subagent("s1", "x1", agent("/work/other", "2026-03-02T00:00:00.000Z", [edit("/work/other/a.ts")]));
  expect(measure("subagent").tasks).toEqual([]);
});

test("subagent files are counted as measured or not measured in the sessions summary", () => {
  subagent("s1", "x1", agent(repo, "2026-03-02T00:00:00.000Z", [edit(`${repo}/a.ts`)]));
  subagent("s1", "x2", agent(repo, "2026-03-02T00:00:00.000Z", [read(`${repo}/a.ts`)]));
  subagent("s1", "x3", new SyntheticSession({ cwd: repo, version: "7.0.0", start: "2026-03-05T00:00:00.000Z", sidechain: true }).prompt());
  const { sessions } = measure("subagent");
  expect(sessions).toEqual({ measured: 0, notMeasured: [], subagents: { measured: 1, notMeasured: 1 } });
  expect(measure("main").sessions.subagents).toEqual({ measured: 0, notMeasured: 0 });
});

test("subagent tasks are ordered by start time, then session and agent id", () => {
  for (const id of ["c", "a", "b"]) subagent("s1", id, agent(repo, "2026-03-04T00:00:00.000Z", [edit(`${repo}/a.ts`)]));
  expect(measure("subagent").tasks.map((t) => t.agentId)).toEqual(["a", "b", "c"]);
});
