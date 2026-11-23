import { posix } from "node:path";
import { builtinOmissions } from "@code-health/cli-kit/builtin-excludes";
import { droppedCounts } from "@code-health/cli-kit/dropped-files";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import type { ReportKind } from "@code-health/cli-kit/report-command";
import { folderDistance, folderOf } from "@code-health/graph/tree-distance";
import { FILE_KINDS, FILES_READ, historyWindowText, READ_BY_COMMANDS } from "@code-health/history/report-header";
import { dropEmptySlots } from "@code-health/report/empty-block";
import { capRows } from "@code-health/report/table-cap";
import { clip } from "@code-health/report/text";
import { treeFromRef } from "@code-health/parse/source-tree";
import type { Block } from "@code-health/report/block";
import type { Cell } from "@code-health/report/components/ranked-table";
import type { ExcludedCount, Slot } from "@code-health/report/protocol";
import type { ReportBuild, Section } from "@code-health/report/report-model";
import type { Candidate, OmittedUnit } from "../candidates.ts";
import { command as analyseCommand } from "../commands/analyse.ts";
import { readSettings, type LocalitySettings } from "../config.ts";
import { planMove, type Refusal } from "../move-plan.ts";
import type { GoPackages } from "../placement.ts";
import { goPackagesOf, loadProject } from "../project.ts";

/** Rows of the candidate table, and how many of them get a move plan and a judgement. */
const TOP = 15;
const PLANNED = 10;
/** Rows of the review and split table and of the scrutinise table. */
const TOP_REVIEW = 10;
const TOP_SCRUTINISE = 10;
const VERDICTS = ["do-it", "do-it-differently", "leave"];
const KINDS = ["move", "split", "inline", "scrutinise", "review"];
const DISTANCE_BINS = 5;
/** Rows of the omitted units table, of the blocked units table, and blockers named per unit. */
const TOP_OMITTED = 10;
const TOP_BLOCKED = 10;
const BLOCKERS_PER_UNIT = 3;
const REFUSAL_DETAIL_CHARS = 120;
const WARNINGS_SHOWN = 3;
const WARNING_CHARS = 160;
const OMITTED_DETAIL_CHARS = 200;

interface AnalyseExtra {
  summary: { files: number; units: number; placed: number; omitted: Record<string, number>; byRecommendation: Record<string, number> };
  omitted: OmittedUnit[];
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
  refusal: string | null;
  failure: string | null;
  /** What the mover could not rewrite, one line each. */
  warnings: string[];
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const byText = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);

/** The files that use a unit: the ones that call it and the ones that otherwise refer to it. */
function consumersOf(candidate: Candidate): string[] {
  return [...new Set([...candidate.directCalls, ...candidate.otherRefs].map((entry) => entry.path))].sort();
}

const consumerFolders = (candidate: Candidate) => new Set(consumersOf(candidate).map(folderOf));
const ROOT_TEXT = "the repository root (/)";
const folderText = (folder: string) => (folder === "" ? ROOT_TEXT : folder);
const confidenceOf = (candidate: Candidate) => (candidate.confidence === undefined ? "normal" : `low: ${candidate.confidence.reason}`);

/** One literal line: the refusal codes with their counts, then the detail of the first refusal, cut to one short sentence. */
function refusalLine(refusals: Refusal[]): string {
  const counts = new Map<string, number>();
  for (const refusal of refusals) counts.set(refusal.code, (counts.get(refusal.code) ?? 0) + 1);
  const codes = [...counts].map(([code, n]) => (n > 1 ? `${code} x${n}` : code)).join(", ");
  return `${codes}; first: ${clip(refusals[0]!.detail, REFUSAL_DETAIL_CHARS)}`;
}

