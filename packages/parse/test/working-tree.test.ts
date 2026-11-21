import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { gitBlobSha, restrictTree, treeFromRef, treeFromWorkingTree } from "../src/source-tree.ts";

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
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

describe("treeFromWorkingTree", () => {
  it("is the committed tree when nothing changed", async () => {
    const repo = repoWith({ "src/a.ts": "export const a = 1;\n", "b.ts": "B" });
    const working = await treeFromWorkingTree(repo.path);
    const committed = await treeFromRef(repo.path, "HEAD");
    expect([...working.files]).toEqual([...committed.files]);
  });

  it("sees edits, untracked files and deletions, and leaves out ignored files", async () => {
    const repo = repoWith({ "a.ts": "A", "b.ts": "B", ".gitignore": "ignored/\n" });
    writeFileSync(join(repo.path, "a.ts"), "A changed");
    writeFileSync(join(repo.path, "new.ts"), "N");
    mkdirSync(join(repo.path, "ignored"));
    writeFileSync(join(repo.path, "ignored", "x.ts"), "X");
    rmSync(join(repo.path, "b.ts"));
    const tree = await treeFromWorkingTree(repo.path);
    expect([...tree.files.keys()]).toEqual([".gitignore", "a.ts", "new.ts"]);
    expect(await tree.read("a.ts")).toBe("A changed");
    expect(tree.files.get("a.ts")).toBe(gitBlobSha(Buffer.from("A changed")));
    expect(await tree.read("b.ts")).toBeUndefined();
  });
});

describe("restrictTree", () => {
  it("holds only the named files that exist, in path order", async () => {
    const repo = repoWith({ "a.ts": "A", "b.ts": "B", "c.ts": "C" });
    const tree = restrictTree(await treeFromRef(repo.path, "HEAD"), ["c.ts", "a.ts", "missing.ts"]);
    expect([...tree.files.keys()]).toEqual(["a.ts", "c.ts"]);
    expect(await tree.read("b.ts")).toBeUndefined();
    expect([...(await tree.readMany(["a.ts", "b.ts", "c.ts"])).keys()]).toEqual(["a.ts", "c.ts"]);
  });
});
