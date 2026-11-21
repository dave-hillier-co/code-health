import { HistoryState } from "./history-state.ts";
import { measureHistoryLayer, type ChangeFacts, type Measurement, type MeasureContext } from "./measure.ts";
import type { MergedChange } from "./merged-changes.ts";

export interface PastChange {
  change: MergedChange;
  /** The change's history-layer factors, measured from the history before it and nothing else. */
  measurements: Measurement[];
}

export const SECONDS_PER_MONTH = 30.4375 * 86_400;

/** What the factors read of a past change. */
export function factsOf(change: MergedChange): ChangeFacts {
  return {
    time: change.time,
    authors: change.authors.map((author) => author.toLowerCase()),
    files: change.files,
    moved: change.files.filter((file) => file.status === "R").length,
  };
}

export const isFix = (change: MergedChange, patterns: readonly RegExp[]): boolean =>
  change.subjects.some((subject) => patterns.some((pattern) => pattern.test(subject)));

export interface PassOptions {
  windowMonths: number;
  maxChangesetSize: number;
  /** Patterns marking a fix or a revert, which feed `defect-history`. */
  fixPatterns: readonly RegExp[];
  /** Only changes for which this is true are measured. Every change is still added to the state. */
  measureWhen?: (change: MergedChange, index: number) => boolean;
}

/**
 * Walks the changes oldest first. Each is measured against the state as it was before it, then added to
 * the state. A measurement therefore depends only on earlier changes: nothing later can alter it.
 */
export function chronologicalPass(
  changes: readonly MergedChange[],
  context: MeasureContext,
  options: PassOptions,
): { state: HistoryState; past: PastChange[] } {
  const state = new HistoryState({ windowSeconds: Math.round(options.windowMonths * SECONDS_PER_MONTH), maxChangesetSize: options.maxChangesetSize });
  const past: PastChange[] = [];
  for (const [index, change] of changes.entries()) {
    state.advance(change.time);
    if (options.measureWhen?.(change, index) ?? true) {
      past.push({ change, measurements: measureHistoryLayer(factsOf(change), state, context) });
    }
    state.add(change, isFix(change, options.fixPatterns));
  }
  return { state, past };
}
