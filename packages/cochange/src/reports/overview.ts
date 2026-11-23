import { builtinOmissions } from "@code-health/cli-kit/builtin-excludes";
import { droppedCounts } from "@code-health/cli-kit/dropped-files";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import type { ReportKind } from "@code-health/cli-kit/report-command";
import type { Block } from "@code-health/report/block";
import type { Cell } from "@code-health/report/components/ranked-table";
import type { Candidate, ExcludedCount, Slot } from "@code-health/report/protocol";
import type { ReportBuild } from "@code-health/report/report-model";
import type { Evidence } from "@code-health/history/evidence";
import type { FiltersApplied } from "@code-health/history/noise";
import { noCacheOption } from "@code-health/history/results-cache";
import { command as hotspotsCommand } from "../commands/hotspots.ts";
import type { HotspotRow } from "../hotspot-ranking.ts";
import { readSiblingResult, type SiblingResult } from "../sibling-reports.ts";
import { windowOptions } from "../window-options.ts";

const TOP = 5;
const FIRST_LOOK_MAX = 3;

/** The fix convention check as hotspots and the other commands print it. */
interface FixConvention {
  fixes: number;
  followsConvention: boolean;
  forms: { conventionalCommits: number; fixVerb: number; issueReference: number };
  landedChanges: number;
  note: string | null;
  share: number;
}

const isoDate = (seconds: number | string) => new Date(typeof seconds === "number" ? seconds * 1000 : seconds).toISOString().slice(0, 10);
const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Commits the history read dropped, and the file changes it dropped, each with the words the page uses. */
const COMMIT_FILTERS: [keyof FiltersApplied["dropped"], string][] = [
  ["outsideWindow", "commits outside the analysis window"],
  ["shallowBoundaryCommits", "shallow boundary commits"],
  ["importedCommits", "commits of imported history"],
  ["blameIgnoredCommits", "commits in the blame ignore file"],
  ["botCommits", "commits by bots and service accounts"],
  ["suiteCommits", "commits trailed by this suite"],
  ["emptyAfterFiltering", "commits with no file left after filtering"],
];
const CHANGE_FILTERS: [keyof FiltersApplied["dropped"], string][] = [
  ["pureRenames", "file changes that only rename"],
  ["excludedByGlob", "file changes matching exclude globs"],
  ["lockfiles", "lockfile changes"],
  ["generated", "generated file changes"],
  ["vendored", "vendored file changes"],
];
const FILE_KINDS: Record<string, string> = { generated: "generated files", vendored: "vendored files", nonCode: "non-code files", tests: "test files" };

function excludedCounts(filters: FiltersApplied, files: Record<string, number>, builtin: Record<string, number>): ExcludedCount[] {
  return [
    ...[...COMMIT_FILTERS, ...CHANGE_FILTERS].map(([key, what]) => ({ what, count: filters.dropped[key] })),
    { what: `changes over the changeset limit of ${filters.maxChangesetSize} files`, count: filters.oversizedChanges },
    ...Object.entries(files).map(([kind, count]) => ({ what: `${FILE_KINDS[kind] ?? kind} left out of the rankings`, count })),
    ...Object.entries(builtin).map(([entry, count]) => ({ what: `files under the built-in exclude ${entry}`, count })),
  ];
}

const grade = (evidence: Evidence): string => evidence.grade;

function evidenceBlocks(evidence: Evidence): Block[] {
  const g = evidence.guidelines.strong;
  const share = (value: number, guideline: number) => (guideline === 0 ? 0 : (value / guideline) * 100);
  const merge = evidence.commitSize;
  return [
    {
      type: "facts",
      caption: "Evidence behind the history-based results",
      facts: [
        { label: "Evidence grade", value: evidence.grade },
        { label: "Months of usable history", value: String(evidence.usableHistoryMonths) },
        { label: "Active contributors in the window", value: String(evidence.activeContributors) },
        { label: "Logical changes in the window", value: String(evidence.logicalChangesInWindow) },
        { label: "Shallow clone", value: evidence.truncated.shallow ? `yes, ${evidence.truncated.boundaryCommits} boundary commits` : "no" },
        { label: "Imported history", value: evidence.importedHistory.length === 0 ? "none detected" : `${evidence.importedHistory.length} detected` },
        {
          label: "Merge policy",
          value: merge.shifted
            ? `the median files per change moved from ${merge.earlierMedian} to ${merge.laterMedian}, which usually means a change of merge policy`
            : `no shift in the median files per change (${merge.earlierMedian} earlier, ${merge.laterMedian} later)`,
        },
      ],
    },
    {
      type: "guideline-bars",
      title: "History against the guidelines for strong evidence",
      unit: "percent of the guideline for strong evidence",
      source: `Guidelines for strong evidence: ${g.months} months, ${g.logicalChanges} logical changes, ${g.contributors} contributors.`,
      bars: [
        { label: `Months of history (${evidence.usableHistoryMonths} of ${g.months})`, value: share(evidence.usableHistoryMonths, g.months), guideline: 100 },
        { label: `Logical changes (${evidence.logicalChangesInWindow} of ${g.logicalChanges})`, value: share(evidence.logicalChangesInWindow, g.logicalChanges), guideline: 100 },
        { label: `Contributors (${evidence.activeContributors} of ${g.contributors})`, value: share(evidence.activeContributors, g.contributors), guideline: 100 },
      ],
    },
    { type: "trend-marker", label: "Median files per logical change", earlier: merge.earlierMedian, later: merge.laterMedian, windows: ["the earlier half", "the later half"] },
  ];
}

