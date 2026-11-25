import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readBlobAt } from "@code-health/history/tree";
import { analyseTree } from "@code-health/parse/analyse-tree";
import { exportedUnitNames } from "@code-health/parse/exported-units";
import type { FileFacts, UnitFact } from "@code-health/parse/facts";
import { factsForBlob } from "@code-health/parse/file-facts";
import { GrammarSet } from "@code-health/parse/grammars";
import { adapterForPath } from "@code-health/parse/languages";
import { ParseCache } from "@code-health/parse/parse-cache";
import { gitBlobSha, treeFromRef } from "@code-health/parse/source-tree";
import { bandAgainst, cutoffsOf, higherBand, type Band } from "./bands.ts";
import type { BranchChange } from "./change.ts";
import type { Factor } from "./factor.ts";
import type { RiskSettings } from "./settings.ts";

export interface SignatureChange {
  /** The file as the base has it, where the change's consumers point. */
  file: string;
  symbol: string;
  change: "signature" | "removed";
  /** Distinct files that used the symbol at the base. */
  fanIn: number;
  /**
   * Distinct files that import a name equal to the symbol's which was not followed to a definition: the module named
   * does not list the name, or a macro of that module may define it. Each may be a consumer `fanIn` does not count,
   * so a `fanIn` of 0 beside one of these is unresolved, not unused.
   */
  fanInUnresolved: number;
}

export interface SignatureResult {
  /** Touched files an adapter reads. Zero means the structural layer has nothing to say about this change. */
  files: number;
  changes: SignatureChange[];
  /** The fan-in of every exported symbol at the base: the population a changed symbol's is placed in. */
  population: readonly number[];
}

/** What a caller of an exported unit depends on: its kind and the size of its interface (parameters, options, reachable members). */
function fingerprint(unit: UnitFact): string {
  return [unit.kind, unit.metrics?.parameters ?? "", unit.metrics?.optionCount ?? "", unit.shape?.interfaceSize ?? ""].join("|");
}

function exportedUnits(facts: FileFacts): Map<string, string> {
  const exported = exportedUnitNames(facts);
  const out = new Map<string, string>();
  for (const unit of facts.units) {
    if (unit.parent === undefined && exported.has(unit.qualifiedName)) out.set(unit.qualifiedName, fingerprint(unit));
  }
  return out;
}

