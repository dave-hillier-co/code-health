import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { couplingHistory } from "../../packages/cochange/test/support/coupling-scenarios.ts";
import { bundle } from "../bundle.mjs";

vi.setConfig({ testTimeout: 120_000 });

/** The hook as Claude Code runs it: a fresh `node <bundle> hook` process, the event on stdin. */
let work: string;
let repo: GitFixture;
let cli: string;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "cochange-hook-"));
  cli = join(work, "cochange.mjs");
  writeFileSync(cli, await bundle("cochange"));
  repo = couplingHistory();
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { hook: { enabled: true } } }));
  const refreshed = spawnSync("node", [cli, "refresh"], { cwd: repo.path, encoding: "utf8" });
  expect(refreshed.status).toBe(0);
});
afterAll(() => {
  repo.dispose();
  rmSync(work, { recursive: true, force: true });
});

function runHook(stdin: string, cwd = repo.path) {
  const started = performance.now();
  const result = spawnSync("node", [cli, "hook"], { cwd, input: stdin, encoding: "utf8" });
  return { ...result, wallMs: performance.now() - started };
}

const editEvent = (session: string, file = "src/app/registry.ts") =>
  JSON.stringify({ session_id: session, cwd: repo.path, tool_name: "Edit", tool_input: { file_path: join(repo.path, file) } });

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;

test("the process prints the hook output and exits 0", () => {
  const { status, stdout, stderr } = runHook(editEvent("process-1"));
  expect(status).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain("`src/billing/invoice.ts`");
});

test.each(["", "not json", "{}", '{"session_id":"x","tool_input":{"file_path":"/nowhere/at/all.ts"}}'])(
  "it exits 0 and prints nothing for input %j",
  (stdin) => {
    const { status, stdout, stderr } = runHook(stdin);
    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  },
);

test("it exits 0 and prints nothing when run outside a repository", () => {
  const outside = mkdtempSync(join(tmpdir(), "cochange-hook-outside-"));
  try {
    const { status, stdout } = runHook(JSON.stringify({ session_id: "x", cwd: outside, tool_name: "Edit", tool_input: { file_path: join(outside, "a.ts") } }), outside);
    expect(status).toBe(0);
    expect(stdout).toBe("");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("it does not wait for a stdin that never closes: it exits 0 within the time budget", async () => {
  const started = performance.now();
  const child = spawn("node", [cli, "hook"], { cwd: repo.path, stdio: ["pipe", "pipe", "pipe"] });
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  expect(code).toBe(0);
  expect(performance.now() - started).toBeLessThan(2_000);
});

test("wall time, process start included, stays within a few hundred milliseconds", () => {
  const runs = Array.from({ length: 7 }, (_, i) => runHook(editEvent(`timing-${i}`)));
  const times = runs.map((run) => run.wallMs);
  // Every run must have done the work, or the timing would measure an early exit.
  expect(runs.every((run) => run.stdout.includes("usually changes with"))).toBe(true);
  console.log(`cochange hook wall time over ${times.length} runs (ms): ${times.map((t) => Math.round(t)).join(" ")}; median ${Math.round(median(times))}`);
  expect(median(times)).toBeLessThan(400);
  // The hook abandons its work at 500 ms, so no run may take much longer, however loaded the machine is.
  expect(Math.max(...times)).toBeLessThan(1_000);
});

test("when the hook is not enabled the run is shorter still: no history is touched", () => {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { hook: { enabled: false } } }));
  try {
    const runs = Array.from({ length: 5 }, (_, i) => runHook(editEvent(`disabled-${i}`)));
    expect(runs.every((run) => run.status === 0 && run.stdout === "")).toBe(true);
    expect(median(runs.map((run) => run.wallMs))).toBeLessThan(250);
  } finally {
    writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { hook: { enabled: true } } }));
  }
});
