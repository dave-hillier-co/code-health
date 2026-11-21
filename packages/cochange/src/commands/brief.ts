import { usageError } from "@code-health/cli-kit/errors";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { treeDistance } from "@code-health/graph/tree-distance";
import { monthsBefore } from "@code-health/history/evidence";
import { listTree } from "@code-health/history/tree";
import { analysisCommand } from "../analysis-command.ts";
import { compareBytes, confidenceOf, degreeOf, partnersOf, reachesDegree } from "../coupling.ts";
import { rankHotspots, type HotspotRow } from "../hotspot-ranking.ts";
import { repoRelative } from "@code-health/history/repo-paths";
import { SECONDS_PER_DAY, isoDate } from "../units.ts";

export const name = "brief";

const DEFAULT_PARTNERS = 5;

const round1 = (value: number) => Math.round(value * 10) / 10;

function partnersOption(context: CommandContext): number {
  const raw = context.values.partners;
  if (raw === undefined) return DEFAULT_PARTNERS;
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < 1) {
    throw usageError(`--partners must be a positive integer, got "${String(raw)}"`);
  }
  return Number(raw);
}

export const command = analysisCommand(name, {
  summary: "A compact pre-change briefing for the given files: what usually changes with them, recent activity, hotspot status",
  options: { partners: { type: "string" } },
  // The briefing covers only the files asked about, so it is printed but never stored as a report.
  partial: () => true,
  async analyse({ context, history }) {
    const requested = context.positionals;
    if (requested.length === 0) throw usageError("brief needs at least one file path: cochange brief PATH...");
    const limit = partnersOption(context);
    const { settings } = history;
    const root = context.repo.root;

    const present = new Set(await listTree(root, history.view.headSha));
    const { rows: ranked } = await rankHotspots(context, history, "file");
    const rankedBy = new Map<string, HotspotRow>(ranked.map((row) => [row.path, row]));

    const anchor = history.view.headDate;
    const recentSince = monthsBefore(anchor, settings.recentMonths);
    const couplingChanges = history.filtered.changes.map((change) => ({
      files: change.files.map((file) => file.fileId),
      oversized: change.oversized,
    }));
    // A partner deleted by the end of the window cannot be edited, so it is not worth naming.
    const lastStatus = new Map<string, string>();
    for (const change of history.filtered.changes) {
      for (const file of change.files) lastStatus.set(file.fileId, file.status);
    }

    const rows = [...new Set(requested.map((raw) => repoRelative(root, raw)))].map((asked) => {
      // A path that exists at the analysed commit names the file there. Only a path that is gone is followed through renames.
      const path = present.has(asked) ? asked : history.view.renames.resolve(asked, -1);
      const exists = present.has(path);

      const dates = history.filtered.changes
        .filter((change) => change.files.some((file) => file.fileId === path))
        .map((change) => change.committerDate);
      const lastChanged = dates.length === 0 ? null : Math.max(...dates);
      const hotspot = rankedBy.get(path);

      const { partners } = partnersOf(couplingChanges, path);
      const alongside = partners
        .filter((partner) => present.has(partner.path) && lastStatus.get(partner.path) !== "D")
        .filter((partner) => reachesDegree({ a: path, b: partner.path, support: partner.support, changesA: partner.changesFocus, changesB: partner.changesPartner }, settings.minDegree))
        .map((partner) => ({
          path: partner.path,
          degree: round1(
            degreeOf({ a: path, b: partner.path, support: partner.support, changesA: partner.changesFocus, changesB: partner.changesPartner }),
          ),
          confidence: round1(confidenceOf(partner.support, partner.changesFocus)),
          reverseConfidence: round1(confidenceOf(partner.support, partner.changesPartner)),
          support: partner.support,
          distance: treeDistance(path, partner.path),
        }))
        .filter((partner) => partner.support >= settings.minSupport)
        .sort((x, y) => y.confidence - x.confidence || y.support - x.support || compareBytes(x.path, y.path));

      const note = !exists && dates.length === 0
        ? `"${asked}" is not in the tree at the analysed commit and has no history in the window: a new file, or a wrong path.`
        : dates.length === 0
          ? `No revisions in the ${settings.windowMonths} month window, so there is no co-change evidence for it.`
          : alongside.length === 0
            ? `Nothing changes with it often enough (support ${settings.minSupport}, degree ${settings.minDegree} %).`
            : null;

      return {
        path,
        requested: asked === path ? null : asked,
        exists,
        frequency: dates.length,
        recentRevisions: dates.filter((date) => date >= recentSince).length,
        lastChanged: lastChanged === null ? null : isoDate(lastChanged),
        ageDays: lastChanged === null ? null : Math.floor((anchor - lastChanged) / SECONDS_PER_DAY),
        hotspotScore: hotspot?.score ?? null,
        recommendation: hotspot?.recommendation ?? null,
        alongside: alongside.slice(0, limit),
        alongsideNotShown: Math.max(0, alongside.length - limit),
        note,
      };
    });

    return {
      inputs: { paths: rows.map((row) => row.requested ?? row.path), partners: limit },
      results: rows,
      columns: ["path", "frequency", "recentRevisions", "lastChanged", "recommendation", "alongside", "note"],
    };
  },
});
