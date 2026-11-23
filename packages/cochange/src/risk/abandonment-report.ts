import { existsSync, readFileSync } from "node:fs";
import { REPORT } from "../abandonment/simulate-run.ts";
import { reportPath } from "../reports.ts";

export interface AbandonmentReport {
  /** The report as `inputs` names it. */
  input: { report: string; head: string; config: string };
  /** Files the simulation found abandoned or with some probability of becoming so, by their path at the report's commit. */
  files: ReadonlyMap<string, { abandoned: boolean; probability: number }>;
  /** The probability the turnover model gives one developer of leaving within the horizon: what a file held by one active developer has. */
  leaverProbability: number;
}

/**
 * The stored `abandonment simulate` report, when it is whole and describes this change's tip: written by a
 * configured run on a clean tree at that commit, under this configuration and these local overrides.
 * Rows are files and probabilities, never people. Anything else gives null, and `abandoned-touched` is
 * measured from the blame cache instead.
 */
export function readAbandonmentReport(root: string, head: string, config: string, overridesStamp: string | null): AbandonmentReport | null {
  const file = reportPath(root, REPORT);
  if (!existsSync(file)) return null;
  try {
    const document = JSON.parse(readFileSync(file, "utf8")) as {
      tool?: unknown;
      command?: unknown;
      repo?: { head?: unknown; dirty?: unknown };
      config?: unknown;
      inputs?: { mode?: unknown; overrides?: { hash?: unknown } };
      results?: { files?: unknown; selection?: { leaverProbability?: unknown } };
    };
    if (document.tool !== "cochange" || document.command !== REPORT) return null;
    if (document.repo?.head !== head || document.repo?.dirty !== false || document.config !== config) return null;
    if (document.inputs?.mode !== "rate" || (document.inputs.overrides?.hash ?? null) !== overridesStamp) return null;
    if (!Array.isArray(document.results?.files)) return null;
    const leaverProbability = document.results.selection?.leaverProbability;
    if (typeof leaverProbability !== "number") return null;
    const files = new Map<string, { abandoned: boolean; probability: number }>();
    for (const row of document.results.files as Record<string, unknown>[]) {
      if (typeof row.path !== "string" || typeof row.probability !== "number" || typeof row.abandoned !== "boolean") continue;
      files.set(row.path, { abandoned: row.abandoned, probability: row.probability });
    }
    return { input: { report: `cochange.${REPORT}`, head, config }, files, leaverProbability };
  } catch {
    return null;
  }
}
