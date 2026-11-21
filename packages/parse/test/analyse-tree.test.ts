import { afterEach, describe, expect, it } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { analyseTree, compareUtf8, isTestPath } from "../src/analyse-tree.ts";
import { ParseCache } from "../src/parse-cache.ts";
import { treeFromRef } from "../src/source-tree.ts";

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function history(): GitFixture {
  const fixture = GitFixture.build([
    {
      type: "commit",
      message: "initial",
      date: "2024-01-01T00:00:00+00:00",
      changes: [
        { op: "add", path: "src/a.ts", content: "import { b } from './b';\nexport function a() { return b(); }\n" },
        { op: "add", path: "src/b.ts", content: "export function b() { return 1; }\n" },
        { op: "add", path: "README.md", content: "# not parsed\n" },
      ],
    },
    {
      type: "commit",
      message: "change b and move a",
      date: "2024-01-02T00:00:00+00:00",
      changes: [
        { op: "modify", path: "src/b.ts", content: "export function b() { return 2; }\nexport function c() {}\n" },
        { op: "rename", from: "src/a.ts", path: "lib/a.ts", content: "import { b } from '../src/b';\nexport function a() { return b(); }\n" },
      ],
    },
  ]);
  fixtures.push(fixture);
  return fixture;
}

describe("analyseTree over a git ref", () => {
  it("analyses a historical revision by its blobs", async () => {
    const repo = history();
    const analysis = await analyseTree(await treeFromRef(repo.path, "HEAD~1"));
    expect(analysis.units.map((unit) => unit.id)).toEqual(["src/a.ts#a", "src/b.ts#b"]);
    expect(analysis.importEdges).toEqual([{ from: "src/a.ts", to: "src/b.ts", kind: "import", typeOnly: false }]);
  });

  it("parses only blobs it has not seen, across revisions", async () => {
    const repo = history();
    const cache = await ParseCache.forRepository(repo.path);

    const first = await analyseTree(await treeFromRef(repo.path, "HEAD~1"), { cache });
    expect(first.stats).toEqual({ parsed: 2, cached: 0 });

    const again = await analyseTree(await treeFromRef(repo.path, "HEAD~1"), { cache });
    expect(again.stats).toEqual({ parsed: 0, cached: 2 });
    expect(again.units).toEqual(first.units);

    // HEAD has two new blobs (b.ts changed, a.ts moved with new content). Nothing else is reparsed.
    const head = await analyseTree(await treeFromRef(repo.path, "HEAD"), { cache });
    expect(head.stats).toEqual({ parsed: 2, cached: 0 });
    const back = await analyseTree(await treeFromRef(repo.path, "HEAD~1"), { cache });
    expect(back.stats).toEqual({ parsed: 0, cached: 2 });
  });

  it("reuses a cached parse for a renamed file whose content is unchanged", async () => {
    const repo = GitFixture.build([
      {
        type: "commit",
        message: "initial",
        date: "2024-01-01T00:00:00+00:00",
        changes: [{ op: "add", path: "a.ts", content: "export function a() {}\n" }],
      },
      {
        type: "commit",
        message: "rename",
        date: "2024-01-02T00:00:00+00:00",
        changes: [{ op: "rename", from: "a.ts", path: "deep/a.ts" }],
      },
    ]);
    fixtures.push(repo);
    const cache = await ParseCache.forRepository(repo.path);
    await analyseTree(await treeFromRef(repo.path, "HEAD~1"), { cache });
    const moved = await analyseTree(await treeFromRef(repo.path, "HEAD"), { cache });
    expect(moved.stats).toEqual({ parsed: 0, cached: 1 });
    expect(moved.units.map((unit) => unit.id)).toEqual(["deep/a.ts#a"]);
  });

  it("flags files with syntax errors", async () => {
    const repo = GitFixture.build([
      {
        type: "commit",
        message: "initial",
        date: "2024-01-01T00:00:00+00:00",
        changes: [
          { op: "add", path: "broken.ts", content: "export function ( {\n" },
          { op: "add", path: "fine.ts", content: "export function fine() {}\n" },
        ],
      },
    ]);
    fixtures.push(repo);
    const analysis = await analyseTree(await treeFromRef(repo.path, "HEAD"));
    expect(analysis.filesWithSyntaxErrors).toEqual(["broken.ts"]);
  });
});

describe("isTestPath", () => {
  it.each([
    ["src/a.test.ts", true],
    ["src/a.spec.tsx", true],
    ["src/a.test.mjs", true],
    ["test/helper.ts", true],
    ["packages/x/tests/a.ts", true],
    ["src/__tests__/a.ts", true],
    ["src/__mocks__/a.ts", true],
    ["src/latest/a.ts", false],
    ["src/contest.ts", false],
    ["src/a.ts", false],
  ])("%s is test: %s", (path, expected) => {
    expect(isTestPath(path)).toBe(expected);
  });
});

describe("compareUtf8", () => {
  it("orders by code point, which is UTF-8 byte order", () => {
    const sorted = ["é", "z", "a", "\u{1F600}", "Ａ"].sort(compareUtf8);
    expect(sorted).toEqual(["a", "z", "é", "Ａ", "\u{1F600}"]);
    expect(compareUtf8("a", "ab")).toBeLessThan(0);
    expect(compareUtf8("same", "same")).toBe(0);
  });
});
