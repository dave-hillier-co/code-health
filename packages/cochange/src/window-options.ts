import type { OptionSpec } from "@code-health/cli-kit/args";
import { usageError } from "@code-health/cli-kit/errors";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { monthsBefore } from "@code-health/history/evidence";
import { parseDate } from "./spread-measure.ts";

/** A window the command's own options state, in unix seconds of committer date. `since` is inclusive. */
export interface ExplicitWindow {
  since?: number;
  until?: number;
}

/** The options every history command takes, so a shallow clone's error has a way out that is not deepening the clone. */
export const windowOptions = { since: { type: "string" }, until: { type: "string" } } satisfies OptionSpec;

function dateOption(context: CommandContext, option: "since" | "until"): number | undefined {
  const value = context.values[option];
  if (value === undefined) return undefined;
  const parsed = typeof value === "string" ? parseDate(value) : null;
  if (parsed === null) {
    throw usageError(`--${option} must be an ISO 8601 date such as 2024-03-01, not "${String(value)}"`);
  }
  return parsed;
}

/**
 * The window the options state, or undefined when neither is given. `--since` is inclusive and `--until`
 * exclusive. A bare `--until` looks back `windowMonths` from that date.
 */
export function statedWindow(context: CommandContext, windowMonths: number): ExplicitWindow | undefined {
  const since = dateOption(context, "since");
  const until = dateOption(context, "until");
  if (since === undefined && until === undefined) return undefined;
  const effectiveSince = since ?? monthsBefore(until!, windowMonths);
  if (until !== undefined && effectiveSince >= until) throw usageError("--since must be before --until");
  return { since: effectiveSince, until };
}
