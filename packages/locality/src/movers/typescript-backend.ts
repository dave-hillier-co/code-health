import { posix } from "node:path";
import { Node, Project, ts, type NoSubstitutionTemplateLiteral, type SourceFile, type StringLiteral } from "ts-morph";
import type { SourceTree } from "@code-health/parse/source-tree";
import type { FileOperation } from "../move-plan.ts";
import { buildProject } from "../ts-project.ts";
import type { MoveResult, MoverBackend, Rewrite, Skeleton } from "./mover-language.ts";
import { sourceFilesOf } from "./mover-language.ts";

const isSource = sourceFilesOf("typescript");
const KNOWN_EXTENSION = /\.(?:[cm]?[jt]sx?|json)$/;
const TS_EXTENSION = /\.(?:[cm]?tsx?)$/;

/**
 * The specifier TypeScript's own rewrite should have produced. It drops the extension a repository writes in
 * its imports (`./money.ts`, `./money.js`), so the extension of the old specifier is put back, and so is the
 * `index` of a directory import written out in full.
 */
function keepStyle(before: string, after: string): string {
  if (before === after) return after;
  const written = KNOWN_EXTENSION.exec(before)?.[0];
  if (written === undefined || KNOWN_EXTENSION.test(after)) return after;
  if (/\/index\.[cm]?[jt]sx?$/.test(before) && !after.endsWith("/index")) return `${after}/index${written}`;
  return `${after}${written}`;
}

/** A relative specifier from one file to another, written with the extension the old specifier used, if any. */
function relativeSpecifier(from: string, to: string, old: string): string {
  let relative = posix.relative(posix.dirname(from), to);
  if (!relative.startsWith(".")) relative = `./${relative}`;
  const written = KNOWN_EXTENSION.exec(old)?.[0];
  if (TS_EXTENSION.test(relative) || (written !== undefined && KNOWN_EXTENSION.test(relative))) {
    const own = KNOWN_EXTENSION.exec(relative)![0];
    const stem = relative.slice(0, relative.length - own.length);
    return written === undefined ? stem : `${stem}${TS_EXTENSION.test(own) ? written : own}`;
  }
  return relative;
}

/** Calls whose first argument is a module path: the test frameworks' mock and actual-module helpers, and `require.resolve`. */
const MODULE_PATH_CALLS = new Set([
  ...["mock", "doMock", "unmock", "doUnmock", "dontMock", "setMock", "requireActual", "requireMock", "createMockFromModule", "genMockFromModule", "unstable_mockModule"].map((method) => `jest.${method}`),
  ...["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"].map((method) => `vi.${method}`),
  "require.resolve",
]);

type PathLiteral = StringLiteral | NoSubstitutionTemplateLiteral;

interface ModulePaths {
  /** Every literal that names a module: import specifiers and the literal path arguments of mock calls, in source order. */
  literals: PathLiteral[];
  /** Mock calls whose path is computed, with the argument's text and the initialiser's text when the argument is a variable. */
  computed: { line: number; call: string; text: string }[];
}

function modulePaths(file: SourceFile): ModulePaths {
  const literals: PathLiteral[] = [...file.getImportStringLiterals()];
  const computed: ModulePaths["computed"] = [];
  file.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const call = node.getExpression().getText();
    const argument = node.getArguments()[0];
    if (!MODULE_PATH_CALLS.has(call) || argument === undefined) return;
    if (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument)) {
      if (!literals.some((known) => known.getStart() === argument.getStart())) literals.push(argument);
      return;
    }
    const declared = Node.isIdentifier(argument) ? file.getVariableDeclaration(argument.getText())?.getInitializer()?.getText() : undefined;
    computed.push({ line: node.getStartLineNumber(), call, text: `${argument.getText()} ${declared ?? ""}` });
  });
  literals.sort((a, b) => a.getStart() - b.getStart());
  return { literals, computed };
}

/** The file name without directory or extension, which is what a computed path would still spell out. */
function stemOf(path: string): string {
  return posix.basename(path).replace(KNOWN_EXTENSION, "");
}

function resolveSpecifier(project: Project, specifier: string, from: SourceFile): string | undefined {
  const resolved = ts.resolveModuleName(specifier, from.getFilePath(), project.getCompilerOptions(), project.getModuleResolutionHost());
  return resolved.resolvedModule?.resolvedFileName;
}

