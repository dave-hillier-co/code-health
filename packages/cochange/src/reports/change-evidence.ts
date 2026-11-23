import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { usageError } from "@code-health/cli-kit/errors";

/**
 * The per-branch results of the complexity and structure plugins that the change summary shows, passed in with
 * `--evidence FILE` as `cochange risk` takes them. They describe one branch, so they are not stored results: the
 * skill runs them and hands their JSON over, and this CLI never invokes another plugin.
 *
 * Accepted: `complexity check --json` (the new functions above a guideline and the existing ones above it that got
 * worse, with a guideline per metric), `complexity diff --json` (the functions the change added or changed, of which
 * the ones over a guideline and new or worse are kept), and `structure check --json` (the cycles and layer
 * violations the change adds). Each must name the change's own base.
 */
export interface ComplexityRow {
  id: string;
  path: string;
  unit: string;
  kind: "new" | "worsened";
  metric: string;
  before: number | null;
  after: number;
  /** The guideline the value is over, when the source states it (check does, diff names only the label). */
  guideline: number | null;
}

export interface StructureRow {
  kind: "cycle" | "layer-violation";
  id: string;
  level: string | null;
  detail: string;
}

export interface EvidenceFile {
  tool: string;
  command: string;
  /** A short hash of the file, so the stamp names what the report depended on without a path. */
  hash: string;
}

export interface ChangeEvidence {
  files: EvidenceFile[];
  complexity: { source: "check" | "diff"; rows: ComplexityRow[]; compared: number | null; unsupportedFiles: number } | null;
  structure: StructureRow[] | null;
  /** The files `assessBranch` can read itself: they make the `complexity-delta` and `structure-delta` factors. */
  forAssessment: string[];
}

interface Document {
  tool?: unknown;
  command?: unknown;
  inputs?: { base?: { sha?: unknown } | string; head?: { sha?: unknown } | null; baseSha?: unknown; analysed?: unknown; against?: unknown };
  results?: unknown;
  summary?: unknown;
  unsupportedFiles?: unknown;
}

export const NO_CHANGE_EVIDENCE: ChangeEvidence = { files: [], complexity: null, structure: null, forAssessment: [] };

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

/** Reads and checks the evidence files. A file that is not what the report reads, or is about another change, is a usage error. */
export function readChangeEvidence(root: string, files: readonly string[], change: { base: string; head: string }): ChangeEvidence {
  let complexity: ChangeEvidence["complexity"] = null;
  let structure: StructureRow[] | null = null;
  const read: EvidenceFile[] = [];
  const forAssessment: string[] = [];
  for (const file of files) {
    const path = isAbsolute(file) ? file : join(root, file);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      throw usageError(`--evidence ${file}: cannot read it (a relative path is taken from the repository root)`);
    }
    let document: Document;
    try {
      document = JSON.parse(content) as Document;
    } catch {
      throw usageError(`--evidence ${file}: not JSON; pass the output of \`complexity check --json\`, \`complexity diff --json\` or \`structure check --json\``);
    }
    const tool = text(document.tool);
    const command = text(document.command);
    if (!Array.isArray(document.results)) throw usageError(`--evidence ${file}: no results list`);
    checkAgainst(file, document, change);
    const rows = document.results as Record<string, unknown>[];
    if (tool === "complexity" && (command === "check" || command === "diff")) {
      if (complexity !== null && complexity.source === command) throw usageError(`--evidence names complexity ${command} twice`);
      // check states the guideline and is the ratchet itself, so it wins over diff when both are passed.
      const parsed: NonNullable<ChangeEvidence["complexity"]> = command === "check" ? fromCheck(rows, document) : fromDiff(rows, document);
      if (complexity === null || command === "check") complexity = parsed;
      if (command === "diff") forAssessment.push(file);
    } else if (tool === "structure" && command === "check") {
      if (structure !== null) throw usageError("--evidence names structure check twice");
      structure = rows.filter((row) => row.kind === "cycle" || row.kind === "layer-violation").map(structureRow);
      forAssessment.push(file);
    } else {
      throw usageError(`--evidence ${file}: ${tool}/${command} is not evidence this report reads; pass \`complexity check --json\`, \`complexity diff --json\` or \`structure check --json\``);
    }
    read.push({ tool, command, hash: createHash("sha256").update(content).digest("hex").slice(0, 16) });
  }
  return { files: read, complexity, structure, forAssessment };
}

