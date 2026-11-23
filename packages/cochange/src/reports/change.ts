import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { builtinOmissions } from "@code-health/cli-kit/builtin-excludes";
import { usageError } from "@code-health/cli-kit/errors";
import { droppedCounts } from "@code-health/cli-kit/dropped-files";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import type { ReportKind } from "@code-health/cli-kit/report-command";
import type { Block } from "@code-health/report/block";
import type { Cell } from "@code-health/report/components/ranked-table";
import type { EvidenceItem } from "@code-health/report/components/evidence-list";
import { dropEmptySlots } from "@code-health/report/empty-block";
import type { ExcludedCount, Slot } from "@code-health/report/protocol";
import { capRows } from "@code-health/report/table-cap";
import type { ReportBuild, Section } from "@code-health/report/report-model";
import { runGit } from "@code-health/history/git";
import { loadHistory } from "../history-access.ts";
import { assessBranch, type Assessed } from "../risk/assess.ts";
import { INDENTATION_PROXY } from "../risk/composition.ts";
import { resolveRange } from "../risk/change.ts";
import type { Factor } from "../risk/factor.ts";
import { findingsOf, type Finding } from "../risk/findings.ts";
import { levelResult, type LevelResult } from "../risk/level-result.ts";
import type { PlacementOutcome } from "../risk/placement-result.ts";
import { readRiskSettings } from "../risk/settings.ts";
import { readStoredBacktest } from "../risk/stored-backtest.ts";
import { NO_CHANGE_EVIDENCE, readChangeEvidence, type ChangeEvidence, type ComplexityRow, type StructureRow } from "./change-evidence.ts";

/** The most items needing attention that get a slot. The rest are counted on the page, and the tables list them. */
const MAX_ITEMS = 8;
/** Rows a table lists before it says how many it leaves out. */
const ROWS = 15;
const EVIDENCE_ITEMS = 6;

export const ITEM_VERDICTS = ["needs-change", "accepted-with-reason", "false-positive"];