/**
 * Applies file operations to a tree in memory and reports the file contents that follow. The moves and
 * the rewriting of every import that reaches across them are ts-morph's, so path mappings and package
 * exports are followed. Each specifier is then checked to still reach the file it reached before, with the
 * move accounted for, and one that does not is rewritten. Nothing is written: the caller decides whether
 * to show it, apply it or compare it with a move somebody else made.
 */
async function performMove(tree: SourceTree, operations: readonly FileOperation[]): Promise<Omit<MoveResult, "confirmations">> {
  const { project, relative, absolute, warnings } = await buildProject(tree);
  const sources = project.getSourceFiles();
  const originalText = new Map(sources.map((file) => [relative(file.getFilePath()), file.getFullText()]));
  const before = new Map(
    sources.map((file) => [
      relative(file.getFilePath()),
      modulePaths(file).literals.map((literal) => ({ specifier: literal.getLiteralValue(), target: resolveSpecifier(project, literal.getLiteralValue(), file) })),
    ]),
  );

  const origin = new Map<string, string>();
  const destination = new Map<string, string>();
  for (const operation of operations) {
    const file = project.getSourceFile(absolute(operation.from));
    if (file === undefined) {
      if (isSource(operation.from)) warnings.push(`${operation.from} could not be read as a source file`);
      continue;
    }
    file.move(absolute(operation.to));
    origin.set(operation.to, operation.from);
    destination.set(absolute(operation.from), absolute(operation.to));
  }

  const rewrites: Rewrite[] = [];
  const texts = new Map<string, string>();
  for (const file of project.getSourceFiles()) {
    const path = relative(file.getFilePath());
    const was = before.get(origin.get(path) ?? path);
    if (was === undefined) continue;
    const { literals, computed } = modulePaths(file);
    for (const site of computed) {
      const referred = [...destination.values()].find((moved) => site.text.includes(stemOf(moved)));
      if (referred !== undefined) {
        warnings.push(`${path}:${site.line} ${site.call}(...) takes a computed path that may refer to ${relative(referred)}: check it by hand`);
      }
    }
    if (literals.length === was.length) {
      literals.forEach((literal, index) => {
        const old = was[index]!;
        let wanted = keepStyle(old.specifier, literal.getLiteralValue());
        if (old.target !== undefined) {
          const expected = destination.get(old.target) ?? old.target;
          if (resolveSpecifier(project, wanted, file) !== expected) {
            wanted = relativeSpecifier(file.getFilePath(), expected, old.specifier);
            if (resolveSpecifier(project, wanted, file) !== expected) {
              warnings.push(`${path}:${literal.getStartLineNumber()} "${old.specifier}" no longer resolves to ${relative(expected)} and could not be repaired`);
            } else if (!old.specifier.startsWith(".")) {
              warnings.push(`${path}:${literal.getStartLineNumber()} "${old.specifier}" became the relative "${wanted}": check whether an alias still fits`);
            }
          }
        }
        if (wanted !== literal.getLiteralValue()) literal.setLiteralValue(wanted);
      });
    } else {
      warnings.push(`${path}: its imports could not be matched against the original, so none were checked`);
    }
    const text = file.getFullText();
    if (text !== originalText.get(origin.get(path) ?? path)) texts.set(path, text);
    modulePaths(file).literals.forEach((literal, index) => {
      const old = was[index];
      if (old !== undefined && old.specifier !== literal.getLiteralValue()) {
        rewrites.push({ path, line: literal.getStartLineNumber(), from: old.specifier, to: literal.getLiteralValue() });
      }
    });
  }
  rewrites.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  return { rewrites, texts, warnings };
}

/** The text with each import specifier blanked, so only what is not an import path remains. */
function skeleton(path: string, text: string): Skeleton {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true } });
  const file = project.createSourceFile(`/${path}`, text);
  const { literals } = modulePaths(file);
  const specifiers = literals.map((literal) => ({ value: literal.getLiteralValue(), line: literal.getStartLineNumber() }));
  let blanked = text;
  for (const literal of [...literals].reverse()) {
    blanked = `${blanked.slice(0, literal.getStart() + 1)}${blanked.slice(literal.getEnd() - 1)}`;
  }
  return { text: blanked, specifiers };
}

export const backend: MoverBackend = { performMove, skeleton };
