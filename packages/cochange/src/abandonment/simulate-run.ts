import { usageError } from "@code-health/cli-kit/errors";
import type { CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { integerOption } from "../coupled-pairs.ts";
import { UNASSIGNED, readComponents } from "../components.ts";
import { estimateTurnover, type Turnover } from "./activity.ts";
import { round4 } from "./current.ts";
import { goneLinesOf, reachesThreshold } from "./knowledge-model.ts";
import { commonExtra, commonInputs, prepare, type Prepared } from "./prepare.ts";
import { fileFindings, hotspotWeights, rankScore } from "./ranking.ts";
import { reportLoss } from "./report.ts";
import { chooseSelection, readSimulationSettings } from "./selection.ts";
import { readRank, requireKnowledge } from "./settings.ts";
import { simulate } from "./simulate.ts";

const isoDay = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

/** Turnover observed in the whole history up to the analysed commit. */
export function observedTurnover(p: Prepared): Turnover {
  return estimateTurnover(p.knowledge.activity, p.knowledge.model.asOf, {
    windowSeconds: p.knowledge.windowSeconds,
    periodSeconds: p.knowledge.periodSeconds,
  });
}

const turnoverSummary = (t: Turnover) => ({
  rate: t.rate === null ? null : round4(t.rate),
  atRisk: t.atRisk,
  departed: t.departed,
  periods: t.periods.length,
});

/** `abandonment turnover`: the rate per period with the counts behind it, and no names. */
export async function turnoverCommand(context: CommandContext): Promise<CommandOutput> {
  const p = await prepare(context);
  const turnover = observedTurnover(p);
  return {
    inputs: commonInputs(p, "turnover"),
    extra: commonExtra(p, {
      turnover: { ...turnoverSummary(turnover), configuredRate: p.settings.turnoverRate === null ? null : round4(p.settings.turnoverRate) },
    }),
    results: turnover.periods.map((period) => ({
      start: isoDay(period.start),
      end: isoDay(period.end),
      developers: period.atRisk,
      departed: period.departed,
      rate: round4(period.rate),
    })),
    columns: ["start", "end", "developers", "departed", "rate"],
  };
}

/** `abandonment simulate`: the loss distribution, and the files and components it concentrates in. */
export async function simulateCommand(context: CommandContext): Promise<CommandOutput> {
  const sim = readSimulationSettings(context, requireKnowledge(context));
  const top = integerOption(context, "top", 20, 1, 100_000);
  const p = await prepare(context);
  const { settings } = p;
  const { model } = p.knowledge;
  const turnover = observedTurnover(p);
  const { selection, source } = chooseSelection(sim, settings, turnover);
  const components = readComponents(context.config.effective.components);
  const active = model.developers.filter((d) => d.active).length;
  if (selection.mode === "k-leavers" && selection.k > active) {
    throw usageError(`--k ${selection.k} is more than the ${active} active developers; at most ${active} can leave`);
  }

  const result = simulate(model, {
    selection,
    trials: sim.trials,
    seed: sim.seed,
    alphas: settings.alphas,
    thresholdPercent: settings.abandonmentThreshold,
    components,
  });

  const weights = await hotspotWeights(context, p.history);
  const rank = readRank(context, settings);
  const byPath = new Map(model.files.map((f) => [f.path, f]));
  const fileRows = result.fileRisks
    .filter((f) => f.probability > 0)
    .map((f) => {
      const file = byPath.get(f.path)!;
      const former = file.holders.filter((h) => !model.developers[h.dev]!.active).length;
      const abandoned = reachesThreshold(goneLinesOf(file, model.developers), file.people, settings.abandonmentThreshold);
      const weight = weights.get(f.path);
      return {
        path: f.path,
        score: rankScore(rank, f.probability, weight),
        probability: round4(f.probability),
        tailShare: round4(f.tailShare),
        abandoned,
        hotspot: weight?.hot ?? false,
        hotspotPercentile: round4(weight?.percentile ?? 0),
        peopleLines: file.people,
        activeAuthors: file.holders.length - former,
        formerAuthors: former,
        findings: fileFindings({ abandoned, probability: f.probability, hot: weight?.hot ?? false, noSuccessor: false }, settings.atRiskProbability),
      };
    })
    .sort((a, b) => b.score - a.score || b.probability - a.probability || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .slice(0, top);

  const componentRows = result.componentRisks
    .map((c) => {
      const loss = reportLoss(c.lines, c.baselineLines, c.peopleLines);
      const tailRatio = loss.increment.atRisk[0]!.tailRatio;
      const concentrated = c.name !== UNASSIGNED && tailRatio !== null && tailRatio >= settings.concentratedTailRatio;
      return {
        path: c.name,
        peopleLines: c.peopleLines,
        abandonedLines: c.baselineLines,
        expectedLoss: loss.increment.expected,
        atRisk: loss.increment.atRisk,
        findings: concentrated ? ["concentrated-component"] : [],
      };
    })
    .sort((a, b) => b.expectedLoss - a.expectedLoss || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .slice(0, top);

  const leaverProbability = round4(result.meanLeaverProbability);
  return {
    inputs: commonInputs(p, "simulate", {
      mode: sim.mode,
      k: sim.k,
      trials: sim.trials,
      horizonPeriods: sim.horizonPeriods,
      seed: sim.seed,
      alphas: settings.alphas,
      rank,
      turnoverRate: settings.turnoverRate === null ? null : round4(settings.turnoverRate),
    }),
    extra: commonExtra(p, { turnover: turnoverSummary(turnover) }),
    results: {
      mode: sim.mode,
      trials: sim.trials,
      horizonPeriods: sim.horizonPeriods,
      seed: sim.seed,
      selection: {
        source,
        ratePerPeriod: selection.mode === "rate" ? round4(selection.rate) : null,
        leavers: selection.mode === "k-leavers" ? selection.k : null,
        leaverProbability,
      },
      population: { activeDevelopers: result.activeDevelopers, files: result.population.files, peopleLines: result.population.peopleLines },
      loss: {
        lines: reportLoss(result.lines, result.baseline.lines, result.population.peopleLines),
        files: reportLoss(result.files, result.baseline.files, result.population.files),
      },
      files: fileRows,
      components: componentRows,
    },
  };
}
