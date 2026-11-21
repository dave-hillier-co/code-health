import { runGit } from "./git.ts";

/** Files in the tree of `ref`, repo-relative POSIX paths, sorted. */
export async function listTree(repoPath: string, ref: string): Promise<string[]> {
  const out = await runGit(repoPath, ["ls-tree", "-r", "--name-only", "-z", "--full-tree", ref]);
  return out.split("\0").filter((p) => p !== "").sort();
}

/** Contents of a file at `ref`, or undefined when it does not exist there. */
export async function readBlobAt(repoPath: string, ref: string, path: string): Promise<string | undefined> {
  try {
    return await runGit(repoPath, ["cat-file", "blob", `${ref}:${path}`]);
  } catch {
    return undefined;
  }
}

/** Contents of the blob with this object id, as text. */
export async function readBlob(repoPath: string, blob: string): Promise<string> {
  return runGit(repoPath, ["cat-file", "blob", blob]);
}

/** Size in bytes of the blob with this object id. */
export async function blobSize(repoPath: string, blob: string): Promise<number> {
  return Number((await runGit(repoPath, ["cat-file", "-s", blob])).trim());
}

/**
 * Parses `.git-blame-ignore-revs`: one revision per line, `#` comments.
 * Returns lower-case SHA prefixes.
 */
export function parseBlameIgnoreRevs(text: string): string[] {
  const revs: string[] = [];
  for (const line of text.split("\n")) {
    const token = line.replace(/#.*/, "").trim().split(/\s+/)[0] ?? "";
    if (/^[0-9a-f]{7,40}$/i.test(token)) revs.push(token.toLowerCase());
  }
  return revs;
}

export async function readBlameIgnoreRevs(repoPath: string, ref: string, file: string): Promise<string[]> {
  const text = await readBlobAt(repoPath, ref, file);
  return text === undefined ? [] : parseBlameIgnoreRevs(text);
}

export interface PathAttributes {
  generated: Set<string>;
  vendored: Set<string>;
}

const isSet = (value: string) => value === "set" || value === "true";

/**
 * Paths carrying `linguist-generated` or `linguist-vendored`, as git itself
 * evaluates them (nested files, patterns and negation) against the tree of `ref`.
 * Skipped entirely when the tree has no .gitattributes.
 */
export async function readPathAttributes(
  repoPath: string,
  ref: string,
  paths: readonly string[],
  treeFiles: readonly string[],
): Promise<PathAttributes> {
  const result: PathAttributes = { generated: new Set(), vendored: new Set() };
  const hasAttributes = treeFiles.some((p) => p === ".gitattributes" || p.endsWith("/.gitattributes"));
  if (!hasAttributes || paths.length === 0) return result;
  const input = paths.join("\0") + "\0";
  const base = ["check-attr", "-z", "--stdin"];
  const names = ["linguist-generated", "linguist-vendored"];
  let out: string;
  try {
    out = await runGit(repoPath, [...base, `--source=${ref}`, ...names], { input });
  } catch {
    // git older than 2.40 has no --source: fall back to the working tree.
    out = await runGit(repoPath, [...base, ...names], { input });
  }
  const tokens = out.split("\0");
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const [path, attribute, value] = [tokens[i]!, tokens[i + 1]!, tokens[i + 2]!];
    if (!isSet(value)) continue;
    if (attribute === "linguist-generated") result.generated.add(path);
    else if (attribute === "linguist-vendored") result.vendored.add(path);
  }
  return result;
}