function fixBlocks(convention: FixConvention): Block[] {
  return [
    {
      type: "facts",
      caption: "Fix convention check",
      facts: [
        { label: "Landed changes in the window", value: String(convention.landedChanges) },
        { label: "Changes whose title or message is a fix", value: `${convention.fixes} (${percent(convention.share)})` },
        { label: "Conventional Commits fix prefixes", value: String(convention.forms.conventionalCommits) },
        { label: "Fix verbs", value: String(convention.forms.fixVerb) },
        { label: "Issue references", value: String(convention.forms.issueReference) },
        { label: "Convention followed", value: convention.followsConvention ? "yes" : "no" },
      ],
    },
    ...(convention.note === null ? [] : [{ type: "notice" as const, level: "notice" as const, text: convention.note }]),
  ];
}

function excludedBlocks(excluded: ExcludedCount[]): Block[] {
  return [
    {
      type: "ranked-table",
      caption: "What the run left out, with counts",
      numbered: false,
      columns: [
        { key: "what", label: "Left out" },
        { key: "count", label: "Count", align: "right" },
      ],
      rows: excluded.map((e): Record<string, Cell> => ({ what: e.what, count: e.count })),
    },
  ];
}

interface Result {
  /** Candidate subject for the first-look slot. */
  candidates: Candidate[];
  blocks: Block[];
  /** What the report read, for the stamp, or null when it did not read a stored result. */
  read: { report: string; head: string; config: string } | null;
  missing: string | null;
}

function missingResult(title: string, command: string): Result {
  return {
    candidates: [],
    blocks: [{ type: "notice", level: "notice", text: `No stored ${title} for this commit. Run \`${command}\` to store it, then run the overview again.` }],
    read: null,
    missing: command,
  };
}

function resultFrom(stored: SiblingResult | undefined, title: string, command: string, build: (stored: SiblingResult) => { block: Block; candidates: Candidate[] }): Result {
  if (stored === undefined) return missingResult(title, command);
  const { block, candidates } = build(stored);
  return { candidates, blocks: [block], read: { report: stored.report, head: stored.head, config: stored.config }, missing: null };
}

const top = <T>(rows: readonly T[]): T[] => rows.slice(0, TOP);

function complexityResult(stored: SiblingResult | undefined): Result {
  return resultFrom(stored, "complexity analyse result", "complexity analyse", (s) => {
    const rows = top(s.rows);
    return {
      candidates: rows.flatMap((row) => (text(row.id) === null ? [] : [{ ref: `complexity:${text(row.id)}`, label: `${text(row.id)} (complexity)` }])),
      block: {
        type: "ranked-table",
        caption: "Most complex units, from complexity analyse",
        noun: "units",
        total: s.rows.length,
        columns: [
          { key: "id", label: "Unit" },
          { key: "cognitive", label: "Cognitive", align: "right" },
          { key: "cyclomatic", label: "Cyclomatic", align: "right" },
          { key: "nesting", label: "Nesting", align: "right" },
          { key: "length", label: "Length", align: "right" },
          { key: "labels", label: "Labels" },
        ],
        rows: rows.map((row): Record<string, Cell> => ({
          id: text(row.id) ?? text(row.path),
          cognitive: number(row.cognitive),
          cyclomatic: number(row.cyclomatic),
          nesting: number(row.nesting),
          length: number(row.length),
          labels: Array.isArray(row.labels) && row.labels.length > 0 ? row.labels.join(", ") : null,
        })),
      },
    };
  });
}

