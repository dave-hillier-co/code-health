import { round4 } from "./current.ts";
import type { KnowledgeModel } from "./knowledge-model.ts";

export interface FileRedundancy {
  path: string;
  /** Lines held by people. */
  peopleLines: number;
  /** Active developers holding at least the minimum share of those lines. */
  qualifyingAuthors: number;
  /** Active developers holding any lines at all. */
  activeAuthors: number;
  redundant: boolean;
}

/**
 * Whether a file has redundancy: at least `minAuthors` active developers each holding at least
 * `minSharePercent` of the lines held by people, in exact integer arithmetic. Developers who
 * have left hold nothing that counts, and bots and services hold no lines in the model.
 */
export function measureRedundancy(
  model: KnowledgeModel,
  hot: ReadonlySet<string>,
  rule: { minAuthors: number; minSharePercent: number },
): FileRedundancy[] {
  return model.files
    .filter((file) => hot.has(file.path))
    .map((file) => {
      const active = file.holders.filter((h) => model.developers[h.dev]!.active);
      const qualifying = active.filter((h) => 100 * h.lines >= rule.minSharePercent * file.people).length;
      return {
        path: file.path,
        peopleLines: file.people,
        qualifyingAuthors: qualifying,
        activeAuthors: active.length,
        redundant: qualifying >= rule.minAuthors,
      };
    });
}

export interface RedundancySummary {
  hotspotFiles: number;
  redundant: number;
  /** redundant / hotspotFiles, null when there are no hotspot files with lines held by people. */
  share: number | null;
}

export function summariseRedundancy(files: readonly FileRedundancy[]): RedundancySummary {
  const redundant = files.filter((f) => f.redundant).length;
  return { hotspotFiles: files.length, redundant, share: files.length === 0 ? null : round4(redundant / files.length) };
}
