import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Names the code that is running, so a stored result or build written by different code is not reused.
 *
 * - Run from a bundle (`<plugin>.mjs` with its `chunk-*.mjs` files): the SHA-256 of the content of every `.mjs`
 *   file in the bundle's folder, taken once per process.
 * - Run from source (development and tests): the size and modification time of every `.ts` file under
 *   `packages/<name>/src`, taken once per process. This is a stat, not a content hash, because the source tree
 *   has hundreds of files.
 */

let cached: string | undefined;

function bundleIdentity(dir: string): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".mjs")).sort()) {
    hash.update(name).update("\0").update(readFileSync(join(dir, name))).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function sourceIdentity(packages: string): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(packages).sort()) {
    let files: string[];
    try {
      files = sourceFiles(join(packages, name, "src")).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const s = statSync(file);
      hash.update(`${file}:${s.size}:${s.mtimeMs}\n`);
    }
  }
  return hash.digest("hex").slice(0, 16);
}

/** A short string that is equal for equal code and differs when the bundle or the source changed. */
export function codeIdentity(): string {
  if (cached !== undefined) return cached;
  const here = fileURLToPath(import.meta.url);
  try {
    cached = here.endsWith(".ts") ? sourceIdentity(join(dirname(here), "..", "..")) : bundleIdentity(dirname(here));
  } catch {
    cached = "unknown";
  }
  return cached;
}
