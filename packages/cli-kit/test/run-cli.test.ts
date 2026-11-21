import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { configError, environmentError, ExitCode, usageError } from "../src/errors.ts";
import { runCli, type CliDefinition } from "../src/run-cli.ts";

const rows = [
  { path: "src/b.ts", score: 0.5, churn: 7 },
  { path: "src/a.ts", score: 0.5, churn: 3 },
  { path: "src/c.ts", score: 2 / 3, churn: 1 },
];

const cli: CliDefinition = {
  tool: "demo",
  config: { plugin: "demo", section: { threshold: 1 } },
  commands: {
    list: {
      summary: "List rows",
      options: { since: { type: "string" } },
      run: ({ values }) => ({ inputs: { since: values.since ?? null }, results: rows, columns: ["path", "score", "churn"] }),
    },
    sections: {
      summary: "Extra sections",
      run: () => ({ results: [], extra: { evidence: { grade: "weak" } } }),
    },
    clash: { summary: "Clashing extra", run: () => ({ results: [], extra: { results: 1 } }) },
    check: { summary: "Fail", run: () => ({ results: [], failed: true }) },
    summary: { summary: "Object result", run: () => ({ results: { verdict: "ok" } }) },
    usage: { summary: "Usage error", run: () => { throw usageError("bad input"); } },
    boom: { summary: "Crash", run: () => { throw new Error("kaput"); } },
  },
};

let repo: GitFixture;
beforeAll(() => {
  repo = GitFixture.build([
    {
      type: "commit",
      message: "init",
      date: "2024-01-01T10:00:00+00:00",
      changes: [
        { op: "add", path: "src/a.ts", content: "a\n" },
        { op: "add", path: "code-health.json", content: '{"demo":{"threshold":5}}\n' },
      ],
    },
  ]);
});
afterAll(() => repo.dispose());

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  argv: string[],
  options: { tty?: boolean; cwd?: string; cli?: CliDefinition } = {},
): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(options.cli ?? cli, {
    argv,
    cwd: options.cwd ?? repo.path,
    stdout: { write: (text) => (stdout += text), isTTY: options.tty ?? false },
    stderr: { write: (text) => (stderr += text) },
  });
  return { code, stdout, stderr };
}

function withoutMeta(stdout: string): Record<string, unknown> {
  const { meta: _meta, ...rest } = JSON.parse(stdout);
  return rest;
}

