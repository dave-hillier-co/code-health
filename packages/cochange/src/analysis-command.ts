import type { OptionSpec } from "@code-health/cli-kit/args";
import type { Command, CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { skipReport } from "@code-health/history/reports";
import { noCacheHelp, noCacheOption, readCached, storeCached, wantsNoCache } from "@code-health/history/results-cache";
import { analysedSha, derivedResult, type Derived } from "./derived-results.ts";
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
  /** The subcommands the command dispatches to, so `--help` can describe each with only its own options (see `Command.subcommands`). */
  subcommands?: Command["subcommands"];
  /** Options only hidden subcommands take, left out of the command's own `--help` listing (see `Command.hiddenOptions`). */
  hiddenOptions?: Command["hiddenOptions"];
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
   * Keeps the complete result in the results cache, so a later run for the same commit, config and stated inputs
   * prints it without reading history (see `Derived`). `--no-cache` computes and stores anew. Such a command
   * stores every variant of its stated inputs, a date window included, not only the default run.
   */
  cache?: Derived;
  /**
   * Answers the run from results other commands stored, before any history is read. Returns undefined when
   * they do not cover this run, and is not tried with `--no-cache`.
   */
  fromCache?(context: CommandContext, window: ExplicitWindow | undefined): Promise<CommandOutput | undefined>;
  /**
   * Computes the complete result. Return every row: the kit applies `--limit`
   * and `--fields` when printing, and the report stores the whole list. Add
   * anything else a result depends on to `inputs`, and command specific
   * sections (such as `complexitySource`) to `extra`.
   */
  analyse(input: AnalysisInput): CommandOutput | Promise<CommandOutput>;
}

/** What every analysis adds around the command's `analyse`: identity stamps, window, filters and evidence. */
export function finishAnalysis(history: LoadedHistory, output: CommandOutput): CommandOutput {
  return {
    ...output,
    inputs: { ...output.inputs, ...identityStamps(history) },
    extra: { ...historySections(history), ...output.extra },
  };
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
    options: { ...(ownsWindow(spec) ? {} : windowOptions), ...spec.options, ...sharedOptions, ...(spec.cache || spec.fromCache ? noCacheOption : {}) },
    optionHelp: spec.cache || spec.fromCache ? { "no-cache": noCacheHelp } : undefined,
    ...(spec.subcommands === undefined ? {} : { subcommands: spec.subcommands }),
    ...(spec.hiddenOptions === undefined ? {} : { hiddenOptions: spec.hiddenOptions }),
    async run(context) {
      const window = ownsWindow(spec) ? spec.window?.(context) : statedWindow(context, readSettings(context.config).windowMonths);
      const reuse = !wantsNoCache(context);
      if (reuse && spec.fromCache) {
        const answered = await spec.fromCache(context, window);
        if (answered !== undefined) return answered;
      }
      const analysedRef = await spec.ref?.(context);
      const stored = spec.cache ? derivedResult(context, spec.cache, await analysedSha(context, analysedRef), window) : undefined;
      if (stored !== undefined && reuse) {
        const hit = readCached(context, stored);
        if (hit !== undefined) return hit;
      }
      const history = await loadHistory(context, {
        noRefresh: context.values["no-refresh"] === true,
        window,
        wholeHistory: spec.wholeHistory,
        ref: analysedRef,
      });
      const output = await spec.analyse({ context, history });
      const finished = finishAnalysis(history, output);
      if (stored !== undefined) {
        if (context.values["no-refresh"] === true) skipReport(context, "the run read the history cache without refreshing it");
        else if (stored.head !== history.view.headSha) skipReport(context, "the analysed commit is not the one the ref named");
        else await storeCached(context, stored, finished);
        return finished;
      }
      const wholeRepository = window === undefined && !spec.partial?.(context);
      if (wholeRepository) await writeReport(context, name, finished, history.view.headSha);
      else skipReport(context, window !== undefined ? "the run was limited to a date window" : "the run chose a view other than the default");
      return finished;
    },
  };
}
