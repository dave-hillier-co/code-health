import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { GitFixture, type Step } from "@code-health/fixtures/git-fixture";
import { locateCache } from "../src/cache-location.ts";
import { refresh } from "../src/refresh.ts";
import { SCHEMA_VERSION } from "../src/store.ts";

// Fixture repos run real processes many times, which is slow on a loaded machine.
vi.setConfig({ testTimeout: 180_000 });

const fixtures: GitFixture[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function build(steps: Step[]) {
  const f = GitFixture.build(steps);
  fixtures.push(f);
  return f;
}

function commit(n: number, path = `f${n}`): Step {
  return {
    type: "commit",
    message: `commit ${n}`,
    date: `2024-01-${String(n).padStart(2, "0")}T10:00:00Z`,
    changes: [{ op: "add", path, content: `${n}\n` }],
  };
}

async function query<T>(repo: GitFixture, sql: string): Promise<T[]> {
  const { dbPath } = await locateCache(repo.path);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

const count = async (repo: GitFixture, table: string) =>
  (await query<{ n: number }>(repo, `SELECT COUNT(*) AS n FROM ${table}`))[0]!.n;

test("first refresh stores every commit with changes and writes the cache gitignore", async () => {
  const repo = build([commit(1), commit(2), commit(3)]);
  const result = await refresh(repo.path);
  expect(result.added).toBe(3);
  expect(result.reachable).toBe(3);
  expect(result.rebuilt).toBe(false);
  expect(result.headSha).toBe(repo.git("rev-parse", "HEAD"));
  expect(await count(repo, "commits")).toBe(3);
  expect(await count(repo, "changes")).toBe(3);
  const { cacheDir } = await locateCache(repo.path);
  expect(readFileSync(join(cacheDir, ".gitignore"), "utf8").trim()).toBe("*");
  expect(repo.git("status", "--porcelain")).toBe("");
  const meta = await query<{ key: string; value: string }>(repo, "SELECT key, value FROM meta");
  expect(meta.find((m) => m.key === "git_version")?.value).toMatch(/^\d+\.\d+/);
});

test("refresh is incremental and adds only new commits", async () => {
  const repo = build([commit(1), commit(2)]);
  await refresh(repo.path);
  expect((await refresh(repo.path)).added).toBe(0);
  repo.apply([commit(3), commit(4)]);
  const result = await refresh(repo.path);
  expect(result.added).toBe(2);
  expect(await count(repo, "commits")).toBe(4);
});

test("switching branches adds only the commits not yet stored", async () => {
  const repo = build([commit(1), commit(2), { type: "branch", name: "feature" }, commit(3), commit(4)]);
  repo.git("checkout", "--quiet", "main");
  await refresh(repo.path, { ref: "main" });
  const result = await refresh(repo.path, { ref: "feature" });
  expect(result.added).toBe(2);
  expect(result.reachable).toBe(4);
});

test("a rewritten history costs only the new commits and keeps the old ones stored", async () => {
  const repo = build([commit(1), commit(2), commit(3)]);
  await refresh(repo.path);
  repo.git("reset", "--quiet", "--hard", "HEAD~1");
  repo.apply([commit(4, "other")]);
  const result = await refresh(repo.path);
  expect(result.added).toBe(1);
  expect(result.reachable).toBe(3);
  expect(await count(repo, "commits")).toBe(4);
});

test("a schema version mismatch rebuilds the cache", async () => {
  const repo = build([commit(1), commit(2)]);
  await refresh(repo.path);
  const { dbPath } = await locateCache(repo.path);
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  db.close();
  const result = await refresh(repo.path);
  expect(result.rebuilt).toBe(true);
  expect(result.added).toBe(2);
});

test("changing the rename similarity rebuilds the cache", async () => {
  const repo = build([commit(1)]);
  await refresh(repo.path, { similarity: 50 });
  expect((await refresh(repo.path, { similarity: 50 })).rebuilt).toBe(false);
  const result = await refresh(repo.path, { similarity: 80 });
  expect(result.rebuilt).toBe(true);
  expect(result.added).toBe(1);
});

test("a damaged cache file is rebuilt", async () => {
  const repo = build([commit(1)]);
  await refresh(repo.path);
  const { dbPath } = await locateCache(repo.path);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(dbPath, "this is not a database");
  const result = await refresh(repo.path);
  expect(result.rebuilt).toBe(true);
  expect(result.added).toBe(1);
});

test("concurrent refreshes do not duplicate work", async () => {
  const repo = build(Array.from({ length: 12 }, (_, i) => commit(i + 1)));
  const results = await Promise.all([refresh(repo.path), refresh(repo.path), refresh(repo.path)]);
  expect(results.reduce((sum, r) => sum + r.added, 0)).toBe(12);
  expect(await count(repo, "commits")).toBe(12);
  const { lockPath } = await locateCache(repo.path);
  expect(existsSync(lockPath)).toBe(false);
});

test("refreshes from separate processes serialise on the lock", async () => {
  const repo = build(Array.from({ length: 8 }, (_, i) => commit(i + 1)));
  const script = join(import.meta.dirname, "support", "refresh-process.ts");
  const run = () =>
    new Promise<number>((resolve, reject) => {
      execFile(process.execPath, ["--experimental-strip-types", "--no-warnings", script, repo.path], (error, stdout, stderr) => {
        if (error) reject(new Error(`child failed (${error.code}): ${stderr}`));
        else resolve(Number(stdout.trim()));
      });
    });
  const added = await Promise.all([run(), run()]);
  expect(added.reduce((a, b) => a + b, 0)).toBe(8);
});

test("renames are recorded with their old path", async () => {
  const repo = build([
    { type: "commit", message: "a", date: "2024-01-01T00:00:00Z", changes: [{ op: "add", path: "old.txt", content: "1\n2\n3\n4\n5\n6\n" }] },
    { type: "commit", message: "mv", date: "2024-01-02T00:00:00Z", changes: [{ op: "rename", from: "old.txt", path: "new/new.txt" }] },
  ]);
  await refresh(repo.path);
  const rows = await query<{ path: string; old_path: string; status: string; similarity: number }>(
    repo,
    "SELECT path, old_path, status, similarity FROM changes WHERE status = 'R'",
  );
  expect(rows).toEqual([{ path: "new/new.txt", old_path: "old.txt", status: "R", similarity: 100 }]);
});

function shallowClone(source: GitFixture, depth: number): string {
  const dir = mkdtempSync(join(tmpdir(), "code-health-clone-"));
  dirs.push(dir);
  const target = join(dir, "clone");
  execFileSync("git", ["clone", "--quiet", `--depth=${depth}`, `file://${source.path}`, target], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  return realpathSync(target);
}

test("shallow clones are detected and boundary commits are re-read once deepened", async () => {
  const source = build([commit(1), commit(2), commit(3), commit(4)]);
  const clone = shallowClone(source, 2);
  const first = await refresh(clone);
  expect(first.shallow.isShallow).toBe(true);
  expect(first.shallow.boundary).toHaveLength(1);
  expect(first.reachable).toBe(2);

  const boundarySha = first.shallow.boundary[0]!;
  const location = await locateCache(clone);
  const read = (sql: string) => {
    const db = new DatabaseSync(location.dbPath, { readOnly: true });
    try {
      return db.prepare(sql).all() as Record<string, unknown>[];
    } finally {
      db.close();
    }
  };
  expect(read(`SELECT boundary FROM commits WHERE sha = '${boundarySha}'`)).toEqual([{ boundary: 1 }]);
  // The truncated commit looks like it added the whole tree.
  expect(read(`SELECT COUNT(*) AS n FROM changes WHERE sha = '${boundarySha}'`)).toEqual([{ n: 3 }]);

  execFileSync("git", ["fetch", "--quiet", "--unshallow"], { cwd: clone, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  const second = await refresh(clone);
  expect(second.shallow.isShallow).toBe(false);
  expect(second.reachable).toBe(4);
  expect(second.added).toBe(3); // the old boundary commit plus the two older commits
  expect(read(`SELECT boundary FROM commits WHERE sha = '${boundarySha}'`)).toEqual([{ boundary: 0 }]);
  expect(read(`SELECT COUNT(*) AS n FROM changes WHERE sha = '${boundarySha}'`)).toEqual([{ n: 1 }]);
});

test("the analysed repository is never modified", async () => {
  const repo = build([commit(1), commit(2)]);
  const before = repo.git("for-each-ref");
  await refresh(repo.path);
  expect(repo.git("for-each-ref")).toBe(before);
  expect(repo.git("status", "--porcelain", "--ignored")).toBe("!! .cache/");
});

test("an interrupted refresh never stores a commit without its ancestors", async () => {
  const repo = build([commit(1), commit(2), commit(3), commit(4)]);
  const blob = repo.git("rev-parse", "HEAD~2:f2");
  rmSync(join(repo.path, ".git", "objects", blob.slice(0, 2), blob.slice(2)), { force: true });
  await expect(refresh(repo.path, { batchSize: 1 })).rejects.toThrow();
  const head = repo.git("rev-parse", "HEAD");
  const stored = await query<{ sha: string }>(repo, "SELECT sha FROM commits");
  expect(stored.map((r) => r.sha)).not.toContain(head);
});
