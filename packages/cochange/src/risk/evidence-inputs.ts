import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { usageError } from "@code-health/cli-kit/errors";

/**
 * Per-branch results of sibling plugins, passed in with `--evidence FILE`. They describe one branch, so
 * they are not reports in the suite's sense (full runs stamped with HEAD): the skill runs them and hands
 * their JSON over, and this CLI never invokes another plugin.
 *
 * Accepted:
 * - `complexity diff --json`, for the change's own base. A unit counts when it is over a threshold
 *   (a label ending in `-warn` or `-high`) and either new or worse (a positive cognitive delta).
 * - `structure check --json`: its results are the cycles and layer violations new since the base, each
 *   a row with a `kind` of `cycle` or `layer-violation`. A row marked `new: false` is not counted.
 */
export interface ComplexityEvidence {
  stamp: EvidenceStamp;
  units: { id: string; path: string; change: string; cognitive: number | null; delta: number | null; labels: string[] }[];
  /** Changed files the complexity plugin could not parse, so their units were not compared. */
  unsupportedFiles: number;
}

export interface StructureEvidence {
  stamp: EvidenceStamp;
  findings: { kind: string; id: string }[];
}

export interface EvidenceStamp {
  tool: string;
  command: string;
  /** A short hash of the file, so the output names what it depended on without a path. */
  hash: string;
}

export interface EvidenceInputs {
  complexity: ComplexityEvidence | null;
  structure: StructureEvidence | null;
  stamps: EvidenceStamp[];
}

interface Document {
  tool?: unknown;
  command?: unknown;
  inputs?: { base?: { sha?: unknown }; head?: { sha?: unknown } | null };
  results?: unknown;
}

export const NO_EVIDENCE: EvidenceInputs = { complexity: null, structure: null, stamps: [] };

/** Reads and checks the evidence files. A bad one is a usage error, never silently ignored. */
export function readEvidence(root: string, files: readonly string[], change: { base: string; head: string; worktree: boolean }): EvidenceInputs {
  let complexity: ComplexityEvidence | null = null;
  let structure: StructureEvidence | null = null;
  const stamps: EvidenceStamp[] = [];
  for (const file of files) {
    const path = isAbsolute(file) ? file : join(root, file);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      throw usageError(`--evidence ${file}: cannot read it (a relative path is taken from the repository root)`);
    }
    let document: Document;
    try {
      document = JSON.parse(text) as Document;
    } catch {
      throw usageError(`--evidence ${file}: not JSON; pass the output of \`complexity diff --json\` or \`structure check --json\``);
    }
    const tool = String(document.tool ?? "");
    const command = String(document.command ?? "");
    const stamp: EvidenceStamp = { tool, command, hash: createHash("sha256").update(text).digest("hex").slice(0, 16) };
    if (!Array.isArray(document.results)) throw usageError(`--evidence ${file}: no results list`);
    checkAgainst(file, document, change);

    if (tool === "complexity" && command === "diff") {
      if (complexity) throw usageError("--evidence names complexity diff twice");
      const raw = document as Document & { unsupportedFiles?: unknown };
      complexity = {
        stamp,
        unsupportedFiles: typeof raw.unsupportedFiles === "number" ? raw.unsupportedFiles : 0,
        units: (document.results as Record<string, unknown>[]).map((row) => ({
          id: String(row.id ?? row.path ?? ""),
          path: String(row.path ?? ""),
          change: String(row.change ?? ""),
          cognitive: numberAt(row.after, "cognitive"),
          delta: numberAt(row.delta, "cognitive"),
          labels: Array.isArray(row.labels) ? row.labels.map(String) : [],
        })),
      };
    } else if (tool === "structure" && command === "check") {
      if (structure) throw usageError("--evidence names structure check twice");
      structure = {
        stamp,
        findings: (document.results as Record<string, unknown>[])
          .filter((row) => (row.kind === "cycle" || row.kind === "layer-violation") && row.new !== false)
          .map((row) => ({ kind: String(row.kind), id: String(row.id ?? row.edge ?? row.path ?? "") })),
      };
    } else {
      throw usageError(`--evidence ${file}: ${tool}/${command} is not evidence this command reads; pass \`complexity diff --json\` or \`structure check --json\``);
    }
    stamps.push(stamp);
  }
  return { complexity, structure, stamps };
}

function numberAt(value: unknown, key: string): number | null {
  const found = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  return typeof found === "number" ? found : null;
}

/** Evidence about another base or tip says nothing about this change. */
function checkAgainst(file: string, document: Document, change: { base: string; head: string; worktree: boolean }): void {
  const base = document.inputs?.base?.sha;
  if (typeof base === "string" && base !== change.base) {
    throw usageError(`--evidence ${file}: made against ${base.slice(0, 10)}, but this change starts at ${change.base.slice(0, 10)}; run it for the same base`);
  }
  const head = document.inputs?.head;
  if (!change.worktree && head !== null && head !== undefined && typeof head.sha === "string" && head.sha !== change.head) {
    throw usageError(`--evidence ${file}: made up to ${head.sha.slice(0, 10)}, but this change ends at ${change.head.slice(0, 10)}`);
  }
}

/** Units the complexity diff reports as over a threshold and either new or worse. */
export function overThreshold(evidence: ComplexityEvidence): ComplexityEvidence["units"] {
  return evidence.units.filter((unit) => {
    const over = unit.labels.some((label) => /-(warn|high)$/.test(label));
    return over && (unit.change === "added" || (unit.delta ?? 0) > 0);
  });
}