function fromCheck(rows: Record<string, unknown>[], document: Document): NonNullable<ChangeEvidence["complexity"]> {
  const summary = record(document.summary);
  return {
    source: "check",
    compared: number(summary.compared),
    unsupportedFiles: number(document.unsupportedFiles) ?? 0,
    rows: rows.map((row) => ({
      id: text(row.id) || text(row.path),
      path: text(row.path),
      unit: text(row.unit) || text(row.id),
      kind: row.finding === "new" ? "new" : "worsened",
      metric: text(row.metric),
      before: number(row.before),
      after: number(row.after) ?? 0,
      guideline: number(row.guideline),
    })),
  };
}

function fromDiff(rows: Record<string, unknown>[], document: Document): NonNullable<ChangeEvidence["complexity"]> {
  const kept: ComplexityRow[] = [];
  for (const row of rows) {
    const labels = Array.isArray(row.labels) ? row.labels.map(String) : [];
    const added = row.change === "added";
    const before = record(row.before);
    const after = record(row.after);
    const delta = record(row.delta);
    for (const label of labels) {
      const match = /^(.*)-(warn|high)$/.exec(label);
      if (match === null) continue;
      const metric = match[1]!;
      if (!added && (number(delta[metric]) ?? 0) <= 0) continue;
      kept.push({
        id: text(row.id) || text(row.path),
        path: text(row.path),
        unit: text(row.unit) || text(row.id),
        kind: added ? "new" : "worsened",
        metric,
        before: added ? null : number(before[metric]),
        after: number(after[metric]) ?? 0,
        guideline: null,
      });
    }
  }
  return { source: "diff", compared: rows.length, unsupportedFiles: number(document.unsupportedFiles) ?? 0, rows: kept };
}

function structureRow(row: Record<string, unknown>): StructureRow {
  const kind = row.kind === "cycle" ? "cycle" : "layer-violation";
  const nodes = Array.isArray(row.nodes) ? row.nodes.map(String) : [];
  const detail =
    kind === "cycle"
      ? `${nodes.length} modules${typeof row.level === "string" ? ` at the ${row.level} level` : ""}${nodes.length > 0 ? `: ${nodes.slice(0, 4).join(", ")}${nodes.length > 4 ? ", ..." : ""}` : ""}`
      : `${text(row.fromLayer) || "a layer"} imports ${text(row.toLayer) || "another layer"}`;
  return { kind, id: text(row.id) || text(row.edge) || text(row.path), level: typeof row.level === "string" ? row.level : null, detail };
}

/** Evidence about another base or tip says nothing about this change. */
function checkAgainst(file: string, document: Document, change: { base: string; head: string }): void {
  const inputs = document.inputs;
  const named = typeof inputs?.base === "object" ? inputs.base?.sha : inputs?.base;
  const base = inputs?.baseSha ?? named;
  if (typeof base === "string" && base.length >= 7 && !change.base.startsWith(base) && base !== change.base) {
    throw usageError(`--evidence ${file}: made against ${base.slice(0, 10)}, but this change starts at ${change.base.slice(0, 10)}; run it for the same base`);
  }
  const head = inputs?.head?.sha ?? inputs?.analysed;
  if (typeof head === "string" && head !== change.head) {
    throw usageError(`--evidence ${file}: made up to ${head.slice(0, 10)}, but this change ends at ${change.head.slice(0, 10)}`);
  }
}
