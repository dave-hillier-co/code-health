import { measureAbstractness } from "../abstractness.ts";
import { packageRows } from "../list.ts";
import { analyseReuse } from "../reuse.ts";
import type { Subcommand } from "../subcommand.ts";

export const list: Subcommand = {
  summary: "Every package with its kind, purpose, size, consumers, stability, closure and change frequency",
  async analyse({ model }) {
    const rows = packageRows(model, measureAbstractness(await analyseReuse(model), model.settings.packages.minExportedTypes));
    const ecosystems: Record<string, number> = {};
    for (const row of rows) ecosystems[row.ecosystem] = (ecosystems[row.ecosystem] ?? 0) + 1;
    return {
      inputs: { subcommand: "list", graceDays: model.settings.packages.graceDays },
      results: rows,
      columns: ["id", "kind", "purpose", "files", "consumers", "ca", "ce", "instability", "abstractness", "distance", "closure", "share", "revisions"],
      extra: {
        repository: {
          packages: rows.length,
          ecosystems,
          eligibleChanges: model.activity.eligibleChanges,
        },
      },
    };
  },
};
