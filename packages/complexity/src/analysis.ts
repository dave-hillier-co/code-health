import { usageError } from "@code-health/cli-kit/errors";
import type { CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { writeReport } from "@code-health/history/reports";
import { ParseCache } from "@code-health/parse/parse-cache";
import { currentTree, type CurrentTree } from "./current-tree.ts";
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
