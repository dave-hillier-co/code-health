import { usageError } from "@code-health/cli-kit/errors";
import type { CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { historySections, identityStamps } from "../analysis-command.ts";
import { integerOption } from "../coupled-pairs.ts";
import { readComponents } from "../components.ts";
import { loadHistory, type LoadedHistory } from "../history-access.ts";
import { estimateTurnover, readActivity } from "./activity.ts";
import { measureCurrent, round4 } from "./current.ts";
import { windowSecondsOf } from "../active-developers.ts";
import { loadKnowledge, periodSecondsOf } from "./load.ts";
import { readSimulationSettings } from "./selection.ts";
import { requireKnowledge } from "./settings.ts";
import { simulate } from "./simulate.ts";

const SECONDS_PER_DAY = 86_400;
const isoDay = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

/** `--at DATE` as the end of that day, UTC, in unix seconds. */
export function parseAt(value: string): number {
  const seconds = Date.parse(`${value}T23:59:59Z`) / 1000;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(seconds) || isoDay(seconds) !== value) {
    throw usageError(`--at must be a date as YYYY-MM-DD, not "${value}"`);
  }
  return seconds;
}

/** The latest commit of the history made at or before a date, by committer date. */
export function commitAt(history: LoadedHistory, date: number): string | null {
  let found: { sha: string; position: number } | null = null;
  for (const c of history.view.commits) {
    if (c.committerDate <= date && (found === null || c.position > found.position)) found = { sha: c.sha, position: c.position };
  }
  return found?.sha ?? null;
}

export interface Backtest {
  predicted: Set<string>;
  actual: Set<string>;
  hits: string[];
  precision: number | null;
  recall: number | null;
}

/** Scores predictions against what happened: how many predicted files were abandoned, and how many abandoned files were predicted. */
export function scorePredictions(predicted: ReadonlySet<string>, actual: ReadonlySet<string>): Backtest {
  const hits = [...predicted].filter((path) => actual.has(path)).sort();
  return {
    predicted: new Set(predicted),
    actual: new Set(actual),
    hits,
    precision: predicted.size === 0 ? null : hits.length / predicted.size,
    recall: actual.size === 0 ? null : hits.length / actual.size,
  };
}

/**
 * `abandonment backtest`: at a past date, predict which files will be abandoned one horizon later
 * with the rate-mode model as it stood then (history up to the date only, blame of the commit
 * then), and compare with the files that were abandoned. Nothing here uses what happened after
 * the date to make the prediction.
 */
