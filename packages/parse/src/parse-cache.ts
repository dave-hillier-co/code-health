import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureCacheDir, locateCache } from "@code-health/history/cache-location";
import type { FileFacts } from "./facts.ts";

/**
 * Parse results keyed by git blob SHA and a grammar cache key, under
 * `.cache/code-health/parse/`. Content-addressed, so entries are never
 * invalidated, and a historical revision is analysed by its blobs.
 */
export class ParseCache {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  /** The cache of the repository containing `repoPath`, shared by its linked worktrees. */
  static async forRepository(repoPath: string): Promise<ParseCache> {
    const location = await locateCache(repoPath);
    ensureCacheDir(location);
    return new ParseCache(join(location.cacheDir, "parse"));
  }

  async get(blobSha: string, key: string): Promise<FileFacts | undefined> {
    try {
      return JSON.parse(await readFile(this.entryPath(blobSha, key), "utf8")) as FileFacts;
    } catch {
      return undefined;
    }
  }

  async set(blobSha: string, key: string, facts: FileFacts): Promise<void> {
    const path = this.entryPath(blobSha, key);
    await mkdir(dirname(path), { recursive: true });
    // Unique per call: concurrent writers in one process share a pid, and must not share a temporary file.
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(facts));
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  /** The key is a loaded grammar's `cacheKey`: its version and the extractor's, so changed extraction rules never read old facts. */
  private entryPath(blobSha: string, key: string): string {
    return join(this.directory, key, blobSha.slice(0, 2), `${blobSha}.json`);
  }
}
