import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GRAMMAR_PART_BYTES, grammarPartName, locateGrammarFile, runtimeSpec, shippedGrammarSpecs } from "./grammars.ts";

/** The files one grammar is shipped as: the file itself, or its parts in order when it is larger than a part. */
function shippedAs(file: string, bytes: Buffer): { name: string; bytes: Buffer }[] {
  if (bytes.length <= GRAMMAR_PART_BYTES) return [{ name: file, bytes }];
  const parts: { name: string; bytes: Buffer }[] = [];
  for (let start = 0; start < bytes.length; start += GRAMMAR_PART_BYTES) {
    parts.push({ name: grammarPartName(file, parts.length), bytes: bytes.subarray(start, start + GRAMMAR_PART_BYTES) });
  }
  return parts;
}

/** Every file `copyGrammars` writes, with its bytes. The runtime is loaded by path, so it is always whole. */
function shippedFiles(): { name: string; bytes: Buffer }[] {
  const files = shippedGrammarSpecs().flatMap((spec) => shippedAs(spec.file, readFileSync(locateGrammarFile(spec))));
  const runtime = readFileSync(locateGrammarFile(runtimeSpec));
  if (runtime.length > GRAMMAR_PART_BYTES) throw new Error(`${runtimeSpec.file} is ${runtime.length} bytes: the runtime is loaded by path and cannot be shipped in parts`);
  return [...files, { name: runtimeSpec.file, bytes: runtime }];
}

/** The names of the files `copyGrammars` writes, sorted: a grammar over `GRAMMAR_PART_BYTES` appears as its parts. */
export function shippedGrammarFiles(): string[] {
  return [...new Set(shippedFiles().map((file) => file.name))].sort();
}

/**
 * Writes the .wasm files a parsing tool needs into `destination`, normally
 * `plugins/code-health/dist/grammars`, where the bundled CLI finds them relative
 * to `import.meta.url`. The plugin ships the grammar of every supported adapter;
 * which of them a tool loads depends on the repository it analyses. A grammar
 * larger than `GRAMMAR_PART_BYTES` is written as parts, which the loader joins.
 * The build calls this after esbuild. Anything else in `destination` is removed,
 * so a grammar that changes from whole to parts leaves no stale file. Returns the
 * written file names, sorted.
 */
export function copyGrammars(destination: string): string[] {
  mkdirSync(destination, { recursive: true });
  const files = shippedFiles();
  const names = new Set(files.map((file) => file.name));
  for (const existing of readdirSync(destination)) if (!names.has(existing)) rmSync(join(destination, existing), { recursive: true });
  for (const file of files) writeFileSync(join(destination, file.name), file.bytes);
  return [...names].sort();
}

/** The npm packages whose .wasm files `copyGrammars` ships, sorted, so the build can carry their licences. */
export function shippedGrammarPackages(): string[] {
  return [...new Set([...shippedGrammarSpecs(), runtimeSpec].map((spec) => spec.packageName))].sort();
}
