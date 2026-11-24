import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { authoredFilesAt } from "@code-health/history/blame-lines";
import { listBlobs } from "@code-health/history/tree";
import { isCodePath } from "@code-health/parse/code-files";
import { readBlobs } from "@code-health/parse/source-tree";
import { testClassifier } from "@code-health/parse/test-files";

/** A production code file of the tree at HEAD and its physical lines. */
export interface CodeMapFile {
  path: string;
  lines: number;
}

export interface CodeMapFiles {
  /** Every production code file with text lines, sorted by path. Both the hotspots and the knowledge map draw these and no others, so their tiles sit in the same places. */
  files: CodeMapFile[];
  /** Production code files with no text lines to size: empty files and binary content. They hold no area. */
  unsized: number;
  /** Production code files the suite's shared filters leave out (the `exclude` globs, lockfiles, generated and vendored files), and their lines. They are not drawn. */
  excluded: { files: number; lines: number };
}

const BATCH = 256;

function linesOf(text: string): number {
  return text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
}

/**
 * The production code files of the tree at HEAD (a language adapter or a lexical profile claims them, and they are
 * not test files) that the suite's shared filters keep with their physical lines. The map of the hotspots report and the map of the knowledge report both
 * read this one list, so they draw the same files at the same size.
 */
export async function readCodeMapFiles(context: CommandContext, head: string): Promise<CodeMapFiles> {
  const root = context.repo.root;
  const languages = context.config.effective.languages;
  const isTest = testClassifier(context.config.effective.testPatterns);
  const blobs = (await listBlobs(root, head)).filter(({ path }) => isCodePath(path, languages) && !isTest(path));
  // The files the blame and the history analyse: the same exclude globs, lockfiles, and generated and vendored files. It also records the generated and vendored files for the page's "excluded" counts.
  const authored = new Set((await authoredFilesAt(root, head, context.config.effective.exclude)).map((blob) => blob.path));
  const files: CodeMapFile[] = [];
  const excluded = { files: 0, lines: 0 };
  let unsized = 0;
  for (let start = 0; start < blobs.length; start += BATCH) {
    const chunk = blobs.slice(start, start + BATCH);
    const texts = await readBlobs(root, chunk.map((blob) => blob.blob));
    for (const { path, blob } of chunk) {
      const text = texts.get(blob);
      const lines = text === undefined || text.includes("\0") ? 0 : linesOf(text);
      if (!authored.has(path)) {
        excluded.files++;
        excluded.lines += lines;
      } else if (lines === 0) unsized++;
      else files.push({ path, lines });
    }
  }
  return { files, unsized, excluded };
}
