import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { ParseCache } from "@code-health/parse/parse-cache";
import { restrictTree, treeFromRef, treeFromWorkingTree, type SourceTree } from "@code-health/parse/source-tree";
import type { ComplexitySettings } from "./config.ts";
import { matchUnits, type UnitMatch } from "./match-units.ts";
import { measureTree } from "./measure.ts";
import { changedPaths, type Revision } from "./revisions.ts";

/** What a comparison runs against: a revision, or the files on disk. */
export type Target = { kind: "revision"; revision: Revision } | { kind: "working-tree" };

export interface Comparison {
  matches: UnitMatch[];
  /** Files that differ between the two sides. */
  changedFiles: number;
  /** Changed files with no structural adapter, whose functions cannot be compared. */
  unsupportedFiles: number;
}

/**
 * Measures the functions of the files that differ between `base` and `target`, on both sides, and matches
 * them. Files that did not change have the same functions on both sides, so they are not read. Only the
 * structural layer is used, because unit identity is never lexical.
 */
export async function compareToBase(
  context: CommandContext,
  settings: ComplexitySettings,
  base: Revision,
  target: Target,
): Promise<Comparison> {
  const root = context.repo.root;
  const paths = await changedPaths(root, base.sha, target.kind === "revision" ? target.revision.sha : null);
  const cache = await ParseCache.forRepository(root);
  const baseTree = restrictTree(await treeFromRef(root, base.sha), paths);
  const targetTree: SourceTree =
    target.kind === "revision" ? await treeFromRef(root, target.revision.sha) : await treeFromWorkingTree(root);
  const options = { settings, layer: "structural", cache, keepText: true } as const;
  const [before, after] = await Promise.all([
    measureTree(baseTree, options),
    measureTree(restrictTree(targetTree, paths), options),
  ]);
  return {
    matches: matchUnits(before.files, after.files, settings.moveSimilarity),
    changedFiles: paths.length,
    unsupportedFiles: after.files.filter((file) => file.source === null).length,
  };
}