const isoDate = (iso: string) => iso.slice(0, 10);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const short = (sha: string) => sha.slice(0, 7);
const clip = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max - 3)}...`);

/** One thing that needs a person's attention, with the slot that asks for a judgement of it. */
interface Item {
  slot: Slot;
  /** What the evidence list of the full report is headed with. */
  heading: string;
  evidence: EvidenceItem[];
  omitted: number;
}

const ITEM_TASK =
  "Give a verdict and one or two sentences. needs-change: the change should be altered before it merges, and the text says what. accepted-with-reason: the change stays as it is, and the text gives the reason. false-positive: the finding does not apply, and the text says why. Cite only values shown in this report.";

function itemSlot(id: string, about: Slot["about"], title: string, specific: string): Slot {
  return { id, title: `Judgement: ${title}`, about, task: `${specific} ${ITEM_TASK}`, verdicts: ITEM_VERDICTS, maxChars: 300 };
}

/** A factor's evidence record as one line: the path or id first, then every other plain value. */
function describeEvidence(record: Record<string, unknown>): EvidenceItem {
  const pair = text(record.a) !== null && text(record.b) !== null;
  const idKey = pair ? "a" : ["file", "path", "id", "test"].find((key) => text(record[key]) !== null);
  const rest = Object.entries(record)
    .filter(([key]) => key !== idKey && !(pair && key === "b"))
    .flatMap(([key, value]): string[] => {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [`${key} ${value}`];
      if (Array.isArray(value)) return [`${key} ${value.length}`];
      return [];
    });
  const id = idKey === undefined ? "item" : pair ? `${text(record.a)} and ${text(record.b)}` : text(record[idKey])!;
  return { id, text: rest.length === 0 ? "touched by the change" : rest.join(", ") };
}

function evidenceItems(records: Record<string, unknown>[]): { items: EvidenceItem[]; omitted: number } {
  return { items: records.slice(0, EVIDENCE_ITEMS).map(describeEvidence), omitted: Math.max(0, records.length - EVIDENCE_ITEMS) };
}

function findingItem(finding: Finding): Item {
  const files = finding.evidence.flatMap((record) => text(record.file) ?? text(record.path) ?? []);
  const label = clip(files.length === 0 ? finding.summary : `${finding.summary}: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", ..." : ""}`, 220);
  const { items, omitted } = evidenceItems(finding.evidence);
  return {
    slot: itemSlot(
      `finding-${finding.id}`,
      { kind: "finding", ref: `risk:${finding.id}`, label },
      `${finding.id}`,
      `Finding "${finding.id}": ${finding.summary}. The risk response is: ${finding.response}${finding.redFlag === null ? "" : ` The usual red flag is ${finding.redFlag}.`}`,
    ),
    heading: `${finding.id} (${finding.band ?? "no band"}): ${finding.summary}`,
    evidence: items,
    omitted,
  };
}

function structureItem(row: StructureRow, index: number): Item {
  const what = row.kind === "cycle" ? "new import cycle" : "new layer violation";
  return {
    slot: itemSlot(
      `structure-${index + 1}`,
      { kind: "finding", ref: `structure:${row.id}`, label: clip(`${what} ${row.id}: ${row.detail}`, 220) },
      `${what} ${row.id}`,
      `Structure check says this change adds a ${what} (${row.id}). Say whether the dependency is intended.`,
    ),
    heading: `${what}: ${row.id}`,
    evidence: [{ id: row.id, text: row.detail }],
    omitted: 0,
  };
}

const range = (row: ComplexityRow) => (row.before === null ? String(row.after) : `${row.before} to ${row.after}`);

function complexityItem(rows: ComplexityRow[], index: number): Item {
  const first = rows[0]!;
  const unit = first.id;
  const worst = rows.map((r) => `${r.metric} ${range(r)}${r.guideline === null ? "" : ` (guideline ${r.guideline})`}`).join(", ");
  const kind = rows.some((r) => r.kind === "new") ? "new" : "worsened";
  return {
    slot: itemSlot(
      `complexity-${index + 1}`,
      { kind: "unit", ref: first.id, label: clip(`${unit} (${kind}): ${worst}`, 220) },
      `complexity of ${unit}`,
      `The function ${unit} is ${kind === "new" ? "new and above a complexity guideline" : "above a complexity guideline and got worse"}. Say whether it should be simplified before merge.`,
    ),
    heading: `${unit}: ${kind === "new" ? "new function above guideline" : "existing function above guideline that got worse"}`,
    evidence: rows.map((r) => ({ id: r.metric, text: `${r.kind === "new" ? "new function" : "worsened"}: ${r.before === null ? "" : `before ${r.before}, `}after ${r.after}${r.guideline === null ? ", above its guideline" : `, guideline ${r.guideline}`}` })),
    omitted: 0,
  };
}

function hotspotsItem(factor: Factor): Item {
  const files = factor.evidence.flatMap((record) => text(record.file) ?? []);
  const { items, omitted } = evidenceItems(factor.evidence);
  return {
    slot: itemSlot(
      "hotspots-touched",
      { kind: "finding", ref: "risk:hotspots-touched", label: clip(`${plural(number(factor.value.hotFiles) ?? files.length, "hotspot")} touched: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", ..." : ""}`, 220) },
      "hotspots touched",
      "The change puts churn into files that are hotspots. Say whether the change is covered well enough for those files.",
    ),
    heading: `hotspots touched (${factor.band}): ${plural(number(factor.value.hotFiles) ?? 0, "hot file")}`,
    evidence: items,
    omitted,
  };
}

/** What needs attention, in the order to deal with it: the risk findings, then the structure and complexity results, then the hotspots. */
function attentionItems(assessed: Assessed, evidence: ChangeEvidence): { shown: Item[]; total: number } {
  // A complexity finding comes only from a comparison that was passed in, and then from its own rows: without one, the indentation fallback of `cochange risk` is not a comparison.
  const findings = findingsOf(assessed, null).filter((f) => f.id !== "complexity-delta" && !(f.id === "structure-delta" && evidence.structure !== null));
  const items: Item[] = findings.map(findingItem);
  (evidence.structure ?? []).forEach((row, i) => items.push(structureItem(row, i)));
  const byUnit = new Map<string, ComplexityRow[]>();
  for (const row of evidence.complexity?.rows ?? []) byUnit.set(row.id, [...(byUnit.get(row.id) ?? []), row]);
  [...byUnit.entries()].forEach(([, rows], i) => items.push(complexityItem(rows, i)));
  const hot = assessed.factors.find((f) => f.name === "hotspots-touched");
  if (hot !== undefined && hot.status === "ok" && (hot.band === "moderate" || hot.band === "high")) items.push(hotspotsItem(hot));
  return { shown: items.slice(0, MAX_ITEMS), total: items.length };
}

function guidanceSlot(): Slot {
  return {
    id: "guidance",
    title: "Judgement: reviewer guidance",
    about: { kind: "report", ref: "change", label: "the change" },
    task: "In at most three sentences, tell the reviewer where to look first and what to ask the author, using only the findings and values shown in this report. When nothing needs attention, say what a quick review can skip. Do not name people.",
    verdicts: [],
    maxChars: 500,
  };
}

function limitsSlot(): Slot {
  return {
    id: "limits",
    title: "Judgement: what limits this summary",
    about: { kind: "report", ref: "change", label: "the change" },
    task: "In at most three sentences, say what limits how far this summary can be trusted for this change, using only the evidence grade, the unavailable factors and the missing results shown above.",
    verdicts: [],
    maxChars: 500,
  };
}

/** The ratio of a factor's guidelines, as the words the page prints. A count is met from a value, a percentile cutoff is exceeded. */
function guidelineText(factor: Factor): string {
  const parts = Object.entries(factor.guidelines).map(([series, cutoffs]) => {
    if (cutoffs === null) return `${series}: no cutoff, the baseline is too small`;
    if (cutoffs.moderate === cutoffs.high) return `${series}: ${series === "count" ? "from" : "above"} ${cutoffs.high} is high, with no moderate band: the moderate and high cutoffs are the same value`;
    return series === "count" ? `${series}: moderate from ${cutoffs.moderate}, high from ${cutoffs.high}` : `${series}: moderate above ${cutoffs.moderate}, high above ${cutoffs.high}`;
  });
  return parts.length === 0 ? "none" : parts.join("; ");
}

function valueText(factor: Factor): string {
  const parts = Object.entries(factor.value)
    .filter(([, value]) => value !== null && typeof value !== "object")
    .map(([key, value]) => `${key} ${value}`);
  const label = factor.name === "complexity-delta" && factor.source === INDENTATION_PROXY ? `${INDENTATION_PROXY}: ` : "";
  return parts.length === 0 ? `${label}none` : `${label}${parts.join(", ")}`;
}

function bandText(factor: Factor): string {
  return factor.status === "ok" ? (factor.band ?? "none") : factor.status;
}

function factorBlocks(assessed: Assessed, compact: boolean): Block[] {
  if (compact) return [];
  const { factors } = assessed;
  const baseline = assessed.baseline;
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `Each band compares the change with the ${plural(baseline.population, "merged change")} measured as of their own time since ${isoDate(baseline.since)}, and counts are met from a stated value. A band labels the value beside it and decides nothing.`,
    },
    {
      type: "ranked-table",
      caption: "Risk factors with their values and bands",
      numbered: false,
      columns: [
        { key: "factor", label: "Factor" },
        { key: "band", label: "Band" },
        { key: "value", label: "Value" },
        { key: "guideline", label: "Guideline" },
        { key: "evidence", label: "Evidence items", align: "right" },
      ],
      rows: factors.map((f): Record<string, Cell> => ({ factor: f.name, band: bandText(f), value: valueText(f), guideline: guidelineText(f), evidence: f.evidence.length })),
    },
  ];
  const unavailable = factors.filter((f) => f.status !== "ok");
  if (unavailable.length > 0) {
    blocks.push({ type: "evidence-list", title: "Factors with no band", items: unavailable.map((f) => ({ id: f.name, text: `${f.status}: ${f.reason ?? "no reason given"}` })) });
  }
  return blocks;
}

function abandonedBlocks(assessed: Assessed): Block[] {
  const factor = assessed.factors.find((f) => f.name === "abandoned-touched");
  if (factor === undefined || factor.status !== "ok") {
    return [{ type: "notice", level: "notice", text: `Abandoned touched files could not be computed: ${factor?.reason ?? "the factor is not available"}.` }];
  }
  const baseline = number(factor.value.baseline) ?? 0;
  const count = number(factor.value.count) ?? 0;
  if (count === 0) return [{ type: "notice", level: "notice", text: `No touched file is abandoned or above the repository's baseline abandonment probability of ${baseline}.` }];
  const rows = factor.evidence.map((e): Record<string, Cell> => ({ file: text(e.file), abandoned: e.abandoned === true ? "yes" : "no", probability: number(e.probability) }));
  const table = capRows(
    {
      caption: `Touched files that are abandoned or above the repository's baseline abandonment probability of ${baseline}, the probability one developer leaves within the horizon, which every file has from the turnover model alone`,
      noun: "files",
      total: count,
      numbered: false,
      emptyText: `No touched file is abandoned or above the repository's baseline abandonment probability of ${baseline}.`,
      columns: [
        { key: "file", label: "File" },
        { key: "abandoned", label: "Abandoned now" },
        { key: "probability", label: "Probability of abandonment", align: "right" },
      ],
      rows,
    },
    ROWS,
    "cochange abandonment simulate",
  );
  return [{ type: "ranked-table", ...table }];
}

