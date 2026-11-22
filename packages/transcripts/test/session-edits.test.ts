import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { encodeProjectDir } from "../src/measure-repo.ts";
import { readRepoSessionEdits, readSessionEdits } from "../src/session-edits.ts";
import { parseWindow } from "../src/time-window.ts";
import { SyntheticSession, edit, read, write } from "./synthetic-transcript.ts";

const roots = ["/work/repo"];
const R = "/work/repo/";

test("edits come out in order, one per call, as repo paths, and reads and outside edits are left out", () => {
  const session = new SyntheticSession()
    .prompt()
    .assistant("m1", [read(`${R}src/a.ts`), edit(`${R}src/b.ts`)])
    .assistant("m2", [edit("/home/me/notes.md"), write(`${R}src/a.ts`), edit(`${R}src/b.ts`)]);
  const result = readSessionEdits(session.toJsonl(), "s1", roots);
  expect(result).toMatchObject({ sessionId: "s1", edits: ["src/b.ts", "src/a.ts", "src/b.ts"] });
});

test("a session with no edit to the repo, or an unrecognised version, has no edits to report", () => {
  expect(readSessionEdits(new SyntheticSession().prompt().assistant("m1", [read(`${R}a.ts`)]).toJsonl(), "s", roots)).toBeNull();
  const odd = new SyntheticSession({ version: "9.0.0" }).prompt().assistant("m1", [edit(`${R}a.ts`)]);
  expect(readSessionEdits(odd.toJsonl(), "s", roots)).toBeNull();
});

const directories: string[] = [];
afterAll(() => directories.forEach((d) => rmSync(d, { recursive: true, force: true })));

test("a repo's sessions are those whose directory and recorded working directory match, within the window, by session id", () => {
  const projects = mkdtempSync(join(tmpdir(), "code-health-edits-"));
  directories.push(projects);
  const dir = join(projects, encodeProjectDir("/work/repo"));
  mkdirSync(dir, { recursive: true });
  const put = (id: string, session: SyntheticSession) => writeFileSync(join(dir, `${id}.jsonl`), session.toJsonl());
  put("b", new SyntheticSession({ start: "2026-03-02T09:00:00.000Z" }).prompt().assistant("m", [edit(`${R}x.ts`)]));
  put("a", new SyntheticSession({ start: "2026-03-03T09:00:00.000Z" }).prompt().assistant("m", [edit(`${R}y.ts`)]));
  put("late", new SyntheticSession({ start: "2026-05-03T09:00:00.000Z" }).prompt().assistant("m", [edit(`${R}z.ts`)]));
  put("elsewhere", new SyntheticSession({ start: "2026-03-03T09:00:00.000Z", cwd: "/other/place" }).prompt().assistant("m", [edit("/other/place/q.ts")]));
  const sessions = readRepoSessionEdits({ projectsDir: projects, repoRoots: roots, window: parseWindow("2026-03-01", "2026-04-01") });
  expect(sessions.map((s) => [s.sessionId, s.edits])).toEqual([
    ["a", ["y.ts"]],
    ["b", ["x.ts"]],
  ]);
});

test("a truncated last line, as a session cut off mid-write leaves, does not lose the edits before it", () => {
  const session = new SyntheticSession().prompt().assistant("m1", [edit(`${R}src/a.ts`)]).raw('{"type":"assistant","message":{"id":"m2","content":[{"type":"tool_use","na');
  expect(readSessionEdits(session.toJsonl(), "cut", roots)).toMatchObject({ edits: ["src/a.ts"] });
});

test("an edit named by a relative path is taken as relative to the repo, as a tool call is, unless it climbs out of it", () => {
  const session = new SyntheticSession().prompt().assistant("m1", [edit("src/relative.ts"), edit("../outside.ts"), edit(`${R}src/a.ts`)]);
  expect(readSessionEdits(session.toJsonl(), "relative", roots)?.edits).toEqual(["src/relative.ts", "src/a.ts"]);
});

test("edits made inside a subagent (a sidechain) are the subagent's, not the session's", () => {
  const session = new SyntheticSession().prompt().assistant("m1", [edit(`${R}src/a.ts`)]);
  session.raw(
    JSON.stringify({
      type: "assistant",
      uuid: "side-1",
      timestamp: "2026-03-01T09:00:30.000Z",
      sessionId: "session-1",
      cwd: "/work/repo",
      isSidechain: true,
      version: "2.1.330",
      message: { id: "side", role: "assistant", content: [{ type: "tool_use", id: "t", name: "Edit", input: { file_path: `${R}src/sub.ts` } }], usage: {} },
    }),
  );
  expect(readSessionEdits(session.toJsonl(), "side", roots)?.edits).toEqual(["src/a.ts"]);
});

test("a repository reached through a symlinked root is the same repository once both spellings are given as roots", () => {
  const session = new SyntheticSession({ cwd: "/link/repo" }).prompt().assistant("m1", [edit("/link/repo/src/a.ts")]);
  expect(readSessionEdits(session.toJsonl(), "link", ["/work/repo"])).toBeNull();
  expect(readSessionEdits(session.toJsonl(), "link", ["/work/repo", "/link/repo"])?.edits).toEqual(["src/a.ts"]);
});

test("the same session id in two project directories is read once per file, not merged away", () => {
  const projects = mkdtempSync(join(tmpdir(), "code-health-edits-dup-"));
  directories.push(projects);
  for (const root of ["/work/repo", "/work/repo/.claude/worktrees/w"]) {
    const dir = join(projects, encodeProjectDir(root));
    mkdirSync(dir, { recursive: true });
    const session = new SyntheticSession({ cwd: root, sessionId: "dup", start: "2026-03-02T09:00:00.000Z" }).prompt().assistant("m", [edit(`${root}/src/a.ts`)]);
    writeFileSync(join(dir, "dup.jsonl"), session.toJsonl());
  }
  const sessions = readRepoSessionEdits({ projectsDir: projects, repoRoots: ["/work/repo", "/work/repo/.claude/worktrees/w"], window: parseWindow("2026-03-01", "2026-04-01") });
  expect(sessions.map((s) => [s.sessionId, s.edits])).toEqual([
    ["dup", ["src/a.ts"]],
    ["dup", ["src/a.ts"]],
  ]);
});