/** A dry run of the move the analyser proposes, as `locality move` plans it without `--apply`. */
async function dryRun(context: CommandContext, candidate: Candidate, settings: LocalitySettings, files: Set<string>, go: GoPackages): Promise<PlanSummary> {
  const plan = planMove(candidate, settings, files, {}, go);
  const base = { destination: plan.destination, filesMoved: plan.operations.length, refusal: plan.refusals.length === 0 ? null : refusalLine(plan.refusals) };
  if (plan.refusals.length > 0) return { ...base, rewrites: 0, filesRewritten: 0, failure: null, warnings: [] };
  try {
    const { performMove } = await import("../move-engine.ts");
    const tree = await treeFromRef(context.repo.root, "HEAD");
    const moved = await performMove(tree, plan.operations);
    if ((moved.breaks ?? []).length > 0) {
      return { ...base, refusal: refusalLine((moved.breaks ?? []).map((detail) => ({ code: "does-not-compile", detail }))), rewrites: 0, filesRewritten: 0, failure: null, warnings: [] };
    }
    return { ...base, rewrites: moved.rewrites.length, filesRewritten: new Set(moved.rewrites.map((r) => r.path)).size, failure: null, warnings: moved.warnings };
  } catch (error) {
    return { ...base, rewrites: 0, filesRewritten: 0, failure: error instanceof Error ? error.message : String(error), warnings: [] };
  }
}

function planText(plan: PlanSummary): string {
  if (plan.refusal !== null) return `no plan: ${plan.refusal}`;
  if (plan.failure !== null) return `the dry run failed: ${plan.failure}`;
  const moved = `${plural(plan.filesMoved, "file")} moved to ${folderText(plan.destination)}, ${plural(plan.rewrites, "import")} rewritten in ${plural(plan.filesRewritten, "file")}`;
  if (plan.warnings.length === 0) return moved;
  const shown = plan.warnings.slice(0, WARNINGS_SHOWN).map((warning) => clip(warning, WARNING_CHARS));
  const rest = plan.warnings.length > shown.length ? `; and ${plan.warnings.length - shown.length} more` : "";
  return `${moved}; ${plural(plan.warnings.length, "warning")} from the mover: ${shown.join("; ")}${rest}`;
}

const gainColumns = (settings: LocalitySettings) => [
  { key: "path", label: "Unit" },
  { key: "kind", label: "Kind" },
  { key: "target", label: "Target" },
  { key: "gain", label: "Gain (net distance removed)", align: "right" as const, guideline: { value: settings.minDistance, note: "locality.minDistance" } },
  { key: "ratio", label: `Gain ÷ guideline (${settings.minDistance})`, align: "right" as const },
  { key: "files", label: "Unit files", align: "right" as const },
  { key: "consumers", label: "Consumer files", align: "right" as const },
  { key: "folders", label: "Consumer folders", align: "right" as const },
  { key: "distance", label: "Distance", align: "right" as const },
  { key: "confidence", label: "Confidence" },
];

/**
 * For Go moves, at most one move per target folder that holds no Go file: a folder holds one package, so moves into it from different
 * packages cannot all be made as listed. The move with the highest gain stays (the first of equals, in the analysis order) and the rest are returned as left out.
 */
function oneMovePerEmptyFolder(moves: readonly Candidate[], files: ReadonlySet<string>): { kept: Candidate[]; left: Candidate[] } {
  const goFolders = new Set([...files].filter((file) => file.endsWith(".go")).map((file) => posix.dirname(file)));
  const best = new Map<string, Candidate>();
  for (const move of moves) {
    if (!move.unit.files.every((file) => file.endsWith(".go")) || goFolders.has(move.target === "" ? "." : move.target)) continue;
    const held = best.get(move.target);
    if (held === undefined || move.gain > held.gain) best.set(move.target, move);
  }
  const left = moves.filter((move) => {
    const held = best.get(move.target);
    return held !== undefined && held !== move && move.unit.files.every((file) => file.endsWith(".go"));
  });
  return { kept: moves.filter((move) => !left.includes(move)), left };
}

