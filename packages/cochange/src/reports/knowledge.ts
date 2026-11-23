import { builtinOmissions } from "@code-health/cli-kit/builtin-excludes";
import { droppedCounts } from "@code-health/cli-kit/dropped-files";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import type { ReportKind } from "@code-health/cli-kit/report-command";
import type { Block } from "@code-health/report/block";
import type { Cell } from "@code-health/report/components/ranked-table";
import type { ExcludedCount, Slot } from "@code-health/report/protocol";
import type { ReportBuild } from "@code-health/report/report-model";
import { excludedCounts, historyWindowText } from "@code-health/history/report-header";
import type { FiltersApplied } from "@code-health/history/noise";
import { measureCurrent, round4, summariseCurrent } from "../abandonment/current.ts";
import type { KnowledgeModel } from "../abandonment/knowledge-model.ts";
import { PATTERNS, type Pattern, type PatternFile } from "../abandonment/patterns.ts";
import { measurePatterns, type MeasuredPatterns } from "../abandonment/patterns-run.ts";
import { commonInputs, prepare, type Prepared } from "../abandonment/prepare.ts";
import { rankScore } from "../abandonment/ranking.ts";
import { requireKnowledge } from "../abandonment/settings.ts";
import { simulateCommand } from "../abandonment/simulate-run.ts";

const TOP = 10;
const TREEMAP_TILES = 60;

interface PatternInfo {
  label: string;
  /** The mark printed in a treemap tile. */
  mark: string;
  band: number;
  /** The rule, with the guideline values it is judged against. */
  rule: (p: Prepared) => string;
  /** What the slot asks for. */
  task: string;
  /** The verdicts the slot allows. */
  verdicts: string[];
}

const percent = (share: number): number => Math.round(share * 1000) / 10;
const oneDecimal = (value: number): number => Math.round(value * 10) / 10;
const oneDecimal = (value: number): number => Math.round(value * 10) / 10;
const oneDecimal = (value: number): number => Math.round(value * 10) / 10;

const VERDICTS = ["pair", "document", "rotate-reviews", "leave"];
const INCONCLUSIVE_VERDICTS = ["map-identities", "leave"];
const INCONCLUSIVE_VERDICTS = ["map-identities", "leave"];
const INCONCLUSIVE_VERDICTS = ["map-identities", "leave"];
const CITE =
  "Give one or two sentences of why that cite only values shown in this report. Do not name people, do not rank or judge any person, and do not guess who might leave. Do not add numbers the report does not show.";
const SLOT_RULES = `Choose one verdict: pair (pair on the next change to these files), document (write down what the owner knows), rotate-reviews (have another active developer review each change), or leave (the pattern does not call for action here). ${CITE}`;

const PATTERN_INFO: Record<Pattern, PatternInfo> = {
  "single-owner-hotspot": {
    label: "Single-owner hotspot",
    mark: "SOH",
    band: 5,
    rule: (p) => `One active developer holds at least ${p.settings.singleOwnerShare}% of the lines held by people, and the file is a hotspot`,
    task: `For the single-owner hotspots: these change often, and one active developer holds nearly all of the lines. ${SLOT_RULES}`,
    verdicts: VERDICTS,
  },
  "former-contributors-complex": {
    label: "Complex code by former contributors",
    mark: "CFC",
    band: 4,
    rule: (p) => `Developers who have left hold at least ${p.settings.formerContributorShare}% of the lines held by people, and the file's complexity is at or above the ${p.settings.complexityPercentile}th percentile`,
    task: `For complex code written mostly by people who have left: whoever changes it next inherits the complexity without its authors. ${SLOT_RULES}`,
    verdicts: VERDICTS,
  },
  "single-owner": {
    label: "Single owner",
    mark: "SO",
    band: 3,
    rule: (p) => `One active developer holds at least ${p.settings.singleOwnerShare}% of the lines held by people`,
    task: `For files with a single owner that are not hotspots: they change rarely, so the risk is lower than for hotspots. ${SLOT_RULES}`,
    verdicts: VERDICTS,
  },
  "many-active-developers": {
    label: "Many active developers",
    mark: "MAD",
    band: 2,
    rule: (p) => `At least ${p.settings.manyActiveAuthors} active developers each hold at least ${p.settings.meaningfulShare}% of the lines held by people`,
    task: `For files many active developers share: knowledge is spread, and the risk is coordination. ${SLOT_RULES}`,
    verdicts: VERDICTS,
  },
  inconclusive: {
    label: "Inconclusive",
    mark: "INC",
    band: 1,
    rule: (p) => `Lines of bots, services, agents, unknown commits and unmapped identities are at least ${p.settings.inconclusiveShare}% of the file's lines, or its blame is not known`,
    task: `For files whose authorship cannot be read: choose map-identities (review the identity mapping, because settled identities would let these files be read) or leave (nothing here is worth settling). ${CITE}`,
    verdicts: INCONCLUSIVE_VERDICTS,
  },
};

