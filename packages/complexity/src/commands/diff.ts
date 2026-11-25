import { usageError } from "@code-health/cli-kit/errors";
import type { Command } from "@code-health/cli-kit/run-cli";
import { compareToBase } from "../comparison.ts";
import { readSettings, guidelinesFor } from "../config.ts";
import { labelsFor, metricIds, type Values } from "../metrics.ts";
import { resolveRevision } from "../revisions.ts";
import { pick, unitName } from "../rows.ts";

export const name = "diff";

function delta(before: Values, after: Values): Values {
  const out: Values = {};
  for (const metric of metricIds) {
    const value = after[metric];
    if (value !== undefined) out[metric] = value - (before[metric] ?? 0);
  }
  return out;
}

/**
 * The functions a change added or changed, with their metrics before and after. `BASE..HEAD` compares two
 * revisions, and `BASE` alone compares against the working tree. A function that only moved or was
 * renamed is matched to its old self by body similarity and left out unless its body changed.
 */
export const command: Command = {
  summary: "Functions added or changed between two revisions, or a revision and the working tree, with before and after",
  async run(context) {
    const [range] = context.positionals;
    if (range === undefined) throw usageError("diff needs a revision: BASE, or BASE..HEAD");
    const [baseRev, headRev, ...extra] = range.split("..");
    if (baseRev === undefined || baseRev === "" || extra.length > 0 || headRev === "") {
      throw usageError(`"${range}" is not BASE or BASE..HEAD`);
    }

    const settings = readSettings(context.config);
    const base = await resolveRevision(context.repo.root, baseRev);
    const head = headRev === undefined ? undefined : await resolveRevision(context.repo.root, headRev);
    const comparison = await compareToBase(
      context,
      settings,
      base,
      head === undefined ? { kind: "working-tree" } : { kind: "revision", revision: head },
    );

    const summary = { added: 0, changed: 0, removed: 0, moved: 0, unchanged: 0 };
    const rows = [];
    for (const match of comparison.matches) {
      const { before, after } = match;
      if (after === undefined) {
        summary.removed++;
        continue;
      }
      if (match.moved) summary.moved++;
      if (before === undefined) summary.added++;
      else if (match.changed) summary.changed++;
      else {
        summary.unchanged++;
        continue;
      }
      const guidelines = guidelinesFor(settings, after.path);
      rows.push({
        path: after.path,
        unit: unitName(after),
        id: after.id,
        change: before === undefined ? "added" : "changed",
        renamedFrom: match.moved ? before!.id : null,
        startLine: after.startLine,
        endLine: after.endLine,
        before: before === undefined ? null : pick(before.values, metricIds),
        after: pick(after.values, metricIds),
        delta: before === undefined ? null : delta(before.values, after.values),
        score: (after.values.cognitive ?? 0) - (before?.values.cognitive ?? 0),
        labels: labelsFor(after.values, guidelines, after.bumpyRoad === true),
      });
    }

    return {
      inputs: {
        base,
        head: head ?? null,
        against: head === undefined ? "working-tree" : "revision",
      },
      extra: { summary, changedFiles: comparison.changedFiles, unsupportedFiles: comparison.unsupportedFiles },
      results: rows,
      columns: ["path", "unit", "change", "score", "before", "after", "delta", "labels"],
    };
  },
};
