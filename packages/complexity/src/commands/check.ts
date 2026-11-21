import type { Command } from "@code-health/cli-kit/run-cli";
import { compareToBase } from "../comparison.ts";
import { readSettings, thresholdsFor } from "../config.ts";
import { exceeded, limitOf } from "../metrics.ts";
import { hasUncommittedWork } from "../current-tree.ts";
import { defaultBase, resolveRevision } from "../revisions.ts";
import { unitName } from "../rows.ts";

export const name = "check";

/**
 * The ratchet. It compares the functions that changed against a base revision, and fails on a new function
 * over a threshold or an existing one that is over a threshold and got worse. A function that stays under
 * its thresholds never fails, and neither does one that is over and did not get worse. The base is a
 * revision rather than a committed baseline file, which would conflict on every merge.
 */
export const command: Command = {
  summary: "Fail when a new function is over a threshold or an existing one over a threshold got worse than a base revision",
  options: { base: { type: "string" } },
  async run(context) {
    const settings = readSettings(context.config);
    const root = context.repo.root;
    const base =
      typeof context.values.base === "string" ? await resolveRevision(root, context.values.base) : await defaultBase(root, settings);
    // The code as it stands: HEAD when the tree is clean, otherwise the work in progress, as a pre-commit run wants.
    const uncommitted = await hasUncommittedWork(context);
    const target = uncommitted
      ? ({ kind: "working-tree" } as const)
      : ({ kind: "revision", revision: { rev: "HEAD", sha: context.repo.head } } as const);
    const comparison = await compareToBase(context, settings, base, target);

    const summary = { compared: 0, added: 0, changed: 0, removed: 0, moved: 0, violations: 0 };
    const rows = [];
    for (const match of comparison.matches) {
      const { before, after } = match;
      if (after === undefined) {
        summary.removed++;
        continue;
      }
      summary.compared++;
      if (match.moved) summary.moved++;
      if (before === undefined) summary.added++;
      else if (match.changed) summary.changed++;
      const thresholds = thresholdsFor(settings, after.path);
      for (const metric of exceeded(after.values, thresholds)) {
        const now = after.values[metric]!;
        const was = before?.values[metric];
        const limit = limitOf(thresholds, metric);
        if (before !== undefined && now - (was ?? 0) <= settings.delta) continue;
        rows.push({
          path: after.path,
          unit: unitName(after),
          id: after.id,
          finding: before === undefined ? "new" : "worsened",
          metric,
          before: was ?? null,
          after: now,
          threshold: limit,
          delta: was === undefined ? null : now - was,
          startLine: after.startLine,
          endLine: after.endLine,
          score: now - limit,
          renamedFrom: match.moved ? before!.id : null,
        });
      }
    }
    summary.violations = rows.length;

    return {
      inputs: { base, against: uncommitted ? "working-tree" : "head", delta: settings.delta },
      extra: { summary, changedFiles: comparison.changedFiles, unsupportedFiles: comparison.unsupportedFiles },
      results: rows,
      columns: ["path", "unit", "finding", "metric", "before", "after", "threshold", "delta"],
      failed: rows.length > 0,
    };
  },
};