export async function backtestCommand(context: CommandContext): Promise<CommandOutput> {
  const settings = requireKnowledge(context);
  const sim = readSimulationSettings(context, settings);
  const top = integerOption(context, "top", 20, 1, 100_000);
  const noRefresh = context.values["no-refresh"] === true;
  const history = await loadHistory(context, { noRefresh });
  const { root } = context.repo;

  const periodSeconds = periodSecondsOf(settings);
  const windowSeconds = windowSecondsOf(settings);
  const horizonSeconds = sim.horizonPeriods * periodSeconds;
  const anchor = history.view.headDate;
  const latest = anchor - horizonSeconds;
  const requested = context.values.at;
  const at = requested === undefined ? latest : parseAt(String(requested));
  if (at > latest) {
    throw usageError(`a backtest needs a whole horizon of ${sim.horizonPeriods} period(s) after the date to compare with; the latest date is ${isoDay(latest - SECONDS_PER_DAY + 1)}`);
  }
  const outcomeAt = at + horizonSeconds;
  const startSha = commitAt(history, at);
  const outcomeSha = commitAt(history, outcomeAt);
  if (startSha === null || outcomeSha === null) throw usageError(`the history has no commit at or before ${isoDay(at)}`);

  const identity = { localMailmap: history.identities.localMailmap, matcher: history.identities.matcher };
  const activity = await readActivity(root, history.view.commits, identity);
  const turnover = estimateTurnover(activity, at, { windowSeconds, periodSeconds });
  const rate = settings.turnoverRate ?? turnover.rate;
  if (rate === null) {
    throw usageError(`the history before ${isoDay(at)} is too short to estimate turnover; set cochange.knowledge.turnoverRate, or choose a later date`);
  }

  const before = await loadKnowledge(context, history, settings, { noRefresh, target: { sha: startSha, asOf: at }, activity });
  const after = await loadKnowledge(context, history, settings, { noRefresh, target: { sha: outcomeSha, asOf: outcomeAt }, activity });

  const result = simulate(before.model, {
    selection: { mode: "rate", rate, periods: sim.horizonPeriods },
    trials: sim.trials,
    seed: sim.seed,
    alphas: settings.alphas,
    thresholdPercent: settings.abandonmentThreshold,
    components: readComponents(context.config.effective.components),
  });

  // Files are matched across the two dates by their stable identity, so a file renamed in between is the same file.
  const positionOf = (sha: string): number => history.view.commits.find((c) => c.sha === sha)!.position;
  const identityBefore = (path: string): string => history.view.renames.resolve(path, positionOf(startSha));
  const identityAfter = (path: string): string => history.view.renames.resolve(path, positionOf(outcomeSha));
  const pathOf = new Map(before.model.files.map((f) => [identityBefore(f.path), f.path]));
  const abandonedBefore = new Set(measureCurrent(before.model, settings.abandonmentThreshold).filter((f) => f.abandoned).map((f) => identityBefore(f.path)));
  const abandonedAfter = new Set(measureCurrent(after.model, settings.abandonmentThreshold).filter((f) => f.abandoned).map((f) => identityAfter(f.path)));
  const present = new Set(pathOf.keys());
  const survivors = new Set(after.model.files.map((f) => identityAfter(f.path)));
  // Files that exist at both dates and were not abandoned at the first: the ones a prediction can be right or wrong about.
  const candidates = [...present].filter((id) => survivors.has(id) && !abandonedBefore.has(id));
  const probability = new Map(result.fileRisks.map((f) => [identityBefore(f.path), f.probability]));
  // A file is predicted at or above the at-risk guideline. Precision and recall need that cut, and the rows carry the probability.
  const predicted = new Set(candidates.filter((id) => probability.get(id)! * 100 >= settings.atRiskProbability));
  const actual = new Set(candidates.filter((id) => abandonedAfter.has(id)));
  const score = scorePredictions(predicted, actual);
  const predictedGone = [...present].filter((id) => !abandonedBefore.has(id) && !survivors.has(id) && probability.get(id)! * 100 >= settings.atRiskProbability).length;

  const rows = candidates
    .filter((id) => predicted.has(id) || actual.has(id))
    .map((id) => ({
      path: pathOf.get(id)!,
      score: round4(probability.get(id)!),
      probability: round4(probability.get(id)!),
      outcome: predicted.has(id) ? (actual.has(id) ? "hit" : "false-alarm") : "missed",
    }))
    .sort((a, b) => b.score - a.score || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .slice(0, top);

  return {
    inputs: {
      subcommand: "backtest",
      at: isoDay(at),
      trials: sim.trials,
      horizonPeriods: sim.horizonPeriods,
      seed: sim.seed,
      alphas: settings.alphas,
      atRiskProbability: settings.atRiskProbability,
      abandonmentThreshold: settings.abandonmentThreshold,
      activityWindowMonths: settings.activityWindowMonths,
      periodMonths: settings.periodMonths,
      copyDetection: settings.copyDetection,
      turnoverRate: settings.turnoverRate === null ? null : round4(settings.turnoverRate),
      ...identityStamps(history),
    },
    extra: historySections(history),
    results: {
      at: isoDay(at),
      outcomeAt: isoDay(outcomeAt),
      commits: { at: startSha, outcome: outcomeSha },
      model: {
        source: settings.turnoverRate === null ? "history" : "configured",
        ratePerPeriod: round4(rate),
        leaverProbability: round4(result.meanLeaverProbability),
        activeDevelopers: result.activeDevelopers,
        departures: { atRisk: turnover.atRisk, departed: turnover.departed, periods: turnover.periods.length },
      },
      candidates: candidates.length,
      predicted: { files: predicted.size, goneByOutcome: predictedGone },
      actual: { files: actual.size },
      truePositives: score.hits.length,
      precision: score.precision === null ? null : round4(score.precision),
      recall: score.recall === null ? null : round4(score.recall),
      // What the model expected against what happened, over every file, whether or not it crossed the threshold.
      expectedAbandoned: round4(candidates.reduce((sum, path) => sum + probability.get(path)!, 0)),
      files: rows,
    },
  };
}
