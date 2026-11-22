import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture, type Identity } from "@code-health/fixtures/git-fixture";
import { runCochange } from "./support/run.ts";

vi.setConfig({ testTimeout: 60_000 });

const ann: Identity = { name: "Ann Lee", email: "ann@corp.com" };

let repo: GitFixture;
beforeAll(() => {
  const steps = [1, 2, 3, 4].map((i) => ({
    type: "commit" as const,
    message: `change ${i}`,
    date: `2024-03-${String(i).padStart(2, "0")}T10:00:00Z`,
    author: ann,
    changes: [{ op: "add" as const, path: `src/f${i}.ts`, content: `export const f${i} = ${i};\n` }],
  }));
  repo = GitFixture.build(steps);
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: true } } }));
});
afterAll(() => repo.dispose());

const run = (...argv: string[]) => runCochange(repo.path, [...argv, "--json"]);
const errorOf = (stdout: string, stderr: string): { code: string; message: string } => JSON.parse(stdout || stderr).error;

test("risk backtest dispatches to the backtest, not to a risk assessment of a revision named backtest", async () => {
  const { code, stdout } = await run("risk", "backtest");
  expect(code).toBe(ExitCode.Success);
  const document = JSON.parse(stdout);
  expect(document.command).toBe("risk");
  expect(document.results.kind).toBe("backtest");
});

test("abandonment backtest dispatches to the backtest handler and not to the current report", async () => {
  const { code, stdout, stderr } = await run("abandonment", "backtest", "--at", "2024-03-02");
  // The fixture has under a year of history after that date, so the handler answers with its own usage error.
  // `current` would have exited 0 with a report, and neither is what this handler says.
  expect(code).toBe(ExitCode.Usage);
  expect(errorOf(stdout, stderr).message).toMatch(/whole horizon/);
});

test("an unknown word after risk is a usage error that names both readings, not a silent run", async () => {
  const { code, stdout, stderr } = await run("risk", "bogus");
  expect(code).toBe(ExitCode.Usage);
  expect(errorOf(stdout, stderr).message).toMatch(/"bogus" is neither a risk subcommand nor a commit/);
});

test("risk backtest takes no arguments, and is refused before any history is read", async () => {
  const { code, stdout, stderr } = await run("risk", "backtest", "extra");
  expect(code).toBe(ExitCode.Usage);
  expect(errorOf(stdout, stderr).message).toBe("risk backtest takes no arguments");
});

test("an unknown subcommand of abandonment, and extra words after a known one, are usage errors", async () => {
  for (const argv of [["abandonment", "bogus"], ["abandonment", "current", "extra"], ["abandonment", "backtest", "extra"]]) {
    const { code, stdout, stderr } = await run(...argv);
    expect(code).toBe(ExitCode.Usage);
    const { message } = errorOf(stdout, stderr);
    expect(message).toMatch(/^usage: abandonment </);
    expect(message).not.toContain("backtest");
  }
});

test("a branch named like a subcommand is analysed as the base when written BASE..HEAD", async () => {
  execFileSync("git", ["branch", "backtest", "HEAD~2"], { cwd: repo.path });
  execFileSync("git", ["branch", "explain", "HEAD~1"], { cwd: repo.path });
  for (const word of ["backtest", "explain"]) {
    const { code, stdout } = await run("risk", `${word}..HEAD`);
    expect(code).toBe(ExitCode.Success);
    const document = JSON.parse(stdout);
    expect(document.results.kind).toBe("assessment");
    expect(document.inputs.range).toBe(`${word}..HEAD`);
  }
  // Written bare, the word is the subcommand.
  expect(JSON.parse((await run("risk", "backtest")).stdout).results.kind).toBe("backtest");
});
