import type { OptionSpec } from "@code-health/cli-kit/args";
import type { Command, CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { loadHistory, type ExplicitWindow, type LoadedHistory } from "./history-access.ts";
import { writeReport } from "./reports.ts";
import { readSettings } from "./config.ts";
import { statedWindow, windowOptions } from "./window-options.ts";

export interface AnalysisInput {
  context: CommandContext;
  history: LoadedHistory;
}

export interface AnalysisSpec {
  summary: string;
  /** The command's own options. `no-refresh` is added for every analysis command. */
  options?: OptionSpec;
  /**
   * A window stated by the command's own options (for example `--since`). It
   * counts as a stated window for the shallow-clone guard, and a run that
   * states one is not stored as a report.
   */
  window?(context: CommandContext): ExplicitWindow | undefined;
  /** The ref to analyse instead of the configured one, for a command about a branch other than the checked out one. */
  ref?(context: CommandContext): string | undefined | Promise<string | undefined>;
  /** Read all usable history rather than the analysis window (see `HistoryOptions.wholeHistory`). */
  wholeHistory?: boolean;
  /**
   * True when this run covers less than the whole repository: path arguments,
   * a `--file` filter, a `--by` view that is not the default. Partial runs
   * are printed but never stored as a report.
   */
  partial?(context: CommandContext): boolean;
  /**
   * Computes the complete result. Return every row: the kit applies `--limit`
   * and `--fields` when printing, and the report stores the whole list. Add
   * anything else a result depends on to `inputs`, and command specific
   * sections (such as `complexitySource`) to `extra`.
   */
  analyse(input: AnalysisInput): CommandOutput | Promise<CommandOutput>;
}

/** The `window`, `filtersApplied` and `evidence` sections every command that reads history adds to its output. */
export function historySections(history: LoadedHistory): Record<string, unknown> {
  return {
    window: {
      since: new Date(history.window.since * 1000).toISOString(),
      until: new Date(history.window.until * 1000).toISOString(),
    },
    filtersApplied: history.filtersApplied,
    evidence: history.evidence,
  };
}

/** The `identityInputs` entry of a command's `inputs`, present when identity decisions or a local mailmap shaped the results. */
export function identityStamps(history: LoadedHistory): Record<string, unknown> {
  return Object.keys(history.identities.stamps).length > 0 ? { identityInputs: history.identities.stamps } : {};
}

const sharedOptions = { "no-refresh": { type: "boolean" } } satisfies OptionSpec;

/**
 * Whether the command states its window itself, or reads all of history so that a window means nothing to it.
 * Every other command takes `--since` and `--until`, which is how a shallow clone is given the window it needs.
 */
function ownsWindow(spec: AnalysisSpec): boolean {
  return spec.window !== undefined || spec.wholeHistory === true || spec.options?.since !== undefined || spec.options?.until !== undefined;
}

/**
 * Builds a command that reads history. It does the plumbing every analysis
 * command needs, so the command itself is only its computation:
 *
 * - refreshes the history cache first unless `--no-refresh` is given,
 * - refuses a shallow clone without a stated window,
 * - reads the history for the analysis window (or the one `--since` and `--until` state) and applies the noise filters,
 * - adds `window`, `filtersApplied` and `evidence` to the output,
 * - stores the full result as a report on a clean tree, for whole-repository runs
 *   that analyse HEAD itself.
 */
export function analysisCommand(name: string, spec: AnalysisSpec): Command {
  return {
    summary: spec.summary,
    options: { ...(ownsWindow(spec) ? {} : windowOptions), ...spec.options, ...sharedOptions },
    async run(context) {
      const window = ownsWindow(spec) ? spec.window?.(context) : statedWindow(context, readSettings(context.config).windowMonths);
      const history = await loadHistory(context, {
        noRefresh: context.values["no-refresh"] === true,
        window,
        wholeHistory: spec.wholeHistory,
        ref: await spec.ref?.(context),
      });
      const output = await spec.analyse({ context, history });
      const finished: CommandOutput = {
        ...output,
        inputs: { ...output.inputs, ...identityStamps(history) },
        extra: { ...historySections(history), ...output.extra },
      };
      const wholeRepository = window === undefined && !spec.partial?.(context);
      if (wholeRepository) await writeReport(context, name, finished, history.view.headSha);
      else skipReport(context, window !== undefined ? "the run was limited to a date window" : "the run chose a view other than the default");
      return finished;
    },
  };
}
