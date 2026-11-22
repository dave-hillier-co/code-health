import { usageError } from "@code-health/cli-kit/errors";
import type { Command, CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { backtestCommand } from "../abandonment/backtest.ts";
import { groupByComponent, measureCurrent, round4, summariseCurrent } from "../abandonment/current.ts";
import { commonExtra, commonInputs, prepare } from "../abandonment/prepare.ts";
import { fileFindings, hotspotWeights, rankScore, rules as abandonmentRules } from "../abandonment/ranking.ts";
import { readRank } from "../abandonment/settings.ts";
import { noSuccessorCheck } from "../abandonment/successors.ts";
import { simulationOptions } from "../abandonment/selection.ts";
import { adoptionCommand, redundancyCommand, trendCommand } from "../abandonment/outcome-run.ts";
import { simulateCommand, turnoverCommand } from "../abandonment/simulate-run.ts";
import { readComponents } from "../components.ts";
import { byOption, readBy } from "../units.ts";

export const name = "abandonment";

export const rules = abandonmentRules;

const SUBCOMMANDS = ["adoption", "backtest", "current", "redundancy", "simulate", "trend", "turnover"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

/**
 * Knowledge lost when people leave. Every subcommand is behind the privacy gate
 * (`cochange.knowledge.enabled`), reports files and components with developers as
 * counts, and is never stored as a report for another plugin to read.
 */
export const command: Command = {
  subcommands: {
    adoption: { summary: "Files abandoned at a past date and whether an active developer, or a recommended successor, picked them up", options: ["at", "successors", "horizon", "no-refresh"] },
    backtest: { summary: "At a past date, the predicted at-risk files against the files actually abandoned one horizon later", options: ["at", "trials", "horizon", "seed", "top", "no-refresh"] },
    current: { summary: "Files already abandoned, ranked", options: ["by", "rank", "no-refresh"] },
    redundancy: { summary: "Share of hotspot files with enough active authors holding enough of the lines", options: ["min-authors", "min-share", "no-refresh"] },
    simulate: { summary: "Loss distribution of simulated turnover, with the files and components it concentrates in", options: ["mode", "k", "trials", "horizon", "seed", "top", "rank", "no-refresh"] },
    trend: { summary: "Expected loss and knowledge at risk over time, at the same settings and rate", options: ["points", "trials", "horizon", "seed", "no-refresh"] },
    turnover: { summary: "Observed turnover rate per period, with the developer counts behind it", options: ["no-refresh"] },
  },
  summary: "Knowledge lost when people leave: files already abandoned, simulated turnover, and a backtest of the model",
  options: { ...byOption, ...simulationOptions, top: { type: "string" }, points: { type: "string" }, successors: { type: "string" }, "min-authors": { type: "string" }, "min-share": { type: "string" }, rank: { type: "string" }, at: { type: "string" }, "no-refresh": { type: "boolean" } },
  async run(context) {
    const [sub, ...rest] = context.positionals;
    if (!SUBCOMMANDS.includes(sub as Subcommand) || rest.length > 0) throw usageError(`usage: abandonment <${SUBCOMMANDS.join("|")}>`);
    const subcommand = sub as Subcommand;
    rejectOptionsOutsideTheirCommand(subcommand, context);
    switch (subcommand) {
      case "adoption":
        return adoptionCommand(context);
      case "backtest":
        return backtestCommand(context);
      case "current":
        return current(context);
      case "redundancy":
        return redundancyCommand(context);
      case "simulate":
        return simulateCommand(context);
      case "trend":
        return trendCommand(context);
      case "turnover":
        return turnoverCommand(context);
    }
  },
};

function rejectOptionsOutsideTheirCommand(sub: Subcommand, context: CommandContext): void {
  const only: Record<string, Subcommand[]> = {
    by: ["current"],
    at: ["adoption", "backtest"],
    points: ["trend"],
    successors: ["adoption"],
    "min-authors": ["redundancy"],
    "min-share": ["redundancy"],
    rank: ["current", "simulate"],
    mode: ["simulate"],
    k: ["simulate"],
    trials: ["backtest", "simulate", "trend"],
    horizon: ["adoption", "backtest", "simulate", "trend"],
    seed: ["backtest", "simulate", "trend"],
    top: ["backtest", "simulate"],
  };
  for (const [option, owners] of Object.entries(only)) {
    if (context.values[option] !== undefined && !owners.includes(sub)) throw usageError(`--${option} belongs to abandonment ${owners.join(", ")}`);
  }
}

async function current(context: CommandContext): Promise<CommandOutput> {
  const by = readBy(context);
  const p = await prepare(context);
  const { model } = p.knowledge;
  const files = measureCurrent(model, p.settings.abandonmentGuideline);
  const unattributed = model.files.reduce((sum, f) => sum + f.unattributed, 0);

  const rank = readRank(context, p.settings);
  const weights = by === "file" ? await hotspotWeights(context, p.history) : new Map();
  const noSuccessor = noSuccessorCheck(p.history, model);
  const rows =
    by === "file"
      ? files
          // The guideline does not remove a file: a file with any lines held by people who have left is listed, and `abandoned` marks those at it.
          .filter((f) => f.abandonedLines > 0)
          .map((f) => ({
            path: f.path,
            abandoned: f.abandoned,
            // Ranked by the hotspot percentile weighting the abandoned share, or by the lines lost under --rank abandonment.
            score: rank === "hotspot" ? rankScore(rank, f.abandonedShare, weights.get(f.path)) : f.abandonedLines,
            hotspot: weights.get(f.path)?.hot ?? false,
            hotspotPercentile: round4(weights.get(f.path)?.percentile ?? 0),
            findings: fileFindings({ abandoned: f.abandoned, probability: f.abandoned ? 1 : 0, hot: weights.get(f.path)?.hot ?? false, noSuccessor: () => noSuccessor(f.path) }, p.settings.atRiskProbability),
            abandonedShare: f.abandonedShare,
            abandonedLines: f.abandonedLines,
            peopleLines: f.peopleLines,
            activeAuthors: f.activeAuthors,
            formerAuthors: f.formerAuthors,
            nonPersonLines: f.nonPersonLines,
          }))
      : // Every component with a measured file is listed. Components with no abandoned lines have score 0 and sort last.
        groupByComponent(files, readComponents(context.config.effective.components)).map((g) => ({ ...g, score: g.abandonedShare }));

  return {
    inputs: commonInputs(p, "current", { by, rank }),
    extra: commonExtra(p, { summary: summariseCurrent(files, unattributed) }),
    results: rows,
    // Only the file view omits rows by a value: files with no lines held by people who have left. Say how many.
    notices: [
      ...p.notices,
      ...(by === "file" ? [`Omitted ${files.length - rows.length} of ${files.length} measured files that have no lines held by people who have left`] : []),
    ],
    columns:
      by === "file"
        ? ["path", "abandoned", "abandonedShare", "abandonedLines", "peopleLines", "activeAuthors", "formerAuthors", "nonPersonLines", "hotspot", "findings"]
        : ["path", "files", "abandonedFiles", "abandonedShare", "abandonedLines", "peopleLines"],
  };
}
