import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configError, usageError } from "@code-health/cli-kit/errors";
import { serialise } from "@code-health/cli-kit/serialise";
import { ensureLocalState, identityFiles } from "@code-health/history/identity-decisions";
import type { TaskEffort } from "@code-health/transcripts/agent-effort";
import type { EffortSummary, NotMeasuredSession } from "@code-health/transcripts/measure-repo";
import type { DayWindow } from "./measure-window.ts";
import type { Heat } from "./measure-effort.ts";
import type { SpreadSummary } from "./measure-spread.ts";
import type { StructureMetrics } from "./structure-metrics.ts";
import { SCHEMA_VERSION, TOOL } from "./tool.ts";

/** A candidate as it stood before anything moved: where it ranked, and the files whose changes and reads are its neighbourhood. */
export interface BaselineCandidate {
  /** Position in the analysis ranking, from 1. */
  rank: number;
  path: string;
  score: number;
  recommendation: string;
  rule: string;
  /** The unit's files, as they were named at the baseline. */
  files: string[];
  /** The production files that use the unit. */
  consumers: string[];
}

/** The footprint of a candidate: the unit and its consumers. A move changes how far apart they are. */
export const footprintOf = (candidate: BaselineCandidate): string[] => [...new Set([...candidate.files, ...candidate.consumers])].sort();

export interface Baseline {
  schemaVersion: number;
  tool: typeof TOOL;
  name: string;
  /** The commit analysed, and its committer date. Everything below was read as of it. */
  head: string;
  headDate: string;
  window: DayWindow;
  /** The filters the spread and the comparison apply, so the matching window is measured the same way. */
  filters: { exclude: string[]; suiteCommitsExcluded: boolean };
  evidence: { grade: string; logicalChangesInWindow: number; usableHistoryMonths: number; activeContributors: number; shallow: boolean };
  /** Change spread of the whole repository over the window. */
  spread: SpreadSummary;
  effort: {
    sessions: { measured: number; notMeasured: NotMeasuredSession[] };
    summary: EffortSummary;
    /** Paths and counts of each task. The transcripts may be gone by the time of the comparison, so they are kept here. */
    tasks: TaskEffort[];
    stamp: string;
  };
  readHeat: Heat[];
  /** Total weighted import distance, single-file folders and maximum depth at the baseline. Absent in baselines written before they were recorded. */
  structure?: StructureMetrics;
  /** The ranked candidates, from which the comparison group is later drawn. */
  candidates: BaselineCandidate[];
  /** All candidates the analysis ranked, of which `candidates` holds the first ones. */
  candidateCount: number;
  /** Commits that already carried this tool's trailer at the baseline: a baseline taken after the first tidy-up is not a baseline. */
  priorSuiteCommits: number;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function baselinePath(root: string, name: string): string {
  if (!NAME.test(name)) throw usageError(`--name must be letters, digits, dots, dashes and underscores, not "${name}"`);
  return join(identityFiles(root).localDir, `${TOOL}.baseline.${name}.json`);
}

export const baselineExists = (root: string, name: string): boolean => existsSync(baselinePath(root, name));

/** Writes the baseline into `.code-health/local/`, which is never tracked and never regenerated. */
export function writeBaseline(root: string, baseline: Baseline): string {
  ensureLocalState(root);
  const path = baselinePath(root, baseline.name);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, serialise(baseline));
  renameSync(temporary, path);
  return path;
}

export function readBaseline(root: string, name: string): Baseline {
  const path = baselinePath(root, name);
  if (!existsSync(path)) {
    throw usageError(`no baseline named "${name}": run \`locality measure baseline\` before the first tidy-up`);
  }
  let value: Baseline;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as Baseline;
  } catch {
    throw configError(`${path} is not valid JSON`);
  }
  if (value.schemaVersion !== SCHEMA_VERSION || value.tool !== TOOL) {
    throw configError(`${path} was written by another version of the tool (schemaVersion ${String(value.schemaVersion)})`);
  }
  return value;
}
