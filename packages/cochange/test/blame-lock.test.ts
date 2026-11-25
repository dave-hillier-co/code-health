import { spawn, type ChildProcess } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { withoutMeta } from "@code-health/fixtures/cli-testing";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { knowledgeHistory } from "./support/knowledge-scenario.ts";
import { runCochange } from "./support/run.ts";

vi.setConfig({ testTimeout: 120_000 });

let repo: GitFixture;
beforeAll(() => {
  repo = knowledgeHistory();
});
afterAll(() => repo.dispose());

const holders: ChildProcess[] = [];
afterEach(() => {
  for (const h of holders.splice(0)) h.kill();
});

const lockPath = () => join(repo.path, ".cache", "code-health", "blame.lock");

beforeEach(async () => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: true } } }));
  expect((await runCochange(repo.path, ["refresh"])).code).toBe(ExitCode.Success);
});

/** A live process holding the blame lock, as a long first blame in another terminal would. */
function holdBlameLock(): ChildProcess {
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600_000)"], { stdio: "ignore" });
  holders.push(holder);
  writeFileSync(lockPath(), JSON.stringify({ token: "other", pid: holder.pid, host: hostname(), time: Date.now(), command: "cochange abandonment current" }));
  return holder;
}

/** The CLI as a separate process, so what the lock prints to stderr is seen as a user sees it. Calls `onStderr` with all stderr so far. */
function cochangeProcess(args: string[], onStderr: (stderr: string) => void): Promise<{ code: number; stdout: string; stderr: string }> {
  const main = join(import.meta.dirname, "..", "src", "main.ts");
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", main, ...args], { cwd: repo.path });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    onStderr(stderr);
  });
  return new Promise((resolve) => child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr })));
}

test("a command waiting for the blame lock prints the holder on stderr, takes the lock over once the holder dies, and its JSON is unchanged", async () => {
  const expected = await runCochange(repo.path, ["identities", "check", "--json"]);
  rmSync(join(repo.path, ".cache", "code-health", "blame.sqlite"), { force: true });

  const holder = holdBlameLock();
  const exited = new Promise((r) => holder.once("exit", r));
  // The holder dies only once the waiter has said it is waiting, however slow the machine.
  const run = await cochangeProcess(["identities", "check", "--json"], (stderr) => {
    if (stderr.includes("waiting for blame.lock")) holder.kill();
  });
  await exited;

  expect(run.code).toBe(ExitCode.Success);
  expect(run.stderr).toMatch(new RegExp(`^waiting for blame\\.lock: held by process ${holder.pid} \\(cochange abandonment current\\) for \\d+s$`, "m"));
  expect(run.stderr).toContain(`blame.lock: process ${holder.pid} (cochange abandonment current) is no longer running, so this command takes the lock over`);
  expect(withoutMeta(run.stdout)).toBe(withoutMeta(expected.stdout));
});

test("commands that read no blame, and --no-refresh, do not wait for the blame lock", async () => {
  await runCochange(repo.path, ["abandonment", "current", "--json"]);
  holdBlameLock();
  for (const sub of ["list", "propose", "classify"]) {
    expect((await runCochange(repo.path, ["identities", sub, "--json"])).code).toBe(ExitCode.Success);
  }
  expect((await runCochange(repo.path, ["identities", "check", "--no-refresh", "--json"])).code).toBe(ExitCode.Success);
  expect((await runCochange(repo.path, ["abandonment", "current", "--no-refresh", "--json"])).code).toBe(ExitCode.Success);
});

test("a command whose blame is already in the cache does not wait for another process's refresh", async () => {
  await runCochange(repo.path, ["abandonment", "current", "--json"]);
  holdBlameLock();
  expect((await runCochange(repo.path, ["abandonment", "current", "--json"])).code).toBe(ExitCode.Success);
  expect((await runCochange(repo.path, ["identities", "check", "--json"])).code).toBe(ExitCode.Success);
});
