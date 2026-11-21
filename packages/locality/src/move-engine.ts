import type { LanguageAdapter } from "@code-health/parse/language-adapter";
import { supportedAdapters } from "@code-health/parse/languages";
import type { SourceTree } from "@code-health/parse/source-tree";
import { findExecutable, notConfirmed } from "./external-tools.ts";
import { moverFor, type MoveResult, type MoverLanguage } from "./movers/language.ts";
import type { FileOperation } from "./move-plan.ts";

export type { MoveResult, Rewrite } from "./movers/language.ts";

/** What a move runs with. The defaults are the supported adapters, the registered movers and the PATH. */
export interface MoveOptions {
  adapters?: readonly LanguageAdapter[];
  movers?: readonly MoverLanguage[];
  /** Where external tools are looked for. Defaults to the PATH. */
  searchPath?: string;
}

/**
 * Applies file operations to a tree in memory and reports the file contents that follow. Each operation goes
 * to the mover of the language that owns the file, and the results are merged. When an adapter names an
 * external tool that confirms references and the tool is installed, the mover asks it; when it is not
 * installed the move is reported `not confirmed`. Files no adapter claims are moved by the caller and
 * rewritten by nobody.
 */
export async function performMove(tree: SourceTree, operations: readonly FileOperation[], options: MoveOptions = {}): Promise<MoveResult> {
  const adapters = options.adapters ?? supportedAdapters();
  const byLanguage = new Map<MoverLanguage, FileOperation[]>();
  for (const operation of operations) {
    const language = moverFor(operation.from, adapters, options.movers);
    if (language !== undefined) byLanguage.set(language, [...(byLanguage.get(language) ?? []), operation]);
  }

  const result: MoveResult = { rewrites: [], texts: new Map(), warnings: [], confirmations: [] };
  for (const [language, own] of [...byLanguage].sort(([a], [b]) => (a.id < b.id ? -1 : 1))) {
    const backend = await language.load();
    const part = await backend.performMove(tree, own);
    result.rewrites.push(...part.rewrites);
    for (const [path, text] of part.texts) result.texts.set(path, text);
    result.warnings.push(...part.warnings);

    const tool = adapters.find((adapter) => adapter.id === language.id)?.mover.confirmation ?? null;
    if (tool === null) continue;
    const found = await findExecutable(tool.executable, options.searchPath);
    const outcome = found === undefined || backend.confirm === undefined ? notConfirmed(tool) : await backend.confirm(tree, own, { name: tool.name, path: found });
    result.confirmations.push({ language: language.id, tool: tool.name, ...outcome });
  }
  result.rewrites.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  return result;
}