function evidenceBlocks(assessed: Assessed): Block[] {
  return assessed.factors
    .filter((f) => f.status === "ok" && f.evidence.length > 0 && f.name !== "abandoned-touched")
    .map((f): Block => {
      const { items, omitted } = evidenceItems(f.evidence);
      return { type: "evidence-list", title: `Evidence for ${f.name}`, items, omitted };
    });
}

function levelBlocks(level: LevelResult): Block[] {
  if (level.status !== "shown") {
    const why = level.backtest === null && level.status === "unavailable" && level.reason?.startsWith("no stored backtest")
      ? "a level is shown only where a stored backtest shows that the levels separate past changes, and none is stored for this configuration"
      : (level.reason ?? "it is not available");
    return [{ type: "notice", level: "notice", text: `No level is shown: ${why}.` }];
  }
  const backtest = level.backtest!;
  return [
    {
      type: "facts",
      caption: "Level, from a stored backtest of this repository",
      facts: [
        { label: "Level", value: level.value ?? "none" },
        { label: "Backtest made at", value: short(backtest.head) },
        { label: "Commits since the backtest", value: backtest.commitsAgo === null ? "unknown" : String(backtest.commitsAgo) },
        { label: "Levels separate past changes", value: backtest.separation.status },
        { label: "Placement", value: "not part of this report, so the level is read with placement unknown, as `cochange risk` reads it when placement is withheld" },
      ],
    },
  ];
}

