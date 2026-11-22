import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { readSession } from "@code-health/history/session-state";
import { runHook } from "../src/hook.ts";

/** `run` with `depth` nested ifs: lexical nesting `depth`, `depth` branch keywords. */
function nested(depth: number, name = "run"): string {
  const lines = [`export function ${name}(a: number): number {`];
  for (let level = 1; level <= depth; level++) lines.push(`${"  ".repeat(level)}if (a > ${level}) {`);
  lines.push(`${"  ".repeat(depth + 1)}return a;`);
  for (let level = depth; level >= 1; level--) lines.push(`${"  ".repeat(level)}}`);
  lines.push("  return 0;", "}", "");
  return lines.join("\n");
}

const thresholds = { nesting: 2, cyclomatic: { warn: 20, high: 40 } };
const enable = (hook: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ complexity: { thresholds, hook: { enabled: true, ...hook }, ...extra } }));

const simple = "src/simple.ts";
const busy = "src/busy.ts";
const tangled = "src/tangled.ts";

let repo: GitFixture;
let base: string;
beforeAll(() => {
  repo = GitFixture.build([
    {
      type: "commit",
      message: "Base",
      date: "2024-01-01T00:00:00+00:00",
      changes: [
        { op: "add", path: simple, content: nested(1) },
        // Already over the nesting threshold of 2 at HEAD.
        { op: "add", path: busy, content: nested(3) },
        { op: "add", path: "notes.txt", content: "plain text\n" },
        { op: "add", path: "tool.rb", content: "def run(a)\n  a\nend\n" },
      ],
    },
  ]);
  base = repo.git("rev-parse", "HEAD").trim();
});
afterAll(() => repo.dispose());
// Every test starts from the fixture as it was built: no edits, no config, no session state.
beforeEach(() => {
  repo.git("reset", "--quiet", "--hard", base);
  repo.git("clean", "--quiet", "-fdx");
});

const write = (file: string, content: string) => writeFileSync(join(repo.path, file), content);

const edit = (file: string, session = "session-1", tool = "Edit", budgetMs = 60_000) =>
  runHook({
    cwd: repo.path,
    budgetMs,
    stdin: JSON.stringify({
      session_id: session,
      cwd: repo.path,
      hook_event_name: "PostToolUse",
      tool_name: tool,
      tool_input: { file_path: join(repo.path, file) },
    }),
  });
const note = (stdout: string): string => JSON.parse(stdout).hookSpecificOutput.additionalContext;
const state = (session = "session-1") => readSession(repo.path, session, "complexity");

describe("when it speaks", () => {
  test("a unit that crossed a threshold in the edit gets one sentence in the hook output format", async () => {
    enable();
    write(simple, nested(3));
    const stdout = await edit(simple);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `${simple}: \`run\` nesting depth rose from 1 to 3 (guideline 2, ratio 1.5). Worth a look: run \`complexity explain ${simple}#run\` for the breakdown.`,
      },
    });
  });

  test("a unit in a new file counts as new", async () => {
    enable();
    write(tangled, nested(4, "knot"));
    expect(note(await edit(tangled))).toBe(
      `${tangled}: \`knot\` nesting depth is 4 in a new or renamed unit (guideline 2, ratio 2). Worth a look: run \`complexity explain ${tangled}#knot\` for the breakdown.`,
    );
  });

  test("a unit already over a threshold that got worse by more than the delta speaks", async () => {
    enable();
    write(busy, nested(4));
    expect(note(await edit(busy))).toContain("`run` nesting depth rose from 3 to 4 (guideline 2, ratio 2)");
  });

  test("the keyword count stands in for cyclomatic complexity, one below it", async () => {
    enable({}, { thresholds: { nesting: 10, cyclomatic: { warn: 3, high: 6 } } });
    // Three nested ifs have 3 decision points, cyclomatic complexity 4, which is over a warn level of 3.
    write(simple, nested(3));
    expect(note(await edit(simple))).toContain("keyword complexity rose from 1 to 3");
  });

  test("with several findings it names the worst and counts the rest", async () => {
    enable();
    write(simple, nested(3) + nested(5, "deeper"));
    expect(note(await edit(simple))).toContain("`deeper` nesting depth is 5 in a new or renamed unit (guideline 2, ratio 2.5), and 1 more finding in this file.");
  });

  test("Write and MultiEdit are watched as well as Edit", async () => {
    enable();
    write(simple, nested(3));
    expect(await edit(simple, "a", "Write")).not.toBe("");
    expect(await edit(simple, "b", "MultiEdit")).not.toBe("");
  });

  test("JavaScript is measured with the same profile", async () => {
    enable();
    write("src/plain.js", nested(4, "knot"));
    expect(note(await edit("src/plain.js"))).toContain("complexity explain src/plain.js#knot");
  });

  test("the explain command is given in full when the plugin's root is known", async () => {
    enable();
    write(simple, nested(3));
    process.env.CLAUDE_PLUGIN_ROOT = "/plugins/complexity";
    try {
      expect(note(await edit(simple))).toContain(`\`node /plugins/complexity/dist/complexity.mjs explain ${simple}#run\``);
    } finally {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    }
  });
});

