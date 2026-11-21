import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { ensureCacheDir, locateCache } from "../src/cache-location.ts";
import { LockTimeoutError, withLock } from "../src/lock.ts";

// Fixture repos run real processes many times, which is slow on a loaded machine.
vi.setConfig({ testTimeout: 180_000 });

const fixtures: GitFixture[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo() {
  const f = GitFixture.build([
    { type: "commit", message: "init", date: "2024-01-01T00:00:00Z", changes: [{ op: "add", path: "a", content: "1\n" }] },
  ]);
  fixtures.push(f);
  return f;
}

test("cache lives in .cache/code-health at the repo root with a self-ignoring gitignore", async () => {
  const f = repo();
  const location = await locateCache(f.path);
  expect(location.cacheDir).toBe(join(realpathSync(f.path), ".cache", "code-health"));
  expect(existsSync(location.cacheDir)).toBe(false);
  ensureCacheDir(location);
  expect(readFileSync(join(location.cacheDir, ".gitignore"), "utf8").trim()).toBe("*");
  expect(f.git("status", "--porcelain")).toBe("");
});

test("an existing cache gitignore is left alone", async () => {
  const f = repo();
  const location = await locateCache(f.path);
  ensureCacheDir(location);
  writeFileSync(join(location.cacheDir, ".gitignore"), "*\n# edited\n");
  ensureCacheDir(location);
  expect(readFileSync(join(location.cacheDir, ".gitignore"), "utf8")).toContain("# edited");
});

test("linked worktrees share the main worktree's cache", async () => {
  const f = repo();
  const linked = join(mkdtempSync(join(tmpdir(), "code-health-wt-")), "linked");
  dirs.push(join(linked, ".."));
  f.git("worktree", "add", "--quiet", "-b", "other", linked);
  const main = await locateCache(f.path);
  const other = await locateCache(linked);
  expect(other.cacheDir).toBe(main.cacheDir);
  expect(other.repoRoot).not.toBe(main.repoRoot);
});

test("a lock serialises holders", async () => {
  const dir = mkdtempSync(join(tmpdir(), "code-health-lock-"));
  dirs.push(dir);
  const path = join(dir, "x.lock");
  const events: string[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let signalHeld!: () => void;
  const held = new Promise<void>((resolve) => (signalHeld = resolve));

  const a = withLock(path, async () => {
    events.push("a:start");
    signalHeld();
    await released;
    events.push("a:end");
  });
  await held;
  const b = withLock(path, async () => {
    events.push("b:start");
    events.push("b:end");
  });
  // b is now polling for the lock a holds. A slow machine only gives it more chances to
  // wrongly start, so this wait can make the assertion stricter but never spuriously fail it.
  await new Promise((r) => setTimeout(r, 100));
  expect(events).toEqual(["a:start"]);
  release();
  await Promise.all([a, b]);
  expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  expect(existsSync(path)).toBe(false);
});

test("a lock is released when the holder throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "code-health-lock-"));
  dirs.push(dir);
  const path = join(dir, "x.lock");
  await expect(withLock(path, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  expect(existsSync(path)).toBe(false);
});

test("a lock left by a dead process is taken over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "code-health-lock-"));
  dirs.push(dir);
  const path = join(dir, "x.lock");
  const { hostname } = await import("node:os");
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  writeFileSync(path, JSON.stringify({ token: "dead", pid: Number(child.stdout), host: hostname(), time: Date.now() }));
  expect(await withLock(path, async () => "ok", { timeoutMs: 30_000 })).toBe("ok");
});

test("waiting for a live holder times out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "code-health-lock-"));
  dirs.push(dir);
  const path = join(dir, "x.lock");
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let signalHeld!: () => void;
  const held = new Promise<void>((resolve) => (signalHeld = resolve));
  const holder = withLock(path, async () => {
    signalHeld();
    await released;
  });
  await held;
  // The holder is this process, which is alive, so however slow the runner the wait ends in a timeout.
  await expect(withLock(path, async () => 1, { timeoutMs: 100, staleMs: 3_600_000 })).rejects.toBeInstanceOf(LockTimeoutError);
  release();
  await holder;
});

test("an empty lock file left by a crash is reclaimed once it has aged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "code-health-lock-"));
  dirs.push(dir);
  const path = join(dir, "x.lock");
  writeFileSync(path, "");
  const old = new Date(Date.now() - 60_000);
  utimesSync(path, old, old);
  expect(await withLock(path, async () => "ok", { timeoutMs: 30_000 })).toBe("ok");
});

test("a fresh empty lock file is left alone, as its owner may still be writing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "code-health-lock-"));
  dirs.push(dir);
  const path = join(dir, "x.lock");
  writeFileSync(path, "");
  // An hour before such a file counts as abandoned, so a stalled runner cannot age it past the limit.
  await expect(withLock(path, async () => 1, { timeoutMs: 100, unreadableMs: 3_600_000 })).rejects.toBeInstanceOf(LockTimeoutError);
});

test("a holder whose lock was removed does not delete the next owner's lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "code-health-lock-"));
  dirs.push(dir);
  const path = join(dir, "x.lock");
  await withLock(path, async () => {
    rmSync(path);
    writeFileSync(path, JSON.stringify({ token: "someone-else", pid: process.pid, host: "elsewhere", time: Date.now() }));
  });
  expect(existsSync(path)).toBe(true);
});
