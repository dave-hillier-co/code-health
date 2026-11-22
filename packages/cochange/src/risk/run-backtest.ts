import { usageError } from "@code-health/cli-kit/errors";
import type { CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import type { LoadedHistory } from "../history-access.ts";
import { writeReport } from "../reports.ts";
import { parseDate } from "../spread-measure.ts";
import { measureContext } from "./assess.ts";
import { adoptionOf } from "./adoption.ts";
import { outcomesOf, scoreMainline, summarise } from "./backtest.ts";
import { mergedChanges } from "./merged-changes.ts";
import { readRiskSettings } from "./settings.ts";
import { BACKTEST_REPORT } from "./stored-backtest.ts";

/** What a backtest leaves out, and why. Printed with every result so nobody reads more into it than it holds. */
export const BACKTEST_LIMITS: readonly string[] = [
  "History layer only: complexity-delta, structure-delta and abandoned-touched would need a parse of every past change, so they are left out of the bands and the level.",
  "Placement is by change-familiarity and neighbourhood from history alone, not from blame, which is not affordable at every past commit.",
  "Pure moves are filtered from history, so mixed-purpose sees only moves that also edit the file.",
  "Hotspots are ranked by change frequency, because complexity cannot be measured at every past commit.",
  "A change counts as followed by trouble when it was reverted or a fix touched its files within the follow-up window. The file-level test over-counts in busy files, so each rate is shown beside the rate of the same files.",
  "Results are per factor band and per level, never per person.",
];

/**
 * `risk backtest`: every merged change on the main line, scored as of itself, against whether it was
 * later reverted or fixed. A whole run on a clean tree is stored, and `risk` shows a level only when the
 * stored result says the levels separate past changes.
 */
export async function runBacktest(context: CommandContext, history: LoadedHistory): Promise<CommandOutput> {
  const risk = readRiskSettings(context.config);
  const sinceText = context.values.since;
  if (sinceText !== undefined && typeof sinceText !== "string") throw usageError("--since needs a date");
  const since = sinceText === undefined ? undefined : parseDate(sinceText);
  if (sinceText !== undefined && since === null) throw usageError(`--since must be YYYY-MM-DD or an ISO 8601 date-time with a zone, got "${sinceText}"`);

  const adoptedText = context.values.adopted;
  if (adoptedText !== undefined && typeof adoptedText !== "string") throw usageError("--adopted needs a date");
  const adopted = adoptedText === undefined ? undefined : parseDate(adoptedText);
  if (adoptedText !== undefined && adopted === null) throw usageError(`--adopted must be YYYY-MM-DD or an ISO 8601 date-time with a zone, got "${adoptedText}"`);

  const root = context.repo.root;
  const measure = measureContext(context, history, risk);
  const mainline = await mergedChanges(root, history.view, history.filtered.changes, history.view.headSha);
  const scored = scoreMainline(mainline.changes, measure, {
    windowMonths: history.settings.windowMonths,
    maxChangesetSize: history.settings.maxChangesetSize,
    since: since ?? undefined,
  });
  const outcomes = await outcomesOf(root, history.view.headSha, mainline.changes, risk, history.view.headDate);
  const summary = summarise(scored, mainline.changes, outcomes, risk);

  const output: CommandOutput = {
    inputs: {
      since: since === undefined || since === null ? null : new Date(since * 1000).toISOString(),
      ...(adopted === undefined || adopted === null ? {} : { adopted: new Date(adopted * 1000).toISOString() }),
      followUpDays: risk.followUpDays,
      baselineChanges: risk.baselineChanges,
      fixPatterns: risk.fix.settings.fixPatterns,
      fixExcludePatterns: risk.fix.settings.fixExcludePatterns,
      revertPatterns: risk.fix.settings.revertPatterns,
      fixMatchBody: risk.fix.settings.fixMatchBody,
      mergeStyle: { merges: mainline.merges, direct: mainline.direct },
    },
    results: {
      kind: "backtest",
      ...summary,
      ...(adopted === undefined || adopted === null ? {} : { adoption: adoptionOf(mainline.changes, outcomes, adopted, risk, history.view.headDate) }),
      limits: [...BACKTEST_LIMITS],
      stored: false,
    },
  };

  // Only a run over the whole history is the repository's answer. A window is printed and not kept.
  if (since === undefined && adopted === undefined && history.view.ref === "HEAD") {
    const stored = await writeReport(context, BACKTEST_REPORT, output, history.view.headSha);
    (output.results as { stored: boolean }).stored = stored;
  }
  return output;
}
