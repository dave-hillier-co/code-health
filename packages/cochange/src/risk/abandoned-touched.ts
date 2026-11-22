import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { commitsInSnapshot, resolveOwners } from "@code-health/history/blame-owners";
import { readBlame } from "@code-health/history/blame-read";
import { refreshBlame } from "@code-health/history/blame-refresh";
import { estimateTurnover, readActivity } from "../abandonment/activity.ts";
import { round4 } from "../abandonment/current.ts";
import { windowSecondsOf } from "../active-developers.ts";
import { blameOptions, periodSecondsOf } from "../abandonment/load.ts";
import { buildKnowledgeModel, goneLinesOf, reachesGuideline } from "../abandonment/knowledge-model.ts";
import { readKnowledgeSettings, readOverrides } from "../abandonment/settings.ts";
import { readAbandonmentReport, type AbandonmentReport } from "./abandonment-report.ts";
import { simulate } from "../abandonment/simulate.ts";
import type { LoadedHistory } from "../history-access.ts";
import { TOOL } from "../tool.ts";
import type { BranchChange } from "./change.ts";
import type { Measurement } from "./measure.ts";

const SOURCE = "knowledge analysis";

export interface AbandonedTouched {
  measurement: Measurement;
  /** The stored report the measurement was read from, when it was. */
  report: AbandonmentReport["input"] | null;
}

const unavailable = (reason: string): Measurement => ({
  name: "abandoned-touched",
  family: "history",
  layer: "history",
  kind: "count",
  source: SOURCE,
  unavailable: reason,
  series: {},
  value: {},
  evidence: [],
});

/**
 * Touched files that were already abandoned at the base, or are likely to be abandoned within the
 * horizon, when the repository has opted in to the knowledge analysis (`cochange.knowledge.enabled`).
 *
 * Abandonment output is never stored, so this is computed here from the blame cache of the touched files
 * at the base and the same model and simulation `abandonment` uses, judged at the date of the change's tip.
 * Developers enter as counts only: the evidence names files, never people. A file's probability needs a
 * turnover rate, the configured one or the one history shows; without either, only files already abandoned count.
 */
export async function abandonedTouched(context: CommandContext, history: LoadedHistory, change: BranchChange): Promise<AbandonedTouched> {
  const section = (context.config.effective[TOOL] as { knowledge?: { enabled?: unknown } }).knowledge;
  if (section?.enabled !== true) return { measurement: unavailable("knowledge analysis is not enabled (cochange.knowledge.enabled)"), report: null };
  const settings = readKnowledgeSettings(context.config.effective);
  const root = context.repo.root;

  // The report is the composition seam: when `abandonment simulate` has already run for this tip, its files are read, not computed again.
  const report = change.worktree ? null : readAbandonmentReport(root, change.head, context.config.hash, readOverrides(root).stamp);
  if (report !== null) return { measurement: fromReport(report, change, settings.atRiskProbability), report: report.input };
  return { measurement: await fromBlame(context, history, change, settings), report: null };
}

/**
 * The report describes the tip, so a line the change itself wrote counts for the file's authors at the
 * tip, where the blame cache at the base would count the file as it was before the change.
 */
function fromReport(report: AbandonmentReport, change: BranchChange, atRiskProbability: number): Measurement {
  const touched = [...new Set(change.files.filter((f) => f.status !== "A" && f.status !== "D").map((f) => f.path))].sort();
  const rows = touched.flatMap((file) => {
    const row = report.files.get(file);
    if (row === undefined) return [];
    const abandoned = row.abandoned;
    return abandoned || (row.probability > 0 && row.probability * 100 >= atRiskProbability) ? [{ file, abandoned, probability: round4(abandoned ? 1 : row.probability) }] : [];
  });
  return { ...measurement(rows, touched.length, 0), source: "abandonment report" };
}

async function fromBlame(
  context: CommandContext,
  history: LoadedHistory,
  change: BranchChange,
  settings: ReturnType<typeof readKnowledgeSettings>,
): Promise<Measurement> {
  const root = context.repo.root;

  const paths = [...new Set(change.files.filter((f) => f.status !== "A").map((f) => f.oldPath ?? f.path))].sort();
  if (paths.length === 0) return measurement([], 0, 0);

  const options = { ref: change.base, ...blameOptions(history, settings), paths };
  if (context.values["no-refresh"] !== true) await refreshBlame(root, options);
  const snapshot = await readBlame(root, options);
  const identity = { localMailmap: history.identities.localMailmap, matcher: history.identities.matcher };
  const owners = await resolveOwners(root, commitsInSnapshot(snapshot), identity);
  const activity = await readActivity(root, history.view.commits, identity);
  const asOf = history.view.headDate;
  const model = buildKnowledgeModel({ snapshot, owners, activity, asOf, windowSeconds: windowSecondsOf(settings), overrides: readOverrides(root) });

  // Each developer leaves independently, so the probability of a file does not depend on the files left out of this model.
  const turnover = estimateTurnover(activity, asOf, { windowSeconds: windowSecondsOf(settings), periodSeconds: periodSecondsOf(settings) });
  const rate = settings.turnoverRate ?? turnover.rate;
  const probabilities = new Map<string, number>();
  if (rate !== null && model.files.length > 0) {
    const result = simulate(model, {
      selection: { mode: "rate", rate, periods: settings.horizonPeriods },
      trials: settings.trials,
      seed: settings.seed,
      alphas: settings.alphas,
      guidelinePercent: settings.abandonmentGuideline,
    });
    for (const risk of result.fileRisks) probabilities.set(risk.path, risk.probability);
  }

  const rows = model.files
    .map((file) => {
      const abandoned = reachesGuideline(goneLinesOf(file, model.developers), file.people, settings.abandonmentGuideline);
      const probability = abandoned ? 1 : (probabilities.get(file.path) ?? 0);
      return { path: file.path, abandoned, probability, share: round4(goneLinesOf(file, model.developers) / file.people) };
    })
    .filter((row) => row.abandoned || (row.probability > 0 && row.probability * 100 >= settings.atRiskProbability));

  const nowPath = new Map(change.files.map((f) => [f.oldPath ?? f.path, f.path]));
  return measurement(
    rows.map((row) => ({ file: nowPath.get(row.path) ?? row.path, abandoned: row.abandoned, probability: round4(row.probability), abandonedShare: row.share })),
    snapshot.files.size,
    snapshot.missing.length,
  );
}

function measurement(evidence: Record<string, unknown>[], files: number, unknown: number): Measurement {
  const sorted = [...evidence].sort((a, b) => (a.file as string) < (b.file as string) ? -1 : (a.file as string) > (b.file as string) ? 1 : 0);
  return {
    name: "abandoned-touched",
    family: "history",
    layer: "history",
    kind: "count",
    source: SOURCE,
    unavailable: null,
    series: { count: sorted.length },
    value: { count: sorted.length, files, unknown },
    evidence: sorted.slice(0, 5),
  };
}
