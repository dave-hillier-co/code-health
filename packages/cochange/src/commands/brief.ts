import { usageError } from "@code-health/cli-kit/errors";
import type { CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { listTree } from "@code-health/history/tree";
import { readStored, storeCached, type CachedInput, type Hit, type StoredResult } from "@code-health/history/results-cache";
import { repoRelative } from "@code-health/history/repo-paths";
import { analysisCommand, finishAnalysis } from "../analysis-command.ts";
import { readSettings, type CochangeSettings } from "../config.ts";
import { compareBytes, confidenceOf, degreeOf, reachesDegree } from "../coupling.ts";
import { analysedSha, derivedResult } from "../derived-results.ts";
import { activityOutput, derived as activityDerived, type FileActivity } from "../file-activity.ts";
import type { ExplicitWindow } from "../history-access.ts";
import type { HotspotRow } from "../hotspot-ranking.ts";
import { SECONDS_PER_DAY, isoDate } from "../units.ts";
import { statedWindow } from "../window-options.ts";
import { couplingOutput, derived as couplingDerived } from "./coupling.ts";
import { derived as hotspotsDerived, rankedOutput } from "./hotspots.ts";

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

/** One pair row of the stored coupling result, read from the side of one of its files. */
interface Partner {
  path: string;
  support: number;
  changesFocus: number;
  changesPartner: number;
  distance: number;
}

interface PairRow {
  path: string;
  with: string;
  distance: number;
  evidence: { support: number; changesPath: number; changesWith: number };
}

/** What the briefing is computed from: the hotspot ranking, the coupling pairs and the per-file activity of one window. */
interface Sources {
  hotspots: CommandOutput;
  coupling: CommandOutput;
  activity: CommandOutput;
}

function partnerIndex(pairs: readonly PairRow[]): Map<string, Partner[]> {
  const index = new Map<string, Partner[]>();
  const add = (focus: string, partner: Partner) => {
    const list = index.get(focus);
    if (list === undefined) index.set(focus, [partner]);
    else list.push(partner);
  };
  for (const pair of pairs) {
    const { support, changesPath, changesWith } = pair.evidence;
    add(pair.path, { path: pair.with, support, changesFocus: changesPath, changesPartner: changesWith, distance: pair.distance });
    add(pair.with, { path: pair.path, support, changesFocus: changesWith, changesPartner: changesPath, distance: pair.distance });
  }
  return index;
}

/**
 * The briefing for the requested files, from the hotspot ranking, coupling pairs and per-file activity of the
 * analysed commit, so it reads no history. `resolve` follows a requested path that is not in the tree through renames.
 */
function briefOutput(
  context: CommandContext,
  settings: CochangeSettings,
  present: ReadonlySet<string>,
  sources: Sources,
  resolve: (asked: string) => string,
): CommandOutput {
  const requested = context.positionals;
  if (requested.length === 0) throw usageError("brief needs at least one file path: cochange brief PATH...");
  const limit = partnersOption(context);
  const root = context.repo.root;
  const rankedBy = new Map((sources.hotspots.results as HotspotRow[]).map((row) => [row.path, row]));
  const activityOf = new Map((sources.activity.results as FileActivity[]).map((row) => [row.path, row]));
  const partnersByFile = partnerIndex(sources.coupling.results as PairRow[]);
  const { fixConvention } = sources.hotspots.extra as { fixConvention: { note: string | null } };
  const { headDate: anchor } = sources.activity.extra as { headDate: number };

  const rows = [...new Set(requested.map((raw) => repoRelative(root, raw)))].map((asked) => {
    // A path that exists at the analysed commit names the file there. Only a path that is gone is followed through renames.
    const path = present.has(asked) ? asked : resolve(asked);
    const exists = present.has(path);

    const activity = activityOf.get(path);
    const frequency = activity?.revisions ?? 0;
    const hotspot = rankedBy.get(path);

    const alongside = (partnersByFile.get(path) ?? [])
      // A partner deleted by the end of the window cannot be edited, so it is not worth naming. The pairs hold none.
      .filter((partner) => present.has(partner.path))
      .map((partner) => {
        const pair = { a: path, b: partner.path, support: partner.support, changesA: partner.changesFocus, changesB: partner.changesPartner };
        return {
          path: partner.path,
          degree: round1(degreeOf(pair)),
          confidence: round1(confidenceOf(partner.support, partner.changesFocus)),
          reverseConfidence: round1(confidenceOf(partner.support, partner.changesPartner)),
          support: partner.support,
          distance: partner.distance,
          // The degree is a guideline: partners under it are listed after those at or above it, not dropped.
          aboveGuideline: reachesDegree(pair, settings.minDegree),
        };
      })
      .sort((x, y) => Number(y.aboveGuideline) - Number(x.aboveGuideline) || y.confidence - x.confidence || y.support - x.support || compareBytes(x.path, y.path));

    const note = !exists && frequency === 0
      ? `"${asked}" is not in the tree at the analysed commit and has no history in the window: a new file, or a wrong path.`
      : frequency === 0
        ? `No revisions in the ${settings.windowMonths} month window, so there is no co-change evidence for it.`
        : alongside.length === 0
          ? `Nothing shares at least ${settings.minSupport} changes with it.`
          : !alongside.some((partner) => partner.aboveGuideline)
            ? `No partner reaches the degree guideline of ${settings.minDegree} %. The partners listed are below it.`
            : null;

    return {
      path,
      requested: asked === path ? null : asked,
      exists,
      frequency,
      recentRevisions: activity?.recentRevisions ?? 0,
      fixes: hotspot?.fixes ?? 0,
      fixShare: hotspot === undefined || hotspot.landedChanges === 0 ? null : Math.round((hotspot.fixes / hotspot.landedChanges) * 1000) / 1000,
      lastChanged: activity === undefined ? null : isoDate(activity.lastChanged),
      ageDays: activity === undefined ? null : Math.floor((anchor - activity.lastChanged) / SECONDS_PER_DAY),
      hotspotScore: hotspot?.score ?? null,
      recommendation: hotspot?.recommendation ?? null,
      alongside: alongside.slice(0, limit),
      alongsideNotShown: Math.max(0, alongside.length - limit),
      note,
    };
  });

  const { window, filtersApplied, evidence } = sources.hotspots.extra as Record<string, unknown>;
  return {
    inputs: {
      paths: rows.map((row) => row.requested ?? row.path),
      partners: limit,
      degreeGuideline: settings.minDegree,
      ...(sources.hotspots.inputs?.identityInputs === undefined ? {} : { identityInputs: sources.hotspots.inputs.identityInputs }),
    },
    results: rows,
    extra: { window, filtersApplied, evidence, fixConvention },
    notices: fixConvention.note === null ? [] : [fixConvention.note.replace(/\.$/, "")],
    columns: ["path", "frequency", "recentRevisions", "fixes", "lastChanged", "recommendation", "alongside", "note"],
  };
}

/** What names the three stored results the briefing is computed from, for the window the run states. */
function storedSources(context: CommandContext, head: string, window: ExplicitWindow | undefined) {
  return {
    activity: derivedResult(context, activityDerived, head, window),
    coupling: derivedResult(context, couplingDerived, head, window),
    hotspots: derivedResult(context, hotspotsDerived, head, window),
  };
}

export const command = analysisCommand(name, {
  summary: "A compact pre-change briefing for the given files: what usually changes with them, recent activity, hotspot status",
  options: { partners: { type: "string" } },
  // The briefing covers only the files asked about, so it is printed but never stored as a report.
  partial: () => true,
  /**
   * With the hotspot ranking, the coupling pairs and the per-file activity stored for this commit, config and
   * window, the briefing reads them and no history. A file that is not in the tree needs the renames, so it is
   * answered from history.
   */
  async fromCache(context, window) {
    if (context.positionals.length === 0) return undefined;
    const head = await analysedSha(context);
    const stored = storedSources(context, head, window);
    const activity = readStored(context, stored.activity);
    const coupling = readStored(context, stored.coupling);
    const hotspots = readStored(context, stored.hotspots);
    if (activity === undefined || coupling === undefined || hotspots === undefined) return undefined;
    const present = new Set(await listTree(context.repo.root, head));
    if (context.positionals.some((raw) => !present.has(repoRelative(context.repo.root, raw)))) return undefined;

    hotspots.restoreLeftOut();
    const output = briefOutput(
      context,
      readSettings(context.config),
      present,
      { hotspots: hotspots.output, coupling: coupling.output, activity: activity.output },
      (path) => path,
    );
    const named = [activity, coupling, hotspots].map((hit: Hit): CachedInput => hit.input);
    return { ...output, inputs: { ...output.inputs, resultsCache: named } };
  },
  async analyse({ context, history }) {
    // Asked before anything is computed or stored.
    if (context.positionals.length === 0) throw usageError("brief needs at least one file path: cochange brief PATH...");
    const window = statedWindow(context, history.settings.windowMonths);
    const stored = storedSources(context, history.view.headSha, window);
    // Each result is stored as soon as it is computed, so what it records of the files left out is its own.
    // The hotspot ranking is last, because the briefing reports the files left out of that.
    const finish = async (computed: CommandOutput, result: StoredResult): Promise<CommandOutput> => {
      const output = finishAnalysis(history, computed);
      if (context.values["no-refresh"] !== true) await storeCached(context, result, output);
      return output;
    };
    const activity = await finish(activityOutput(history), stored.activity);
    const coupling = await finish(await couplingOutput(context, history), stored.coupling);
    const hotspots = await finish(await rankedOutput(context, history), stored.hotspots);
    const present = new Set(await listTree(context.repo.root, history.view.headSha));
    return briefOutput(context, history.settings, present, { hotspots, coupling, activity }, (asked) => history.view.renames.resolve(asked, -1));
  },
});
