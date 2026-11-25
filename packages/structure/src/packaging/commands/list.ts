import { measureAbstractness } from "../abstractness.ts";
import { packageRows, type PackageRow } from "../list.ts";
import { internalMarker, type PackageModel } from "../model.ts";
import { analyseReuse } from "../reuse.ts";
import type { Subcommand } from "../subcommand.ts";

const plural = (count: number, noun: string, many = `${noun}s`): string => `${count} ${count === 1 ? noun : many}`;

/** What a table run prints after the rows: the files no package owns, and the packages listed as published only by default. */
function notices(model: PackageModel, rows: readonly PackageRow[]): string[] {
  const out: string[] = [];
  if (model.unowned > 0) out.push(`${plural(model.unowned, "file")} ${model.unowned === 1 ? "is" : "are"} owned by no package, so changes to them count for no package.`);
  const assumed = rows.filter((row) => row.kindSource === "default");
  const byMarker = new Map<string, string[]>();
  for (const row of assumed) {
    const marker = internalMarker(model.byId.get(row.id)!) ?? `${row.ecosystem} manifests have no such marker`;
    byMarker.set(marker, [...(byMarker.get(marker) ?? []), row.id]);
  }
  for (const [marker, ids] of [...byMarker].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out.push(
      `${plural(ids.length, "package")} ${ids.length === 1 ? "is" : "are"} listed as published only because ${ids.length === 1 ? "its manifest does" : "their manifests do"} not mark ${ids.length === 1 ? "it" : "them"} internal (${marker}) and no config says otherwise: ${ids.join(", ")}.`,
    );
  }
  return out;
}

export const list: Subcommand = {
  summary: "Every package with its kind, purpose, size, consumers, stability, closure and change frequency, the largest share of changes first",
  async analyse({ model }) {
    const rows = packageRows(model, measureAbstractness(await analyseReuse(model), model.settings.packages.minExportedTypes));
    const ecosystems: Record<string, number> = {};
    for (const row of rows) ecosystems[row.ecosystem] = (ecosystems[row.ecosystem] ?? 0) + 1;
    return {
      inputs: { subcommand: "list", graceDays: model.settings.packages.graceDays },
      results: rows,
      presorted: true,
      columns: ["id", "kind", "purpose", "files", "consumers", "ca", "ce", "instability", "abstractness", "distance", "closure", "share", "revisions"],
      notices: notices(model, rows),
      extra: {
        repository: {
          packages: rows.length,
          ecosystems,
          eligibleChanges: model.activity.eligibleChanges,
          unowned: model.unowned,
        },
      },
    };
  },
};
