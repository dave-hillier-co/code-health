import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { measureSession, measureSubagent } from "../src/agent-effort.ts";
import { encodeProjectDir, measureRepo, summariseTasks } from "../src/measure-repo.ts";
import { readSessionEdits } from "../src/session-edits.ts";
import { parseTranscript } from "../src/transcript-format.ts";
import { parseWindow } from "../src/time-window.ts";
import { SyntheticSession, bash, edit, grep, read } from "./synthetic-transcript.ts";

const roots = ["/work/repo"];
const R = "/work/repo/";

function tasksOf(session: SyntheticSession, mode: "tools" | "all" = "all") {
  const result = measureSession(session.toJsonl(), "session-1", roots, mode);
  if (result.status !== "measured") throw new Error(result.reason);
  return result.tasks;
}

test("agents that only edit through the shell have edits, and their reads count", () => {
  const [task] = tasksOf(
    new SyntheticSession()
      .prompt()
      .assistant("m1", [bash("cat src/a.ts"), bash("head -20 src/b.ts && grep -n x src/c.ts")])
      .assistant("m2", [bash("sed -i 's/a/b/' src/a.ts"), bash("cat > src/new.ts <<'EOF'\nexport const x = 1;\nEOF")]),
  );
  expect(task).toMatchObject({ filesRead: 3, reads: 3, reReads: 0, edits: 2, filesEdited: 2, shellCalls: 4, unparsedShellCalls: 0 });
  expect(task?.editedPaths).toEqual(["src/a.ts", "src/new.ts"]);
  expect(task?.readPaths).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  expect(task?.tool).toEqual({ reads: 0, filesRead: 0, reReads: 0, searches: 0, edits: 0 });
  expect(task?.shell).toEqual({ reads: 3, filesRead: 3, reReads: 0, searches: 0, edits: 2 });
});

test("with the tools effort mode a shell-only task has no edits and is left out, but a mixed task keeps only tool counts", () => {
  const shellOnly = new SyntheticSession().prompt().assistant("m1", [bash("cat src/a.ts"), bash("sed -i 's/a/b/' src/a.ts")]);
  expect(tasksOf(shellOnly, "tools")).toEqual([]);

  const mixed = new SyntheticSession()
    .prompt()
    .assistant("m1", [read(`${R}src/a.ts`), bash("cat src/b.ts"), edit(`${R}src/a.ts`), bash("sed -i 's/a/b/' src/c.ts")]);
  const [tools] = tasksOf(mixed, "tools");
  const [all] = tasksOf(mixed, "all");
  expect(tools).toMatchObject({ effortMode: "tools", filesRead: 1, edits: 1, shellCalls: 2 });
  expect(tools?.editedPaths).toEqual(["src/a.ts"]);
  expect(all).toMatchObject({ effortMode: "all", filesRead: 2, edits: 2 });
  expect(all?.editedPaths).toEqual(["src/a.ts", "src/c.ts"]);
  // The parts are the same in both modes.
  expect(tools?.tool).toEqual(all?.tool);
  expect(tools?.shell).toEqual(all?.shell);
  expect(all?.tool).toEqual({ reads: 1, filesRead: 1, reReads: 0, searches: 0, edits: 1 });
  expect(all?.shell).toEqual({ reads: 1, filesRead: 1, reReads: 0, searches: 0, edits: 1 });
});

test("the mode defaults to all", () => {
  const result = measureSession(new SyntheticSession().prompt().assistant("m1", [bash("sed -i 's/a/b/' a.ts")]).toJsonl(), "s", roots);
  expect(result.status === "measured" && result.tasks).toHaveLength(1);
});

test("a file read through a tool and through the shell counts once as a file and once more as a re-read", () => {
  const [task] = tasksOf(
    new SyntheticSession().prompt().assistant("m1", [read(`${R}a.ts`), bash("cat a.ts"), bash("cat a.ts"), edit(`${R}a.ts`)]),
  );
  expect(task).toMatchObject({ reads: 3, filesRead: 1, reReads: 2 });
  expect(task?.tool).toMatchObject({ reads: 1, filesRead: 1, reReads: 0 });
  expect(task?.shell).toMatchObject({ reads: 2, filesRead: 1, reReads: 1 });
});