describe("when it stays silent", () => {
  test("off by default: nothing is read, nothing is written", async () => {
    write(simple, nested(5));
    expect(await edit(simple)).toBe("");
    expect(existsSync(join(repo.path, ".cache"))).toBe(false);
  });

  test("an edit that crossed nothing", async () => {
    enable();
    write(simple, nested(2));
    expect(await edit(simple)).toBe("");
    expect(state().lastRun?.outcome).toBe("printed nothing: nothing went above a guideline or worsened");
  });

  test("a unit over a threshold that did not get worse, or got better", async () => {
    enable();
    write(busy, `// reformatted\n${nested(3)}`);
    expect(await edit(busy)).toBe("");
    write(busy, nested(2));
    expect(await edit(busy, "session-2")).toBe("");
  });

  test("a worsening within the configured delta", async () => {
    enable({}, { delta: 1 });
    write(busy, nested(4));
    expect(await edit(busy)).toBe("");
  });

  test("a file in a language with no lexer profile, or whose profile has not cleared the agreement bar", async () => {
    enable();
    write("notes.txt", "plain text\n".repeat(10));
    expect(await edit("notes.txt")).toBe("");
    write("tool.rb", "def run(a)\n  if a\n    if a\n      if a\n        a\n      end\n    end\n  end\nend\n");
    expect(await edit("tool.rb")).toBe("");
    expect(state().lastRun?.outcome).toMatch(/^printed nothing: no per-function metrics/);
  });

  test("a file type mapped to a lexer profile by config, whose values are unverified", async () => {
    enable({}, {});
    const config = JSON.parse(readFileSync(join(repo.path, "code-health.json"), "utf8"));
    write("code-health.json", JSON.stringify({ ...config, languages: { zig: "rust" } }));
    write("tool.zig", "pub fn run(a: i32) -> i32 {\n  if a > 1 {\n    if a > 2 {\n      if a > 3 {\n        return a;\n      }\n    }\n  }\n  0\n}\n");
    expect(await edit("tool.zig")).toBe("");
    expect(state().lastRun?.outcome).toMatch(/^printed nothing: no per-function metrics \(.*unverified/);
  });

  test("an excluded file", async () => {
    enable();
    writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ exclude: ["src/**"], complexity: { thresholds, hook: { enabled: true } } }));
    write(simple, nested(5));
    expect(await edit(simple)).toBe("");
  });

  test("a test file when tests are not analysed", async () => {
    enable({}, { analyseTests: false });
    write("src/run.test.ts", nested(5));
    expect(await edit("src/run.test.ts")).toBe("");
  });

  test("a file that is not in the repository, or is gone", async () => {
    enable();
    expect(await edit("../outside.ts")).toBe("");
    expect(await edit("src/never-written.ts")).toBe("");
  });

  test("an event with no session, another tool or stdin that is not JSON", async () => {
    enable();
    write(simple, nested(5));
    const stdin = (body: object) => JSON.stringify({ cwd: repo.path, tool_input: { file_path: join(repo.path, simple) }, ...body });
    expect(await runHook({ cwd: repo.path, stdin: stdin({ tool_name: "Edit" }) })).toBe("");
    expect(await runHook({ cwd: repo.path, stdin: stdin({ session_id: "s", tool_name: "Read" }) })).toBe("");
    expect(await runHook({ cwd: repo.path, stdin: "not json" })).toBe("");
    expect(await runHook({ cwd: repo.path, stdin: "" })).toBe("");
  });

  test("an invalid config", async () => {
    writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ complexity: { hook: { enabled: "yes" } } }));
    write(simple, nested(5));
    expect(await edit(simple)).toBe("");
  });

  test("a spent time budget, with the outcome recorded", async () => {
    enable();
    write(simple, nested(5));
    expect(await edit(simple, "s", "Edit", 0)).toBe("");
    expect(state("s").lastRun?.outcome).toBe("printed nothing: over the time budget");
  });
});

