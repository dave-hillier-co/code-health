import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { ensureCacheDir, locateCache } from "../src/cache-location.ts";
import { LockTimeoutError, withLock } from "../src/lock.ts";

// Fixture repos run real processes many times, which is slow on a loaded machine.
vi.setConfig({ testTimeout: 180_000 });

const fixtures: GitFixture[] = [];
const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
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

/** A real process that stays alive until killed, to stand as a lock holder. */
function liveProcess(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600_000)"], { stdio: "ignore" });
  children.push(child);
  return child;
}

function lockDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "code-health-lock-"));
  dirs.push(dir);
  return dir;
}

test("the lock file names the holder: process, host, start time and command", async () => {
  const path = join(lockDir(), "x.lock");
  const before = Date.now();
  const owner = await withLock(path, async () => JSON.parse(readFileSync(path, "utf8")));
  expect(owner).toMatchObject({ pid: process.pid, host: hostname() });
  expect(owner.time).toBeGreaterThanOrEqual(before);
  expect(typeof owner.command).toBe("string");
  expect(owner.command.length).toBeGreaterThan(0);
});

test("a waiter prints which lock it waits for, the holder, how long it has held it and its progress, at an interval", async () => {
  const path = join(lockDir(), "blame.lock");
  const holder = liveProcess();
  const fiveMinutesAgo = Date.now() - 5 * 60_000 - 3_000;
  writeFileSync(path, JSON.stringify({ token: "t", pid: holder.pid, host: hostname(), time: fiveMinutesAgo, command: "cochange abandonment current", progress: "blamed 3 of 10 files" }));
  const lines: string[] = [];
  const started = Date.now();
  const wait = withLock(path, async () => 1, { timeoutMs: 400, pollMs: 5, noticeAfterMs: 0, noticeEveryMs: 100, notify: (line) => lines.push(line) });
  await expect(wait).rejects.toBeInstanceOf(LockTimeoutError);
  const polls = (Date.now() - started) / 5;
  expect(lines.length).toBeGreaterThanOrEqual(2);
  expect(lines.length).toBeLessThan(polls / 4);
  expect(lines[0]).toMatch(new RegExp(`^waiting for blame\\.lock: held by process ${holder.pid} \\(cochange abandonment current\\) for 5m \\d+s, blamed 3 of 10 files$`));
});

test("a wait that times out names the holder and how long it showed no progress", async () => {
  const path = join(lockDir(), "blame.lock");
  const holder = liveProcess();
  writeFileSync(path, JSON.stringify({ token: "t", pid: holder.pid, host: hostname(), time: Date.now(), command: "cochange risk main" }));
  const error = await withLock(path, async () => 1, { timeoutMs: 1_000, notify: () => {} }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(LockTimeoutError);
  expect((error as Error).message).toBe(`Timed out waiting for blame.lock: process ${holder.pid} (cochange risk main) holds it and showed no progress for 1s`);
});

test("a holder that keeps reporting progress is waited for past the timeout", async () => {
  const path = join(lockDir(), "x.lock");
  let signalHeld!: () => void;
  const held = new Promise<void>((resolve) => (signalHeld = resolve));
  const options = { timeoutMs: 1_000, progressEveryMs: 0, notify: () => {} };
  const holder = withLock(
    path,
    async (lock) => {
      signalHeld();
      for (let i = 1; i <= 30; i++) {
        lock.progress(`step ${i}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    options,
  );
  await held;
  expect(await withLock(path, async () => "waited", options)).toBe("waited");
  await holder;
});

test("taking over a lock from a dead process prints a line saying so", async () => {
  const path = join(lockDir(), "blame.lock");
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  const pid = Number(child.stdout);
  writeFileSync(path, JSON.stringify({ token: "dead", pid, host: hostname(), time: Date.now(), command: "cochange abandonment current" }));
  const lines: string[] = [];
  expect(await withLock(path, async () => "ok", { timeoutMs: 30_000, notify: (line) => lines.push(line) })).toBe("ok");
  expect(lines).toEqual([`blame.lock: process ${pid} (cochange abandonment current) is no longer running, so this command takes the lock over`]);
});

test("a lock from another host is not judged by its process id", async () => {
  const path = join(lockDir(), "x.lock");
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  writeFileSync(path, JSON.stringify({ token: "far", pid: Number(child.stdout), host: `not-${hostname()}`, time: Date.now(), command: "cochange blame refresh" }));
  await expect(withLock(path, async () => 1, { timeoutMs: 100, staleMs: 3_600_000, notify: () => {} })).rejects.toBeInstanceOf(LockTimeoutError);
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
