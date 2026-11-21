/**
 * The head of a Java or Kotlin file: its package clause and its imports, found by line. They come before any
 * declaration, so reading stops at the first line of code that is neither. A move only ever edits these lines.
 */

export interface ImportLine {
  /** 0-based index into the file's lines. */
  index: number;
  /** What is imported, without a trailing `.*`: `a.b.C`, or `a.b` for `a.b.*`. */
  name: string;
  /** Java `import static`. */
  isStatic: boolean;
  /** `a.b.*`. */
  wildcard: boolean;
}

export interface SourceHead {
  lines: string[];
  /** 0-based index of the package clause, or undefined for the default package. */
  packageIndex: number | undefined;
  packageName: string;
  imports: ImportLine[];
}

const packageClause = /^(\s*package\s+)([\w.]+)(\s*;?\s*)$/;
const importClause = /^(\s*import\s+)(static\s+)?([\w.]+?)(\.\*)?(\s+as\s+\w+)?(\s*;?\s*)$/;

export function readHead(text: string): SourceHead {
  const lines = text.split("\n");
  const head: SourceHead = { lines, packageIndex: undefined, packageName: "", imports: [] };
  let inBlockComment = false;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith("@") && head.packageIndex === undefined && head.imports.length === 0) continue;
    const pkg = packageClause.exec(line);
    if (pkg !== null && head.packageIndex === undefined) {
      head.packageIndex = index;
      head.packageName = pkg[2]!;
      continue;
    }
    const imported = importClause.exec(line);
    if (imported !== null) {
      head.imports.push({ index, name: imported[3]!, isStatic: imported[2] !== undefined, wildcard: imported[4] !== undefined });
      continue;
    }
    break;
  }
  return head;
}

/** The line with the package name replaced. */
export function withPackage(line: string, name: string): string {
  return line.replace(packageClause, (_all, before: string, _name: string, after: string) => `${before}${name}${after}`);
}

/** The line with the imported name replaced, keeping `static`, `.*`, `as` and the semicolon as written. */
export function withImport(line: string, name: string): string {
  return line.replace(importClause, (_all, before: string, isStatic: string | undefined, _name: string, wildcard: string | undefined, alias: string | undefined, after: string) => `${before}${isStatic ?? ""}${name}${wildcard ?? ""}${alias ?? ""}${after}`);
}

/** The package a path implies under a source root, and the root a file's package implies. `.` is the repository root. */
export function sourceRootOf(path: string, packageName: string): string | undefined {
  const slash = path.lastIndexOf("/");
  const dir = slash < 0 ? "." : path.slice(0, slash);
  if (packageName === "") return dir;
  const suffix = packageName.replaceAll(".", "/");
  if (dir === suffix) return ".";
  return dir.endsWith(`/${suffix}`) ? dir.slice(0, dir.length - suffix.length - 1) : undefined;
}

export function packageUnder(root: string, path: string): string | undefined {
  const slash = path.lastIndexOf("/");
  const dir = slash < 0 ? "." : path.slice(0, slash);
  if (root === ".") return dir === "." ? "" : dir.replaceAll("/", ".");
  if (dir === root) return "";
  return dir.startsWith(`${root}/`) ? dir.slice(root.length + 1).replaceAll("/", ".") : undefined;
}
