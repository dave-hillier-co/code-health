import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { invoice, riskHistory } from "./support/risk-scenario.ts";
import { runCochange } from "./support/run.ts";

// Every run here is refused or answered without history, so the history cache is never built.
let repo: GitFixture;
beforeAll(() => {
  repo = riskHistory();
}, 60_000);
afterAll(() => repo.dispose());

const cacheBuilt = () => existsSync(join(repo.path, ".cache", "code-health", "history.sqlite"));

async function risk(...args: string[]) {
  const run = await runCochange(repo.path, ["risk", ...args, "--json"]);
  return { ...run, document: run.stdout === "" ? undefined : JSON.parse(run.stdout) };
}

test("a file path is refused: risk assesses a change, and the error names the commands for a file", async () => {
  const { code, stderr } = await risk(invoice);
  expect(code).toBe(ExitCode.Usage);
  const message: string = JSON.parse(stderr).error.message;
  expect(message).toContain(`"${invoice}" is a file`);
  expect(message).toMatch(/risk assesses a change \(a commit or a range/);
  expect(message).toContain(`cochange brief ${invoice}`);
  expect(message).toContain("cochange hotspots");
  expect(cacheBuilt()).toBe(false);
});

test("a bare word that is neither a file nor a commit is still refused as before", async () => {
  const { code, stderr } = await risk("nonesuch");
  expect(code).toBe(ExitCode.Usage);
  expect(stderr).toMatch(/neither a risk subcommand nor a commit/);
  expect(cacheBuilt()).toBe(false);
});

test("bad arguments to the subcommands are refused before any history is read", async () => {
  expect((await risk("explain", "nonesuch")).code).toBe(ExitCode.Usage);
  expect((await risk("explain", "size", "main..missing", "extra")).code).toBe(ExitCode.Usage);
  expect((await risk("explain", "size", "nonesuch..missing")).code).toBe(ExitCode.Usage);
  expect((await risk("reviewers", "--evidence", "x.json")).code).toBe(ExitCode.Usage);
  expect((await risk("reviewers", "a", "b")).code).toBe(ExitCode.Usage);
  expect((await risk("backtest", "a")).code).toBe(ExitCode.Usage);
  expect(cacheBuilt()).toBe(false);
});

test("explain without a range prints the rules and does not read history", async () => {
  const { code, document } = await risk("explain");
  expect(code).toBe(ExitCode.Success);
  expect(document.results.kind).toBe("explain");
  expect(document.results.topic).toBe("level");
  expect(document.window).toBeUndefined();
  expect(cacheBuilt()).toBe(false);
});

test("explain of a factor without a range prints its definition only, and does not assess the checked out branch", async () => {
  repo.git("checkout", "--quiet", "missing");
  const { code, document } = await risk("explain", "missing-co-change");
  repo.git("checkout", "--quiet", "main");
  expect(code).toBe(ExitCode.Success);
  expect(document.results.topic).toBe("missing-co-change");
  expect(document.results.doc.definition).toMatch(/confidence/);
  expect(document.results.branch).toBeNull();
  expect(document.inputs).toEqual({ topic: "missing-co-change", range: null });
  expect(cacheBuilt()).toBe(false);
});
