import { relative } from "node:path";
import { usageError } from "@code-health/cli-kit/errors";
import type { Command, CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { roundFloat } from "@code-health/cli-kit/serialise";
import { compareIds } from "@code-health/graph/graph";
import { listTree } from "@code-health/history/tree";
import { summariseTasks, type EffortSource } from "@code-health/transcripts/measure-repo";
import type { EffortMode, TaskEffort } from "@code-health/transcripts/agent-effort";
import { analyseProject, SORT_METHOD } from "../candidates.ts";
import { baselineExists, baselinePath, footprintOf, readBaseline, writeBaseline, type Baseline, type BaselineCandidate } from "../baseline-store.ts";
import { chooseComparison } from "../comparison-group.ts";
import { readSettings, type LocalitySettings } from "../config.ts";
import { readHistory } from "../history-evidence.ts";
import { buildModel } from "../model.ts";
import { checkouts, defaultProjectsDirectory, readEffort, readHeat, stampOf, tasksTouching } from "../measure-effort.ts";
import { identitiesAt, isAncestor, readMeasureHistory } from "../measure-history.ts";
import { changesBetween, changesTouching, summariseSpread, type SpreadSummary } from "../measure-spread.ts";
import { addDays, dayOf, matchingWindow, windowEndingAt, windowLength, windowSeconds, type DayWindow } from "../measure-window.ts";
import { loadProject } from "../project.ts";
import { actionsSince, countSuiteCommits } from "../suite-commits.ts";
import { gamingCheck, type StructureMetrics } from "../structure-metrics.ts";
import { testPremise } from "../premise.ts";
import { claimOf, differenceOf, effortConclusion, type Arm } from "../verdict.ts";

export const name = "measure";

const DEFAULT_NAME = "default";
const DEFAULT_CANDIDATES = 200;
const HEAT_FILES = 50;
const TOOL_PLUGIN = "locality";

export const command: Command = {
  summary:
    "Record the baseline before a tidy-up (measure baseline), then compare against it afterwards (measure compare)",
  usage: "baseline | compare",
  hiddenOptions: ["until"],
  optionHelp: {
    name: "the name of the baseline to record or compare against (default: default)",
    "projects-dir": "the folder of Claude Code session transcripts read for agent effort (default: ~/.claude/projects)",
    candidates: "how many top candidates the baseline records (default 200)",
    since: "baseline and compare: start the after window on this date, YYYY-MM-DD (default: the day after the last suite commit)",
    source: "baseline: which tasks are read, main (main sessions), subagent (subagent transcripts) or all (default all); compare uses the baseline's",
    effort: "baseline: which calls count toward effort, tools (Read, Grep, Glob, Edit, Write and NotebookEdit calls only) or all (those and the files named in Bash commands) (default all); compare uses the baseline's",
    force: "replace a baseline of the same name",
  },
  options: {
    name: { type: "string" },
    "projects-dir": { type: "string" },
    candidates: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    source: { type: "string" },
    effort: { type: "string" },
    force: { type: "boolean" },
  },
  async run(context): Promise<CommandOutput> {
    const [subcommand] = context.positionals;
    if (subcommand !== "baseline" && subcommand !== "compare" && subcommand !== "premise") {
      throw usageError("measure takes one subcommand: baseline or compare");
    }
    const settings = readSettings(context.config);
    if (subcommand === "premise") return premise(context, settings);
    return subcommand === "baseline" ? baseline(context, settings) : compare(context, settings);
  },
};

function stringOption(context: CommandContext, option: string): string | undefined {
  const value = context.values[option];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") throw usageError(`--${option} needs a value`);
  return value;
}

function projectsDirectory(context: CommandContext): string {
  return stringOption(context, "projects-dir") ?? defaultProjectsDirectory();
}

const SOURCES: readonly EffortSource[] = ["main", "subagent", "all"];

function sourceOption(context: CommandContext): EffortSource | undefined {
  const value = stringOption(context, "source");
  if (value === undefined) return undefined;
  const source = SOURCES.find((candidate) => candidate === value);
  if (source === undefined) throw usageError("--source must be main, subagent or all");
  return source;
}

const EFFORT_MODES: readonly EffortMode[] = ["tools", "all"];

function effortOption(context: CommandContext): EffortMode | undefined {
  const value = stringOption(context, "effort");
  if (value === undefined) return undefined;
  const mode = EFFORT_MODES.find((candidate) => candidate === value);
  if (mode === undefined) throw usageError("--effort must be tools or all");
  return mode;
}

function measureName(context: CommandContext): string {
  return stringOption(context, "name") ?? DEFAULT_NAME;
}

const localPath = (context: CommandContext, name: string): string => relative(context.repo.root, baselinePath(context.repo.root, name)).split("\\").join("/");

async function baseline(context: CommandContext, settings: LocalitySettings): Promise<CommandOutput> {
  const { root } = context.repo;
  const name = measureName(context);
  const requested = stringOption(context, "candidates");
  if (requested !== undefined && !/^[1-9]\d*$/.test(requested)) throw usageError("--candidates must be a positive integer");
  const keep = requested === undefined ? DEFAULT_CANDIDATES : Number(requested);
  if (baselineExists(root, name) && context.values.force !== true) {
    throw usageError(
      `a baseline named "${name}" already exists and cannot be regenerated once code has moved: pass --force to replace it, or --name for another`,
    );
  }

  const analysis = await readMeasureHistory(root, settings);
  const { view } = analysis;
  const window = windowEndingAt(view.headDate, settings.windowMonths);
  const seconds = windowSeconds(window);
  const spread = summariseSpread(changesBetween(analysis.filtered.changes, seconds.since, seconds.until));

  const source = sourceOption(context) ?? "all";
  const mode = effortOption(context) ?? "all";
  const effort = readEffort(projectsDirectory(context), await checkouts(root), window, source, mode);

  const project = await loadProject(root, "HEAD", settings);
  const history = settings.useHistory ? await readHistory(context, settings) : undefined;
  const analysed = analyseProject(project, buildModel(project, settings, history), settings, history);
  const ranked = analysed.candidates;
  const candidates = ranked.slice(0, keep).map(
    (candidate, index): BaselineCandidate => ({
      rank: index + 1,
      path: candidate.path,
      score: candidate.score,
      ratio: candidate.ranking.ratio,
      recommendation: candidate.recommendation,
      rule: candidate.rule,
      files: [...candidate.unit.files].sort(compareIds),
      consumers: [...new Set([...candidate.directCalls, ...candidate.otherRefs].map((consumer) => consumer.path))].sort(compareIds),
    }),
  );

  const prior = countSuiteCommits(view, TOOL_PLUGIN);
  const record: Baseline = {
    schemaVersion: 1,
    tool: "locality",
    name,
    head: view.headSha,
    headDate: new Date(view.headDate * 1000).toISOString(),
    window,
    filters: { exclude: [...settings.exclude].sort(), suiteCommitsExcluded: true },
    evidence: {
      grade: analysis.evidence.grade,
      logicalChangesInWindow: analysis.evidence.logicalChangesInWindow,
      usableHistoryMonths: analysis.evidence.usableHistoryMonths,
      activeContributors: analysis.evidence.activeContributors,
      shallow: analysis.evidence.truncated.shallow,
    },
    spread,
    effort: { sessions: effort.sessions, source, mode, summary: effort.summary, tasks: effort.tasks, stamp: stampOf(effort.tasks) },
    readHeat: readHeat(effort.tasks, HEAT_FILES),
    structure: analysed.metrics,
    sortMethod: SORT_METHOD,
    candidates,
    candidateCount: ranked.length,
    priorSuiteCommits: prior,
  };
  writeBaseline(root, record);

  noticeShell(context, effort.summary.shell);
  return {
    inputs: { name, transcripts: { tasks: effort.tasks.length, stamp: record.effort.stamp } },
    extra: { evidence: record.evidence },
    results: {
      name,
      file: localPath(context, name),
      head: record.head,
      window,
      spread,
      structure: analysed.metrics,
      effort: {
        source,
        mode,
        sessions: { measured: effort.sessions.measured, notMeasured: effort.sessions.notMeasured.length, subagents: effort.sessions.subagents },
        ...effort.summary,
      },
      candidates: { recorded: candidates.length, ranked: ranked.length },
      priorSuiteCommits: prior,
    },
  };
}

interface Group {
  candidates: BaselineCandidate[];
  /** Files as the baseline named them. */
  baselineFiles: Set<string>;
  /** The same files by stable identity, which is their path today, and those of them that still exist. */
  identities: Set<string>;
  existing: Set<string>;
}

function describeArm(spread: SpreadSummary, tasks: readonly TaskEffort[]) {
  return { spread, effort: summariseTasks(tasks) };
}

const mean = (value: { mean: number } | null): number | null => (value === null ? null : value.mean);

/** Whether the history, read now, still gives the spread the baseline recorded over its window: false after a rewrite. */
function reproduced(now: SpreadSummary, recorded: SpreadSummary): boolean {
  const same = now.mean === null || recorded.mean === null ? now.mean === recorded.mean : roundFloat(now.mean) === roundFloat(recorded.mean);
  return now.measured === recorded.measured && now.changes === recorded.changes && same;
}

/** The structure of HEAD, measured as the baseline measured it. */
async function structureNow(context: CommandContext, settings: LocalitySettings): Promise<StructureMetrics> {
  const project = await loadProject(context.repo.root, "HEAD", settings);
  const history = settings.useHistory ? await readHistory(context, settings) : undefined;
  return analyseProject(project, buildModel(project, settings, history), settings, history).metrics;
}

const EFFORT_FIGURES = ["filesRead", "foldersVisited", "reReads", "tokens"] as const;

async function compare(context: CommandContext, settings: LocalitySettings): Promise<CommandOutput> {
  const { root } = context.repo;
  const name = measureName(context);
  const before = readBaseline(root, name);
  if (before.sortMethod !== SORT_METHOD) {
    throw usageError(
      `the baseline "${name}" ranked candidates by ${before.sortMethod ?? "an earlier method"} and this version ranks by ${SORT_METHOD}, so the ranks are not comparable: take a new baseline with --name`,
    );
  }
  const analysis = await readMeasureHistory(root, settings);
  const { view } = analysis;
  if (!(await isAncestor(root, before.head, view.headSha))) {
    throw usageError(`the baseline's commit ${before.head.slice(0, 12)} is not an ancestor of HEAD: compare from a branch that contains it`);
  }

  const done = await actionsSince(root, view, before.head, TOOL_PLUGIN);
  const moved = new Set(done.actions.map((action) => action.from));
  const actedOn = before.candidates.filter((candidate) => candidate.files.some((file) => moved.has(file)));
  // Candidates whose files were moved or removed without the trailer are not attributed to the tool. Counted so the reader sees them.
  const movedByHand = new Set(done.untrailered.map((action) => action.from));
  const untrailered = before.candidates.filter((candidate) => !actedOn.includes(candidate) && candidate.files.some((file) => movedByHand.has(file))).length;
  const common = {
    inputs: { name, baseline: { head: before.head, stamp: before.effort.stamp } },
  };
  if (actedOn.length === 0) {
    return {
      ...common,
      results: {
        name,
        status: "nothing-acted-on",
        baseline: { head: before.head, window: before.window },
        suite: { commits: done.commits, actedOn: 0, untrailered },
      },
    };
  }

  const now = await structureNow(context, settings);
  const structure = { before: before.structure ?? null, after: now, gaming: gamingCheck(before.structure ?? null, now) };
  const comparison = chooseComparison(before.candidates, actedOn);
  const ends = addDays(dayOf(view.headDate), 1);
  const requested = stringOption(context, "since");
  if (requested !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(requested)) throw usageError("--since must be a date such as 2024-03-01");
  // The suite's own work is not an outcome: the after window starts the day after its last commit.
  const start = requested ?? addDays(dayOf(done.latest as number), 1);
  const after = matchingWindow(before.window, start, ends);

  const present = new Set(await listTree(root, view.headSha));
  const all = [...new Set([...actedOn, ...comparison.group].flatMap(footprintOf))];
  const identities = await identitiesAt(root, view, before.head, all);
  const group = (candidates: BaselineCandidate[]): Group => {
    const files = new Set(candidates.flatMap(footprintOf));
    const ids = new Set([...files].map((file) => identities.get(file) as string));
    return { candidates, baselineFiles: files, identities: ids, existing: new Set([...ids].filter((id) => present.has(id))) };
  };
  const acted = group(actedOn);
  const alone = group(comparison.group);

  const changes = analysis.filtered.changes;
  const windowChanges = (window: DayWindow) => {
    const { since, until } = windowSeconds(window);
    return changesBetween(changes, since, until);
  };
  const beforeChanges = windowChanges(before.window);
  const afterChanges = windowChanges(after);
  const recomputed = summariseSpread(beforeChanges);

  // The after window is read the way the baseline was, which is main sessions only for a baseline from before subagents were read.
  const recordedSource = before.effort.source ?? "main";
  const requestedSource = sourceOption(context);
  if (requestedSource !== undefined && requestedSource !== recordedSource) {
    throw usageError(`the baseline "${name}" read ${recordedSource} tasks, so the comparison reads them too: drop --source or take a new baseline with --name`);
  }
  // Likewise for what counts as effort: a baseline from before shell commands were read counted tool calls only.
  const recordedMode = before.effort.mode ?? "tools";
  const requestedMode = effortOption(context);
  if (requestedMode !== undefined && requestedMode !== recordedMode) {
    throw usageError(`the baseline "${name}" counted ${recordedMode} for effort, so the comparison counts the same: drop --effort or take a new baseline with --name`);
  }
  const afterEffort = readEffort(projectsDirectory(context), await checkouts(root), after, recordedSource, recordedMode);
  const arms = (g: Group) => ({
    before: describeArm(summariseSpread(changesTouching(beforeChanges, g.identities)), tasksTouching(before.effort.tasks, g.baselineFiles)),
    after: describeArm(summariseSpread(changesTouching(afterChanges, g.identities)), tasksTouching(afterEffort.tasks, g.existing)),
  });
  const actedArms = arms(acted);
  const aloneArms = arms(alone);

  const spreadArm = (a: ReturnType<typeof arms>): Arm => ({
    before: { mean: a.before.spread.mean, n: a.before.spread.measured },
    after: { mean: a.after.spread.mean, n: a.after.spread.measured },
  });
  const effortArm = (a: ReturnType<typeof arms>, figure: (typeof EFFORT_FIGURES)[number]): Arm => ({
    before: { mean: mean(a.before.effort[figure]), n: a.before.effort.tasks },
    after: { mean: mean(a.after.effort[figure]), n: a.after.effort.tasks },
  });
  const { minSamples, noise } = { minSamples: settings.measureMinSamples, noise: settings.measureNoisePercent };
  const spreadDifference = differenceOf(spreadArm(actedArms), spreadArm(aloneArms), minSamples, noise);
  const effortDifferences = Object.fromEntries(
    EFFORT_FIGURES.map((figure) => [figure, differenceOf(effortArm(actedArms, figure), effortArm(aloneArms, figure), minSamples, noise)]),
  );
  const effort = effortConclusion(EFFORT_FIGURES.map((figure) => effortDifferences[figure]!.conclusion));

  return {
    ...common,
    inputs: {
      ...common.inputs,
      transcripts: { tasksAfter: afterEffort.tasks.length, stamp: stampOf(afterEffort.tasks) },
      since: requested ?? null,
    },
    results: {
      name,
      status: "compared",
      baseline: { head: before.head, window: before.window, spread: before.spread, effort: before.effort.summary },
      spreadReproduced: reproduced(recomputed, before.spread),
      structure,
      after: { ...after, days: windowLength(after), matchingDays: windowLength(before.window) },
      suite: { commits: done.commits, actedOn: actedOn.length, untrailered, comparison: comparison.group.length, overlapping: comparison.overlapping },
      pairs: comparison.pairs,
      actedOn: { candidates: actedOn.map((candidate) => candidate.path), ...actedArms },
      comparison: { candidates: comparison.group.map((candidate) => candidate.path), ...aloneArms },
      spread: { role: "outcome, partly by construction", ...spreadDifference },
      effort: { role: "primary outcome", conclusion: effort, ...effortDifferences },
      claim: claimOf(effort, spreadDifference.conclusion),
    },
  };
}

/** Prints, on stderr, the summary line of how much of the shell was read: Bash calls in the tasks, those not parsed, and the parsed share. Prints nothing when the tasks made no Bash call. */
function noticeShell(context: CommandContext, shell: { calls: number; unparsed: number; parsedShare: number | null }): void {
  if (shell.parsedShare === null) return;
  (context.stderrNotices ??= []).push(`Shell: ${shell.calls} Bash calls in these tasks, ${shell.unparsed} not parsed, parsed share ${(shell.parsedShare * 100).toFixed(1)}%.`);
}

const PREMISE_LIMITS = [
  "Observational: tasks were not assigned to near or far files, so what the task was is a confounder the data cannot remove.",
  "Distance is that of the files a task edited, from the Edit, Write and NotebookEdit tools and, with --effort all, from the files named in Bash commands. Tasks editing a single file have none and are left out.",
  "Effort is read from the transcripts of main sessions and of subagents. With --effort all, files named in the commands of Bash calls count as reads and edits, but only for the calls that were parsed (shell.parsedShare is their share): scripts that edit files by computed paths, reads made inside test runs and builds, and unparsed commands are not seen, so every figure is a lower bound. With --effort tools, no Bash call counts.",
  "A subagent task is given to it by an orchestrator, which writes its prompt and sets its scope, so the kind of task is a stronger confounder for subagent tasks than for main-session tasks. A subagent starts with none of the context the main session had, and that alone can raise its reads.",
  "A main-session task that delegated work to a subagent is counted without that work, and the subagent's work is a task of its own, so the two halves of one piece of work are measured apart.",
  "A correlation here is not a measure of what a move would save.",
];

const PREMISE_VERDICTS = {
  supported: "tasks touching more distant files cost more, beyond what the number of files edited explains",
  "partly-supported": "one cost figure rises with distance beyond what the number of files edited explains, and the others show nothing",
  contradicted: "tasks touching more distant files cost less",
  mixed: "the cost figures disagree",
  "not-shown": "no relationship between distance and cost was shown. That is not evidence there is none",
  "not-measured": "distance did not vary across the tasks, or cost did not, so nothing could be tested. That is not a finding of no relationship",
  "insufficient-sample": "too few tasks to conclude anything",
} as const;

/** Reads `--since` and `--until` as days, `until` excluded, defaulting to the window of months ending at HEAD. */
function premiseWindow(context: CommandContext, settings: LocalitySettings, headDate: number): DayWindow {
  const day = (option: string): string | undefined => {
    const value = stringOption(context, option);
    if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw usageError(`--${option} must be a date such as 2024-03-01`);
    return value;
  };
  const fallback = windowEndingAt(headDate, settings.windowMonths);
  const window = { from: day("since") ?? fallback.from, to: day("until") ?? fallback.to };
  if (window.from >= window.to) throw usageError("--since must be before --until");
  return window;
}

/**
 * The suite's build-order premise check: from existing history and session transcripts, whether tasks whose edited
 * files are further apart cost more reads and tokens. It runs before any mover has changed anything, and it says
 * how many tasks it rests on and stops short of what that sample can show.
 */
async function premise(context: CommandContext, settings: LocalitySettings): Promise<CommandOutput> {
  const analysis = await readMeasureHistory(context.repo.root, settings);
  const { view } = analysis;
  const window = premiseWindow(context, settings, view.headDate);
  const seconds = windowSeconds(window);
  const spread = summariseSpread(changesBetween(analysis.filtered.changes, seconds.since, seconds.until));

  const source = sourceOption(context) ?? "all";
  const mode = effortOption(context) ?? "all";
  const effort = readEffort(projectsDirectory(context), await checkouts(context.repo.root), window, source, mode);
  const result = testPremise(effort.tasks, settings.measureMinSamples);
  const bySource = Object.fromEntries(
    (["main", "subagent"] as const)
      .filter((each) => source === "all" || source === each)
      .map((each) => [each, testPremise(effort.tasks.filter((task) => task.source === each), settings.measureMinSamples)]),
  );

  noticeShell(context, result.shell);
  return {
    inputs: {
      transcripts: { tasks: effort.tasks.length, stamp: stampOf(effort.tasks) },
      since: stringOption(context, "since") ?? null,
      until: stringOption(context, "until") ?? null,
    },
    extra: {
      evidence: {
        grade: analysis.evidence.grade,
        logicalChangesInWindow: analysis.evidence.logicalChangesInWindow,
        usableHistoryMonths: analysis.evidence.usableHistoryMonths,
        activeContributors: analysis.evidence.activeContributors,
        shallow: analysis.evidence.truncated.shallow,
      },
    },
    results: {
      status: "premise",
      window,
      source,
      effort: mode,
      sessions: { measured: effort.sessions.measured, notMeasured: effort.sessions.notMeasured.length, subagents: effort.sessions.subagents },
      minSamples: settings.measureMinSamples,
      history: { spread },
      ...result,
      bySource,
      meaning: PREMISE_VERDICTS[result.verdict],
      limits: PREMISE_LIMITS,
    },
  };
}
