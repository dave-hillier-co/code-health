import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
