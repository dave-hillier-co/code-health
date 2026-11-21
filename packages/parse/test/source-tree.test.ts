import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { gitBlobSha, treeFromDirectory, treeFromRef } from "../src/source-tree.ts";

const fixtures: GitFixture[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): GitFixture {
  const fixture = GitFixture.build([
    {
      type: "commit",
      message: "initial",
      date: "2024-01-01T00:00:00+00:00",
      changes: Object.entries(files).map(([path, content]) => ({ op: "add" as const, path, content })),
    },
  ]);
  fixtures.push(fixture);
  return fixture;
}

describe("gitBlobSha", () => {
  it("matches git's own object hashing", () => {
    expect(gitBlobSha(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(gitBlobSha(Buffer.from(""))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });
});

describe("treeFromRef", () => {
  it("lists files with their blob SHAs and reads their content", async () => {
    const repo = repoWith({ "src/a.ts": "export const a = 1;\n", "b.ts": "é\n" });
    const tree = await treeFromRef(repo.path, "HEAD");
    expect([...tree.files.keys()]).toEqual(["b.ts", "src/a.ts"]);
    expect(tree.files.get("src/a.ts")).toBe(repo.git("rev-parse", "HEAD:src/a.ts"));
    expect(await tree.read("src/a.ts")).toBe("export const a = 1;\n");
    expect(await tree.read("b.ts")).toBe("é\n");
    expect(await tree.read("missing.ts")).toBeUndefined();
  });

  it("reads many files in one call", async () => {
    const repo = repoWith({ "a.ts": "A", "b.ts": "B", "c.ts": "C" });
    const tree = await treeFromRef(repo.path, "HEAD");
    const contents = await tree.readMany(["c.ts", "a.ts"]);
    expect([...contents]).toEqual([
      ["c.ts", "C"],
      ["a.ts", "A"],
    ]);
  });
});

describe("treeFromDirectory", () => {
  it("assigns the same blob SHAs git would and skips node_modules, .git and .cache", async () => {
    const repo = repoWith({ "src/a.ts": "export const a = 1;\n" });
    const dir = mkdtempSync(join(tmpdir(), "code-health-tree-"));
    dirs.push(dir);
    for (const [path, content] of Object.entries({
      "src/a.ts": "export const a = 1;\n",
      "node_modules/x/index.js": "x",
      ".git/config": "x",
      ".cache/code-health/x": "x",
    })) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    const tree = await treeFromDirectory(dir);
    expect([...tree.files.keys()]).toEqual(["src/a.ts"]);
    expect(tree.files.get("src/a.ts")).toBe(repo.git("rev-parse", "HEAD:src/a.ts"));
    expect(await tree.read("src/a.ts")).toBe("export const a = 1;\n");
  });
});