function missingBlocks(assessed: Assessed): Block[] {
  const factor = assessed.factors.find((f) => f.name === "missing-co-change");
  if (factor === undefined || factor.status !== "ok") {
    return [{ type: "notice", level: "notice", text: `Missing co-change partners could not be computed: ${factor?.reason ?? "the factor is not available"}.` }];
  }
  const skipped = number(factor.value.manifestPartnersSkipped) ?? 0;
  const skippedNotice: Block[] = skipped === 0 ? [] : [{ type: "notice", level: "notice", text: `${plural(skipped, "build manifest")} that list${skipped === 1 ? "s" : ""} source files (such as CMakeLists.txt) usually change with a touched file and are not in the change; ${skipped === 1 ? "it is" : "they are"} not counted as missing, because the change adds, removes or renames no code file in ${skipped === 1 ? "its" : "their"} folder.` }];
  if (factor.evidence.length === 0) return [...skippedNotice, { type: "notice", level: "notice", text: "No file that usually changes with a touched file is missing from the change." }];
  const rows = factor.evidence.map((e): Record<string, Cell> => ({ file: text(e.file), towards: text(e.towards), confidence: number(e.confidence), support: number(e.support) }));
  return [
    ...skippedNotice,
    {
      type: "ranked-table",
      caption: "Files that usually change with a touched file and are not in the change",
      noun: "partners",
      total: rows.length,
      columns: [
        { key: "file", label: "Missing file" },
        { key: "towards", label: "Usually changes with" },
        { key: "confidence", label: "Confidence (%)", align: "right", guideline: { value: assessed.risk.missingConfidence, note: "cochange.risk.missingConfidence", direction: "below" } },
        { key: "support", label: "Shared changes", align: "right", guideline: { value: assessed.context.minSupport, note: "cochange.minSupport", direction: "below" } },
      ],
      rows: rows.slice(0, ROWS),
    },
  ];
}

