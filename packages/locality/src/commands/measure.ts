import { relative } from "node:path";
import { usageError } from "@code-health/cli-kit/errors";
import type { Command, CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { roundFloat } from "@code-health/cli-kit/serialise";
import { compareIds } from "@code-health/graph/graph";
import { listTree } from "@code-health/history/tree";
import { summariseTasks } from "@code-health/transcripts/measure-repo";
import type { TaskEffort } from "@code-health/transcripts/agent-effort";
import { analyseProject } from "../candidates.ts";
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
import { claimOf, differenceOf, effortConclusion, type Arm } from "../verdict.ts";

export const name = "measure";

const DEFAULT_NAME = "default";
const DEFAULT_CANDIDATES = 200;
const HEAT_FILES = 50;
const TOOL_PLUGIN = "locality";

export const command: Command = {
  summary: "Record the baseline before a tidy-up (measure baseline), then compare against it afterwards (measure compare)",
  options: {
    name: { type: "string" },
    "projects-dir": { type: "string" },
    candidates: { type: "string" },
    since: { type: "string" },
    force: { type: "boolean" },
  },
  async run(context): Promise<CommandOutput> {
    const [subcommand] = context.positionals;
    if (subcommand !== "baseline" && subcommand !== "compare") throw usageError("measure takes one subcommand: baseline or compare");
    const settings = readSettings(context.config);
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

  const effort = readEffort(projectsDirectory(context), await checkouts(root), window);

  const project = await loadProject(root, "HEAD", settings);
  const history = settings.useHistory ? await readHistory(context, settings) : undefined;
  const analysed = analyseProject(project, buildModel(project, settings, history), settings, history);
  const ranked = analysed.candidates;
  const candidates = ranked.slice(0, keep).map(
    (candidate, index): BaselineCandidate => ({
      rank: index + 1,
      path: candidate.path,
      score: candidate.score,
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
    effort: { sessions: effort.sessions, summary: effort.summary, tasks: effort.tasks, stamp: stampOf(effort.tasks) },
    readHeat: readHeat(effort.tasks, HEAT_FILES),
    structure: analysed.metrics,
    candidates,
    candidateCount: ranked.length,
    priorSuiteCommits: prior,
  };
  writeBaseline(root, record);

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
      effort: { sessions: { measured: effort.sessions.measured, notMeasured: effort.sessions.notMeasured.length }, ...effort.summary },
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
  const analysis = await readMeasureHistory(root, settings);
  const { view } = analysis;
  if (!(await isAncestor(root, before.head, view.headSha))) {
    throw usageError(`the baseline's commit ${before.head.slice(0, 12)} is not an ancestor of HEAD: compare from a branch that contains it`);
  }

  const done = await actionsSince(root, view, before.head, TOOL_PLUGIN);
  const moved = new Set(done.actions.map((action) => action.from));
  const actedOn = before.candidates.filter((candidate) => candidate.files.some((file) => moved.has(file)));
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
        suite: { commits: done.commits, actedOn: 0 },
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

  const afterEffort = readEffort(projectsDirectory(context), await checkouts(root), after);
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
      suite: { commits: done.commits, actedOn: actedOn.length, comparison: comparison.group.length, overlapping: comparison.overlapping },
      pairs: comparison.pairs,
      actedOn: { candidates: actedOn.map((candidate) => candidate.path), ...actedArms },
      comparison: { candidates: comparison.group.map((candidate) => candidate.path), ...aloneArms },
      spread: { role: "outcome, partly by construction", ...spreadDifference },
      effort: { role: "primary outcome", conclusion: effort, ...effortDifferences },
      claim: claimOf(effort, spreadDifference.conclusion),
    },
  };
}
