import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { couplingHistory } from "../../packages/cochange/test/support/coupling-scenarios.ts";
import { bundle, bundleChunks, grammarsPath } from "../bundle.mjs";

vi.setConfig({ testTimeout: 120_000 });

/** The hook as Claude Code runs it: a fresh `node <bundle> hook` process, the event on stdin. */
let work: string;
let repo: GitFixture;
let cli: string;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "cochange-hook-"));
  cli = join(work, "cochange.mjs");
  // The chunks and grammars sit beside the bundle, as they do in an installed plugin.
  cpSync(grammarsPath("cochange"), join(work, "grammars"), { recursive: true });
  writeFileSync(cli, await bundle("cochange"));
  for (const [name, text] of await bundleChunks("cochange")) writeFileSync(join(work, name), text);
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
  const result = spawnSync("node", [cli, "hook"], { cwd, input: stdin, encoding: "utf8", env: { ...process.env, CODE_HEALTH_HOOK_BUDGET_MS: "60000" } });
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

test("it does not wait for a stdin that never closes: it exits 0 by itself", async () => {
  // The time budget is the hook's own, so the exit itself is the assertion; the test's timeout bounds a hang.
  const child = spawn("node", [cli, "hook"], { cwd: repo.path, stdio: ["pipe", "pipe", "pipe"] });
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  expect(code).toBe(0);
});

test("wall time, process start included, is recorded for diagnosis and does not gate", () => {
  const runs = Array.from({ length: 7 }, (_, i) => runHook(editEvent(`timing-${i}`)));
  const times = runs.map((run) => run.wallMs);
  // Every run must have done the work, or the timing would measure an early exit.
  expect(runs.every((run) => run.stdout.includes("usually changes with"))).toBe(true);
  console.log(`cochange hook wall time over ${times.length} runs (ms): ${times.map((t) => Math.round(t)).join(" ")}; median ${Math.round(median(times))}`);
  // The budget itself is checked by behaviour in hook.test.ts and hook-manifest.test.ts. Wall time depends
  // on the machine, so the figures above are for reading, not for failing a build.
});

test("when the hook is not enabled it prints nothing and touches no history", () => {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { hook: { enabled: false } } }));
  try {
    const runs = Array.from({ length: 5 }, (_, i) => runHook(editEvent(`disabled-${i}`)));
    expect(runs.every((run) => run.status === 0 && run.stdout === "")).toBe(true);
  } finally {
    writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { hook: { enabled: true } } }));
  }
});

test("hooks running at once in one session each keep their edit in the session state", async () => {
  const files = Array.from({ length: 8 }, (_, i) => `src/parallel/file-${i}.ts`);
  await Promise.all(
    files.map(
      (file) =>
        new Promise<void>((resolve) => {
          const child = spawn("node", [cli, "hook"], { cwd: repo.path, stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, CODE_HEALTH_HOOK_BUDGET_MS: "60000" } });
          child.on("exit", () => resolve());
          child.stdin.end(editEvent("parallel", file));
        }),
    ),
  );
  const state = JSON.parse(readFileSync(join(repo.path, ".cache", "code-health", "sessions", "parallel.cochange.json"), "utf8")) as { edited: string[] };
  expect([...state.edited].sort()).toEqual(files);
});

test("when the budget is spent before the work is done the process is silent and exits 0 without waiting for it", () => {
  const result = spawnSync("node", [cli, "hook"], {
    cwd: repo.path,
    input: editEvent("budget-spent"),
    encoding: "utf8",
    env: { ...process.env, CODE_HEALTH_HOOK_BUDGET_MS: "1" },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
});