function complexityBlocks(evidence: ChangeEvidence): Block[] {
  const complexity = evidence.complexity;
  if (complexity === null) {
    return [{ type: "notice", level: "notice", text: "No complexity comparison was passed in. The complexity-delta factor in the risk table is the indentation proxy (production code files whose indentation complexity rose), not a complexity comparison, and lists no units. Run `complexity check --json` (or `complexity diff BASE..HEAD --json`) for this base and pass it with `--evidence FILE`, then run this report again." }];
  }
  const blocks: Block[] = [];
  if (complexity.rows.length === 0) {
    blocks.push({ type: "notice", level: "notice", text: `No new function is above a guideline and no existing one above it got worse${complexity.compared === null ? "" : `, over ${plural(complexity.compared, "compared function")}`}, from complexity ${complexity.source}.` });
  } else {
    const rows = complexity.rows.map((r): Record<string, Cell> => ({
      unit: r.id,
      metric: r.metric,
      change: r.kind === "new" ? "new" : "worsened",
      before: r.before,
      after: r.after,
      guideline: r.guideline,
      against: r.guideline === null ? "above guideline" : r.after > r.guideline ? `above guideline by ${r.after - r.guideline}` : "at guideline",
    }));
    blocks.push({
      type: "ranked-table",
      caption: `Functions above a complexity guideline that are new or got worse, from complexity ${complexity.source}`,
      noun: "rows",
      total: rows.length,
      numbered: false,
      columns: [
        { key: "unit", label: "Function" },
        { key: "metric", label: "Metric" },
        { key: "change", label: "Change" },
        { key: "before", label: "Before", align: "right" },
        { key: "after", label: "After", align: "right" },
        { key: "guideline", label: "Guideline", align: "right" },
        { key: "against", label: "Against the guideline" },
      ],
      rows: rows.slice(0, ROWS),
    });
  }
  if (complexity.unsupportedFiles > 0) blocks.push({ type: "notice", level: "limit", text: `${plural(complexity.unsupportedFiles, "changed file")} could not be parsed, so ${complexity.unsupportedFiles === 1 ? "its" : "their"} functions were not compared.` });
  return blocks;
}

function structureBlocks(evidence: ChangeEvidence): Block[] {
  if (evidence.structure === null) {
    return [{ type: "notice", level: "notice", text: "No structure check was passed in. Run `structure check --json` for this base and pass it with `--evidence FILE`, then run this report again." }];
  }
  if (evidence.structure.length === 0) return [{ type: "notice", level: "notice", text: "The change adds no import cycle and no layer violation, from structure check." }];
  return [
    {
      type: "ranked-table",
      caption: "Import cycles and layer violations the change adds, from structure check",
      noun: "findings",
      total: evidence.structure.length,
      numbered: false,
      columns: [
        { key: "kind", label: "Kind" },
        { key: "id", label: "Finding" },
        { key: "detail", label: "Detail" },
      ],
      rows: evidence.structure.slice(0, ROWS).map((r): Record<string, Cell> => ({ kind: r.kind, id: r.id, detail: r.detail })),
    },
  ];
}

