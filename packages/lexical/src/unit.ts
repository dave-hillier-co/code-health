/**
 * The one unit shape both analysis layers report. The lexical layer fills what a lexer can know (lines,
 * and often a name); the structural layer fills everything.
 *
 * Matching the layers (the agreement test):
 * - Match by `startLine` and `endLine`. Names are not comparable: lexical names are missing for anonymous
 *   bound functions, omit object-literal scopes, and carry no `~n` suffix on duplicates.
 * - Exclude structural units of kind `class` and `macro` first. The lexical layer never emits class or macro
 *   blocks, so a matcher that keeps them counts each as a missed unit. `isFunctionUnit` is that filter.
 * - Lexical blocks that match no structural function are spurious, and are counted as such.
 */
/** `macro` is a definition whose body the grammar does not parse (Rust `macro_rules!`): a unit with a name and lines, and no metrics. */
export type UnitKind = "function" | "arrow" | "method" | "class" | "macro";

export interface UnitShape {
  /** Qualified name within the file. Always present structurally, often absent lexically. */
  qualifiedName?: string;
  /** Always present structurally, never lexically. */
  kind?: UnitKind;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  source: "structural" | "lexical";
  /** Qualified name of the enclosing unit, when nested. Structural only. */
  parent?: string;
}

/** True for units the lexical layer is expected to find: everything except classes and macros. */
export function isFunctionUnit(unit: Pick<UnitShape, "kind">): boolean {
  return unit.kind !== "class" && unit.kind !== "macro";
}
