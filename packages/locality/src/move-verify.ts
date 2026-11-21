import { Project } from "ts-morph";
import { hasCodeHealthTrailer } from "@code-health/history/trailers";
import type { SourceTree } from "@code-health/parse/source-tree";
import { performMove } from "./move-engine.ts";
import { SOURCE_EXTENSION, type FileOperation } from "./move-plan.ts";

export interface SpecifierDifference {
  path: string;
  line: number;
  expected: string;
  actual: string;
}

export interface Verification {
  verified: boolean;
  checks: { operations: boolean; content: boolean; trailer: boolean };
  operations: {
    planned: FileOperation[];
    /** Planned moves the commit did not make: the source is still there, or the destination is not. */
    missing: FileOperation[];
    /** Files the commit adds or removes that no planned move accounts for. */
    unexpectedAdded: string[];
    unexpectedDeleted: string[];
  };
  content: {
    /** Files whose text is exactly what the mover would have written. */
    identical: number;
    /** Files that differ from the mover's output in import specifiers alone. */
    specifierDifferences: SpecifierDifference[];
    /** Files that differ in anything else: the commit is not a move-only commit. */
    otherChanges: string[];
  };
}

interface Skeleton {
  /** The text with each import specifier blanked, so only what is not an import path remains. */
  text: string;
  specifiers: { value: string; line: number }[];
}

function skeletonOf(path: string, text: string): Skeleton {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true } });
  const file = project.createSourceFile(`/${path}`, text);
  const literals = file.getImportStringLiterals();
  const specifiers = literals.map((literal) => ({ value: literal.getLiteralValue(), line: literal.getStartLineNumber() }));
  let blanked = text;
  for (const literal of [...literals].reverse()) {
    blanked = `${blanked.slice(0, literal.getStart() + 1)}${blanked.slice(literal.getEnd() - 1)}`;
  }
  return { text: blanked, specifiers };
}

/**
 * Checks that a commit somebody else made reproduces a planned move: the planned files moved and nothing
 * else was added or removed, every file holds the text the mover would have written, and the message
 * carries the `Code-Health:` trailer. A file that differs only in how an import is spelled is told apart
 * from one that changed in some other way, so the first can be reviewed and the second is a failure of
 * the one-step-per-commit rule.
 */
export async function verifyMove(
  parent: SourceTree,
  commit: SourceTree,
  operations: readonly FileOperation[],
  message: string,
): Promise<Verification> {
  const expected = await performMove(parent, operations);
  const moves = new Map(operations.map((operation) => [operation.to, operation.from]));
  const sources = new Set(operations.map((operation) => operation.from));

  const missing = operations.filter((operation) => commit.files.has(operation.from) || !commit.files.has(operation.to));
  const unexpectedAdded = [...commit.files.keys()].filter((path) => !parent.files.has(path) && !moves.has(path));
  const unexpectedDeleted = [...parent.files.keys()].filter((path) => !commit.files.has(path) && !sources.has(path));
  const modified = [...commit.files].filter(([path, blob]) => parent.files.has(path) && parent.files.get(path) !== blob).map(([path]) => path);

  const checked = [...new Set([...modified, ...[...moves.keys()].filter((path) => commit.files.has(path)), ...[...expected.texts.keys()].filter((path) => commit.files.has(path))])].sort();
  const actualTexts = await commit.readMany(checked);
  const originalTexts = await parent.readMany([...new Set(checked.map((path) => moves.get(path) ?? path))]);

  let identical = 0;
  const specifierDifferences: SpecifierDifference[] = [];
  const otherChanges: string[] = [];
  for (const path of checked) {
    const actual = actualTexts.get(path);
    const wanted = expected.texts.get(path) ?? originalTexts.get(moves.get(path) ?? path);
    if (actual === undefined || wanted === undefined) continue;
    if (actual === wanted) {
      identical++;
      continue;
    }
    if (!SOURCE_EXTENSION.test(path)) {
      otherChanges.push(path);
      continue;
    }
    const wantedSkeleton = skeletonOf(path, wanted);
    const actualSkeleton = skeletonOf(path, actual);
    if (wantedSkeleton.text !== actualSkeleton.text || wantedSkeleton.specifiers.length !== actualSkeleton.specifiers.length) {
      otherChanges.push(path);
      continue;
    }
    wantedSkeleton.specifiers.forEach((specifier, index) => {
      const found = actualSkeleton.specifiers[index]!;
      if (specifier.value !== found.value) specifierDifferences.push({ path, line: found.line, expected: specifier.value, actual: found.value });
    });
  }

  const checks = {
    operations: missing.length === 0 && unexpectedAdded.length === 0 && unexpectedDeleted.length === 0,
    content: specifierDifferences.length === 0 && otherChanges.length === 0,
    trailer: hasCodeHealthTrailer(message),
  };
  return {
    verified: checks.operations && checks.content && checks.trailer,
    checks,
    operations: { planned: [...operations], missing, unexpectedAdded, unexpectedDeleted },
    content: { identical, specifierDifferences, otherChanges },
  };
}