function hotspotBlocks(assessed: Assessed): Block[] {
  const factor = assessed.factors.find((f) => f.name === "hotspots-touched");
  if (factor === undefined || factor.status !== "ok") {
    return [{ type: "notice", level: "notice", text: `Hotspots touched could not be computed: ${factor?.reason ?? "the factor is not available"}.` }];
  }
  const hot = number(factor.value.hotFiles) ?? 0;
  const share = number(factor.value.share) ?? 0;
  const blocks: Block[] = [
    {
      type: "facts",
      caption: "Hotspots the change touches",
      facts: [
        { label: "Hot files touched", value: String(hot) },
        { label: "Share of the change's churn in hot files", value: `${Math.round(share * 1000) / 10}%` },
        { label: "Band", value: bandText(factor) },
        { label: "Guideline", value: guidelineText(factor) },
      ],
    },
  ];
  blocks.push({
    type: "ranked-table",
    caption: "Hot files the change touches, by revisions in the window",
    noun: "files",
    total: factor.evidence.length,
    emptyText: "The change touches no hot file.",
    columns: [
      { key: "file", label: "File" },
      { key: "revisions", label: "Revisions", align: "right" },
    ],
    rows: factor.evidence.slice(0, ROWS).map((e): Record<string, Cell> => ({ file: text(e.file), revisions: number(e.revisions) })),
  });
  return blocks;
}

/** A range that covers several landed changes is their union, and the factors that describe one change then describe the union. */
function landedBlocks(assessed: Assessed): Block[] {
  const { landed, commits } = assessed.change;
  if (landed <= 1) return [];
  return [{ type: "notice", level: "limit", text: `This range covers ${landed} landed changes and ${plural(commits.length, "commit")}, so the per-change factors (size, spread, novel coupling and the others) describe their union, not one change. Name a single change as BASE..HEAD to read it alone.` }];
}

function changeBlocks(assessed: Assessed): Block[] {
  const { change } = assessed;
  const added = change.files.reduce((sum, f) => sum + (f.added ?? 0), 0);
  const deleted = change.files.reduce((sum, f) => sum + (f.deleted ?? 0), 0);
  return [
    ...landedBlocks(assessed),
    {
      type: "facts",
      caption: "The change",
      facts: [
        { label: "Range", value: `${short(change.base)}..${short(change.head)}${change.against === null || change.against === change.base ? "" : `, against ${change.against}`}` },
        { label: "Commits", value: String(change.commits.length) },
        { label: "Files changed", value: String(change.files.length) },
        { label: "Lines added and deleted", value: `${added} and ${deleted}` },
        { label: "Files moved or renamed", value: String(change.moved) },
        { label: "Commits with an agent trailer", value: String(change.agentCommits) },
      ],
    },
  ];
}

function attentionSection(assessed: Assessed, items: Item[], total: number, compact: boolean): Section {
  const notices = compact ? landedBlocks(assessed) : [];
  if (total === 0) return { id: "attention", heading: "Needs attention", blocks: [...notices, { type: "paragraph", text: "Nothing needs attention: the risk factors raise no finding, and the complexity and structure results passed in, where there are any, show nothing new." }] };
  // The full report lists every item with its verdict. The compact form lists the items judged needs-change or not yet judged, and counts the rest.
  const blocks: Block[] = compact
    ? [
        ...notices,
        {
          type: "judged-items",
          items: items.map((item) => ({ slot: item.slot.id, blocks: [] })),
          fold: { keep: ["needs-change"], labels: { "false-positive": "false positive", "accepted-with-reason": "accepted with a reason" }, pointer: "see the full report" },
          emptyText: "Nothing needs attention.",
        },
      ]
    : items.flatMap((item): Block[] => [{ type: "evidence-list", title: item.heading, items: item.evidence, omitted: item.omitted }, { type: "judgement", slot: item.slot.id }]);
  if (total > items.length) blocks.push({ type: "notice", level: "notice", text: `${plural(total - items.length, "more item")} need attention and have no judgement slot, to keep the summary short. ${compact ? "The full report lists them" : "The tables below list them"}.` });
  return { id: "attention", heading: "Needs attention", blocks };
}

