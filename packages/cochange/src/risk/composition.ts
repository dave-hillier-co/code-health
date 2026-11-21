import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readBlobAt } from "@code-health/history/tree";
import { analyseSource } from "@code-health/lexical/analyse-source";
import { reportPath } from "../reports.ts";
import type { Factor } from "./factor.ts";
import { bandAgainst, cutoffsOf, higherBand, type Band } from "./bands.ts";
import type { BranchChange } from "./change.ts";
import { overThreshold, type EvidenceInputs } from "./evidence-inputs.ts";
import type { Measurement } from "./measure.ts";
import type { RiskSettings } from "./settings.ts";

/**
 * The factors that need more than history: `complexity-delta` and `structure-delta` from what the
 * skill passed in, and `abandoned-touched`, which is measured from the knowledge analysis (see
 * `abandoned-touched.ts`). Each is a count, or is unavailable: a factor that could not be computed is never low.
 */
export async function liveMeasurements(
  root: string,
  change: BranchChange,
  risk: RiskSettings,
  evidence: EvidenceInputs,
  abandoned: Measurement,
): Promise<Measurement[]> {
  return [await complexityDelta(root, change, risk, evidence), structureDelta(evidence), abandoned];
}

function structureDelta(evidence: EvidenceInputs): Measurement {
  const base = { name: "structure-delta", family: "structure-and-content", layer: "structural", kind: "count", source: "structure check" } as const;
  if (evidence.structure === null) {
    return { ...base, unavailable: "no structure check was passed in: run `structure check --json` for this branch and pass it with --evidence", series: {}, value: {}, evidence: [] };
  }
  const { findings } = evidence.structure;
  return {
    ...base,
    unavailable: null,
    series: { count: findings.length },
    value: { count: findings.length },
    evidence: findings.slice(0, 5).map((finding) => ({ kind: finding.kind, id: finding.id })),
  };
}

async function complexityDelta(root: string, change: BranchChange, risk: RiskSettings, evidence: EvidenceInputs): Promise<Measurement> {
  const base = { name: "complexity-delta", family: "structure-and-content", kind: "count" } as const;
  if (evidence.complexity !== null) {
    const units = overThreshold(evidence.complexity);
    return {
      ...base,
      layer: "structural",
      source: "complexity diff",
      unavailable: null,
      series: { count: units.length },
      value: { count: units.length, unsupportedFiles: evidence.complexity.unsupportedFiles },
      evidence: units.slice(0, 5).map((unit) => ({ unit: unit.id, change: unit.change, cognitive: unit.cognitive, delta: unit.delta })),
    };
  }

  // Without the complexity plugin: how much more indentation the touched code files carry than they did at the base.
  const rows: { file: string; before: number; after: number; delta: number }[] = [];
  let examined = 0;
  for (const file of change.files) {
    if (file.status === "D" || file.binary) continue;
    const before = file.status === "A" ? "" : await readBlobAt(root, change.base, file.oldPath ?? file.path);
    const after = change.worktree ? readWorktree(root, file.path) : await readBlobAt(root, change.head, file.path);
    if (after === undefined || before === undefined || after.includes("\0") || before.includes("\0")) continue;
    // Prose has no lexer profile, so its indentation says nothing about how hard code is to read.
    const now = analyseSource(file.path, after);
    if (now.profile === null) continue;
    examined++;
    const was = before === "" ? 0 : analyseSource(file.oldPath ?? file.path, before).file.indentationComplexity;
    const rose = now.file.indentationComplexity;
    if (rose - was >= risk.complexityRise) rows.push({ file: file.path, before: was, after: rose, delta: rose - was });
  }
  rows.sort((a, b) => b.delta - a.delta || (a.file < b.file ? -1 : 1));
  return {
    ...base,
    layer: "lexical",
    source: "indentation",
    unavailable: null,
    series: { count: rows.length },
    value: { count: rows.length, files: examined },
    evidence: rows.slice(0, 5),
  };
}

function readWorktree(root: string, path: string): string | undefined {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return undefined;
  }
}

export interface LocalityFanIn {
  /** The report as `inputs` names it. */
  input: { report: string; head: string; config: string };
  /** The largest fan-in among the units listed for each file. */
  byFile: ReadonlyMap<string, number>;
  /** The fan-in of every unit in the report: the population a file's fan-in is placed in. */
  population: readonly number[];
}

/**
 * Locality's report, when it is whole: from locality, stamped with this change's tip, taken on a clean
 * tree. Rows carry `path` and `fanIn`. Anything else gives null and `blast-radius` keeps its co-change form.
 */
export function readLocalityFanIn(root: string, head: string): LocalityFanIn | null {
  const file = reportPath(root, "analyse", "locality");
  if (!existsSync(file)) return null;
  try {
    const document = JSON.parse(readFileSync(file, "utf8")) as {
      tool?: unknown;
      command?: unknown;
      repo?: { head?: unknown; dirty?: unknown };
      config?: unknown;
      results?: unknown;
    };
    if (document.tool !== "locality" || document.command !== "analyse") return null;
    if (document.repo?.head !== head || document.repo?.dirty !== false) return null;
    if (!Array.isArray(document.results) || typeof document.config !== "string") return null;
    const byFile = new Map<string, number>();
    const population: number[] = [];
    for (const row of document.results as Record<string, unknown>[]) {
      if (typeof row.path !== "string" || typeof row.fanIn !== "number") continue;
      population.push(row.fanIn);
      byFile.set(row.path, Math.max(byFile.get(row.path) ?? 0, row.fanIn));
    }
    return { input: { report: "locality.analyse", head, config: document.config }, byFile, population };
  } catch {
    return null;
  }
}

/**
 * Adds locality's fan-in to `blast-radius`. The factor is banded on its co-change reach as before, and
 * its fan-in is placed against the fan-in of every unit locality listed. The band is the higher of the two,
 * so the report can only raise it, which keeps the baseline (measured from history alone) comparable.
 */
export function withFanIn(factor: Factor, touched: readonly string[], locality: LocalityFanIn, risk: RiskSettings): Factor {
  const rows = touched.flatMap((file) => (locality.byFile.has(file) ? [{ file, fanIn: locality.byFile.get(file)! }] : []));
  const fanIn = rows.reduce((most, row) => Math.max(most, row.fanIn), 0);
  const cutoffs = locality.population.length < risk.minBaseline ? null : cutoffsOf(locality.population, risk.moderatePercentile, risk.highPercentile);
  const placed: Band | null = cutoffs === null ? null : bandAgainst(fanIn, cutoffs);
  const band: Band | null = placed === null ? (factor.band as Band | null) : factor.band === null ? placed : higherBand(factor.band as Band, placed);
  return {
    ...factor,
    status: band === null ? factor.status : "ok",
    band,
    source: "co-change and locality report",
    reason: band === null ? factor.reason : null,
    value: { ...factor.value, fanIn },
    thresholds: { ...factor.thresholds, fanIn: cutoffs === null ? null : { moderate: cutoffs.moderate, high: cutoffs.high } },
    evidence: [...factor.evidence, ...rows.sort((a, b) => b.fanIn - a.fanIn || (a.file < b.file ? -1 : 1)).slice(0, 5).map((row) => ({ ...row, from: "locality" }))],
  };
}