test("a glob in a command is a search, not a read", () => {
  const [task] = tasksOf(new SyntheticSession().prompt().assistant("m1", [bash("cat src/*.ts"), bash("grep -rn x src"), grep(`${R}src`), edit(`${R}a.ts`)]));
  expect(task).toMatchObject({ reads: 0, filesRead: 0, searches: 3 });
  expect(task?.shell).toMatchObject({ searches: 2, reads: 0 });
});

test("compound commands count every command they hold", () => {
  const [task] = tasksOf(
    new SyntheticSession()
      .prompt()
      .assistant("m1", [
        bash("cat a.ts | grep x && sed -n 1,5p b.ts; for f in c.ts d.ts; do sed -i 's/x/y/' $f; done"),
        bash("(cd lib && cat e.ts) && rm old.ts"),
      ]),
  );
  expect(task?.readPaths).toEqual(["a.ts", "b.ts", "lib/e.ts"]);
  expect(task?.editedPaths).toEqual(["c.ts", "d.ts", "old.ts"]);
});

test("relative paths resolve against the cwd of the line and a literal cd", () => {
  const [task] = tasksOf(
    new SyntheticSession({ cwd: "/work/repo/packages/x" })
      .prompt()
      .assistant("m1", [bash("cat src/a.ts"), bash("cd ../y && sed -i 's/a/b/' src/b.ts"), bash("cat ../../README.md")]),
  );
  expect(task?.readPaths).toEqual(["README.md", "packages/x/src/a.ts"]);
  expect(task?.editedPaths).toEqual(["packages/y/src/b.ts"]);
});

test("paths in a Claude Code worktree map to the same file in the repo", () => {
  const session = new SyntheticSession({ cwd: "/work/repo/.claude/worktrees/wip-a" })
    .prompt()
    .assistant("m1", [bash("cat src/a.ts"), bash("sed -i 's/a/b/' /work/repo/.claude/worktrees/wip-a/src/a.ts")]);
  const [task] = tasksOf(session);
  expect(task?.readPaths).toEqual(["src/a.ts"]);
  expect(task?.editedPaths).toEqual(["src/a.ts"]);
});

test("a subagent's deleted worktree, found from its recorded cwd, maps to the repo", () => {
  const text = new SyntheticSession({ cwd: "/elsewhere/repo/.claude/worktrees/gone", sidechain: true })
    .prompt()
    .assistant("m1", [bash("cat src/a.ts"), bash("echo x > src/b.ts")])
    .toJsonl();
  const result = measureSubagent(text, "s", "agent-1", roots, null);
  const task = result.status === "measured" ? result.tasks[0] : undefined;
  expect(task?.readPaths).toEqual(["src/a.ts"]);
  expect(task?.editedPaths).toEqual(["src/b.ts"]);
});

test("paths outside the repo, under .git and in node_modules are not counted", () => {
  const [task] = tasksOf(
    new SyntheticSession()
      .prompt()
      .assistant("m1", [
        bash("cat /etc/hosts /home/me/.claude/plan.md ~/notes.md node_modules/x/index.js .git/config"),
        bash("echo x > /tmp/out.txt && sed -i 's/a/b/' /home/me/other/file.ts"),
        bash("cd /tmp && cat a.ts && grep -rn x /opt/project"),
        bash("echo x > in-repo.txt"),
      ]),
  );
  expect(task).toMatchObject({ reads: 0, filesRead: 0, searches: 0, edits: 1, shellCalls: 4, unparsedShellCalls: 0 });
  expect(task?.editedPaths).toEqual(["in-repo.txt"]);
});

test("a task whose only shell edit is outside the repo is not a task", () => {
  expect(tasksOf(new SyntheticSession().prompt().assistant("m1", [bash("echo x > /tmp/out.txt"), bash("cat a.ts")]))).toEqual([]);
});

test("commands that cannot be parsed are counted and contribute no path", () => {
  const [task] = tasksOf(
    new SyntheticSession()
      .prompt()
      .assistant("m1", [
        bash("cat $(git ls-files | head -1)"),
        bash("cat a.ts && cat $UNSET"),
        bash("git ls-files | xargs sed -i s/a/b/"),
        bash("python3 -c \"open('x.ts','w').write('1')\""),
        bash("cat parsed.ts"),
        bash("npm test"),
        edit(`${R}b.ts`),
      ]),
  );
  expect(task).toMatchObject({ shellCalls: 6, unparsedShellCalls: 4, filesRead: 1, edits: 1 });
  expect(task?.readPaths).toEqual(["parsed.ts"]);
});

