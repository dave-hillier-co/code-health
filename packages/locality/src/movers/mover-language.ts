import type { SourceTree } from "@code-health/parse/source-tree";
import { adapterById } from "@code-health/parse/languages";
import type { FileOperation } from "../move-plan.ts";

/** One import specifier the move changed. `path` is where the file is after the move. */
export interface Rewrite {
  path: string;
  line: number;
  from: string;
  to: string;
}

/** Whether a tool outside the bundle confirmed the references of a move. Absent tools are reported, never failures. */
export interface MoveConfirmation {
  language: string;
  tool: string;
  status: "confirmed" | "not confirmed";
  detail: string;
}

export interface MoveResult {
  rewrites: Rewrite[];
  /** The text of every file the move changes, by its path after the move. Moved files whose text is unchanged are not listed. */
  texts: Map<string, string>;
  /** What the mover could not rewrite and the result still builds. */
  warnings: string[];
  /** What leaves the result not compiling, one line each: the move is refused for these, never made with a warning. */
  breaks?: string[];
  confirmations: MoveConfirmation[];
}

/** A text with each reference blanked, so only what is not a reference remains. */
export interface Skeleton {
  text: string;
  specifiers: { value: string; line: number }[];
}

/**
 * What a mover reads of a tree that does not depend on the move, computed once for a tree. A report plans a move
 * for each of many candidates against one tree, and reading and parsing the repository again for each plan was
 * most of its time. A tree is not changed after it is read, and what `read` returns must only be read by a plan.
 */
export function oncePerTree<T>(read: (tree: SourceTree) => Promise<T>): (tree: SourceTree) => Promise<T> {
  const known = new WeakMap<SourceTree, Promise<T>>();
  return (tree) => {
    let found = known.get(tree);
    if (found === undefined) {
      found = read(tree);
      known.set(tree, found);
    }
    return found;
  };
}

/** What a mover does for the files of one language. */
export interface MoverBackend {
  /**
   * Applies the file operations of this language's files to the tree in memory and reports the file contents
   * that follow. Nothing is written: the caller decides whether to show it, apply it or compare it with a move
   * somebody else made. `confirmations` is left empty, the engine fills it from `confirm`.
   */
  performMove(tree: SourceTree, operations: readonly FileOperation[]): Promise<Omit<MoveResult, "confirmations">>;
  /** The text of a source file with the spelling of each reference blanked, to tell a rewritten reference from another change. */
  skeleton(path: string, text: string): Skeleton;
  /**
   * Asks the external tool the adapter's `mover.confirmation` names to confirm references after the move.
   * Called only when the tool is installed; when it is not, the engine reports `not confirmed` itself.
   */
  confirm?(tree: SourceTree, operations: readonly FileOperation[], tool: { name: string; path: string }): Promise<{ status: "confirmed" | "not confirmed"; detail: string }>;
}

/**
 * The locality side of a language: a loader for its mover backend. The backend is loaded on first use,
 * because a backend can be most of a bundle (ts-morph) and a run that moves nothing never needs it.
 * A language is one file in `movers/<id>.ts` and one line in `movers/registered-languages.ts`. The `id` is the adapter's.
 */
export interface MoverLanguage {
  id: string;
  load(): Promise<MoverBackend>;
}

/** The same test for one language's files, for a backend that must not touch another language's. */
export function sourceFilesOf(adapterId: string): (path: string) => boolean {
  const extensions = adapterById(adapterId)?.mover.sourceExtensions ?? [];
  return (path) => extensions.some((extension) => path.endsWith(extension));
}
