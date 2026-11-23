import { builtinOmissions } from "@code-health/cli-kit/builtin-excludes";
import { droppedCounts } from "@code-health/cli-kit/dropped-files";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import type { ReportKind } from "@code-health/cli-kit/report-command";
import { folderDistance, folderOf } from "@code-health/graph/tree-distance";
import { historyWindowText } from "@code-health/history/report-header";
import { treeFromRef } from "@code-health/parse/source-tree";
import type { Block } from "@code-health/report/block";
import type { Cell } from "@code-health/report/components/ranked-table";
import type { ExcludedCount, Slot } from "@code-health/report/protocol";
import type { ReportBuild, Section } from "@code-health/report/report-model";
import type { Candidate } from "../candidates.ts";
import { command as analyseCommand } from "../commands/analyse.ts";
import { readSettings, type LocalitySettings } from "../config.ts";
import { planMove, type Refusal } from "../move-plan.ts";

/** Rows of the candidate table, and how many of them get a move plan and a judgement. */
const TOP = 15;
const PLANNED = 10;
const VERDICTS = ["do-it", "do-it-differently", "leave"];
const KINDS = ["move", "split", "inline", "scrutinise", "review"];
const DISTANCE_BINS = 5;

interface AnalyseExtra {
  summary: { files: number; units: number; placed: number; byRecommendation: Record<string, number> };
  unresolved: Record<string, number>;
  history: { grade: string; usableHistoryMonths: number; window: { months: number; since: number; until: number } } | null;
}

interface HistoryExtra {
  historyOnly: { omitted: Record<string, number>; reason: string | null };
}

/** What a dry run of the move found, for one candidate. Nothing is written. */
interface PlanSummary {
  destination: string;
  filesMoved: number;
  rewrites: number;
  filesRewritten: number;
  refusals: string[];
  failure: string | null;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const byText = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);

/** The files that use a unit: the ones that call it and the ones that otherwise refer to it. */
function consumersOf(candidate: Candidate): string[] {
  return [...new Set([...candidate.directCalls, ...candidate.otherRefs].map((entry) => entry.path))].sort();
}

const consumerFolders = (candidate: Candidate) => new Set(consumersOf(candidate).map(folderOf));
const confidenceOf = (candidate: Candidate) => (candidate.confidence === undefined ? "normal" : `low: ${candidate.confidence.reason}`);

/** One entry per refusal code: how many there were, and the detail of the first. */
function groupRefusals(refusals: Refusal[]): string[] {
  const groups = new Map<string, Refusal[]>();
  for (const refusal of refusals) groups.set(refusal.code, [...(groups.get(refusal.code) ?? []), refusal]);
  return [...groups].map(([code, list]) => `${code}${list.length > 1 ? ` x${list.length}` : ""} (${list[0]!.detail})`);
}

/** A dry run of the move the analyser proposes, as `locality move` plans it without `--apply`. */
async function dryRun(context: CommandContext, candidate: Candidate, settings: LocalitySettings, files: Set<string>): Promise<PlanSummary> {
  const plan = planMove(candidate, settings, files, {});
  const base = { destination: plan.destination, filesMoved: plan.operations.length, refusals: groupRefusals(plan.refusals) };
  if (plan.refusals.length > 0) return { ...base, rewrites: 0, filesRewritten: 0, failure: null };
  try {
    const { performMove } = await import("../move-engine.ts");
    const tree = await treeFromRef(context.repo.root, "HEAD");
    const moved = await performMove(tree, plan.operations);
    return { ...base, rewrites: moved.rewrites.length, filesRewritten: new Set(moved.rewrites.map((r) => r.path)).size, failure: null };
  } catch (error) {
    return { ...base, rewrites: 0, filesRewritten: 0, failure: error instanceof Error ? error.message : String(error) };
  }
}

function planText(plan: PlanSummary): string {
  if (plan.refusals.length > 0) return `no plan: ${plan.refusals.join(", ")}`;
  if (plan.failure !== null) return `the dry run failed: ${plan.failure}`;
  return `${plural(plan.filesMoved, "file")} moved to ${plan.destination === "" ? "the repository root" : plan.destination}, ${plural(plan.rewrites, "import")} rewritten in ${plural(plan.filesRewritten, "file")}`;
}

function candidateTable(rows: Candidate[], total: number, settings: LocalitySettings): Block {
  return {
    type: "ranked-table",
    caption: "Candidates, ordered by gain over the locality.minDistance guideline",
    noun: "candidates",
    total,
    columns: [
      { key: "path", label: "Unit" },
      { key: "kind", label: "Kind" },
      { key: "gain", label: "Gain (net distance removed)", align: "right", guideline: { value: settings.minDistance, note: "locality.minDistance" } },
      { key: "ratio", label: "Gain over guideline", align: "right" },
      { key: "consumers", label: "Consumer files", align: "right" },
      { key: "folders", label: "Consumer folders", align: "right" },
      { key: "distance", label: "Distance", align: "right" },
      { key: "confidence", label: "Confidence" },
    ],
    rows: rows.map((c): Record<string, Cell> => ({
      path: c.path,
      kind: c.recommendation,
      gain: c.gain,
      ratio: c.ranking.ratio,
      consumers: consumersOf(c).length,
      folders: consumerFolders(c).size,
      distance: c.distance,
      confidence: confidenceOf(c),
    })),
  };
}

