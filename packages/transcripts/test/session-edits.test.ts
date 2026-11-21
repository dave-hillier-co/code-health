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
