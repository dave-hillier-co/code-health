import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { runHook } from "../src/hook.ts";
import { sessionFile, readSession } from "@code-health/history/session-state";
import { couplingHistory } from "./support/coupling-scenarios.ts";
import { model, splitFeatures, view } from "./support/grouping-scenarios.ts";
import { runCochange } from "./support/run.ts";

let repo: GitFixture;
let base: string;
beforeAll(() => {
  repo = couplingHistory();
  base = repo.git("rev-parse", "HEAD").trim();
});
afterAll(() => repo.dispose());
// Every test starts from the fixture as it was built: no later commits, no cache, no config, no session state.
beforeEach(() => {
  repo.git("reset", "--quiet", "--hard", base);
  repo.git("clean", "--quiet", "-fdx");
});

const enable = (hook: Record<string, unknown> = {}) =>
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { hook: { enabled: true, ...hook } } }));
const refresh = () => runCochange(repo.path, ["refresh"]);

const registry = "src/app/registry.ts";
const invoice = "src/billing/invoice.ts";

// What the hook says must not depend on how loaded the machine is, so its tests give it a budget it cannot spend. The budget itself is tested below.
const PLENTY = 60_000;

const edit = (file: string, session = "session-1", tool = "Edit") =>
  runHook({
    cwd: repo.path,
    budgetMs: PLENTY,
    stdin: JSON.stringify({
      session_id: session,
      cwd: repo.path,
      hook_event_name: "PostToolUse",
      tool_name: tool,
      tool_input: { file_path: join(repo.path, file) },
    }),
  });
const note = (stdout: string): string => JSON.parse(stdout).hookSpecificOutput.additionalContext;

describe("when it prints a note", () => {
  test("a file with an unedited partner at or above the confidence guideline gets one note in the hook output format", async () => {
    enable();
    await refresh();
    const stdout = await edit(registry);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `\`${registry}\` changed together with \`${invoice}\` (confidence 100 %, 5 changes). Guideline: confidence 80 %. Not yet edited in this session, so worth a look.`,
      },
    });
  });

  test("it names up to three partners, strongest first", async () => {
    enable({ confidence: 15 });
    await refresh();
    const text = note(await edit(invoice));
    expect(text).toBe(
      `\`${invoice}\` changed together with \`src/billing/invoice.test.ts\` (confidence 37 %, 10 changes), ` +
        "`src/app/registry.ts` (confidence 19 %, 5 changes) and `src/reporting/summary.ts` (confidence 19 %, 5 changes). Guideline: confidence 15 %. Not yet edited in this session, so worth a look.",
    );
  });

  test("the partner cap is a setting, and the note counts the partners it did not name", async () => {
    enable({ confidence: 15, maxPartners: 1 });
    await refresh();
    const text = note(await edit(invoice));
    expect(text).toBe(
      `\`${invoice}\` changed together with \`src/billing/invoice.test.ts\` (confidence 37 %, 10 changes), and 2 more not named. Guideline: confidence 15 %. Not yet edited in this session, so worth a look.`,
    );
  });

  test("Write and MultiEdit are watched as well as Edit", async () => {
    enable();
    await refresh();
    expect(await edit(registry, "a", "Write")).not.toBe("");
    expect(await edit(registry, "b", "MultiEdit")).not.toBe("");
  });

  test("a file renamed since the cache was read is followed to its current identity", async () => {
    enable();
    await refresh();
    // Edited under its old name, as an agent working from older knowledge might.
    expect(note(await edit("src/reports/summary.ts"))).toContain(invoice);
  });
});

describe("once per file per session", () => {
  test("a second edit of the same file prints nothing, and another session prints the note again", async () => {
    enable();
    await refresh();
    expect(await edit(registry)).not.toBe("");
    expect(await edit(registry)).toBe("");
    expect(await edit(registry, "session-2")).not.toBe("");
  });

  test("a partner already edited in this session is not named", async () => {
    enable();
    await refresh();
    expect(await edit(invoice)).toBe("");
    expect(await edit(registry)).toBe("");
  });

  test("the state file records the edited files, the files a note was printed for and the last run", async () => {
    enable();
    await refresh();
    await edit(invoice);
    await edit(registry);
    const state = readSession(repo.path, "session-1", "cochange");
    expect(state.edited).toEqual([invoice, registry]);
    expect(state.spokenAbout).toEqual([]);
    expect(state.lastRun?.outcome).toMatch(/^printed nothing/);

    await edit("src/reporting/summary.ts", "session-3");
    expect(readSession(repo.path, "session-3", "cochange").spokenAbout).toEqual(["src/reporting/summary.ts"]);
    expect(existsSync(join(repo.path, ".cache", "code-health", "sessions", "session-3.cochange.json"))).toBe(true);
  });

  test("the state lives only in .cache/code-health/sessions and is ignored by git", async () => {
    enable();
    await refresh();
    await edit(registry);
    expect(repo.git("status", "--porcelain", "--untracked-files=all").split("\n").filter((l) => l.includes(".cache"))).toEqual([]);
  });
});