const gainRow = (c: Candidate): Record<string, Cell> => ({
  path: c.path,
  kind: c.recommendation,
  target: folderText(c.target),
  gain: c.gain,
  ratio: c.ranking.ratio,
  files: c.size.files,
  consumers: consumersOf(c).length,
  folders: consumerFolders(c).size,
  distance: c.distance,
  confidence: confidenceOf(c),
});

/** Units the planner can plan without a reason: kind move, ordered by gain over the locality.minDistance guideline. */
function moveTable(rows: Candidate[], settings: LocalitySettings): Block {
  return {
    type: "ranked-table",
    ...capRows(
      {
        caption: "Moves the planner can plan without --reason (kind move), ordered by gain over the locality.minDistance guideline",
        noun: "moves",
        emptyText: "No candidate has kind move, so no unit can be planned without --reason.",
        columns: gainColumns(settings),
        rows: rows.map(gainRow),
      },
      TOP,
      "locality analyse --recommendation move",
    ),
  };
}

/** Units whose move or split needs a reason or a decision first: kind review, split or inline. */
function reviewTable(rows: Candidate[], settings: LocalitySettings): Block {
  return {
    type: "ranked-table",
    ...capRows(
      {
        caption: "Reviews, splits and inlines (the planner needs --reason for these), ordered by gain over the locality.minDistance guideline",
        noun: "candidates",
        emptyText: "No candidate has kind review, split or inline.",
        columns: gainColumns(settings),
        rows: rows.map(gainRow),
      },
      TOP_REVIEW,
      "locality analyse --recommendation review",
    ),
  };
}