function cyclesResult(stored: SiblingResult | undefined): Result {
  return resultFrom(stored, "structure cycles result", "structure cycles", (s) => {
    const rows = top(s.rows);
    return {
      candidates: rows.flatMap((row) => (text(row.id) === null ? [] : [{ ref: `structure:${text(row.id)}`, label: `${text(row.id)} (import cycle)` }])),
      block: {
        type: "ranked-table",
        caption: "Largest import cycles, from structure cycles",
        noun: "cycles",
        total: s.rows.length,
        columns: [
          { key: "id", label: "Cycle" },
          { key: "size", label: "Modules", align: "right" },
          { key: "method", label: "Method" },
          { key: "coChangeAcross", label: "Co-changes across", align: "right" },
          { key: "unblockedGain", label: "Unblocked gain", align: "right" },
        ],
        rows: rows.map((row): Record<string, Cell> => ({
          id: text(row.id),
          size: number(row.size),
          method: text(row.method),
          coChangeAcross: number(row.coChangeAcross),
          unblockedGain: number(row.unblockedGain),
        })),
      },
    };
  });
}

function localityResult(stored: SiblingResult | undefined): Result {
  return resultFrom(stored, "locality analyse result", "locality analyse", (s) => {
    const rows = top(s.rows);
    const ranking = (row: Record<string, unknown>) => (typeof row.ranking === "object" && row.ranking !== null ? (row.ranking as Record<string, unknown>) : {});
    const guideline = rows.map((row) => number(ranking(row).guideline)).find((g) => g !== null) ?? undefined;
    return {
      candidates: rows.flatMap((row) => (text(row.path) === null ? [] : [{ ref: `locality:${text(row.path)}`, label: `${text(row.path)} (locality)` }])),
      block: {
        type: "ranked-table",
        caption: "Units furthest from where they are used, from locality analyse",
        noun: "units",
        total: s.rows.length,
        columns: [
          { key: "path", label: "Unit" },
          { key: "recommendation", label: "Recommendation" },
          { key: "gain", label: `Gain (${text(rows[0]?.scoreUnit) ?? "score"})`, align: "right", ...(guideline === undefined ? {} : { guideline: { value: guideline, note: "locality.minDistance gain guideline" } }) },
          { key: "distance", label: "Distance", align: "right" },
          { key: "target", label: "Target" },
        ],
        rows: rows.map((row): Record<string, Cell> => ({
          path: text(row.path),
          recommendation: text(row.recommendation),
          gain: number(ranking(row).value) ?? number(row.score),
          distance: number(row.distance),
          target: text(row.target),
        })),
      },
    };
  });
}

function hotspotResult(rows: readonly HotspotRow[]): Result {
  const shown = top(rows);
  return {
    candidates: shown.map((row) => ({ ref: `hotspot:${row.path}`, label: `${row.path} (hotspot ranking)` })),
    read: null,
    missing: null,
    blocks: [
      {
        type: "ranked-table",
        caption: "Highest hotspot scores, from cochange hotspots",
        noun: "files",
        total: rows.length,
        columns: [
          { key: "path", label: "File" },
          { key: "score", label: "Score", align: "right" },
          { key: "frequency", label: "Revisions", align: "right" },
          { key: "complexity", label: "Complexity", align: "right" },
          { key: "fixes", label: "Fixes", align: "right" },
          { key: "recommendation", label: "Flag" },
        ],
        rows: shown.map((row): Record<string, Cell> => ({ path: row.path, score: row.score, frequency: row.frequency, complexity: row.complexity, fixes: row.fixes, recommendation: row.recommendation })),
      },
      scoreHistogram(rows),
    ],
  };
}

function scoreHistogram(rows: readonly HotspotRow[]): Block {
  const bins = Array.from({ length: 10 }, (_, i) => ({ label: `${(i / 10).toFixed(1)} to ${((i + 1) / 10).toFixed(1)}`, count: 0 }));
  for (const row of rows) if (row.score !== null) bins[Math.min(9, Math.floor(row.score * 10))]!.count++;
  return { type: "histogram", title: "Distribution of hotspot scores", unit: "files", bins };
}