describe("once per file per session", () => {
  test("a file is spoken about once, and a later edit of it in the session is silent even when worse", async () => {
    enable();
    write(simple, nested(3));
    expect(await edit(simple)).not.toBe("");
    write(simple, nested(6));
    expect(await edit(simple)).toBe("");
    expect(state().lastRun?.outcome).toBe("printed nothing: already printed for this file");
  });

  test("another file in the session, and the same file in another session, are spoken about", async () => {
    enable();
    write(simple, nested(3));
    write(tangled, nested(4, "knot"));
    expect(await edit(simple)).not.toBe("");
    expect(await edit(tangled)).not.toBe("");
    expect(await edit(simple, "session-2")).not.toBe("");
  });
});

describe("what it compares with", () => {
  test("with no earlier measurement in the session, the values at HEAD", async () => {
    enable();
    write(simple, nested(3));
    expect(note(await edit(simple))).toContain("rose from 1 to 3");
  });

  test("the session's last measurement of the file once there is one", async () => {
    enable();
    write(simple, nested(2));
    expect(await edit(simple)).toBe("");
    write(simple, nested(3));
    // From 2 in the session's last measurement, not from 1 at HEAD.
    expect(note(await edit(simple))).toContain("rose from 2 to 3");
  });

  test("a unit whose bodies were measured in the session is recorded under the file", async () => {
    enable();
    write(simple, nested(2));
    await edit(simple);
    expect(state().measurements[simple]).toEqual({ run: { keyword: 2, nesting: 2, bumps: 1, bumpy: 0 } });
    expect(state().edited).toEqual([simple]);
  });

  test("a file edited back under the threshold and over again speaks about the second crossing, from the last measurement", async () => {
    enable();
    write(busy, nested(2));
    expect(await edit(busy)).toBe("");
    write(busy, nested(3));
    expect(note(await edit(busy))).toContain("rose from 2 to 3");
  });
});

describe("what it writes", () => {
  test("only its own session state, under the self-ignoring cache, and no report", async () => {
    enable();
    write(simple, nested(3));
    await edit(simple);
    expect(readdirSync(join(repo.path, ".cache", "code-health"))).toEqual([".gitignore", "sessions"]);
    expect(readdirSync(join(repo.path, ".cache", "code-health", "sessions"))).toEqual(["session-1.complexity.json"]);
    expect(repo.git("status", "--porcelain", "--", ".cache")).toBe("");
  });

  test("the state records the edited files, the files spoken about and the last run", async () => {
    enable();
    write(simple, nested(3));
    await edit(simple);
    expect(state().edited).toEqual([simple]);
    expect(state().spokenAbout).toEqual([simple]);
    expect(state().lastRun?.outcome).toBe("printed");
  });
});