function candidateSection(rank: number, candidate: Candidate, plan: PlanSummary, settings: LocalitySettings): Section {
  const consumers = consumersOf(candidate);
  return {
    id: `candidate-${rank}`,
    heading: `${rank}. ${candidate.path}`,
    blocks: [
      {
        type: "facts",
        caption: `Candidate ${rank}: ${candidate.path}`,
        facts: [
          { label: "Kind", value: `${candidate.recommendation} (rule ${candidate.rule})` },
          { label: "Gain", value: `${candidate.gain} of net distance removed, against the locality.minDistance guideline of ${settings.minDistance}` },
          { label: "Net distance", value: `${candidate.netDistance.current} now, ${candidate.netDistance.atTarget} at the target ${candidate.target === "" ? "(the repository root)" : candidate.target}` },
          { label: "Consumers", value: `${plural(consumers.length, "file")} in ${plural(consumerFolders(candidate).size, "folder")}` },
          { label: "Size", value: `${plural(candidate.size.files, "file")}, ${plural(candidate.size.lines, "line")}` },
          { label: "Confidence", value: confidenceOf(candidate) },
          { label: "Blockers", value: candidate.blockers.length === 0 ? "none" : candidate.blockers.map((b) => b.path).join(", ") },
          { label: "Move plan (dry run)", value: planText(plan) },
        ],
      },
      { type: "judgement", slot: `candidate-${rank}` },
    ],
  };
}

function distanceHistogram(all: Candidate[]): Block {
  const bins = Array.from({ length: DISTANCE_BINS + 1 }, (_, i) => ({ label: i === DISTANCE_BINS ? `${DISTANCE_BINS} or more` : String(i), count: 0 }));
  for (const candidate of all) {
    for (const consumer of consumersOf(candidate)) bins[Math.min(DISTANCE_BINS, folderDistance(candidate.location, folderOf(consumer)))]!.count++;
  }
  return { type: "histogram", title: "Distance from each unit's folder to its consumers' folders, in folder hops", unit: "unit and consumer file pairs", bins };
}

const REASON_WORDS: Record<string, string> = {
  "earned-distance": "history candidates whose distance the co-change evidence does not earn",
  "fixed-point": "history candidates whose target is a fixed point",
  "near-partners": "history candidates whose gain is below the locality.minDistance guideline",
  superseded: "history candidates that a structural candidate already covers",
};

function omittedRows(structural: { placed: number; blocked: number; keep: number; notShown: number }, history: HistoryExtra["historyOnly"]): ExcludedCount[] {
  return [
    { what: "units already beside their consumers (rule near-consumers)", count: structural.placed },
    { what: "candidates recommended blocked, held back by a dependency", count: structural.blocked },
    { what: "candidates recommended keep", count: structural.keep },
    { what: `candidates past the top ${TOP} of the table`, count: structural.notShown },
    ...Object.entries(history.omitted).map(([reason, count]) => ({ what: REASON_WORDS[reason] ?? reason, count })),
  ];
}

function slotsFor(planned: Candidate[]): Slot[] {
  return [
    {
      id: "summary",
      title: "Judgement: what this report says",
      about: { kind: "report", ref: "locality", label: "the repository" },
      task: "In at most three sentences, say what the candidates have in common and where to start, using only values shown in this report. Do not add numbers the report does not show.",
      verdicts: [],
      maxChars: 500,
    },
    ...planned.map((candidate, index): Slot => ({
      id: `candidate-${index + 1}`,
      title: `Judgement: ${candidate.path}`,
      about: { kind: "unit", ref: candidate.path, label: candidate.path },
      task:
        `Say whether to make the proposed ${candidate.recommendation} of ${candidate.path}: do-it, do-it-differently or leave. Give the reason, then the risk as "Risk: ..." in the last sentence, using only the facts, blockers, confidence and dry-run plan shown for this candidate. Do not add numbers the report does not show. ` +
        "The plan is a dry run and the report never applies a move.",
      verdicts: VERDICTS,
      maxChars: 400,
    })),
    {
      id: "limits",
      title: "Judgement: what limits these results",
      about: { kind: "report", ref: "locality", label: "the repository" },
      task: "In at most three sentences, say what limits how far these results can be trusted for this repository, using only the unresolved imports, the omitted counts, the confidence column and the evidence grade shown above.",
      verdicts: [],
      maxChars: 500,
    },
  ];
}