const slotId = (pattern: Pattern): string => `pattern-${pattern}`;

/** Commit filters and the file kinds left out, with the words the page uses. */
/** The active developers who hold lines in a file, the largest holder first. Never a developer who has left. */
function activeHolders(model: KnowledgeModel, byPath: ReadonlyMap<string, KnowledgeModel["files"][number]>, path: string): string {
  const file = byPath.get(path);
  if (file === undefined) return "";
  return file.holders
    .filter((h) => model.developers[h.dev]!.active)
    .sort((a, b) => b.lines - a.lines || a.dev - b.dev)
    .map((h) => model.developers[h.dev]!.key.replace(/\s*<[^>]*>$/, ""))
    .join("; ");
}

interface Names {
  enabled: boolean;
  model: KnowledgeModel;
  byPath: ReadonlyMap<string, KnowledgeModel["files"][number]>;
}

const holdersColumn = (names: Names, label: string) => (names.enabled ? [{ key: "holders", label }] : []);
const holdersCell = (names: Names, path: string): Record<string, Cell> => (names.enabled ? { holders: activeHolders(names.model, names.byPath, path) || null } : {});

function patternRow(file: PatternFile, names: Names): Record<string, Cell> {
  return {
    path: file.path,
    hotspot: file.hotspot ? "yes" : "no",
    complexity: file.complexity,
    people: file.peopleLines,
    active: file.activeAuthors,
    former: file.formerAuthors,
    top: percent(file.topActiveShare),
    gone: percent(file.formerShare),
    bus: file.busFactor,
    ...holdersCell(names, file.path),
  };
}

function patternTable(pattern: Pattern, files: readonly PatternFile[], names: Names): Block {
  const own = files.filter((f) => f.pattern === pattern);
  return {
    type: "ranked-table",
    caption: `Top files whose first pattern is ${PATTERN_INFO[pattern].label.toLowerCase()}, hottest first`,
    noun: "files",
    total: own.length,
    columns: [
      { key: "path", label: "File" },
      { key: "hotspot", label: "Hotspot" },
      { key: "complexity", label: "Complexity", align: "right" },
      { key: "people", label: "Lines held by people", align: "right" },
      { key: "active", label: "Active holders", align: "right" },
      { key: "former", label: "Former holders", align: "right" },
      { key: "top", label: "Top active holder (%)", align: "right" },
      { key: "gone", label: "Held by former (%)", align: "right" },
      { key: "bus", label: "Bus factor", align: "right" },
      ...holdersColumn(names, "Active developers holding lines"),
    ],
    rows: own.slice(0, TOP).map((f) => patternRow(f, names)),
  };
}

function countsTable(p: Prepared, measured: MeasuredPatterns): Block {
  const rows = measured.summary.counts.map((c): Record<string, Cell> => ({ pattern: PATTERN_INFO[c.pattern].label, rule: PATTERN_INFO[c.pattern].rule(p), primary: c.primary, matching: c.matching }));
  rows.push({ pattern: "No pattern", rule: "None of the above applies", primary: measured.summary.none, matching: measured.summary.none });
  return {
    type: "ranked-table",
    caption: "Files by knowledge-risk pattern",
    numbered: false,
    columns: [
      { key: "pattern", label: "Pattern" },
      { key: "rule", label: "Rule, with its guideline" },
      { key: "primary", label: "Files, first pattern", align: "right" },
      { key: "matching", label: "Files, any pattern", align: "right" },
    ],
    rows,
  };
}

