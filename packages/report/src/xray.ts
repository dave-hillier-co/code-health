import type { Block } from "./block.ts";
import type { Cell, RankedTableData } from "./components/ranked-table.ts";
import type { Slot } from "./protocol.ts";
import { capRows } from "./table-cap.ts";

/** One function of an X-Ray, as the complexity plugin measures it. A figure the source does not give is null. */
export interface XrayFunction {
  /** The unit id, `path#name`. */
  id: string;
  name: string;
  startLine: number;
  endLine: number;
  length: number | null;
  cognitive: number | null;
  nesting: number | null;
  cyclomatic: number | null;
  /** Code smell labels such as `cognitive-warn` and `bumpy-road`. */
  labels: string[];
  /** Revisions of the function in the history window, or null when no fix result says. */
  revisions: number | null;
  /** Fix commits that changed the function in the window, or null when no fix result is available. */
  fixes: number | null;
}

/** The warn levels the legend shows. Length has none: it is reported and never gated. */
export interface XrayGuidelines {
  cognitive: number;
  cyclomatic: number;
  nesting: number;
  /** Where the values come from, for the legend. */
  note: string;
}

export interface XrayData {
  file: string;
  /** In the order to show them: the most complex first. */
  functions: XrayFunction[];
  /** Absent when the source of the measures does not say which guidelines labelled them. */
  guidelines?: XrayGuidelines;
  /** The most functions the table lists (default `XRAY_ROWS`); the page says how many it omits. */
  rows?: number;
  /** The command whose output lists every function, named where the table is cut. */
  allCommand?: string;
}

/** The functions an X-Ray table lists unless the data says otherwise: a guideline, not a limit on what is measured. */
export const XRAY_ROWS = 25;

/**
 * The names a parser gives a second unit of the same name in one file end in `~2`, `~3`, in source order: an
 * overload in C# and Java, a repeated name in a language without overloads. The suffix is part of the stable
 * unit id, so matching across revisions keeps it. A page prints it as "(variant 2)".
 */
export function displayName(name: string): string {
  return name.replace(/~(\d+)/g, " (variant $1)");
}

/** The default order of functions: cognitive complexity, then cyclomatic complexity, both highest first, then source order. A function without a figure goes last. */
export function byComplexity(a: XrayFunction, b: XrayFunction): number {
  const desc = (x: number | null, y: number | null) => (y ?? -1) - (x ?? -1);
  return desc(a.cognitive, b.cognitive) || desc(a.cyclomatic, b.cyclomatic) || a.startLine - b.startLine;
}

/** The red flags and code smells a judgement may name for a file or a function. */
export const FLAG_VERDICTS = [
  "none-applies",
  "nonobvious-code",
  "bumpy-road",
  "shallow-module",
  "information-leakage",
  "special-general-mixture",
  "overexposure",
  "pass-through-method",
  "conjoined-methods",
  "temporal-decomposition",
  "repetition",
  "vague-name",
  "hard-to-describe",
  "other",
];

/** The functions of an X-Ray that get a judgement slot in the X-Ray report. */
export const XRAY_JUDGED = 5;

const guidelineOf = (value: number | undefined, guidelines: XrayGuidelines | undefined) =>
  value === undefined || guidelines === undefined ? {} : { guideline: { value, note: guidelines.note } };

const lines = (fn: XrayFunction) => `${fn.startLine}-${fn.endLine}`;

/** The table of an X-Ray, with the guidelines as its legend, and a notice when no fix result covers the functions. */
export function xrayBlocks(data: XrayData): Block[] {
  const withFixes = data.functions.some((fn) => fn.fixes !== null);
  const withRevisions = data.functions.some((fn) => fn.revisions !== null);
  const sorted = [...data.functions].sort(byComplexity);
  const full: RankedTableData = {
    caption: `X-Ray of ${data.file}: its functions, most complex first`,
    noun: "functions",
    total: sorted.length,
    columns: [
      { key: "function", label: "Function" },
      { key: "lines", label: "Lines" },
      { key: "length", label: "Length", align: "right" },
      { key: "cognitive", label: "Cognitive", align: "right", ...guidelineOf(data.guidelines?.cognitive, data.guidelines) },
      { key: "nesting", label: "Nesting", align: "right", ...guidelineOf(data.guidelines?.nesting, data.guidelines) },
      { key: "cyclomatic", label: "Cyclomatic", align: "right", ...guidelineOf(data.guidelines?.cyclomatic, data.guidelines) },
      ...(withRevisions ? [{ key: "revisions", label: "Revisions", align: "right" as const }] : []),
      { key: "fixes", label: "Fixes", align: "right" },
      { key: "smells", label: "Code smells" },
    ],
    rows: sorted.map((fn): Record<string, Cell> => ({
      function: displayName(fn.name),
      lines: lines(fn),
      length: fn.length,
      cognitive: fn.cognitive,
      nesting: fn.nesting,
      cyclomatic: fn.cyclomatic,
      revisions: fn.revisions,
      fixes: fn.fixes,
      smells: fn.labels.length === 0 ? "none" : fn.labels.join(", "),
    })),
  };
  const cut: Block = { ...capRows(full, data.rows ?? XRAY_ROWS, data.allCommand ?? `complexity analyse ${data.file} --with-fixes --limit all`), type: "ranked-table" };
  return [
    cut,
    ...(withFixes ? [] : [{ type: "notice" as const, level: "notice" as const, text: "No fix result covers these functions, so revisions and fixes are not shown." }]),
  ];
}

/** One judgement slot per function, for the first `XRAY_JUDGED` functions. */
export function xraySlots(data: XrayData): Slot[] {
  return [...data.functions].sort(byComplexity).slice(0, XRAY_JUDGED).map((fn) => ({
    id: `function:${fn.id}`,
    title: `Judgement: ${displayName(fn.name)}`,
    about: { kind: "unit", ref: fn.id, label: `${displayName(fn.name)} (${data.file}, lines ${lines(fn)})` },
    task:
      "Read the function in the file. Give the red flag or code smell you judge present in it, or none-applies, and in one or two sentences say what makes it hard to read or change and the smallest next step, citing only the values the table shows. A long linear function with low nesting is not a smell on its own.",
    verdicts: FLAG_VERDICTS,
    maxChars: 400,
  }));
}
