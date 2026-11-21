import { usageError } from "@code-health/cli-kit/errors";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { integerOption } from "../coupled-pairs.ts";
import type { Turnover } from "./activity.ts";
import type { Selection } from "./simulate.ts";
import type { KnowledgeSettings } from "./settings.ts";

export const MODES = ["rate", "historical", "k-leavers"] as const;
export type Mode = (typeof MODES)[number];

export interface SimulationSettings {
  mode: Mode;
  k: number | null;
  trials: number;
  horizonPeriods: number;
  seed: number;
}

/** The simulation options of the command line, over the configured defaults. */
export function readSimulationSettings(context: CommandContext, settings: KnowledgeSettings): SimulationSettings {
  const mode = context.values.mode ?? "rate";
  if (typeof mode !== "string" || !MODES.includes(mode as Mode)) throw usageError(`--mode must be one of ${MODES.join(", ")}, not "${String(mode)}"`);
  if (context.values.k !== undefined && mode !== "k-leavers") throw usageError("--k belongs to --mode k-leavers");
  return {
    mode: mode as Mode,
    k: context.values.k === undefined ? null : integerOption(context, "k", 1, 1, 1_000_000),
    trials: integerOption(context, "trials", settings.trials, 1, 10_000_000),
    horizonPeriods: integerOption(context, "horizon", settings.horizonPeriods, 1, 1_000),
    seed: integerOption(context, "seed", settings.seed, 0, 0xffffffff),
  };
}

export const simulationOptions = {
  mode: { type: "string" },
  k: { type: "string" },
  trials: { type: "string" },
  horizon: { type: "string" },
  seed: { type: "string" },
} as const;

/**
 * How leavers are chosen in one run. The per-period rate is the configured one when there is one,
 * otherwise the pooled rate observed in history. Historical mode samples the observed periods and
 * so cannot be given a rate.
 */
export function chooseSelection(sim: SimulationSettings, settings: KnowledgeSettings, turnover: Turnover): { selection: Selection; source: string } {
  if (sim.mode === "k-leavers") {
    if (sim.k === null) throw usageError("--mode k-leavers needs --k N");
    return { selection: { mode: "k-leavers", k: sim.k }, source: "k-leavers" };
  }
  if (sim.mode === "historical") {
    if (turnover.periods.length === 0) throw usageError("historical mode needs at least one period of observed turnover, and the history is too short for one; use --mode rate with cochange.knowledge.turnoverRate");
    return { selection: { mode: "historical", rates: turnover.periods.map((p) => p.rate), periods: sim.horizonPeriods }, source: "history" };
  }
  const rate = settings.turnoverRate ?? turnover.rate;
  if (rate === null) {
    throw usageError("the history is too short to estimate turnover; set cochange.knowledge.turnoverRate, or use --mode k-leavers");
  }
  return { selection: { mode: "rate", rate, periods: sim.horizonPeriods }, source: settings.turnoverRate === null ? "history" : "configured" };
}