/** Units already in their target folder whose consumers are many: location is earned, so the design is what to read. */
function scrutiniseTable(rows: Candidate[], settings: LocalitySettings): Block {
  return {
    type: "ranked-table",
    ...capRows(
      {
        caption: "High fan-in units (kind scrutinise): consumer files are above the locality.highFanIn guideline, so no move is proposed. Ordered by consumer files. Consumer files are the distinct production files that use the unit; test files are not counted",
        noun: "units",
        emptyText: "No unit has kind scrutinise.",
        columns: [
          { key: "path", label: "Unit" },
          { key: "fanIn", label: "Consumer files", align: "right", guideline: { value: settings.highFanIn, note: "locality.highFanIn" } },
          { key: "ratio", label: `Consumer files ÷ guideline (${settings.highFanIn})`, align: "right" },
          { key: "folders", label: "Consumer folders", align: "right" },
          { key: "confidence", label: "Confidence" },
        ],
        rows: rows.map((c): Record<string, Cell> => ({
          path: c.path,
          fanIn: c.fanIn,
          ratio: c.guidelines.fanIn.ratio,
          folders: consumerFolders(c).size,
          confidence: confidenceOf(c),
        })),
      },
      TOP_SCRUTINISE,
      "locality analyse --recommendation scrutinise",
    ),
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
          { label: "Reason", value: candidate.reason },
          { label: "Gain", value: `${candidate.gain} of net distance removed, against the locality.minDistance guideline of ${settings.minDistance}` },
          { label: "Net distance", value: `${candidate.netDistance.current} now, ${candidate.netDistance.atTarget} at the target ${folderText(candidate.target)}` },
          { label: "Consumers", value: `${plural(consumers.length, "file")} in ${plural(consumerFolders(candidate).size, "folder")}` },
          { label: "Size", value: `${plural(candidate.size.files, "file")}, ${plural(candidate.size.lines, "line")}` },
          ...(candidate.unusableTarget === undefined
            ? []
            : [{ label: "Better folder refused", value: `${folderText(candidate.unusableTarget.target)}, with gain ${candidate.unusableTarget.gain}, is refused: ${candidate.unusableTarget.reason}` }]),
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

/** The units with no proposed move and the units that are recommended blocked or keep, counted by reason. */
function omittedRows(structural: { placed: number; blocked: number; keep: number; notShown: number; sharedFolder: number; heldMoves: number; byReason: Record<string, number> }, history: HistoryExtra["historyOnly"]): ExcludedCount[] {
  return [
    { what: "units already beside their consumers (rule near-consumers)", count: structural.placed },
    ...Object.entries(structural.byReason).sort(byText).map(([reason, count]) => ({ what: `units with no proposed move: ${reason}`, count })),
    { what: "units recommended blocked, held back by a dependency (listed below with their blockers)", count: structural.blocked },
    { what: "units of kind move that have blockers (listed in the blocked table, not as moves)", count: structural.heldMoves },
    { what: "units of kind move left out of the moves table: another proposed move lands in the same empty folder", count: structural.sharedFolder },
    { what: "units recommended keep, with nothing to move", count: structural.keep },
    { what: `candidates past the rows of the three candidate tables`, count: structural.notShown },
    ...Object.entries(history.omitted).map(([reason, count]) => ({ what: REASON_WORDS[reason] ?? reason, count })),
  ];
}

function omittedUnitsTable(units: OmittedUnit[]): Block {
  const sorted = [...units].sort((a, b) => b.gain - a.gain || (a.path < b.path ? -1 : 1));
  return {
    type: "ranked-table",
    ...capRows(
    {
      caption: "Units with no proposed move, by gain of the folder their neighbours pull them towards",
      noun: "units",
      emptyText: "No unit was left without a proposed move.",
      columns: [
        { key: "path", label: "Unit" },
        { key: "reason", label: "Reason" },
        { key: "detail", label: "Detail" },
        { key: "target", label: "Pulled towards" },
        { key: "gain", label: "Gain", align: "right" },
        { key: "files", label: "Files", align: "right" },
      ],
      rows: sorted.map((u): Record<string, Cell> => ({ path: u.path, reason: u.reason, detail: clip(u.detail, OMITTED_DETAIL_CHARS), target: u.target === folderOf(u.path) ? "stays: no other folder lowers its distance" : folderText(u.target), gain: u.gain, files: u.files })),
    },
    TOP_OMITTED,
    "locality analyse --json",
  ) };
}

function blockedTable(units: Candidate[]): Block {
  const sorted = [...units].sort((a, b) => b.unblockedGain - a.unblockedGain || (a.path < b.path ? -1 : 1));
  return {
    type: "ranked-table",
    ...capRows(
    {
      caption:
        "Units held back by blockers, by the gain if the blockers were resolved: units recommended blocked, and units of kind move that still have blockers (a blocker is a file the unit depends on that stays behind and lowers the gain)",
      noun: "units",
      emptyText: "No unit is held back by blockers.",
      columns: [
        { key: "path", label: "Unit" },
        { key: "kind", label: "Kind" },
        { key: "gain", label: "Gain now (net distance removed)", align: "right" },
        { key: "unblocked", label: "Gain if the blockers were resolved (net distance removed)", align: "right" },
        { key: "blockers", label: "Blockers" },
      ],
      rows: sorted.map((c): Record<string, Cell> => ({
        path: c.path,
        kind: c.recommendation,
        gain: c.gain,
        unblocked: c.unblockedGain,
        blockers: nameList(c.blockers.map((b) => b.path), BLOCKERS_PER_UNIT),
      })),
    },
    TOP_BLOCKED,
    "locality analyse --recommendation blocked",
  ) };
}

/** Names with the rest counted: `a, b, c and 4 more`. */
function nameList(names: readonly string[], shown: number): string {
  if (names.length === 0) return "none";
  if (names.length <= shown) return names.join(", ");
  return `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
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
    // A unit with blockers is held back, so it is listed in the blocked table and not as a move the planner can plan.
    const unblockedMoves = ofKind.filter((c) => c.recommendation === "move" && c.blockers.length === 0);
    const heldMoves = ofKind.filter((c) => c.recommendation === "move" && c.blockers.length > 0);
    const files = new Set((await treeFromRef(context.repo.root, "HEAD")).files.keys());
    const { kept: moves, left: sharedFolder } = oneMovePerEmptyFolder(unblockedMoves, files);
    const reviews = ofKind.filter((c) => c.recommendation === "review" || c.recommendation === "split" || c.recommendation === "inline");
    const scrutinise = ofKind
      .filter((c) => c.recommendation === "scrutinise")
      .sort((a, b) => b.fanIn - a.fanIn || (a.path < b.path ? -1 : 1));
    // Moves are planned first, then reviews and splits; a scrutinise unit has nothing to move and is not planned.
    const planned = [...moves, ...reviews].slice(0, PLANNED);
    const shownCount = Math.min(moves.length, TOP) + Math.min(reviews.length, TOP_REVIEW) + Math.min(scrutinise.length, TOP_SCRUTINISE);
    const go = goPackagesOf(await loadProject(context.repo.root, "HEAD", settings));
    const plans: PlanSummary[] = [];
    for (const candidate of planned) plans.push(await dryRun(context, candidate, settings, files, go));

    const byKind = extra.summary.byRecommendation;
    const blocked = [...all.filter((c) => c.recommendation === "blocked"), ...heldMoves];
    const omitted = omittedRows({ placed: extra.summary.placed, blocked: byKind.blocked ?? 0, keep: byKind.keep ?? 0, notShown: ofKind.length - shownCount - heldMoves.length - sharedFolder.length, sharedFolder: sharedFolder.length, heldMoves: heldMoves.length, byReason: extra.summary.omitted }, historyOnly);
    const unresolved = Object.entries(extra.unresolved).sort(byText);
    const excluded: ExcludedCount[] = [
      ...omitted,
      ...Object.entries(droppedCounts()).map(([kind, count]) => ({ what: `${FILE_KINDS[kind] ?? kind} left out of the analysis${READ_BY_COMMANDS.has(kind) ? FILES_READ : ""}`, count: count ?? 0 })),
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
            : moveTable(moves, settings),
          ...(ofKind.length === 0 ? [] : [reviewTable(reviews, settings), scrutiniseTable(scrutinise, settings)]),
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
            emptyText: "Nothing was left out.",
            rows: omitted.filter((o) => o.count > 0).map((o): Record<string, Cell> => ({ what: o.what, count: o.count })),
          },
          omittedUnitsTable(extra.omitted),
          blockedTable(blocked),
          ...(historyOnly.reason === null ? [] : [{ type: "notice" as const, level: "notice" as const, text: `The history counts are zero because ${historyOnly.reason}.` }]),
        ],
      },
    ];

    const lowConfidence = ofKind.filter((c) => c.confidence !== undefined).length;
    return dropEmptySlots({
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
        `Three tables list candidates by kind: moves (top ${TOP}), reviews, splits and inlines (top ${TOP_REVIEW}) and scrutinise (top ${TOP_SCRUTINISE}). Each says how many rows it leaves out. Move plans and judgements cover the first ${PLANNED} of the moves, then the reviews and splits. A unit of kind blocked, and a unit of kind move that has blockers, is listed only in the blocked table.`,
        "A move plan is a dry run of the proposed move. The report never applies one.",
        "Gain is the net distance a move removes, against the locality.minDistance guideline. It does not say the move is worth its churn.",
        ...(lowConfidence > 0 ? [`${plural(lowConfidence, "candidate")} rest on includes that found no file, so a consumer may be missing and the result is a lower bound.`] : []),
        ...(history === null ? ["No history was read, so co-change evidence is not used."] : history.grade === "weak" ? ["The evidence grade is weak, so history-based evidence is tentative and the structure leads."] : []),
      ],
      slots: slotsFor(planned),
    });
  },
};