export const localityReport: ReportKind = {
  summary: "Units far from where they are used: the top candidates with a dry-run move plan, consumer distances and what was left out",
  async build(context: CommandContext): Promise<ReportBuild> {
    const settings = readSettings(context.config);
    const output = await analyseCommand.run({ ...context, positionals: [], values: { source: "structural" } });
    const extra = output.extra as unknown as AnalyseExtra;
    const all = output.results as Candidate[];
    // The history-only pass is read for the counts it omits by reason; its candidates are not shown here.
    const historyOutput = await analyseCommand.run({ ...context, positionals: [], values: { source: "history" } });
    const historyOnly = (historyOutput.extra as unknown as HistoryExtra).historyOnly;

    const ofKind = all.filter((c) => KINDS.includes(c.recommendation));
    const shown = ofKind.slice(0, TOP);
    const planned = shown.slice(0, PLANNED);
    const files = new Set((await treeFromRef(context.repo.root, "HEAD")).files.keys());
    const plans: PlanSummary[] = [];
    for (const candidate of planned) plans.push(await dryRun(context, candidate, settings, files));

    const byKind = extra.summary.byRecommendation;
    const omitted = omittedRows({ placed: extra.summary.placed, blocked: byKind.blocked ?? 0, keep: byKind.keep ?? 0, notShown: ofKind.length - shown.length }, historyOnly);
    const unresolved = Object.entries(extra.unresolved).sort(byText);
    const excluded: ExcludedCount[] = [
      ...omitted,
      ...Object.entries(droppedCounts()).map(([kind, count]) => ({ what: `${kind} files left out of the analysis`, count: count ?? 0 })),
      ...Object.entries(builtinOmissions()).map(([entry, count]) => ({ what: `files under the built-in exclude ${entry}`, count })),
    ];

    const history = extra.history;
    const inputs = output.inputs as Record<string, unknown>;
    const sections: Section[] = [
      { id: "summary", heading: "Summary", blocks: [{ type: "judgement", slot: "summary" }] },
      {
        id: "candidates",
        heading: "Candidates",
        blocks: [
          {
            type: "facts",
            caption: "What the analysis covered",
            facts: [
              { label: "Files analysed", value: String(extra.summary.files) },
              { label: "Units", value: String(extra.summary.units) },
              { label: "Candidates of kind move, split, inline, scrutinise or review", value: String(ofKind.length) },
              ...Object.entries(byKind).sort(byText).map(([kind, count]) => ({ label: `Recommended ${kind}`, value: String(count) })),
            ],
          },
          ofKind.length === 0
            ? { type: "notice", level: "notice", text: "The analysis found no candidate of kind move, split, inline, scrutinise or review." }
            : candidateTable(shown, ofKind.length, settings),
        ],
      },
      ...planned.map((candidate, index) => candidateSection(index + 1, candidate, plans[index]!, settings)),
      { id: "distance", heading: "Consumer distance", blocks: [distanceHistogram(all)] },
      {
        id: "unresolved",
        heading: "Unresolved imports",
        blocks:
          unresolved.length === 0
            ? [{ type: "notice", level: "notice", text: "Every import the analysis read resolved, so no consumer is missing for that reason." }]
            : [
                {
                  type: "ranked-table",
                  caption: "Imports the analysis could not resolve, by reason",
                  numbered: false,
                  columns: [
                    { key: "reason", label: "Reason" },
                    { key: "count", label: "Imports", align: "right" },
                  ],
                  rows: unresolved.map(([reason, count]): Record<string, Cell> => ({ reason, count })),
                },
                { type: "notice", level: "limit", text: "A unit used through an unresolved import has a consumer the analysis cannot see, so its distance and gain are lower bounds." },
              ],
      },
      {
        id: "omitted",
        heading: "Omitted, by reason",
        blocks: [
          {
            type: "ranked-table",
            caption: "What the analysis and this report left out, by reason",
            numbered: false,
            columns: [
              { key: "what", label: "Left out" },
              { key: "count", label: "Count", align: "right" },
            ],
            rows: omitted.map((o): Record<string, Cell> => ({ what: o.what, count: o.count })),
          },
          ...(historyOnly.reason === null ? [] : [{ type: "notice" as const, level: "notice" as const, text: `The history counts are zero because ${historyOnly.reason}.` }]),
        ],
      },
    ];

    const lowConfidence = ofKind.filter((c) => c.confidence !== undefined).length;
    return {
      title: "Locality report",
      inputs: { source: "structural", entrySource: inputs.entrySource, entries: inputs.entries },
      header: {
        evidenceGrade: history === null ? "not available: no history was read" : history.grade,
        historyWindow:
          history === null
            ? "No history was read, so the candidates rest on the import graph alone."
            : historyWindowText(history, history.window),
        excluded: excluded.filter((e) => e.count > 0),
      },
      sections,
      limits: [
        "Guidelines order and label results. They are heuristics for investigation and decide nothing.",
        `The table shows the top ${TOP} candidates and says how many it leaves out; the move plans and judgements cover the top ${PLANNED}.`,
        "A move plan is a dry run of the proposed move. The report never applies one.",
        "Gain is the net distance a move removes, against the locality.minDistance guideline. It does not say the move is worth its churn.",
        ...(lowConfidence > 0 ? [`${plural(lowConfidence, "candidate")} rest on includes that found no file, so a consumer may be missing and the result is a lower bound.`] : []),
        ...(history === null ? ["No history was read, so co-change evidence is not used."] : history.grade === "weak" ? ["The evidence grade is weak, so history-based evidence is tentative and the structure leads."] : []),
      ],
      slots: slotsFor(planned),
    };
  },
};
