import { usageError } from "@code-health/cli-kit/errors";
import type { CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { skipReport, writeReport } from "@code-health/history/reports";
import { cachedOutput, noCacheHelp, noCacheOption } from "@code-health/history/results-cache";
import { ParseCache } from "@code-health/parse/parse-cache";
import { currentTree, hasUncommittedWork, type CurrentTree } from "./current-tree.ts";
import { readSettings, type ComplexitySettings } from "./config.ts";
import { measureTree, type Layer, type Measurement } from "./measure.ts";
import { isMetricId, metricIds, type MetricId } from "./metrics.ts";
import { SCHEMA_VERSION, TOOL } from "./tool.ts";

export const layerOption = { layer: { type: "string" } } as const;
export const metricsOption = { metrics: { type: "string" } } as const;

export function parseLayer(value: unknown): Layer {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "lexical" || value === "structural") return value;
  throw usageError(`--layer must be auto, lexical or structural, got "${String(value)}"`);
}

/** The metrics named by `--metrics`, in the tool's order, or the configured ones. */
export function parseMetrics(value: unknown, settings: ComplexitySettings): MetricId[] {
  if (value === undefined) return settings.metrics;
  const names = String(value).split(",").map((name) => name.trim());
  const unknown = names.filter((name) => !isMetricId(name));
  if (unknown.length > 0) throw usageError(`unknown metric ${unknown.join(", ")}; metrics: ${metricIds.join(", ")}`);
  return metricIds.filter((metric) => names.includes(metric));
}

export interface Measured {
  settings: ComplexitySettings;
  current: CurrentTree;
  measurement: Measurement;
}

/** Measures the current code with the parse cache, which is shared with every other plugin and worktree. */
export async function measureCurrent(context: CommandContext, layer: Layer): Promise<Measured> {
  const settings = readSettings(context.config);
  const current = await currentTree(context);
  const cache = await ParseCache.forRepository(context.repo.root);
  const measurement = await measureTree(current.tree, { settings, layer, cache });
  return { settings, current, measurement };
}

/** Stores a whole-repository result as `reports/complexity.<command>.json` when the tree is clean. */
export function storeReport(context: CommandContext, command: string, output: CommandOutput): Promise<boolean> {
  return writeReport(context, { tool: TOOL, schemaVersion: SCHEMA_VERSION }, command, output, context.repo.head);
}

export { noCacheOption, noCacheHelp };

/**
 * Prints the result stored for this commit, config and stated inputs, or computes it and stores it as
 * `reports/complexity.<command>[.<variant>].json`: the default run keeps the plain name other plugins read. A result
 * describes the commit only on a clean tree, so a run with uncommitted work measures the files on disk and stores
 * nothing; the parse cache, which keys by file content, still spares it the files that did not change.
 * `stated` holds the command's own inputs that change the full result, as the run states them, and `cacheable`
 * is false for a run whose result also depends on something the commit and config do not name.
 */
export async function cachedAnalysis(
  context: CommandContext,
  command: string,
  stated: Record<string, unknown>,
  compute: () => Promise<CommandOutput>,
  cacheable = true,
): Promise<CommandOutput> {
  if (!cacheable) return cachedOutput(context, undefined, compute, (run) => skipReport(run, "the run read the history of earlier revisions"));
  const uncommitted = await hasUncommittedWork(context);
  const stored = uncommitted ? undefined : { identity: { tool: TOOL, schemaVersion: SCHEMA_VERSION }, command, head: context.repo.head, stated };
  return cachedOutput(context, stored, compute, (run) => skipReport(run, "the run did not analyse HEAD"));
}
