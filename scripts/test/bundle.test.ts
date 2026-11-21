import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { bundle, bundledPlugins } from "../bundle.mjs";

vi.setConfig({ testTimeout: 60_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let text: string;
let work: string;
let repo: GitFixture;
beforeAll(async () => {
  text = await bundle("cochange");
  work = mkdtempSync(join(tmpdir(), "cochange-bundle-"));
  writeFileSync(join(work, "cochange.mjs"), text);
  repo = GitFixture.build([
    {
      type: "commit",
      message: "one",
      date: "2024-01-01T00:00:00Z",
      changes: [{ op: "add", path: "src/a.ts", content: "a\n" }],
    },
    {
      type: "commit",
      message: "two",
      date: "2024-01-02T00:00:00Z",
      changes: [{ op: "modify", path: "src/a.ts", content: "b\n" }],
    },
  ]);
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  repo.dispose();
});

test("plugins with a CLI source are bundled", () => {
  expect(bundledPlugins(root)).toContain("cochange");
});

test("a rebuild is byte identical", async () => {
  expect(await bundle("cochange")).toBe(text);
});

test("the bundle imports only Node builtins, and is a single ESM file", () => {
  const specifiers = [...text.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  expect(specifiers.length).toBeGreaterThan(0);
  for (const specifier of specifiers) expect(specifier).toMatch(/^node:/);
  expect(text).not.toMatch(/require\(["'](?!node:)/);
  expect(text).not.toContain("sourceMappingURL");
  expect(text).not.toContain(root);
});

test("the bundle runs under plain node, outside the repository's own node_modules", () => {
  const run = spawnSync("node", [join(work, "cochange.mjs"), "refresh"], { cwd: repo.path, encoding: "utf8" });
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  const document = JSON.parse(run.stdout);
  expect(document).toMatchObject({ tool: "cochange", command: "refresh", results: { added: 2, reachable: 2 } });

  const outside = spawnSync("node", [join(work, "cochange.mjs"), "refresh", "--json"], { cwd: tmpdir(), encoding: "utf8" });
  expect(outside.status).toBe(3);
  expect(JSON.parse(outside.stderr).error.code).toBe("not-a-git-repo");

  const help = execFileSync("node", [join(work, "cochange.mjs"), "--help"], { encoding: "utf8" });
  expect(help).toContain("refresh");
});

interface Refreshed {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** A real process of the bundle, started without waiting, so several can be in flight at once. */
function blameRefresh(cwd: string, bundlePath: string): Promise<Refreshed> {
  return new Promise((resolve) => {
    const child = spawn("node", [bundlePath, "blame", "refresh", "--json"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const refreshed = (run: Refreshed) => (JSON.parse(run.stdout) as { results: { files: number; blamed: number; reused: number; rebuilt: boolean } }).results;

/** Six files, so a refresh has real work to share out. */
function blameRepository(): GitFixture {
  return GitFixture.build([
    {
      type: "commit",
      message: "files",
      date: "2024-01-01T00:00:00Z",
      changes: ["a", "b", "c", "d", "e", "f"].map((name) => ({ op: "add" as const, path: `src/${name}.ts`, content: `export const ${name} = 1;\nexport const ${name}2 = 2;\n` })),
    },
  ]);
}

test("separate processes refreshing the blame cache at once take turns, each file is blamed once, and nothing is left locked", async () => {
  const blame = blameRepository();
  try {
    const bundlePath = join(work, "cochange.mjs");
    const runs = await Promise.all([blameRefresh(blame.path, bundlePath), blameRefresh(blame.path, bundlePath), blameRefresh(blame.path, bundlePath)]);
    for (const run of runs) {
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
    }
    const results = runs.map(refreshed);
    expect(results.reduce((sum, r) => sum + r.blamed, 0)).toBe(6);
    expect(results.reduce((sum, r) => sum + r.reused, 0)).toBe(12);
    expect(existsSync(join(blame.path, ".cache", "code-health", "blame.lock"))).toBe(false);
    // The cache they left is whole: a later run reuses every file.
    expect(refreshed(await blameRefresh(blame.path, bundlePath))).toMatchObject({ blamed: 0, reused: 6, rebuilt: false });
  } finally {
    blame.dispose();
  }
});

test("a lock left by a killed process does not stop the next refresh", async () => {
  const blame = blameRepository();
  try {
    const bundlePath = join(work, "cochange.mjs");
    expect((await blameRefresh(blame.path, bundlePath)).status).toBe(0);
    const killed = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    writeFileSync(join(blame.path, ".cache", "code-health", "blame.lock"), JSON.stringify({ token: "killed", pid: Number(killed.stdout), host: hostname(), time: Date.now() }));
    const run = await blameRefresh(blame.path, bundlePath);
    expect(run.status).toBe(0);
    expect(refreshed(run)).toMatchObject({ blamed: 0, reused: 6 });
    expect(existsSync(join(blame.path, ".cache", "code-health", "blame.lock"))).toBe(false);
  } finally {
    blame.dispose();
  }
});

test("a truncated or corrupt blame cache is rebuilt, not trusted and not fatal", async () => {
  const blame = blameRepository();
  try {
    const bundlePath = join(work, "cochange.mjs");
    expect((await blameRefresh(blame.path, bundlePath)).status).toBe(0);
    const cache = join(blame.path, ".cache", "code-health", "blame.sqlite");
    for (const damage of [(bytes: Buffer) => bytes.subarray(0, Math.floor(bytes.length / 2)), () => Buffer.from("this is not a database at all")]) {
      writeFileSync(cache, damage(readFileSync(cache)));
      const run = await blameRefresh(blame.path, bundlePath);
      expect(run.status, run.stderr).toBe(0);
      expect(refreshed(run)).toMatchObject({ blamed: 6, reused: 0, rebuilt: true });
    }
  } finally {
    blame.dispose();
  }
});
