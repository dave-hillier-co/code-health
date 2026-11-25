import type { Node } from "web-tree-sitter";
import type { SourceRepair } from "../../language-adapter.ts";

/**
 * Valid Rust the grammar rejects. Each repair overwrites characters with blanks, so no position moves, and the loader
 * keeps the repaired tree only when it has fewer errors. The repairs run only for a file that already has errors.
 * What each one does to the text, so that facts are read from the repaired tree:
 *
 * - A borrow of a variable named `raw`, `&raw` or `&raw[i..]`, which the grammar reads as the start of a raw borrow
 *   (`&raw const x`). The `&` becomes a blank, so `raw` is read as the variable it is.
 * - Attributes where the grammar takes at most one or none: a second attribute on a parameter
 *   (`#[files("*.avro")] #[exclude("x")] path: PathBuf`, as rstest writes them), and an attribute on a field of a
 *   struct pattern (`let Config { #[cfg(feature = "api")] api, .. } = config`). The attribute becomes blanks.
 * - A higher-ranked bound after a `+` in an `impl` type, `impl Subscriber + for<'a> LookupSpan<'a>`. The
 *   `for<'a>` becomes blanks.
 * - A turbofish on a function named like a primitive type, `char::<_, E>('#')` (nom's parser). The `::<..>` becomes
 *   blanks, leaving a call of `char`.
 */
export function rustRepairs(root: Node, source: string): SourceRepair[] {
  const edits = new Map<number, string>();
  const blank = (start: number, end: number): void => {
    for (let i = start; i < end; i++) if (source[i] !== "\n" && source[i] !== "\r" && source[i] !== " ") edits.set(i, " ");
  };
  visit(root, source, blank);
  return [...edits].map(([offset, character]) => ({ offset, character }));
}

type Blank = (start: number, end: number) => void;

const attributeHolders = new Set(["parameters", "closure_parameters", "struct_pattern"]);
const primitives = new Set(["bool", "char", "str", "u8", "u16", "u32", "u64", "u128", "usize", "i8", "i16", "i32", "i64", "i128", "isize", "f32", "f64"]);

function visit(node: Node, source: string, blank: Blank): void {
  if (!node.hasError && !node.isMissing && node.type !== "raw") return;
  if (node.type === "raw" && !node.isNamed) rawBorrow(node, source, blank);
  if (node.type === "ERROR") {
    misplacedAttribute(node, source, blank);
    boundLifetimes(node, blank);
    primitiveTurbofish(node, source, blank);
  }
  for (const child of node.children) visit(child, source, blank);
}

/** `&raw` read as an unfinished raw borrow: inside an error, and not followed by `const` or `mut`. */
function rawBorrow(raw: Node, source: string, blank: Blank): void {
  if (raw.parent?.type !== "ERROR") return;
  const after = raw.nextSibling;
  if (after !== null && (after.type === "const" || after.type === "mutable_specifier")) return;
  let at = raw.startIndex - 1;
  while (at >= 0 && /\s/.test(source[at]!)) at--;
  if (source[at] === "&") blank(at, at + 1);
}

function misplacedAttribute(error: Node, source: string, blank: Blank): void {
  if (!attributeHolders.has(error.parent?.type ?? "")) return;
  const start = error.startIndex;
  if (source[start] !== "#") return;
  let open = start + 1;
  while (/\s/.test(source[open] ?? "")) open++;
  if (source[open] !== "[") return;
  const end = closingOf(source, open, "[", "]");
  if (end !== undefined) blank(start, end);
}

function boundLifetimes(error: Node, blank: Blank): void {
  const children = error.children;
  for (let i = 1; i < children.length; i++) {
    if (children[i]!.type === "for_lifetimes" && children[i - 1]!.type === "+") blank(children[i]!.startIndex, children[i]!.endIndex);
  }
}

function primitiveTurbofish(error: Node, source: string, blank: Blank): void {
  if (error.text !== "::" || !primitives.has(error.previousSibling?.text ?? "")) return;
  const open = error.nextSibling;
  if (open?.type !== "<") return;
  const end = closingOf(source, open.startIndex, "<", ">");
  if (end !== undefined) blank(error.startIndex, end);
}

/** The index just past the bracket that closes the one at `open`, skipping string and character literals and `->`. */
function closingOf(source: string, open: number, opener: string, closer: string): number | undefined {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (c === '"') {
      for (i++; i < source.length && source[i] !== '"'; i++) if (source[i] === "\\") i++;
      continue;
    }
    if (c === "'" && source[i + 2] === "'") {
      i += 2;
      continue;
    }
    if (c === "'" && source[i + 1] === "\\" && source[i + 3] === "'") {
      i += 3;
      continue;
    }
    if (c === "-" && source[i + 1] === ">") {
      i++;
      continue;
    }
    if (c === opener) depth++;
    else if (c === closer && --depth === 0) return i + 1;
  }
  return undefined;
}
