import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { Block } from "../src/block.ts";
import type { Report, ReportBuild } from "../src/report-model.ts";
import { makeStamp } from "../src/stamp.ts";

export const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "golden");

/** Compares text with `golden/<name>`. UPDATE_GOLDEN=1 writes the file instead; review the diff. */
export function expectGoldenText(name: string, actual: string): void {
  const file = join(GOLDEN_DIR, name);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  expect(existsSync(file), `no golden ${name}; run with UPDATE_GOLDEN=1`).toBe(true);
  expect(actual).toBe(readFileSync(file, "utf8"));
}

/** One of every component, with fixed data. */
export const sampleTreemapItems = [
  { path: "src/core/engine.ts", size: 400, colour: 12 },
  { path: "src/core/util.ts", size: 120, colour: 3 },
  { path: "src/ui/page.ts", size: 200, colour: 7 },
  { path: "src/ui/form.ts", size: 90, colour: null },
  { path: "docs/guide.md", size: 60, colour: 1 },
  { path: "empty.txt", size: 0, colour: 0 },
];

export const sampleBlocks: Record<string, Block> = {
  paragraph: { type: "paragraph", text: "Run `structure cycles` and read <the table>." },
  facts: { type: "facts", caption: "Evidence", facts: [{ label: "Grade", value: "weak" }, { label: "Months", value: "3.5" }] },
  "ranked-table": {
    type: "ranked-table",
    caption: "Top files",
    noun: "files",
    total: 40,
    columns: [
      { key: "path", label: "File" },
      { key: "cognitive", label: "Cognitive", align: "right", guideline: { value: 15, note: "a judgement call" } },
      { key: "confidence", label: "Confidence", align: "right", guideline: { value: 50, direction: "below" } },
    ],
    rows: [
      { path: "src/a|b.ts", cognitive: 40, confidence: 80 },
      { path: "src/c.ts", cognitive: 15, confidence: 20 },
      { path: "src/d.ts", cognitive: null, confidence: 50 },
    ],
  },
  treemap: {
    type: "treemap",
    title: "Files by lines and revisions",
    sizeLabel: "lines",
    colourLabel: "revisions",
    items: sampleTreemapItems,
  },
  sparkline: { type: "sparkline", title: "Changes per month", unit: "changes", points: [{ label: "2025-01", value: 4 }, { label: "2025-02", value: 9 }, { label: "2025-03", value: 6 }] },
  histogram: { type: "histogram", title: "Complexity of files", unit: "files", bins: [{ label: "0 to 9", count: 30 }, { label: "10 to 19", count: 8 }, { label: "20 or more", count: 2 }] },
  matrix: { type: "matrix", title: "Shared changes", valueLabel: "shared changes", rows: ["a.ts", "b.ts"], columns: ["a.ts", "b.ts", "c.ts"], cells: [[null, 5, 1], [5, null, 9]] },
  "function-bars": { type: "function-bars", title: "Functions by cognitive complexity", unit: "cognitive complexity", guideline: 15, source: "Guideline from a judgement call.", bars: [{ label: "parse", value: 30, revisions: 12, fixes: 4 }, { label: "format", value: 10, revisions: 3, fixes: 0 }, { label: "plain", value: 5, revisions: null, fixes: null }], omitted: { count: 2, reason: "the least complex of the file" } },
  "guideline-bars": { type: "guideline-bars", title: "Against guidelines", unit: "cognitive", source: "Guideline from a judgement call.", bars: [{ label: "f", value: 30, guideline: 15 }, { label: "g", value: 10, guideline: 15 }] },
  scatter: {
    type: "scatter",
    title: "Revisions against complexity",
    xLabel: "Revisions",
    yLabel: "Complexity",
    noun: "files",
    xLog: true,
    yLog: true,
    xGuideline: { value: 8, name: "the 75th percentile of revisions" },
    yGuideline: { value: 40, name: "the 75th percentile of complexity" },
    quadrantNames: { upperRight: "look first", upperLeft: "complex, stable", lowerRight: "busy, simple", lowerLeft: "quiet" },
    maxLabels: 2,
    points: [
      { label: "src/core/engine.ts", short: "engine.ts", x: 40, y: 300, highlight: true },
      { label: "src/ui/page.ts", short: "page.ts", x: 12, y: 90, highlight: true },
      { label: "src/ui/form.ts", short: "form.ts", x: 9, y: 50, highlight: true },
      { label: "src/a.ts", x: 2, y: 5 },
      { label: "src/b.ts", x: 1, y: 0 },
      { label: "src/c.ts", x: 3, y: 120 },
      { label: "src/d.ts", x: 20, y: 10 },
    ],
  },
  "stability-chart": {
    type: "stability-chart",
    title: "Packages by instability and abstractness",
    zoneDistance: 0.5,
    zoneSource: "structure.packages.zoneDistance",
    total: 6,
    points: [
      { name: "core", instability: 0.1, abstractness: 0.1, distance: 0.8, ca: 9, ce: 1, exportedTypes: 10, weak: false },
      { name: "ports", instability: 0.9, abstractness: 1, distance: 0.9, ca: 1, ce: 9, exportedTypes: 2, weak: true },
      { name: "app", instability: 0.6, abstractness: 0.4, distance: 0, ca: 2, ce: 3, exportedTypes: 5, weak: false },
    ],
  },
  "trend-marker": { type: "trend-marker", label: "support", earlier: 4, later: 9, windows: ["2024", "2025"] },
  "evidence-list": { type: "evidence-list", title: "Commits", items: [{ id: "abc1234", text: "Fix the parser", detail: "2025-03-01" }, { id: "def5678", text: "Fix again" }], omitted: 3 },
  notice: { type: "notice", level: "limit", text: "History is short." },
  judgement: { type: "judgement", slot: "look" },
};

export const sampleBuild: ReportBuild = {
  title: "Sample report",
  inputs: { arg: "x" },
  header: { evidenceGrade: "moderate", historyWindow: "8 months of history", excluded: [{ what: "generated files", count: 3 }] },
  sections: [
    { id: "overview", heading: "Overview", blocks: [sampleBlocks.paragraph!, sampleBlocks.judgement!, sampleBlocks["ranked-table"]!, sampleBlocks.notice!] },
    { id: "charts", heading: "Charts", blocks: ["treemap", "sparkline", "histogram", "scatter", "matrix", "function-bars", "guideline-bars", "trend-marker", "evidence-list", "facts"].map((k) => sampleBlocks[k]!) },
  ],
  limits: ["The sample is small."],
  slots: [
    { id: "look", title: "Judgement: look", about: { kind: "file", ref: "src/a.ts", label: "src/a.ts" }, task: "Say what to do.", verdicts: ["act", "wait"], maxChars: 100 },
    { id: "limits", title: "Judgement: limits", about: { kind: "report", ref: "sample", label: "the sample" }, task: "Say what limits it.", verdicts: [], maxChars: 100 },
  ],
};

export function sampleReport(): Report {
  return { ...sampleBuild, kind: "sample", header: { repo: "demo", commit: "0123456789abcdef0123456789abcdef01234567", date: "2025-06-01", configHash: "abcdef0123456789", ...sampleBuild.header }, stamp: makeStamp("sample", "0123456789abcdef0123456789abcdef01234567", "abcdef0123456789", sampleBuild.inputs) };
}

export const sampleNotes = { look: { verdict: "act", text: "Split it <now>." }, limits: { text: "Short history." } };
