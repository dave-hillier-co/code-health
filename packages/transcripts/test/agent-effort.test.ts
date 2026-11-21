import { expect, test } from "vitest";
import { measureSession } from "../src/agent-effort.ts";
import { SyntheticSession, bash, edit, grep, read, write } from "./synthetic-transcript.ts";

const roots = ["/work/repo"];
const R = "/work/repo/";

function tasksOf(session: SyntheticSession) {
  const result = measureSession(session.toJsonl(), "session-1", roots);
  if (result.status !== "measured") throw new Error(result.reason);
  return result.tasks;
}

test("a task is one prompt and the agent turns up to the next prompt", () => {
  const tasks = tasksOf(
    new SyntheticSession()
      .prompt()
      .assistant("m1", [read(`${R}src/a.ts`)])
      .assistant("m2", [edit(`${R}src/a.ts`)])
      .prompt()
      .assistant("m3", [read(`${R}lib/b.ts`)])
      .assistant("m4", [edit(`${R}lib/b.ts`)]),
  );
  expect(tasks).toHaveLength(2);
  expect(tasks[0]).toMatchObject({ filesRead: 1, edits: 1, taskIndex: 0 });
  expect(tasks[1]).toMatchObject({ filesRead: 1, edits: 1, taskIndex: 1 });
});

test("tasks with no edits are dropped, and so are agent turns before the first prompt", () => {
  const tasks = tasksOf(
    new SyntheticSession()
      .assistant("m0", [edit(`${R}orphan.ts`)])
      .prompt()
      .assistant("m1", [read(`${R}a.ts`)])
      .prompt()
      .assistant("m2", [read(`${R}b.ts`), write(`${R}b.ts`)]),
  );
  expect(tasks.map((t) => t.taskIndex)).toEqual([1]);
});

test("an edit to a file outside the repo does not make a task", () => {
  const tasks = tasksOf(
    new SyntheticSession().prompt().assistant("m1", [read(`${R}a.ts`), edit("/home/me/.claude/plan.md")]),
  );
  expect(tasks).toEqual([]);
});

test("files read, re-reads and folders visited are counted per task", () => {
  const [task] = tasksOf(
    new SyntheticSession()
      .prompt()
      .assistant("m1", [read(`${R}src/a.ts`), read(`${R}src/b.ts`)])
      .assistant("m2", [read(`${R}src/a.ts`), read(`${R}lib/c.ts`), read(`${R}src/a.ts`)])
      .assistant("m3", [edit(`${R}docs/d.md`)]),
  );
  expect(task).toMatchObject({
    reads: 5,
    filesRead: 3,
    reReads: 2,
    foldersVisited: 3,
    edits: 1,
    filesEdited: 1,
  });
  expect(task?.readPaths).toEqual(["lib/c.ts", "src/a.ts", "src/b.ts"]);
  expect(task?.editedPaths).toEqual(["docs/d.md"]);
  expect(task?.folders).toEqual(["docs", "lib", "src"]);
});

test("reads outside the repo are dropped before counting", () => {
  const [task] = tasksOf(
    new SyntheticSession()
      .prompt()
      .assistant("m1", [read("/etc/hosts"), read(`${R}a.ts`), edit(`${R}a.ts`)]),
  );
  expect(task).toMatchObject({ reads: 1, filesRead: 1, foldersVisited: 1 });
});

test("repo root files live in the root folder, named by the empty string", () => {
  const [task] = tasksOf(new SyntheticSession().prompt().assistant("m1", [read(`${R}a.ts`), edit(`${R}b.ts`)]));
  expect(task?.folders).toEqual([""]);
});

test("searches and other tools do not count as reads", () => {
  const [task] = tasksOf(
    new SyntheticSession().prompt().assistant("m1", [grep(`${R}src`), bash("cat a.ts"), edit(`${R}a.ts`)]),
  );
  expect(task).toMatchObject({ reads: 0, searches: 1, edits: 1 });
});

test("tokens sum over the task's agent turns, each message counted once", () => {
  const [task] = tasksOf(
    new SyntheticSession()
      .prompt()
      .assistant("m1", [read(`${R}a.ts`), read(`${R}b.ts`)], { input: 10, output: 20, cacheRead: 100, cacheCreation: 1000 })
      .assistant("m2", [edit(`${R}a.ts`)], { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 }),
  );
  expect(task?.tokens).toEqual({ input: 11, output: 22, cacheRead: 103, cacheCreation: 1004, total: 1140 });
});

test("a task records when it started, taken from its prompt", () => {
  const [task] = tasksOf(
    new SyntheticSession().at("2026-03-05T10:00:00.000Z").prompt().assistant("m1", [edit(`${R}a.ts`)]),
  );
  expect(task?.startedAt).toBe("2026-03-05T10:00:00.000Z");
  expect(task?.sessionId).toBe("session-1");
});

test("an unrecognised version yields not measured with the version", () => {
  const result = measureSession(new SyntheticSession({ version: "4.0.0" }).prompt().toJsonl(), "s", roots);
  expect(result).toEqual({
    status: "not-measured",
    sessionId: "s",
    version: "4.0.0",
    reason: "unrecognised transcript version",
    startedAt: "2026-03-01T09:00:01.000Z",
  });
});

test("task records carry paths and counts only, never message text", () => {
  const [task] = tasksOf(
    new SyntheticSession().prompt("SECRET-PROMPT-TEXT").assistant("m1", [edit(`${R}a.ts`)]),
  );
  expect(JSON.stringify(task)).not.toContain("SECRET");
  expect(JSON.stringify(task)).not.toContain("synthetic reply");
});

test("searches outside the repo are not counted, searches of the repo and of the working directory are", () => {
  const session = new SyntheticSession()
    .prompt()
    .assistant("m1", [grep("/elsewhere/lib"), grep("/work/repo/src"), grep(), edit("/work/repo/a.ts")]);
  const result = measureSession(session.toJsonl(), "s", ["/work/repo"]);
  expect(result.status === "measured" && result.tasks[0]?.searches).toBe(2);
});
