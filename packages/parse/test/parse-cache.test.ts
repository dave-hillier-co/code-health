import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { fixtureCases } from "@code-health/fixtures/language-conformance";
import { analyseTree } from "../src/analyse-tree.ts";
import type { FileFacts } from "../src/facts.ts";
import { cacheKeyOf } from "../src/grammars.ts";
import { adapterById, overrideSupportedAdapters, registeredAdapters } from "../src/languages.ts";
import { ParseCache } from "../src/parse-cache.ts";
import { treeFromDirectory } from "../src/source-tree.ts";

const dirs: string[] = [];
const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "code-health-parse-cache-"));
  dirs.push(dir);
  return dir;
}

const facts: FileFacts = {
  units: [{ qualifiedName: "a", kind: "function", startLine: 1, endLine: 2, source: "structural" }],
  imports: [],
  reexports: [],
  exports: [],
  references: [],
  nodes: 0,
  hasSyntaxErrors: false,
};
const blob = "ce013625030ba8dba906f756967f9e9ca394464a";

describe("ParseCache", () => {
  it("returns what was stored for a blob and grammar version", async () => {
    const cache = new ParseCache(tempDir());
    expect(await cache.get(blob, "typescript-aaa")).toBeUndefined();
    await cache.set(blob, "typescript-aaa", facts);
    expect(await cache.get(blob, "typescript-aaa")).toEqual(facts);
  });

  it("misses when the grammar version differs", async () => {
    const cache = new ParseCache(tempDir());
    await cache.set(blob, "typescript-aaa", facts);
    expect(await cache.get(blob, "typescript-bbb")).toBeUndefined();
  });

  it("keys entries by the grammar version in the folder layout", async () => {
    const root = tempDir();
    await new ParseCache(root).set(blob, "typescript-aaa", facts);
    const [versionDir] = readdirSync(root);
    expect(versionDir).toContain("typescript-aaa");
    expect(existsSync(join(root, versionDir as string, "ce", `${blob}.json`))).toBe(true);
  });

  it("treats a corrupt entry as a miss", async () => {
    const root = tempDir();
    const cache = new ParseCache(root);
    await cache.set(blob, "typescript-aaa", facts);
    const [versionDir] = readdirSync(root);
    writeFileSync(join(root, versionDir as string, "ce", `${blob}.json`), "{not json");
    expect(await cache.get(blob, "typescript-aaa")).toBeUndefined();
  });

  it("lives under .cache/code-health/parse and is self-ignoring when opened for a repository", async () => {
    const repo = GitFixture.build([
      { type: "commit", message: "init", date: "2024-01-01T00:00:00+00:00", changes: [] },
    ]);
    fixtures.push(repo);
    const cache = await ParseCache.forRepository(repo.path);
    await cache.set(blob, "typescript-aaa", facts);
    expect(readFileSync(join(repo.path, ".cache", "code-health", ".gitignore"), "utf8")).toBe("*\n");
    expect(existsSync(join(repo.path, ".cache", "code-health", "parse"))).toBe(true);
  });
});

describe("ParseCache under concurrent writers", () => {
  it("lets many writers set the same entry at once and always reads a whole entry", async () => {
    const cache = new ParseCache(tempDir());
    const big: FileFacts = { ...facts, units: Array.from({ length: 2000 }, (_, i) => ({ ...facts.units[0]!, qualifiedName: `u${i}` })) };
    await Promise.all(Array.from({ length: 25 }, () => cache.set(blob, "typescript-aaa", big)));
    expect(await cache.get(blob, "typescript-aaa")).toEqual(big);
  });

  it("never exposes a partial entry to a reader racing a writer", async () => {
    const cache = new ParseCache(tempDir());
    const big: FileFacts = { ...facts, units: Array.from({ length: 5000 }, (_, i) => ({ ...facts.units[0]!, qualifiedName: `u${i}` })) };
    const writes = Promise.all(Array.from({ length: 10 }, () => cache.set(blob, "typescript-aaa", big)));
    const reads = await Promise.all(Array.from({ length: 50 }, () => cache.get(blob, "typescript-aaa")));
    await writes;
    for (const read of reads) expect(read === undefined || read.units.length === 5000).toBe(true);
  });

  it("leaves no temporary files behind", async () => {
    const root = tempDir();
    const cache = new ParseCache(root);
    await Promise.all(Array.from({ length: 5 }, () => cache.set(blob, "typescript-aaa", facts)));
    const files = readdirSync(join(root, readdirSync(root)[0]!, blob.slice(0, 2)));
    expect(files).toEqual([`${blob}.json`]);
  });

  it("round-trips facts with undefined fields as absent ones", async () => {
    const cache = new ParseCache(tempDir());
    const withUndefined = { ...facts, units: [{ ...facts.units[0]!, parent: undefined }] } as FileFacts;
    await cache.set(blob, "typescript-aaa", withUndefined);
    expect(await cache.get(blob, "typescript-aaa")).toEqual(facts);
  });
});

describe("the key facts are cached under", () => {
  const grammar = { version: "grammar-aaa+runtime-bbb" };

  it("changes when the extractor version does, so facts of an older extractor are not served", () => {
    expect(cacheKeyOf({ id: "go", extractorVersion: 1 }, grammar)).not.toBe(cacheKeyOf({ id: "go", extractorVersion: 2 }, grammar));
  });

  it("differs between two adapters that share a grammar", () => {
    expect(cacheKeyOf({ id: "java", extractorVersion: 1 }, grammar)).not.toBe(cacheKeyOf({ id: "kotlin", extractorVersion: 1 }, grammar));
  });

  it("makes a cache written for one extractor version a miss for the next", async () => {
    const cache = new ParseCache(tempDir());
    await cache.set(blob, cacheKeyOf({ id: "go", extractorVersion: 1 }, grammar), facts);
    expect(await cache.get(blob, cacheKeyOf({ id: "go", extractorVersion: 2 }, grammar))).toBeUndefined();
  });
});

describe.each(registeredAdapters.map((adapter) => adapter.id))("%s: a warm cache", (id) => {
  it("gives output identical to a cold one for every adapter fixture", async () => {
    overrideSupportedAdapters([adapterById(id)!]);
    try {
      for (const fixture of fixtureCases(id, "adapter")) {
        const tree = await treeFromDirectory(fixture.directory);
        const cache = new ParseCache(tempDir());
        const { stats: coldStats, ...cold } = await analyseTree(tree, { cache });
        const { stats: warmStats, ...warm } = await analyseTree(tree, { cache });
        expect(JSON.stringify(warm), `${id}/${fixture.name}`).toBe(JSON.stringify(cold));
        expect(coldStats.cached, `${id}/${fixture.name} cold run`).toBe(0);
        expect(warmStats.parsed, `${id}/${fixture.name} warm run`).toBe(0);
      }
    } finally {
      overrideSupportedAdapters(undefined);
    }
  });
});
