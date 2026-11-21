import { usageError } from "@code-health/cli-kit/errors";
import type { Command, CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { groupByComponent, measureCurrent, summariseCurrent } from "../abandonment/current.ts";
import { commonExtra, commonInputs, prepare } from "../abandonment/prepare.ts";
import { simulationOptions } from "../abandonment/selection.ts";
import { simulateCommand, turnoverCommand } from "../abandonment/simulate-run.ts";
import { readComponents } from "../components.ts";
import { byOption, readBy } from "../units.ts";

export const name = "abandonment";

const SUBCOMMANDS = ["current", "simulate", "turnover"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

/**
 * Knowledge lost when people leave. Every subcommand is behind the privacy gate
 * (`cochange.knowledge.enabled`), reports files and components with developers as
 * counts, and is never stored as a report for another plugin to read.
 */
export const command: Command = {
  summary: "Knowledge lost when people leave: files already abandoned, simulated turnover, and a backtest of the model",
  options: { ...byOption, ...simulationOptions, top: { type: "string" }, "no-refresh": { type: "boolean" } },
  async run(context) {
    const [sub, ...rest] = context.positionals;
    if (!SUBCOMMANDS.includes(sub as Subcommand) || rest.length > 0) throw usageError(`usage: abandonment <${SUBCOMMANDS.join("|")}>`);
    const subcommand = sub as Subcommand;
    rejectOptionsOutsideTheirCommand(subcommand, context);
    switch (subcommand) {
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
    mode: ["simulate"],
    k: ["simulate"],
    trials: ["simulate"],
    horizon: ["simulate"],
    seed: ["simulate"],
    top: ["simulate"],
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

  const rows =
    by === "file"
      ? files
          .filter((f) => f.abandoned)
          .map((f) => ({
            path: f.path,
            score: f.abandonedLines,
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
    inputs: commonInputs(p, "current", { by }),
    extra: commonExtra(p, { summary: summariseCurrent(files, unattributed) }),
    results: rows,
    columns:
      by === "file"
        ? ["path", "abandonedShare", "abandonedLines", "peopleLines", "activeAuthors", "formerAuthors", "nonPersonLines"]
        : ["path", "files", "abandonedFiles", "abandonedShare", "abandonedLines", "peopleLines"],
  };
}