test("emits the common envelope as JSON when stdout is not a TTY", async () => {
  const { code, stdout, stderr } = await run(["list"]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  const document = JSON.parse(stdout);
  expect(Object.keys(document).sort()).toEqual(
    ["command", "config", "inputs", "meta", "repo", "results", "schemaVersion", "tool", "truncated"].sort(),
  );
  expect(document).toMatchObject({
    schemaVersion: 1,
    tool: "demo",
    command: "list",
    repo: { head: repo.git("rev-parse", "HEAD"), dirty: false },
    inputs: { since: null },
    truncated: { limit: 20, total: 3, cut: 0 },
  });
  expect(document.config).toMatch(/^[0-9a-f]{16}$/);
  expect(Object.keys(document.meta).sort()).toEqual(["durationMs", "generatedAt", "gitVersion", "node"]);
});

test("results are sorted by score then path, with rounded floats", async () => {
  const { stdout } = await run(["list"]);
  expect(JSON.parse(stdout).results).toEqual([
    { path: "src/c.ts", score: 0.666667, churn: 1 },
    { path: "src/a.ts", score: 0.5, churn: 3 },
    { path: "src/b.ts", score: 0.5, churn: 7 },
  ]);
});

test("output is byte identical between runs apart from meta", async () => {
  const first = await run(["list", "--since", "6m"]);
  const second = await run(["list", "--since", "6m"]);
  expect(serialiseWithoutMeta(first.stdout)).toBe(serialiseWithoutMeta(second.stdout));
  expect(JSON.parse(first.stdout).inputs).toEqual({ since: "6m" });
});

function serialiseWithoutMeta(stdout: string): string {
  return JSON.stringify(withoutMeta(stdout));
}

test("--limit and --fields shape the results and report truncation", async () => {
  const { stdout } = await run(["list", "--limit", "1", "--fields", "path"]);
  const document = JSON.parse(stdout);
  expect(document.results).toEqual([{ path: "src/c.ts" }]);
  expect(document.truncated).toEqual({ limit: 1, total: 3, cut: 2 });
});

test("a TTY gets a table unless --json is given", async () => {
  const table = await run(["list", "--limit", "2"], { tty: true });
  expect(table.stdout).toContain("path");
  expect(table.stdout).toContain("src/c.ts");
  expect(table.stdout).toContain("1 more not shown");
  expect(() => JSON.parse(table.stdout)).toThrow();

  const json = await run(["list", "--json"], { tty: true });
  expect(JSON.parse(json.stdout).command).toBe("list");
});

test("a command that reports a failed check exits 1 and still prints its output", async () => {
  const { code, stdout } = await run(["check"]);
  expect(code).toBe(ExitCode.CheckFailed);
  expect(JSON.parse(stdout).results).toEqual([]);
});

test("extra sections are emitted beside the envelope", async () => {
  const document = JSON.parse((await run(["sections"])).stdout);
  expect(document.evidence).toEqual({ grade: "weak" });
  expect(document.results).toEqual([]);
});

test("an extra section that clashes with the envelope is an internal error", async () => {
  const { code, stderr } = await run(["clash"]);
  expect(code).toBe(ExitCode.Environment);
  expect(stderr).toContain("results");
});

test("object results pass through", async () => {
  expect(JSON.parse((await run(["summary"])).stdout).results).toEqual({ verdict: "ok" });
});

test("config explain reports the effective config with sources, and the config hash follows the file", async () => {
  const { stdout } = await run(["config", "explain"]);
  const document = JSON.parse(stdout);
  expect(document.command).toBe("config explain");
  expect(document.inputs.file).toBe("code-health.json");
  expect(document.results).toContainEqual({ path: "demo.threshold", value: 5, source: "file" });
  expect(document.results).toContainEqual({ path: "exclude", value: [], source: "default" });
  expect(document.config).toBe(JSON.parse((await run(["list"])).stdout).config);
});

test("usage errors exit 2 with a JSON error on stderr under --json", async () => {
  const { code, stdout, stderr } = await run(["usage", "--json"]);
  expect(code).toBe(ExitCode.Usage);
  expect(stdout).toBe("");
  expect(JSON.parse(stderr)).toEqual({ error: { code: "usage", message: "bad input", exitCode: 2 } });
});

test("errors are plain text on stderr without --json", async () => {
  const { code, stderr } = await run(["usage"], { tty: true });
  expect(code).toBe(2);
  expect(stderr).toBe("demo: bad input\n");
});

test("unknown commands and options are usage errors, even before the command is known", async () => {
  expect((await run(["nope"])).code).toBe(2);
  const bad = await run(["list", "--bogus", "--json"]);
  expect(bad.code).toBe(2);
  expect(JSON.parse(bad.stderr).error.code).toBe("usage");
});

test("outside a git repository exits 3", async () => {
  const dir = mkdtempSync(join(tmpdir(), "code-health-nogit-"));
  try {
    const { code, stderr } = await run(["list", "--json"], { cwd: dir });
    expect(code).toBe(ExitCode.Environment);
    expect(JSON.parse(stderr).error.code).toBe("not-a-git-repo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invalid config file exits 2", async () => {
  const broken = GitFixture.build([
    {
      type: "commit",
      message: "init",
      date: "2024-01-01T10:00:00+00:00",
      changes: [{ op: "add", path: "code-health.json", content: '{"demo":{"typo":1}}' }],
    },
  ]);
  try {
    const { code, stderr } = await run(["list", "--json"], { cwd: broken.path });
    expect(code).toBe(2);
    expect(JSON.parse(stderr).error.code).toBe("config");
  } finally {
    broken.dispose();
  }
});

test("unexpected exceptions exit 3 as internal errors", async () => {
  const { code, stderr } = await run(["boom", "--json"]);
  expect(code).toBe(3);
  expect(JSON.parse(stderr).error).toMatchObject({ code: "internal", message: "kaput" });
});

test("--help lists commands, and command help lists options", async () => {
  const top = await run(["--help"]);
  expect(top.code).toBe(0);
  expect(top.stdout).toMatch(/list\s+List rows/);
  expect(top.stdout).toMatch(/config explain/);
  const command = await run(["list", "--help"]);
  expect(command.code).toBe(0);
  expect(command.stdout).toContain("--since");
  expect(command.stdout).toContain("--limit");
});

test("no command prints usage to stderr and exits 2", async () => {
  const { code, stdout, stderr } = await run([]);
  expect(code).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toContain("Commands:");
});

class MissingCache extends Error {}

const withMapping: CliDefinition = {
  ...cli,
  commands: {
    ...cli.commands,
    cache: { summary: "Needs a cache", run: () => { throw new MissingCache("no cache"); } },
  },
  mapError: (error) => (error instanceof MissingCache ? environmentError("no-cache", "Run refresh first.") : undefined),
};

test("a CLI can map its own errors to exit codes, and unmapped errors stay internal", async () => {
  const mapped = await run(["cache", "--json"], { cli: withMapping });
  expect(mapped.code).toBe(ExitCode.Environment);
  expect(JSON.parse(mapped.stderr).error).toEqual({ code: "no-cache", message: "Run refresh first.", exitCode: 3 });
  const unmapped = await run(["boom", "--json"], { cli: withMapping });
  expect(JSON.parse(unmapped.stderr).error.code).toBe("internal");
});

test("a mapper may turn an error into a usage error", async () => {
  const cliWithConfig: CliDefinition = { ...withMapping, mapError: () => configError("bad pattern") };
  const { code } = await run(["boom"], { cli: cliWithConfig });
  expect(code).toBe(ExitCode.Usage);
});

const withRules: CliDefinition = {
  ...cli,
  rules: {
    "hidden-coupling": { summary: "Files that change together without a dependency", explanation: "Long form text." },
  },
};

test("explain <rule> prints the rule's explanation", async () => {
  const { code, stdout } = await run(["explain", "hidden-coupling"], { cli: withRules, tty: true });
  expect(code).toBe(0);
  expect(stdout).toContain("Long form text.");
});

test("explain with no rule lists them, and an unknown rule is a usage error", async () => {
  const list = await run(["explain"], { cli: withRules, tty: true });
  expect(list.stdout).toContain("hidden-coupling");
  const unknown = await run(["explain", "nope", "--json"], { cli: withRules });
  expect(unknown.code).toBe(ExitCode.Usage);
  expect(JSON.parse(unknown.stderr).error.message).toContain("hidden-coupling");
});

test("explain is listed in help only when the CLI has rules", async () => {
  expect((await run(["--help"], { cli: withRules })).stdout).toContain("explain <rule>");
  expect((await run(["--help"])).stdout).not.toContain("explain <rule>");
});