function guidelineFacts(p: Prepared): Block {
  const s = p.settings;
  return {
    type: "facts",
    caption: "Guidelines the patterns use (cochange.knowledge, each a judgement call that labels and orders files and hides none)",
    facts: [
      { label: "singleOwnerShare", value: `${s.singleOwnerShare}% of the lines held by people` },
      { label: "formerContributorShare", value: `${s.formerContributorShare}% of the lines held by people` },
      { label: "complexityPercentile", value: `${s.complexityPercentile}th percentile of complexity` },
      { label: "manyActiveAuthors", value: `${s.manyActiveAuthors} active developers` },
      { label: "meaningfulShare", value: `${s.meaningfulShare}% of the lines held by people` },
      { label: "inconclusiveShare", value: `${s.inconclusiveShare}% of a file's lines` },
      { label: "busFactorShare", value: `${s.busFactorShare}% of the lines held by people` },
      { label: "activityWindowMonths", value: `${s.activityWindowMonths} months without a commit means a developer has left` },
    ],
  };
}

function treemapBlock(measured: MeasuredPatterns): Block[] {
  const code = measured.files.filter((f) => f.kind === "code");
  const sized = code.filter((f) => f.peopleLines > 0).sort((a, b) => b.peopleLines - a.peopleLines || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const drawn = sized.slice(0, TREEMAP_TILES);
  return [
    {
      type: "category-treemap",
      title: "Files by lines held by people, marked by knowledge-risk pattern",
      sizeLabel: "lines held by people",
      categoryLabel: "First pattern",
      categories: PATTERNS.map((id) => ({ id, label: PATTERN_INFO[id].label, mark: PATTERN_INFO[id].mark, band: PATTERN_INFO[id].band })),
      items: drawn.map((f) => ({ path: f.path, size: f.peopleLines, category: f.pattern })),
      maxTiles: TREEMAP_TILES,
    },
    { type: "notice", level: "notice", text: `The treemap draws the ${drawn.length} production code files with the most lines held by people, of ${sized.length}. ${measured.files.length - code.length === 0 ? "" : `${measured.files.length - code.length} test, document, data and configuration files are not drawn. `}The tables below list files of every kind by pattern, hottest first.` },
  ];
}

function busFactorTable(p: Prepared, measured: MeasuredPatterns, names: Names): Block[] {
  const byPath = new Map(measured.files.map((f) => [f.path, f]));
  const hotspots = measured.hotspotRows.filter((r) => r.recommendation === "hotspot" && r.role !== "test").sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const rows = hotspots.slice(0, TOP).map((h): Record<string, Cell> => {
    const f = byPath.get(h.path);
    return {
      path: h.path,
      score: h.score === null ? null : round4(h.score),
      people: f?.peopleLines ?? null,
      active: f?.activeAuthors ?? null,
      bus: f?.busFactor ?? null,
      top: f === undefined ? null : percent(f.topActiveShare),
      gone: f === undefined ? null : percent(f.formerShare),
      pattern: f?.pattern === null || f === undefined ? null : PATTERN_INFO[f.pattern!].label,
      ...holdersCell(names, h.path),
    };
  });
  return [
    {
      type: "ranked-table",
      caption: `Bus factor of the top hotspots: the fewest active developers who together hold ${p.settings.busFactorShare}% of a file's lines held by people`,
      noun: "hotspots",
      total: hotspots.length,
      columns: [
        { key: "path", label: "Hotspot" },
        { key: "score", label: "Hotspot score", align: "right" },
        { key: "people", label: "Lines held by people", align: "right" },
        { key: "active", label: "Active holders", align: "right" },
        { key: "bus", label: "Bus factor", align: "right" },
        { key: "top", label: "Top active holder (%)", align: "right" },
        { key: "gone", label: "Held by former (%)", align: "right" },
        { key: "pattern", label: "First pattern" },
        ...holdersColumn(names, "Active developers holding lines"),
      ],
      rows,
    },
    { type: "notice", level: "notice", text: `A dash in the bus factor column means active developers together hold less than ${p.settings.busFactorShare}% of the file's lines held by people, so the rest sits with developers who have left or with lines nobody holds.` },
  ];
}

async function abandonmentBlocks(p: Prepared, measured: MeasuredPatterns): Promise<Block[]> {
  const { model } = p.knowledge;
  const files = measureCurrent(model, p.settings.abandonmentGuideline);
  const summary = summariseCurrent(files, model.files.reduce((sum, f) => sum + f.unattributed, 0));
  const listed = files
    .filter((f) => f.abandonedLines > 0)
    .map((f) => ({ f, score: p.settings.rank === "hotspot" ? rankScore("hotspot", f.abandonedShare, measured.weights.get(f.path)) : f.abandonedLines }))
    .sort((a, b) => b.score - a.score || Buffer.compare(Buffer.from(a.f.path), Buffer.from(b.f.path)));
  return [
    {
      type: "facts",
      caption: "Knowledge lost so far, at the analysed commit",
      facts: [
        { label: "Files with lines held by people", value: String(summary.files.measured) },
        { label: `Files abandoned (${p.settings.abandonmentGuideline}% or more of the lines held by people belong to people who have left)`, value: `${summary.files.abandoned} (${percent(summary.files.share)}%)` },
        { label: "Lines held by people", value: String(summary.lines.people) },
        { label: "Of those, held by people who have left", value: `${summary.lines.abandoned} (${percent(summary.lines.share)}%)` },
        { label: "Lines of bots, services and agents, on neither side", value: String(summary.lines.nonPerson) },
        { label: "Lines with an unknown commit", value: String(summary.lines.unattributed) },
        { label: "Developers active, and who have left", value: `${model.developers.filter((d) => d.active).length} active, ${model.developers.filter((d) => !d.active).length} left` },
      ],
    },
    {
      type: "ranked-table",
      caption: `Files with the most knowledge held by people who have left, ranked ${p.settings.rank === "hotspot" ? "by abandoned share weighted by hotspot percentile" : "by lines lost"}`,
      noun: "files",
      total: listed.length,
      columns: [
        { key: "path", label: "File" },
        { key: "share", label: "Held by former (%)", align: "right", guideline: { value: p.settings.abandonmentGuideline, note: "cochange.knowledge.abandonmentGuideline, at or above it a file is abandoned" } },
        { key: "lines", label: "Lines lost", align: "right" },
        { key: "people", label: "Lines held by people", align: "right" },
        { key: "active", label: "Active holders", align: "right" },
        { key: "former", label: "Former holders", align: "right" },
        { key: "hotspot", label: "Hotspot" },
      ],
      rows: listed.slice(0, TOP).map(({ f }): Record<string, Cell> => ({
        path: f.path,
        share: percent(f.abandonedShare),
        lines: f.abandonedLines,
        people: f.peopleLines,
        active: f.activeAuthors,
        former: f.formerAuthors,
        hotspot: measured.weights.get(f.path)?.hot === true ? "yes" : "no",
      })),
    },
    ...(files.length > listed.length
      ? [{ type: "notice" as const, level: "notice" as const, text: `${files.length - listed.length} of ${files.length} measured files have no lines held by people who have left and are not listed.` }]
      : []),
  ];
}

interface Distribution {
  expected: number;
  expectedShare: number;
  atRisk: { alpha: number; kar: number; karShare: number; tailRatio: number | null }[];
}
interface SimulationResults {
  mode: string;
  trials: number;
  horizonPeriods: number;
  seed: number;
  selection: { source: string; ratePerPeriod: number | null; leaverProbability: number };
  population: { activeDevelopers: number; files: number; peopleLines: number };
  loss: { files: { baseline: number; population: number; increment: Distribution }; lines: { baseline: number; population: number; increment: Distribution } };
  files: { path: string; probability: number; abandoned: boolean; hotspot: boolean; activeAuthors: number; formerAuthors: number; findings: string[] }[];
  components: { path: string; tailRatio: number | null; expectedLoss: number; peopleLines: number; findings: string[] }[];
}

async function simulationBlocks(context: CommandContext, p: Prepared): Promise<{ blocks: Block[]; notices: string[] }> {
  // The whole list of at-risk files, so the table can say how many it leaves out.
  const output = await simulateCommand({ ...context, values: { ...context.values, top: "100000" } });
  const r = output.results as SimulationResults;
  const notices = output.notices ?? [];
  const karFacts = r.loss.files.increment.atRisk.map((a) => ({
    label: `Knowledge at risk at the ${a.alpha}th percentile, in files`,
    value: `${a.kar} of ${r.loss.files.population} files (${percent(a.karShare)}%), ${a.tailRatio === null ? "no tail ratio" : `${oneDecimal(a.tailRatio)} times the expected loss`}`,
  }));
  return {
    notices,
    blocks: [
      {
        type: "facts",
        caption: `Simulated turnover over ${r.horizonPeriods} periods of ${p.settings.periodMonths} months, ${r.trials} trials, seed ${r.seed}`,
        facts: [
          { label: "Model", value: `${r.mode}; leaver rate per period ${r.selection.ratePerPeriod === null ? "not applicable" : `${percent(r.selection.ratePerPeriod)}%`} (${r.selection.source})` },
          { label: "Active developers", value: String(r.population.activeDevelopers) },
          { label: "Files already abandoned", value: `${r.loss.files.baseline} of ${r.loss.files.population}` },
          { label: "Expected further files lost", value: `${oneDecimal(r.loss.files.increment.expected)} (${percent(r.loss.files.increment.expectedShare)}% of files)` },
          ...karFacts,
          { label: "Expected further lines lost", value: `${oneDecimal(r.loss.lines.increment.expected)} of ${r.loss.lines.population} lines held by people (${percent(r.loss.lines.increment.expectedShare)}%)` },
        ],
      },
      {
        type: "ranked-table",
        caption: "Files most likely to lose their authors within the horizon, hotspot-weighted",
        noun: "files",
        total: r.files.length,
        columns: [
          { key: "path", label: "File" },
          { key: "probability", label: "Probability (%)", align: "right", guideline: { value: p.settings.atRiskProbability, note: "cochange.knowledge.atRiskProbability" } },
          { key: "abandoned", label: "Already abandoned" },
          { key: "hotspot", label: "Hotspot" },
          { key: "active", label: "Active holders", align: "right" },
          { key: "former", label: "Former holders", align: "right" },
          { key: "findings", label: "Findings" },
        ],
        rows: r.files.slice(0, TOP).map((f): Record<string, Cell> => ({
          path: f.path,
          probability: percent(f.probability),
          abandoned: f.abandoned ? "yes" : "no",
          hotspot: f.hotspot ? "yes" : "no",
          active: f.activeAuthors,
          former: f.formerAuthors,
          findings: f.findings.length === 0 ? null : f.findings.join(", "),
        })),
      },
      {
        type: "ranked-table",
        caption: "Components by expected loss, with the tail ratio against its guideline",
        noun: "components",
        total: r.components.length,
        columns: [
          { key: "path", label: "Component" },
          { key: "expected", label: "Expected lines lost", align: "right" },
          { key: "people", label: "Lines held by people", align: "right" },
          { key: "tail", label: "Tail ratio", align: "right", guideline: { value: p.settings.concentratedTailRatio, note: "cochange.knowledge.concentratedTailRatio" } },
        ],
        rows: r.components.slice(0, TOP).map((c): Record<string, Cell> => ({ path: c.path, expected: oneDecimal(c.expectedLoss), people: c.peopleLines, tail: c.tailRatio })),
      },
      ...notices.map((text): Block => ({ type: "notice", level: "notice", text })),
    ],
  };
}

function slots(measured: MeasuredPatterns, p: Prepared): Slot[] {
  const withFiles = PATTERNS.filter((pattern) => measured.summary.counts.find((c) => c.pattern === pattern)!.primary > 0);
  return [
    {
      id: "summary",
      title: "Judgement: where knowledge is concentrated",
      about: { kind: "report", ref: "knowledge", label: "the repository" },
      task: "In at most four sentences, say where knowledge is most concentrated or most at risk, using only the pattern counts, the bus factors, the knowledge lost and the simulation shown in this report. Do not name people, do not rank or judge any person, and do not add numbers the report does not show. When a notice says the mapped share is low or the turnover estimate is weak, say the results are tentative.",
      verdicts: [],
      maxChars: 700,
    },
    ...withFiles.map((pattern): Slot => ({
      id: slotId(pattern),
      title: `Judgement: ${PATTERN_INFO[pattern].label.toLowerCase()}`,
      about: { kind: "finding", ref: pattern, label: PATTERN_INFO[pattern].label },
      task: PATTERN_INFO[pattern].task,
      verdicts: PATTERN_INFO[pattern].verdicts,
      maxChars: 450,
    })),
    {
      id: "limits",
      title: "Judgement: what limits these results",
      about: { kind: "report", ref: "knowledge", label: "the repository" },
      task: "In at most three sentences, say what limits how far these results can be trusted for this repository, using only the evidence, the exclusions, the notices and the limits shown above.",
      verdicts: [],
      maxChars: 500,
    },
  ];
}

function limitsOf(p: Prepared, measured: MeasuredPatterns, notices: string[]): string[] {
  const s = p.settings;
  const evidence = p.history.evidence;
  return [
    "Guidelines order and label results. They are heuristics for investigation and decide nothing, and every file is listed under its pattern or under none.",
    "Authorship is git blame ignoring whitespace and following moved and copied lines. It says who last wrote a line, which is not who understands it.",
    `A developer counts as having left after ${s.activityWindowMonths} months without a commit. Someone on leave looks the same, and local overrides correct it.`,
    "The simulation assumes turnover is random. It says nothing about any person, and the report names nobody unless run with --names, which lists active developers only.",
    `Each table shows the top ${TOP} of its result and says how many rows it leaves out; \`cochange abandonment patterns\` prints every file.`,
    `Complexity is ${measured.complexity.source === "indentation" ? "the indentation proxy, because no complexity report covers this commit" : "from the complexity plugin's stored report"}. Test files and files that are not code have none, so the complex-code pattern does not apply to them (${measured.summary.complexityUnknown} files with a blame have no complexity).`,
    ...(evidence.grade === "weak" ? ["The evidence grade is weak, so history-based results are tentative."] : []),
    ...(notices.length > 0 ? ["The notices above say where the identities or the turnover estimate weaken the results."] : []),
    ...(p.knowledge.model.missing.length > 0 ? [`The blame is not cached for ${p.knowledge.model.missing.length} files, which are inconclusive. Run without --no-refresh to refresh it.`] : []),
  ];
}

export const knowledge: ReportKind = {
  summary: "Where knowledge is concentrated and lost: knowledge-risk patterns, bus factor of the hotspots, knowledge lost so far and the simulated turnover (needs cochange.knowledge.enabled)",
  options: { names: { type: "boolean" }, "no-refresh": { type: "boolean" } },
  optionHelp: {
    names: "show the names, without addresses, of the active developers who hold the lines of each listed file (never developers who have left)",
    "no-refresh": "read the history and blame caches without bringing them up to date",
  },
  async build(context: CommandContext): Promise<ReportBuild> {
    requireKnowledge(context);
    const p = await prepare(context);
    const measured = await measurePatterns(context, p);
    const { model } = p.knowledge;
    const names: Names = { enabled: context.values.names === true, model, byPath: new Map(model.files.map((f) => [f.path, f])) };
    const abandonment = await abandonmentBlocks(p, measured);
    const simulation = await simulationBlocks(context, p);
    const withFiles = PATTERNS.filter((pattern) => measured.summary.counts.find((c) => c.pattern === pattern)!.primary > 0);
    const excluded = excludedCounts(p.history.filtersApplied, droppedCounts(), builtinOmissions(), { leftOutOf: "the hotspot ranking" });
    const { evidence, window } = p.history;
    return {
      title: "Knowledge report",
      inputs: { ...commonInputs(p, "report", { names: names.enabled, guidelines: measured.guidelines, complexityReport: measured.complexity.input }) },
      header: {
        evidenceGrade: evidence.grade,
        historyWindow: historyWindowText(evidence, window, "; authorship is the blame at the analysed commit"),
        excluded: excluded.filter((e) => e.count > 0),
      },
      sections: [
        { id: "summary", heading: "Where knowledge is concentrated", blocks: [{ type: "judgement", slot: "summary" }] },
        {
          id: "patterns",
          heading: "Knowledge-risk patterns",
          blocks: [
            guidelineFacts(p),
            countsTable(p, measured),
            ...treemapBlock(measured),
            ...withFiles.flatMap((pattern): Block[] => [patternTable(pattern, measured.files, names), { type: "judgement", slot: slotId(pattern) }]),
          ],
        },
        { id: "bus-factor", heading: "Bus factor of the top hotspots", blocks: busFactorTable(p, measured, names) },
        { id: "knowledge-lost", heading: "Knowledge lost so far", blocks: abandonment },
        { id: "simulation", heading: "Simulated turnover", blocks: simulation.blocks },
      ],
      limits: limitsOf(p, measured, simulation.notices),
      slots: slots(measured, p),
    };
  },
};