describe("when it prints nothing", () => {
  test("by default, and then it writes nothing", async () => {
    await refresh();
    expect(await edit(registry)).toBe("");
    expect(existsSync(join(repo.path, ".cache", "code-health", "sessions"))).toBe(false);
  });

  test("without a cache, and it does not create one", async () => {
    enable();
    expect(await edit(registry)).toBe("");
    expect(existsSync(join(repo.path, ".cache", "code-health", "history.sqlite"))).toBe(false);
  });

  test("when the cache is more than the tolerated number of commits behind, and it does not refresh", async () => {
    enable({ maxCommitsBehind: 2 });
    await refresh();
    const database = join(repo.path, ".cache", "code-health", "history.sqlite");
    for (let i = 0; i < 3; i++) {
      repo.commit({ message: `Later ${i}`, date: `2025-02-0${i + 1}T09:00:00Z`, changes: [{ op: "add", path: `later${i}.txt`, content: "x\n" }] });
    }
    const before = readFileSync(database);
    expect(await edit(registry)).toBe("");
    expect(readFileSync(database).equals(before)).toBe(true);
  });

  test("but within the tolerance it still prints a note from the older cache", async () => {
    enable({ maxCommitsBehind: 3 });
    await refresh();
    for (let i = 0; i < 3; i++) {
      repo.commit({ message: `Later ${i}`, date: `2025-02-0${i + 1}T09:00:00Z`, changes: [{ op: "add", path: `later${i}.txt`, content: "x\n" }] });
    }
    expect(note(await edit(registry))).toContain(invoice);
  });

  test("a partner that is gone from the working tree is not named", async () => {
    enable();
    await refresh();
    rmSync(join(repo.path, invoice));
    expect(await edit(registry)).toBe("");
  });

  test("a file outside the repository, a tool it does not watch, or no file at all", async () => {
    enable();
    await refresh();
    expect(await edit("../outside.ts")).toBe("");
    expect(await edit(registry, "s", "Bash")).toBe("");
    expect(await runHook({ cwd: repo.path, stdin: JSON.stringify({ session_id: "s", cwd: repo.path, tool_name: "Edit", tool_input: {} }) })).toBe("");
  });

  test.each(["", "not json", "[]", "null", '{"session_id":3}'])("input %j", async (stdin) => {
    enable();
    await refresh();
    expect(await runHook({ cwd: repo.path, stdin })).toBe("");
  });

  test("an invalid config file", async () => {
    await refresh();
    writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"hook":{"confidence":0}}}');
    expect(await edit(registry)).toBe("");
  });

  test("a cache from an incompatible layout", async () => {
    enable();
    await refresh();
    writeFileSync(join(repo.path, ".cache", "code-health", "history.sqlite"), "not a database");
    expect(await edit(registry)).toBe("");
  });

  test("when the time budget is already spent", async () => {
    enable();
    await refresh();
    const stdout = await runHook({
      cwd: repo.path,
      budgetMs: 0,
      stdin: JSON.stringify({ session_id: "s", cwd: repo.path, tool_name: "Edit", tool_input: { file_path: join(repo.path, registry) } }),
    });
    expect(stdout).toBe("");
    expect(readSession(repo.path, "s", "cochange").lastRun?.outcome).toBe("printed nothing: over the time budget");
  });
});

test("a session id that is not a safe file name cannot name a path outside the sessions directory", () => {
  const file = sessionFile(repo.path, "../../../etc/passwd", "cochange");
  expect(file.startsWith(join(repo.path, ".cache", "code-health", "sessions"))).toBe(true);
  expect(file).not.toContain("..");
});

describe("the cache it writes into", () => {
  test("session state written before any CLI command has run comes with the cache's own .gitignore, so git status stays clean", async () => {
    enable();
    await edit(registry);
    expect(readFileSync(join(repo.path, ".cache", "code-health", ".gitignore"), "utf8")).toBe("*\n");
    expect(repo.git("status", "--porcelain", "--", ".cache")).toBe("");
  });
});

describe("history as the commands see it", () => {
  let split: GitFixture;
  beforeAll(() => {
    split = splitFeatures();
  });
  afterAll(() => split.dispose());

  const editIn = (file: string) =>
    runHook({
      cwd: split.path,
      budgetMs: PLENTY,
      stdin: JSON.stringify({ session_id: "grouped", cwd: split.path, tool_name: "Edit", tool_input: { file_path: join(split.path, file) } }),
    });

  test("commits grouped by issue key count as one change, as in coupling, so the hook hears the coupled partner", async () => {
    writeFileSync(join(split.path, "code-health.json"), JSON.stringify({ cochange: { grouping: "issue-key", hook: { enabled: true } } }));
    await runCochange(split.path, ["refresh"]);
    expect(note(await editIn(model))).toContain(view);
  });
});
