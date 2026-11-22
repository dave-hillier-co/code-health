import { usageError } from "@code-health/cli-kit/errors";
import type { CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { historySections, identityStamps } from "../analysis-command.ts";
import { windowSecondsOf } from "../active-developers.ts";
import { readComponents } from "../components.ts";
import { integerOption } from "../coupled-pairs.ts";
import { loadHistory } from "../history-access.ts";
import { measureAdoption, summariseAdoption } from "./adoption.ts";
import { commitAt, parseAt } from "./backtest.ts";
import { estimateTurnover, readActivity } from "./activity.ts";
import { measureCurrent, round4 } from "./current.ts";
import { loadKnowledge, periodSecondsOf } from "./load.ts";
import { commonExtra, commonInputs, prepare } from "./prepare.ts";
import { hotspotWeights } from "./ranking.ts";
import { measureRedundancy, summariseRedundancy } from "./redundancy.ts";
import { reportLoss } from "./report.ts";
import { readSimulationSettings } from "./selection.ts";
import { requireKnowledge } from "./settings.ts";
import { simulate } from "./simulate.ts";
import { buildSuccessorIndex } from "./successors.ts";

const isoDay = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** `abandonment redundancy`: the share of hotspot files with enough active authors, each holding enough of the lines. */
export async function redundancyCommand(context: CommandContext): Promise<CommandOutput> {
  const minAuthors = integerOption(context, "min-authors", 2, 1, 1000);
  const minShare = integerOption(context, "min-share", 10, 1, 100);
  const p = await prepare(context);
  const weights = await hotspotWeights(context, p.history);
  const hot = new Set([...weights].filter(([, w]) => w.hot).map(([path]) => path));
  const files = measureRedundancy(p.knowledge.model, hot, { minAuthors, minSharePercent: minShare });
  const percentile = (path: string) => weights.get(path)?.percentile ?? 0;
  const rows = [...files]
    .sort((a, b) => Number(a.redundant) - Number(b.redundant) || percentile(b.path) - percentile(a.path) || byBytes(a.path, b.path))
    .map((f) => ({ ...f, hotspotPercentile: round4(percentile(f.path)) }));
  return {
    inputs: commonInputs(p, "redundancy", { minAuthors, minSharePercent: minShare }),
    extra: commonExtra(p, { summary: summariseRedundancy(files) }),
    results: rows,
    columns: ["path", "redundant", "qualifyingAuthors", "activeAuthors", "peopleLines", "hotspotPercentile"],
  };
}

/**
 * `abandonment trend`: expected loss and knowledge at risk at one period steps back from the analysed
 * commit, each point built from the history and blame of the commit then. Every point uses the same
 * settings and the same turnover rate (the configured one, else the rate observed up to the analysed
 * commit), so the points differ only in the repository, never in the model.
 */
export async function trendCommand(context: CommandContext): Promise<CommandOutput> {
  const settings = requireKnowledge(context);
  const sim = readSimulationSettings(context, settings);
  if (sim.mode !== "rate") throw usageError("trend uses the rate model so that every point has the same settings; --mode is not available");
  const points = integerOption(context, "points", 4, 2, 60);
  const noRefresh = context.values["no-refresh"] === true;
  const history = await loadHistory(context, { noRefresh });
  const periodSeconds = periodSecondsOf(settings);
  const windowSeconds = windowSecondsOf(settings);
  const anchor = history.view.headDate;
  const identity = { localMailmap: history.identities.localMailmap, matcher: history.identities.matcher };
  const activity = await readActivity(context.repo.root, history.view.commits, identity);
  const observed = estimateTurnover(activity, anchor, { windowSeconds, periodSeconds });
  const rate = settings.turnoverRate ?? observed.rate;
  if (rate === null) {
    throw usageError("the history is too short to estimate turnover; set cochange.knowledge.turnoverRate so every point shares one rate");
  }
  const components = readComponents(context.config.effective.components);

  const rows = [];
  let skipped = 0;
  for (let i = 0; i < points; i++) {
    const at = anchor - i * periodSeconds;
    const sha = i === 0 ? history.view.headSha : commitAt(history, at);
    if (sha === null) {
      skipped++;
      continue;
    }
    const knowledge = await loadKnowledge(context, history, settings, { noRefresh, activity, ...(i === 0 ? {} : { target: { sha, asOf: at } }) });
    const result = simulate(knowledge.model, {
      selection: { mode: "rate", rate, periods: sim.horizonPeriods },
      trials: sim.trials,
      seed: sim.seed,
      alphas: settings.alphas,
      guidelinePercent: settings.abandonmentGuideline,
      components,
    });
    const abandoned = measureCurrent(knowledge.model, settings.abandonmentGuideline).filter((f) => f.abandoned).length;
    rows.push({
      date: isoDay(at),
      commit: sha,
      activeDevelopers: result.activeDevelopers,
      files: result.population.files,
      abandonedFiles: abandoned,
      lines: reportLoss(result.lines, result.baseline.lines, result.population.peopleLines),
    });
  }
  rows.reverse();
  const first = rows[0]?.lines.total.expectedShare;
  const last = rows.at(-1)?.lines.total.expectedShare;
  const direction = rows.length < 2 || first === undefined || last === undefined ? null : last < first ? "falling" : last > first ? "rising" : "flat";
  return {
    inputs: {
      subcommand: "trend",
      points,
      trials: sim.trials,
      horizonPeriods: sim.horizonPeriods,
      seed: sim.seed,
      alphas: settings.alphas,
      abandonmentGuideline: settings.abandonmentGuideline,
      activityWindowMonths: settings.activityWindowMonths,
      periodMonths: settings.periodMonths,
      copyDetection: settings.copyDetection,
      turnoverRate: settings.turnoverRate === null ? null : round4(settings.turnoverRate),
      ...identityStamps(history),
    },
    extra: historySections(history),
    results: {
      ratePerPeriod: round4(rate),
      rateSource: settings.turnoverRate === null ? "history" : "configured",
      skippedPoints: skipped,
      direction,
      points: rows,
    },
  };
}

/**
 * `abandonment adoption`: of the files abandoned at a past date, how many were picked up by an active
 * developer within a horizon, and how many by someone the model would have recommended with only the
 * history before that date. Counts only: no developer is named.
 */
export async function adoptionCommand(context: CommandContext): Promise<CommandOutput> {
  const settings = requireKnowledge(context);
  const sim = readSimulationSettings(context, settings);
  const recommended = integerOption(context, "successors", 3, 1, 100);
  const noRefresh = context.values["no-refresh"] === true;
  const history = await loadHistory(context, { noRefresh });
  const periodSeconds = periodSecondsOf(settings);
  const horizonSeconds = sim.horizonPeriods * periodSeconds;
  const anchor = history.view.headDate;
  const latest = anchor - horizonSeconds;
  const at = context.values.at === undefined ? latest : parseAt(String(context.values.at));
  if (at > latest) {
    throw usageError(`adoption needs a whole horizon of ${sim.horizonPeriods} period(s) after the date; the latest date is ${isoDay(latest - 86_400 + 1)}`);
  }
  const outcomeAt = at + horizonSeconds;
  const startSha = commitAt(history, at);
  const outcomeSha = commitAt(history, outcomeAt);
  if (startSha === null || outcomeSha === null) throw usageError(`the history has no commit at or before ${isoDay(at)}`);

  const identity = { localMailmap: history.identities.localMailmap, matcher: history.identities.matcher };
  const activity = await readActivity(context.repo.root, history.view.commits, identity);
  const before = await loadKnowledge(context, history, settings, { noRefresh, target: { sha: startSha, asOf: at }, activity });
  const after = await loadKnowledge(context, history, settings, { noRefresh, target: { sha: outcomeSha, asOf: outcomeAt }, activity });

  const eligible = history.filtered.changes.filter((c) => !c.oversized);
  const known = eligible.filter((c) => c.committerDate <= at);
  const index = buildSuccessorIndex({ ...history, filtered: { ...history.filtered, changes: known } });
  const abandoned = measureCurrent(before.model, settings.abandonmentGuideline)
    .filter((f) => f.abandoned)
    .map((f) => f.path);
  const files = measureAdoption({
    before: before.model,
    after: after.model,
    activity,
    abandoned,
    changes: eligible
      .filter((c) => c.committerDate > at && c.committerDate <= outcomeAt)
      .map((c) => ({ committerDate: c.committerDate, authors: c.authors, files: c.files.map((f) => f.fileId) })),
    index,
    recommended,
  });
  const summary = summariseAdoption(files);
  return {
    inputs: {
      subcommand: "adoption",
      at: isoDay(at),
      successors: recommended,
      horizonPeriods: sim.horizonPeriods,
      abandonmentGuideline: settings.abandonmentGuideline,
      activityWindowMonths: settings.activityWindowMonths,
      periodMonths: settings.periodMonths,
      copyDetection: settings.copyDetection,
      ...identityStamps(history),
    },
    extra: historySections(history),
    results: {
      at: isoDay(at),
      outcomeAt: isoDay(outcomeAt),
      commits: { at: startSha, outcome: outcomeSha },
      ...summary,
      files: files
        .map((f) => ({ path: f.path, changed: f.changed, adopted: f.adopted, byRecommended: f.byRecommended, byNewcomer: f.byNewcomer }))
        .sort((a, b) => byBytes(a.path, b.path)),
    },
  };
}
