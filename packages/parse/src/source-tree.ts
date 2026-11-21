import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readPathAttributes } from "@code-health/history/tree";

/**
 * The files of one revision (a git ref, or a directory on disk), each with its
 * git blob SHA so parse results can be cached by content.
 */
export interface SourceTree {
  /** Repo-relative POSIX path to blob SHA, in path order. */
  files: ReadonlyMap<string, string>;
  /** UTF-8 text of a file, or undefined when the path is not in the tree. */
  read(path: string): Promise<string | undefined>;
  /** Reads several files at once. Paths not in the tree are left out. */
  readMany(paths: readonly string[]): Promise<Map<string, string>>;
}

/** The SHA-1 git assigns to a file with this content. */
export function gitBlobSha(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

function sortedMap<T>(entries: [string, T][]): Map<string, T> {
  return new Map(entries.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
}

const skippedDirectories = new Set(["node_modules", ".git", ".cache"]);

function walk(root: string, relative: string, out: string[]): void {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) walk(root, path, out);
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
}

/** A tree over the files currently on disk, for conformance fixtures and uncommitted work. */
export async function treeFromDirectory(directory: string): Promise<SourceTree> {
  const paths: string[] = [];
  walk(directory, "", paths);
  const shas: [string, string][] = paths.map((path) => [path, gitBlobSha(readFileSync(join(directory, path)))]);
  const known = new Set(paths);
  const read = async (path: string) => (known.has(path) ? readFileSync(join(directory, path), "utf8") : undefined);
  return {
    files: sortedMap(shas),
    read,
    async readMany(wanted) {
      const out = new Map<string, string>();
      for (const path of wanted) {
        const text = await read(path);
        if (text !== undefined) out.set(path, text);
      }
      return out;
    },
  };
}

/**
 * A tree of the files in the working directory of a repository: tracked files, and untracked ones that
 * are not ignored, read from disk. Deleted files are left out, so uncommitted work is analysed as it stands.
 */
export async function treeFromWorkingTree(repoPath: string): Promise<SourceTree> {
  const listing = (await git(repoPath, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).toString("utf8");
  const entries: [string, string][] = [];
  const seen = new Set<string>();
  for (const path of listing.split("\0")) {
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    try {
      if (!lstatSync(join(repoPath, path)).isFile()) continue;
      entries.push([path, gitBlobSha(readFileSync(join(repoPath, path)))]);
    } catch {
      // Listed but gone from disk: deleted and not yet staged.
    }
  }
  const files = sortedMap(await withoutMarkedPaths(repoPath, undefined, entries));
  const read = async (path: string) => (files.has(path) ? readFileSync(join(repoPath, path), "utf8") : undefined);
  return {
    files,
    read,
    async readMany(wanted) {
      const out = new Map<string, string>();
      for (const path of wanted) {
        const text = await read(path);
        if (text !== undefined) out.set(path, text);
      }
      return out;
    },
  };
}

/** A view of a tree holding only some of its files, for comparing the files a change touched. */
export function restrictTree(tree: SourceTree, paths: Iterable<string>): SourceTree {
  const files = new Map<string, string>();
  for (const path of [...new Set(paths)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const blob = tree.files.get(path);
    if (blob !== undefined) files.set(path, blob);
  }
  return {
    files,
    read: async (path) => (files.has(path) ? tree.read(path) : undefined),
    readMany: (wanted) => tree.readMany(wanted.filter((path) => files.has(path))),
  };
}

function git(cwd: string, args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        LC_ALL: "C",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`git ${args.join(" ")} failed (${code}): ${Buffer.concat(err).toString("utf8").trim()}`));
    });
    child.stdin.end(input ?? "");
  });
}

const batchSize = 256;

/** Reads blobs through one `git cat-file --batch` process per chunk. */
async function readBlobs(cwd: string, shas: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let start = 0; start < shas.length; start += batchSize) {
    const chunk = shas.slice(start, start + batchSize);
    const stdout = await git(cwd, ["cat-file", "--batch"], `${chunk.join("\n")}\n`);
    let offset = 0;
    for (const sha of chunk) {
      const newline = stdout.indexOf(0x0a, offset);
      const header = stdout.toString("utf8", offset, newline).split(" ");
      if (header[1] !== "blob") {
        offset = newline + 1;
        continue;
      }
      const size = Number(header[2]);
      const bodyStart = newline + 1;
      out.set(sha, stdout.toString("utf8", bodyStart, bodyStart + size));
      offset = bodyStart + size + 1;
    }
  }
  return out;
}

/**
 * Drops the files that `.gitattributes` marks `linguist-generated` or `linguist-vendored`, the same
 * paths the history filters treat as noise, so every plugin analyses one set of files.
 */
async function withoutMarkedPaths(repoPath: string, ref: string | undefined, entries: [string, string][]): Promise<[string, string][]> {
  const paths = entries.map(([path]) => path);
  let marked;
  try {
    marked = await readPathAttributes(repoPath, ref, paths, paths);
  } catch {
    return entries;
  }
  return entries.filter(([path]) => !marked.generated.has(path) && !marked.vendored.has(path));
}

/** A tree of the files at a git ref. Submodules and symlinks are left out. */
export async function treeFromRef(repoPath: string, ref: string): Promise<SourceTree> {
  const listing = (await git(repoPath, ["ls-tree", "-r", "-z", "--full-tree", ref])).toString("utf8");
  const entries: [string, string][] = [];
  for (const record of listing.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode, type, sha] = record.slice(0, tab).split(" ");
    if (type !== "blob" || mode === "120000" || !sha) continue;
    entries.push([record.slice(tab + 1), sha]);
  }
  const files = sortedMap(await withoutMarkedPaths(repoPath, ref, entries));
  const readMany = async (wanted: readonly string[]) => {
    const known = wanted.filter((path) => files.has(path));
    const blobs = await readBlobs(repoPath, [...new Set(known.map((path) => files.get(path) as string))]);
    const out = new Map<string, string>();
    for (const path of known) {
      const text = blobs.get(files.get(path) as string);
      if (text !== undefined) out.set(path, text);
    }
    return out;
  };
  return {
    files,
    readMany,
    async read(path) {
      return (await readMany([path])).get(path);
    },
  };
}

/** A tree held in memory, from path to text. Paths are listed in UTF-8 order, and blob SHAs are the ones git would give. */
export function treeFromTexts(texts: Readonly<Record<string, string>>): SourceTree {
  const contents = new Map(Object.entries(texts));
  const files = sortedMap([...contents].map(([path, text]): [string, string] => [path, gitBlobSha(Buffer.from(text))]));
  return {
    files,
    read: async (path) => contents.get(path),
    readMany: async (paths) => new Map(paths.filter((path) => contents.has(path)).map((path) => [path, contents.get(path)!])),
  };
}