function excludedOf(assessed: Assessed): ExcludedCount[] {
  const dropped = assessed.history.filtersApplied;
  const labels: [keyof typeof dropped.dropped, string][] = [
    ["outsideWindow", "commits outside the window"],
    ["shallowBoundaryCommits", "shallow boundary commits"],
    ["importedCommits", "imported commits"],
    ["blameIgnoredCommits", "commits in the blame ignore file"],
    ["botCommits", "bot and service commits"],
    ["suiteCommits", "commits trailed by this suite"],
    ["emptyAfterFiltering", "commits with no file left"],
    ["pureRenames", "rename-only file changes"],
    ["excludedByGlob", "file changes under exclude globs"],
    ["lockfiles", "lockfile changes"],
    ["generated", "generated file changes"],
    ["vendored", "vendored file changes"],
  ];
  const kinds: Record<string, string> = { generated: "generated files", vendored: "vendored files", nonCode: "non-code files", tests: "test files" };
  return [
    { what: "changed paths under the noise filters", count: assessed.change.filtered },
    ...labels.map(([key, what]) => ({ what: `baseline: ${what}`, count: dropped.dropped[key] })),
    { what: `baseline: changes over ${dropped.maxChangesetSize} files`, count: dropped.oversizedChanges },
    ...Object.entries(droppedCounts()).map(([kind, count]) => ({ what: `${kinds[kind] ?? kind} left out of rankings`, count: count ?? 0 })),
    ...Object.entries(builtinOmissions()).map(([entry, count]) => ({ what: `files under built-in exclude ${entry}`, count })),
  ].filter((e) => e.count > 0);
}

function limitsOf(assessed: Assessed, level: LevelResult, evidence: ChangeEvidence, compact: boolean): string[] {
  const unavailable = assessed.factors.filter((f) => f.status === "unavailable").map((f) => f.name);
  const history = assessed.history.evidence;
  return [
    "Guidelines order and label what is shown. They are heuristics for review and decide nothing.",
    ...(history.grade === "weak" ? ["The evidence grade is weak, so the history-based bands are tentative and the static results should lead."] : []),
    ...(history.truncated.shallow ? ["The clone is shallow, so history before its boundary is missing."] : []),
    ...(unavailable.length === 0 ? [] : [`No band for ${unavailable.join(", ")}: the factor could not be computed.`]),
    ...(level.status === "shown" || compact ? [] : ["No level is shown, because no stored backtest of this repository says the levels separate past changes."]),
    ...(evidence.complexity === null ? ["No complexity comparison was passed in, so complexity before and after is not shown."] : []),
    ...(evidence.structure === null ? ["No structure check was passed in, so new cycles and layer violations are not shown."] : []),
    ...(compact ? [] : ["Who wrote the touched code (placement) is about people, so this report leaves it out. Names of people appear nowhere on this page."]),
  ];
}

/** The stored backtest's commit, how many commits the change's tip is past it. */
async function commitsSince(root: string, from: string, to: string): Promise<number | null> {
  try {
    return Number((await runGit(root, ["rev-list", "--count", `${from}..${to}`])).trim());
  } catch {
    return null;
  }
}

const NO_PLACEMENT: PlacementOutcome = {
  status: "off",
  mode: "report",
  reason: "the change summary leaves placement out",
  placement: null,
  factors: [],
  blame: { used: false, missing: 0, refreshed: false },
};

function evidenceFiles(context: CommandContext): string[] {
  const value = context.values.evidence;
  return value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(String);
}

