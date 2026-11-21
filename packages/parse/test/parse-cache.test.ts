import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import type { FileFacts } from "../src/facts.ts";
import { ParseCache } from "../src/parse-cache.ts";

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
