import { usageError } from "@code-health/cli-kit/errors";
import { blobSize, readBlob } from "@code-health/history/tree";
import { indentationComplexity } from "@code-health/lexical/indentation-complexity";
import { analysisCommand } from "../analysis-command.ts";
import { integerOption } from "../coupled-pairs.ts";
import { focusPath } from "../focus-path.ts";
import { isoDate } from "../units.ts";

export const name = "trend";

export const DEFAULT_SAMPLES = 10;
export const MAX_SAMPLES = 500;

/** Relative change in complexity, from the first sample to the last, beyond which a file is worsening or improving. */
export const TREND_THRESHOLD = 0.2;

interface Revision {
  commit: string;
  committerDate: number;
  path: string;
  blob: string;
}

/** `count` revisions spread evenly over the list, always including the first and the last. */
export function pickSamples<T>(revisions: readonly T[], count: number): T[] {
  if (revisions.length <= count) return [...revisions];
  const last = revisions.length - 1;
  return Array.from({ length: count }, (_, i) => revisions[Math.round((i * last) / (count - 1))]!);
}

type Direction = "worsening" | "improving" | "stable" | "insufficient";

function directionOf(first: number | null, last: number | null, samples: number): Direction {
  if (samples < 2 || first === null || last === null) return "insufficient";
  const change = first === 0 ? (last === 0 ? 0 : 1) : (last - first) / first;
  if (change >= TREND_THRESHOLD) return "worsening";
  if (change <= -TREND_THRESHOLD) return "improving";
  return "stable";
}

const delta = (first: number | null, last: number | null) => ({
  first,
  last,
  change: first === null || last === null ? null : last - first,
});

export const command = analysisCommand(name, {
  summary: "Indentation complexity and size of one file sampled across its history, from blobs",
  options: { samples: { type: "string" } },
  wholeHistory: true,
  partial: () => true,
  async analyse({ context, history }) {
    const [requested, ...rest] = context.positionals;
    if (requested === undefined || rest.length > 0) throw usageError("usage: trend PATH [--samples N]");
    const samples = integerOption(context, "samples", DEFAULT_SAMPLES, 2, MAX_SAMPLES);
    const file = await focusPath(context, history, requested);

    // One revision per logical change that left the file with content: a deletion has no blob.
    const revisions: Revision[] = [];
    for (const change of history.filtered.changes) {
      const touched = change.files.find((f) => f.fileId === file && f.blob !== null);
      if (touched) {
        revisions.push({ commit: change.shas.at(-1)!, committerDate: change.committerDate, path: touched.path, blob: touched.blob! });
      }
    }
    if (revisions.length === 0) throw usageError(`no revisions of "${requested}" in the analysed history`);

    const rows = await Promise.all(
      pickSamples(revisions, samples).map(async (revision) => {
        const [text, bytes] = await Promise.all([readBlob(context.repo.root, revision.blob), blobSize(context.repo.root, revision.blob)]);
        const binary = text.includes("\0");
        return {
          commit: revision.commit,
          date: isoDate(revision.committerDate),
          path: revision.path,
          complexity: binary ? null : indentationComplexity(text, revision.path),
          lines: binary ? null : text === "" ? 0 : text.replace(/\n$/, "").split("\n").length,
          bytes,
        };
      }),
    );

    const first = rows[0]!;
    const last = rows.at(-1)!;
    return {
      inputs: { path: file, samples, threshold: TREND_THRESHOLD },
      results: {
        path: file,
        revisions: revisions.length,
        samples: rows,
        summary: {
          direction: directionOf(first.complexity, last.complexity, rows.length),
          complexity: delta(first.complexity, last.complexity),
          lines: delta(first.lines, last.lines),
        },
      },
      extra: { complexitySource: "indentation" },
    };
  },
});