function slots(candidates: Candidate[]): Slot[] {
  return [
    {
      id: "first-look",
      title: "Judgement: where to start",
      about: { kind: "report", ref: "overview", label: "the repository" },
      task:
        `Choose up to ${FIRST_LOOK_MAX} subjects from the candidates that the tables in this report say are worth a look first, most worthwhile first. For each, give a verdict and one or two sentences of why that cite only values shown in this report. Do not add numbers the report does not show. When the evidence grade is weak, say the history-based results are tentative.`,
      verdicts: ["investigate-first", "worth-a-look", "evidence-too-weak"],
      maxChars: 320,
      choose: { max: FIRST_LOOK_MAX, candidates },
    },
    {
      id: "limits",
      title: "Judgement: what limits these results",
      about: { kind: "report", ref: "overview", label: "the repository" },
      task: "In at most three sentences, say what limits how far these results can be trusted for this repository, using only the evidence, the exclusions and the missing results shown above.",
      verdicts: [],
      maxChars: 500,
    },
  ];
}

function limitsOf(evidence: Evidence, missing: string[], complexitySource: unknown): string[] {
  return [
    "Guidelines order and label results. They are heuristics for investigation and decide nothing.",
    `Each table shows the top ${TOP} of its result and says how many rows it leaves out; the command prints the rest.`,
    ...(evidence.grade === "weak" ? ["The evidence grade is weak, so history-based results are tentative and static signals should lead."] : []),
    ...(evidence.truncated.shallow ? [`The clone is shallow, so history before ${evidence.truncated.availableSince === null ? "its boundary" : isoDate(evidence.truncated.availableSince)} is missing.`] : []),
    ...(evidence.commitSize.shifted ? ["A change of merge policy shifts what a commit means, so compare windows within one policy."] : []),
    ...(complexitySource === "indentation" ? ["Hotspot complexity is the indentation proxy, because no complexity report covers this commit."] : []),
    ...(missing.length === 0 ? [] : [`Not stored for this commit: ${missing.join(", ")}. The overview reads other plugins' stored results and never computes them.`]),
  ];
}

export const overview: ReportKind = {
  summary: "Evidence, fix convention, exclusions and the top results of each plugin, with a judgement of what to look at first",
  options: { ...windowOptions, "no-refresh": { type: "boolean" }, ...noCacheOption },
  optionHelp: {
    since: "analyse history from this date (ISO 8601); needed on a shallow clone",
    until: "analyse history up to this date (ISO 8601, exclusive)",
    "no-refresh": "read the history cache without bringing it up to date",
    "no-cache": "compute the hotspot ranking again instead of reading the stored one",
  },
  async build(context: CommandContext): Promise<ReportBuild> {
    const output = await hotspotsCommand.run(context);
    const extra = output.extra as { evidence: Evidence; filtersApplied: FiltersApplied; fixConvention: FixConvention; complexitySource: unknown; window: { since: string; until: string } };
    const { evidence } = extra;
    const rows = output.results as HotspotRow[];
    const root = context.repo.root;
    const head = context.repo.head;
    const results = [
      hotspotResult(rows),
      complexityResult(readSiblingResult(root, "complexity", "analyse", head)),
      cyclesResult(readSiblingResult(root, "structure", "cycles", head)),
      localityResult(readSiblingResult(root, "locality", "analyse", head)),
    ];
    const candidates = results.flatMap((r) => r.candidates);
    const missing = results.flatMap((r) => (r.missing === null ? [] : [r.missing]));
    const excluded = excludedCounts(extra.filtersApplied, droppedCounts(), builtinOmissions());
    const inputs = (output.inputs ?? {}) as Record<string, unknown>;
    return {
      title: "Code health overview",
      inputs: {
        since: context.values.since ?? null,
        until: context.values.until ?? null,
        complexityReport: inputs.complexityReport ?? null,
        storedResultsRead: results.flatMap((r) => (r.read === null ? [] : [r.read])),
      },
      header: {
        evidenceGrade: grade(evidence),
        historyWindow: `${evidence.usableHistoryMonths} months of usable history; the analysis window is ${evidence.window.months} months, ${isoDate(extra.window.since)} to ${isoDate(extra.window.until)}`,
        excluded: excluded.filter((e) => e.count > 0),
      },
      sections: [
        { id: "first-look", heading: "What to look at first", blocks: [{ type: "judgement", slot: "first-look" }] },
        { id: "evidence", heading: "Evidence", blocks: evidenceBlocks(evidence) },
        { id: "fix-convention", heading: "Fix convention", blocks: fixBlocks(extra.fixConvention) },
        { id: "excluded", heading: "What was excluded", blocks: excludedBlocks(excluded) },
        { id: "results", heading: "Top results of each plugin", blocks: results.flatMap((r) => r.blocks) },
      ],
      limits: limitsOf(evidence, missing, extra.complexitySource),
      slots: slots(candidates),
    };
  },
};
