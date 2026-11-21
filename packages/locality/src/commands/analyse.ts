import { usageError } from "@code-health/cli-kit/errors";
import type { Command, CommandOutput, Rule } from "@code-health/cli-kit/run-cli";
import { compareIds } from "@code-health/graph/graph";
import { listTree } from "@code-health/history/tree";
import { compileGlobs } from "@code-health/history/glob";
import { analyseProject } from "../candidates.ts";
import type { Candidate } from "../candidates.ts";
import { readSettings, type LocalitySettings } from "../config.ts";
import { buildModel, type Model } from "../model.ts";
import { readHistory, type History } from "../history-evidence.ts";
import { analyseByHistory, historyRuleDescriptions, type HistoryCandidate, type HistoryOnlyResult } from "../history-only.ts";
import { loadProject } from "../project.ts";
import { writeReport } from "../reports.ts";
import { ruleDescriptions } from "../rules.ts";

export const name = "analyse";

export const rules: Record<string, Rule> = { ...ruleDescriptions, ...historyRuleDescriptions };

const sources = ["structural", "history", "both"];

const recommendations = ["inline", "move", "split", "blocked", "keep", "scrutinise", "review"];

export const command: Command = {
  summary: "Rank the code that lives far from its consumers, with a default remedy for each unit",
  usage: "[<path>...]",
  options: { recommendation: { type: "string" }, source: { type: "string" } },
  optionHelp: {
    recommendation: "only units with this recommendation: inline, move, split, blocked, keep, scrutinise or review",
    source: "where candidates come from: structural (default), history or both",
  },
  async run(context): Promise<CommandOutput> {
    const settings = readSettings(context.config);
    const wanted = context.values.recommendation;
    if (wanted !== undefined && (typeof wanted !== "string" || !recommendations.includes(wanted))) {
      throw usageError(`--recommendation must be one of ${recommendations.join(", ")}`);
    }
    const source = context.values.source ?? "structural";
    if (typeof source !== "string" || !sources.includes(source)) {
      throw usageError(`--source must be one of ${sources.join(", ")}`);
    }
    const prefixes = context.positionals.map((path) => path.replace(/\/+$/, ""));

    const history = settings.useHistory ? await readHistory(context, settings) : undefined;
    if (source === "history") return historyOnly(context.repo.root, history, settings, prefixes, wanted);

    const project = await loadProject(context.repo.root, "HEAD", settings);
    const model = buildModel(project, settings, history);
    const analysis = analyseProject(project, model, settings, history);

    const partial = prefixes.length > 0 || wanted !== undefined || source !== "structural";
    const rows = analysis.candidates.filter(
      (candidate) =>
        (wanted === undefined || candidate.recommendation === wanted) &&
        (prefixes.length === 0 || prefixes.some((prefix) => candidate.path === prefix || candidate.path.startsWith(`${prefix}/`))),
    );

    const unresolved: Record<string, number> = {};
    for (const entry of project.analysis.unresolved) unresolved[entry.reason] = (unresolved[entry.reason] ?? 0) + 1;

    const output: CommandOutput = {
      inputs: {
        entrySource: model.entrySource,
        entries: [...model.entries].sort(compareIds),
        paths: prefixes,
        recommendation: wanted ?? null,
        source,
      },
      extra: {
        summary: analysis.summary,
        metrics: analysis.metrics,
        unreachable: model.unreachable,
        barrels: project.analysis.barrels,
        unresolved,
        history: history === undefined ? null : { window: history.window, ...history.evidence },
        filesWithSyntaxErrors: project.analysis.filesWithSyntaxErrors,
        // Only languages with a preprocessor have any, so the key is absent for the rest.
        ...(project.analysis.filesWithMacroCode.length === 0 ? {} : { filesWithMacroCode: project.analysis.filesWithMacroCode }),
        ...(source === "both" ? await crossCheck(context.repo.root, history, settings, model, analysis.candidates) : {}),
      },
      results: rows,
      columns: ["path", "score", "recommendation", "rule", "location", "target", "gain", "fanIn"],
    };
    if (!partial) await writeReport(context, name, output);
    return output;
  },
};

const historyColumns = ["path", "score", "recommendation", "rule", "location", "target", "gain", "fanIn"];

async function historyResult(root: string, history: History | undefined, settings: LocalitySettings): Promise<HistoryOnlyResult> {
  if (history === undefined) {
    return {
      candidates: [],
      omitted: { "earned-distance": 0, "fixed-point": 0, "near-partners": 0, superseded: 0 },
      reason: "history is not available (disabled by locality.useHistory, a shallow clone, or no commits)",
    };
  }
  const excluded = compileGlobs(settings.exclude);
  const files = new Set((await listTree(root, "HEAD")).filter((path) => !excluded(path)));
  return analyseByHistory(history, files, settings);
}

async function historyOnly(root: string, history: History | undefined, settings: LocalitySettings, prefixes: string[], wanted: unknown): Promise<CommandOutput> {
  const result = await historyResult(root, history, settings);
  const rows = result.candidates.filter(
    (candidate) =>
      (wanted === undefined || candidate.recommendation === wanted) &&
      (prefixes.length === 0 || prefixes.some((prefix) => candidate.path === prefix || candidate.path.startsWith(`${prefix}/`))),
  );
  return {
    inputs: { source: "history", paths: prefixes, recommendation: wanted ?? null },
    extra: {
      historyOnly: { omitted: result.omitted, reason: result.reason },
      history: history === undefined ? null : { window: history.window, ...history.evidence },
    },
    results: rows,
    columns: historyColumns,
  };
}

/**
 * Where the import graph and the history disagree: a unit the graph places well (no structural move worth
 * making) whose co-change partners are all elsewhere and none of which it imports or is imported by.
 */
async function crossCheck(root: string, history: History | undefined, settings: LocalitySettings, model: Model, structural: Candidate[]): Promise<Record<string, unknown>> {
  const result = await historyResult(root, history, settings);
  const moving = new Set(structural.filter((candidate) => candidate.gain >= settings.minDistance).flatMap((candidate) => candidate.unit.files));
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => neighbours.set(a, (neighbours.get(a) ?? new Set()).add(b));
  for (const edge of model.edges) {
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }
  const hidden = result.candidates.filter(
    (candidate: HistoryCandidate) =>
      !candidate.unit.files.some((file) => moving.has(file)) &&
      !candidate.consumers.some((partner) => candidate.unit.files.some((file) => neighbours.get(file)?.has(partner.path))),
  );
  return { hiddenCoupling: hidden, historyOnly: { omitted: result.omitted, reason: result.reason } };
}
