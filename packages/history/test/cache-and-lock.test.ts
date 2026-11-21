import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  const hold = (name: string, ms: number) =>
    withLock(path, async () => {
      events.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`${name}:end`);
    });
  await Promise.all([hold("a", 80), hold("b", 10)]);
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
  writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), time: Date.now() }));
  expect(await withLock(path, async () => "ok", { timeoutMs: 1000 })).toBe("ok");
});

test("waiting for a live holder times out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "code-health-lock-"));
  dirs.push(dir);
  const path = join(dir, "x.lock");
  const holder = withLock(path, () => new Promise((r) => setTimeout(r, 300)));
  await new Promise((r) => setTimeout(r, 20));
  await expect(withLock(path, async () => 1, { timeoutMs: 100 })).rejects.toBeInstanceOf(LockTimeoutError);
  await holder;
});