function readWorktree(root: string, path: string): string | undefined {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The exported symbols of the touched files whose signature changed or that were removed, with how many files
 * used each at the base. Structural: read through the parse adapters, so it is absent for a language none claims.
 * A signature is compared by what a caller can see in the facts (kind and interface size), not by its text.
 * Returns null when nothing could be read.
 */
export async function changedSignatures(root: string, change: BranchChange): Promise<SignatureResult | null> {
  try {
    const grammars = new GrammarSet();
    const cache = await ParseCache.forRepository(root);
    const factsOf = async (path: string, text: string | undefined): Promise<FileFacts | null> => {
      if (text === undefined || text.includes("\0")) return null;
      const language = await grammars.forPath(path);
      if (language === undefined) return null;
      return (await factsForBlob(language, gitBlobSha(Buffer.from(text)), text, cache)).facts;
    };

    const moved: { file: string; symbol: string; change: SignatureChange["change"] }[] = [];
    let files = 0;
    for (const file of change.files) {
      if (file.binary || adapterForPath(file.path) === undefined) continue;
      files++;
      if (file.status === "A") continue;
      const basePath = file.oldPath ?? file.path;
      const before = await factsOf(basePath, await readBlobAt(root, change.base, basePath));
      if (before === null) continue;
      const after =
        file.status === "D" ? null : await factsOf(file.path, change.worktree ? readWorktree(root, file.path) : await readBlobAt(root, change.head, file.path));
      const was = exportedUnits(before);
      const now = after === null ? new Map<string, string>() : exportedUnits(after);
      for (const [symbol, shape] of was) {
        if (!now.has(symbol)) moved.push({ file: basePath, symbol, change: "removed" });
        else if (now.get(symbol) !== shape) moved.push({ file: basePath, symbol, change: "signature" });
      }
    }
    if (files === 0) return null;
    if (moved.length === 0) return { files, changes: [], population: [] };

    const analysis = await analyseTree(await treeFromRef(root, change.base), { cache });
    const users = new Map<string, Set<string>>();
    for (const consumer of analysis.consumers) {
      if (consumer.kind === "test" || consumer.toSymbol === undefined) continue;
      const key = `${consumer.to}\0${consumer.toSymbol}`;
      const set = users.get(key) ?? new Set<string>();
      set.add(consumer.from);
      users.set(key, set);
    }
    // By name alone: where an import was not followed, the file that defines the name is what is unknown.
    const unfollowed = new Map<string, Set<{ from: string; to: string | undefined }>>();
    const unfollow = (name: string, from: string, to: string | undefined): void => {
      const set = unfollowed.get(name) ?? new Set();
      set.add({ from, to });
      unfollowed.set(name, set);
    };
    for (const entry of analysis.unresolved) if (entry.name !== undefined) unfollow(entry.name, entry.from, entry.to);
    for (const consumer of analysis.consumers) if (consumer.kind !== "test" && consumer.toSymbol === undefined && consumer.toExport !== "*") unfollow(consumer.toExport, consumer.from, consumer.to);
    const unresolvedUsers = (file: string, symbol: string): number => new Set([...(unfollowed.get(symbol) ?? [])].filter((use) => use.to !== file && use.from !== file).map((use) => use.from)).size;
    const population = analysis.units.filter((unit) => unit.exported && unit.parent === undefined).map((unit) => users.get(`${unit.path}\0${unit.qualifiedName}`)?.size ?? 0);
    const changes = moved.map((m) => ({ ...m, fanIn: users.get(`${m.file}\0${m.symbol}`)?.size ?? 0, fanInUnresolved: unresolvedUsers(m.file, m.symbol) }));
    return { files, changes, population };
  } catch {
    return null;
  }
}

/**
 * Adds the changed signatures to `blast-radius`. The factor keeps its co-change (and locality) band, and the
 * largest fan-in among the changed symbols is placed against the fan-in of every exported symbol at the
 * base. The band is the higher of the two, so structure can only raise it.
 */
export function withSignatures(factor: Factor, result: SignatureResult, risk: RiskSettings): Factor {
  const fanIn = result.changes.reduce((most, row) => Math.max(most, row.fanIn), 0);
  const fanInUnresolved = result.changes.reduce((most, row) => Math.max(most, row.fanInUnresolved), 0);
  const cutoffs = result.changes.length === 0 || result.population.length < risk.minBaseline ? null : cutoffsOf(result.population, risk.moderatePercentile, risk.highPercentile);
  const placed: Band | null = cutoffs === null ? null : bandAgainst(fanIn, cutoffs);
  const band: Band | null = placed === null ? (factor.band as Band | null) : factor.band === null ? placed : higherBand(factor.band as Band, placed);
  const rows = [...result.changes].sort((a, b) => b.fanIn - a.fanIn || (a.file < b.file ? -1 : a.file > b.file ? 1 : a.symbol < b.symbol ? -1 : 1));
  return {
    ...factor,
    status: band === null ? factor.status : "ok",
    band,
    reason: band === null ? factor.reason : null,
    source: joinSources(factor.source, "parse"),
    value: { ...factor.value, signatureChanges: result.changes.length, symbolFanIn: fanIn, symbolFanInUnresolved: fanInUnresolved },
    guidelines: { ...factor.guidelines, ...(cutoffs === null ? {} : { symbolFanIn: { moderate: cutoffs.moderate, high: cutoffs.high } }) },
    evidenceTotal: (factor.evidenceTotal ?? factor.evidence.length) + rows.length,
    evidence: [...factor.evidence, ...rows.slice(0, 5).map((row) => ({ file: row.file, symbol: row.symbol, change: row.change, fanIn: row.fanIn, fanInUnresolved: row.fanInUnresolved, from: "parse" }))],
  };
}

function joinSources(source: string, added: string): string {
  const parts = source.split(/, | and /);
  return parts.length === 1 ? `${source} and ${added}` : `${parts.slice(0, -1).join(", ")}, ${parts.at(-1)} and ${added}`;
}