test("a Bash call with no command string is unparsed", () => {
  const session = new SyntheticSession().prompt().assistant("m1", [{ name: "Bash", input: {} }, edit(`${R}a.ts`)]);
  const [task] = tasksOf(session);
  expect(task).toMatchObject({ shellCalls: 1, unparsedShellCalls: 1 });
});

test("the shell counts of a turn are on the event, and only paths and counts leave the parser", () => {
  const parsed = parseTranscript(new SyntheticSession().prompt().assistant("m1", [bash("cat a.ts"), bash("cat $X")]).toJsonl());
  const turn = parsed.status === "recognised" ? parsed.events[1] : undefined;
  expect(turn).toMatchObject({ shell: { calls: 2, unparsed: 1 }, actions: [{ kind: "read", origin: "shell", path: "/work/repo/a.ts" }] });
  expect(JSON.stringify(turn)).not.toContain("cat");
});

test("a subagent that edits only through the shell is a task", () => {
  const text = new SyntheticSession({ sidechain: true })
    .prompt("do it")
    .assistant("a1", [bash("cat src/a.ts"), bash("sed -i 's/a/b/' src/a.ts")])
    .toJsonl();
  const all = measureSubagent(text, "s", "agent-1", roots, null, "all");
  expect(all.status === "measured" && all.tasks).toHaveLength(1);
  expect(all.status === "measured" && all.tasks[0]).toMatchObject({ source: "subagent", filesRead: 1, edits: 1, shellCalls: 2 });
  const tools = measureSubagent(text, "s", "agent-1", roots, null, "tools");
  expect(tools.status === "measured" && tools.tasks).toEqual([]);
});

test("the summary gives the Bash calls and the share that parsed", () => {
  const tasks = tasksOf(
    new SyntheticSession()
      .prompt()
      .assistant("m1", [bash("cat a.ts"), bash("cat b.ts"), bash("cat $X"), bash("echo x > c.txt")])
      .prompt()
      .assistant("m2", [bash("cat d.ts"), bash("echo x > e.txt")]),
  );
  expect(summariseTasks(tasks).shell).toEqual({ calls: 6, unparsed: 1, parsedShare: 0.833 });
  expect(summariseTasks([]).shell).toEqual({ calls: 0, unparsed: 0, parsedShare: null });
});

test("session edits use the files edited through the shell, and leave them out in tools mode", () => {
  const text = new SyntheticSession().prompt().assistant("m1", [edit(`${R}a.ts`), bash("sed -i 's/a/b/' b.ts"), bash("mv c.ts d.ts")]).toJsonl();
  expect(readSessionEdits(text, "s", roots)?.edits).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
  expect(readSessionEdits(text, "s", roots, "tools")?.edits).toEqual(["a.ts"]);
  const shellOnly = new SyntheticSession().prompt().assistant("m1", [bash("echo x > a.ts")]).toJsonl();
  expect(readSessionEdits(shellOnly, "s", roots, "tools")).toBeNull();
});

test("a repo is measured with the effort option, and the tasks say which mode they were measured in", () => {
  const projects = mkdtempSync(join(tmpdir(), "shell-effort-"));
  try {
    const repo = "/work/my.repo";
    const dir = join(projects, encodeProjectDir(repo));
    mkdirSync(dir, { recursive: true });
    const session = new SyntheticSession({ cwd: repo, start: "2026-03-02T00:00:00.000Z" })
      .prompt()
      .assistant("m1", [bash("cat src/a.ts"), bash("sed -i 's/a/b/' src/a.ts src/b.ts")]);
    writeFileSync(join(dir, "s.jsonl"), session.toJsonl());
    const window = parseWindow("2026-03-01", "2026-04-01");
    const all = measureRepo({ projectsDir: projects, repoRoots: [repo], window });
    expect(all.tasks).toHaveLength(1);
    expect(all.tasks[0]).toMatchObject({ effortMode: "all", filesRead: 1, edits: 2, filesEdited: 2 });
    expect(all.summary.shell).toEqual({ calls: 2, unparsed: 0, parsedShare: 1 });
    const tools = measureRepo({ projectsDir: projects, repoRoots: [repo], window, effort: "tools" });
    expect(tools.tasks).toEqual([]);
  } finally {
    rmSync(projects, { recursive: true, force: true });
  }
});