export const change: ReportKind = {
  summary: "What a branch or pull request changes and the evidence around it: risk factors, missing co-change partners, complexity before and after, new structure findings and hotspots touched",
  usage: "[BASE[..HEAD]]",
  options: { evidence: { type: "string", multiple: true }, "no-refresh": { type: "boolean" } },
  optionHelp: {
    evidence: "complexity check, complexity diff or structure check output (JSON) for this change's base; repeat for several files",
    "no-refresh": "read the history cache without bringing it up to date",
  },
  async dependsOn(context: CommandContext) {
    const resolved = await resolveRange(context.repo.root, { range: context.positionals[0], mainBranch: readRiskSettings(context.config).mainBranch, worktree: false });
    const files = evidenceFiles(context).map((file) => {
      try {
        return createHash("sha256").update(readFileSync(isAbsolute(file) ? file : join(context.repo.root, file))).digest("hex");
      } catch {
        return null;
      }
    });
    return { base: resolved.base, head: resolved.head, evidence: files };
  },
  async build(context: CommandContext): Promise<ReportBuild> {
    if (context.positionals.length > 1) throw usageError("usage: report change [BASE[..HEAD]] [--evidence FILE...]");
    const root = context.repo.root;
    const requested = context.positionals[0];
    const risk = readRiskSettings(context.config);
    const resolved = await resolveRange(root, { range: requested, mainBranch: risk.mainBranch, worktree: false });
    const files = evidenceFiles(context);
    const evidence = files.length === 0 ? NO_CHANGE_EVIDENCE : readChangeEvidence(root, files, resolved);
    const history = await loadHistory(context, { noRefresh: context.values["no-refresh"] === true, wholeHistory: true, ref: resolved.head });
    const assessed = await assessBranch(context, history, { range: requested, worktree: false, evidence: evidence.forAssessment });

    const stored = readStoredBacktest(root, context.config.hash);
    const behind = stored === null ? null : await commitsSince(root, stored.head, assessed.change.head);
    const level = levelResult(assessed, NO_PLACEMENT, stored, behind);

    const compact = context.values.compact === true;
    const { shown, total } = attentionItems(assessed, evidence);
    const hist = assessed.history.evidence;
    const sections: Section[] = compact
      ? [
          attentionSection(assessed, shown, total, true),
          { id: "guidance", heading: "Reviewer guidance", blocks: [{ type: "judgement", slot: "guidance" }] },
        ]
      : [
          { id: "change", heading: "The change", blocks: changeBlocks(assessed) },
          { id: "guidance", heading: "Reviewer guidance", blocks: [{ type: "judgement", slot: "guidance" }] },
          attentionSection(assessed, shown, total, false),
          { id: "factors", heading: "Risk factors", blocks: [...factorBlocks(assessed, false), ...levelBlocks(level)] },
          { id: "missing-co-change", heading: "Missing co-change partners", blocks: missingBlocks(assessed) },
          { id: "complexity", heading: "Complexity before and after", blocks: complexityBlocks(evidence) },
          { id: "structure", heading: "Structure findings the change adds", blocks: structureBlocks(evidence) },
          { id: "hotspots", heading: "Hotspots touched", blocks: hotspotBlocks(assessed) },
          { id: "abandoned", heading: "Abandoned files touched", blocks: abandonedBlocks(assessed) },
          { id: "evidence", heading: "Evidence behind the factors", blocks: evidenceBlocks(assessed) },
        ];
    return dropEmptySlots({
      title: `Change summary ${short(assessed.change.base)}..${short(assessed.change.head)}${compact ? ` (${plural(assessed.change.commits.length, "commit")}, ${plural(assessed.change.files.length, "file")})` : ""}`,
      inputs: {
        range: requested ?? null,
        base: assessed.change.base,
        head: assessed.change.head,
        baseline: assessed.baseline,
        evidence: evidence.files,
        locality: assessed.locality?.input ?? null,
        abandonment: assessed.abandonment,
        backtest: stored === null ? null : { head: stored.head, config: context.config.hash },
      },
      header: {
        evidenceGrade: hist.grade,
        historyWindow: `${hist.usableHistoryMonths} months of usable history; the baseline is the ${plural(assessed.baseline.population, "merged change")} since ${isoDate(assessed.baseline.since)}`,
        excluded: excludedOf(assessed),
      },
      sections,
      limits: limitsOf(assessed, level, evidence, compact),
      slots: [...shown.map((item) => item.slot), guidanceSlot(), limitsSlot()],
    });
  },
};
