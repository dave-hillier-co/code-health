import { usageError } from "@code-health/cli-kit/errors";
import type { Command, CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { backtestCommand } from "../abandonment/backtest.ts";
import { groupByComponent, measureCurrent, round4, summariseCurrent } from "../abandonment/current.ts";
import { commonExtra, commonInputs, prepare } from "../abandonment/prepare.ts";
import { fileFindings, hotspotWeights, rankScore, rules as abandonmentRules } from "../abandonment/ranking.ts";
import { readRank } from "../abandonment/settings.ts";
import { simulationOptions } from "../abandonment/selection.ts";
import { simulateCommand, turnoverCommand } from "../abandonment/simulate-run.ts";
import { readComponents } from "../components.ts";
import { byOption, readBy } from "../units.ts";

export const name = "abandonment";

export const rules = abandonmentRules;

const SUBCOMMANDS = ["backtest", "current", "simulate", "turnover"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

/**
 * Knowledge lost when people leave. Every subcommand is behind the privacy gate
 * (`cochange.knowledge.enabled`), reports files and components with developers as
 * counts, and is never stored as a report for another plugin to read.
 */
export const command: Command = {
  summary: "Knowledge lost when people leave: files already abandoned, simulated turnover, and a backtest of the model",
  options: { ...byOption, ...simulationOptions, top: { type: "string" }, rank: { type: "string" }, at: { type: "string" }, "no-refresh": { type: "boolean" } },
  async run(context) {
    const [sub, ...rest] = context.positionals;
    if (!SUBCOMMANDS.includes(sub as Subcommand) || rest.length > 0) throw usageError(`usage: abandonment <${SUBCOMMANDS.join("|")}>`);
    const subcommand = sub as Subcommand;
    rejectOptionsOutsideTheirCommand(subcommand, context);
    switch (subcommand) {
      case "backtest":
        return backtestCommand(context);
      case "current":
        return current(context);
      case "simulate":
        return simulateCommand(context);
      case "turnover":
        return turnoverCommand(context);
    }
  },
};

function rejectOptionsOutsideTheirCommand(sub: Subcommand, context: CommandContext): void {
  const only: Record<string, Subcommand[]> = {
    by: ["current"],
    at: ["backtest"],
    rank: ["current", "simulate"],
    mode: ["simulate"],
    k: ["simulate"],
    trials: ["backtest", "simulate"],
    horizon: ["backtest", "simulate"],
    seed: ["backtest", "simulate"],
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
  const files = measureCurrent(model, p.settings.abandonmentThreshold);
  const unattributed = model.files.reduce((sum, f) => sum + f.unattributed, 0);

  const rank = readRank(context, p.settings);
  const weights = by === "file" ? await hotspotWeights(context, p.history) : new Map();
  const rows =
    by === "file"
      ? files
          .filter((f) => f.abandoned)
          .map((f) => ({
            path: f.path,
            // Ranked by the hotspot percentile weighting the abandoned share, or by the lines lost under --rank abandonment.
            score: rank === "hotspot" ? rankScore(rank, f.abandonedShare, weights.get(f.path)) : f.abandonedLines,
            hotspot: weights.get(f.path)?.hot ?? false,
            hotspotPercentile: round4(weights.get(f.path)?.percentile ?? 0),
            findings: fileFindings({ abandoned: true, probability: 1, hot: weights.get(f.path)?.hot ?? false, noSuccessor: false }, p.settings.atRiskProbability),
            abandonedShare: f.abandonedShare,
            abandonedLines: f.abandonedLines,
            peopleLines: f.peopleLines,
            activeAuthors: f.activeAuthors,
            formerAuthors: f.formerAuthors,
            nonPersonLines: f.nonPersonLines,
          }))
      : groupByComponent(files, readComponents(context.config.effective.components))
          .filter((g) => g.abandonedLines > 0)
          .map((g) => ({ ...g, score: g.abandonedShare }));

  return {
    inputs: commonInputs(p, "current", { by, rank }),
    extra: commonExtra(p, { summary: summariseCurrent(files, unattributed) }),
    results: rows,
    columns:
      by === "file"
        ? ["path", "abandonedShare", "abandonedLines", "peopleLines", "activeAuthors", "formerAuthors", "nonPersonLines", "hotspot", "findings"]
        : ["path", "files", "abandonedFiles", "abandonedShare", "abandonedLines", "peopleLines"],
  };
}
