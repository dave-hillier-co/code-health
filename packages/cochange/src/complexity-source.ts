import { existsSync, readFileSync } from "node:fs";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { readBlobAt } from "@code-health/history/tree";
import { indentationComplexity } from "@code-health/lexical/indentation-complexity";
import { reportPath } from "./reports.ts";

/** The complexity plugin's report that hotspots may read. */
export const COMPLEXITY_REPORT = { tool: "complexity", command: "files" } as const;

/** Name of the key holding a file's complexity in that report's result rows. */
const COMPLEXITY_FIELD = "complexity";

export type ComplexitySource = "complexity-report" | "indentation";

export interface ComplexityInput {
  report: string;
  head: string;
  config: string;
}

export interface FileComplexity {
  source: ComplexitySource;
  /** Complexity per path. null when the source cannot say: binary or unreadable files, files the report omits. */
  values: Map<string, number | null>;
  /** The sibling report that was read, as it is named in `inputs`, or null when the proxy was used. */
  input: ComplexityInput | null;
}

interface ReportDocument {
  tool?: unknown;
  command?: unknown;
  repo?: { head?: unknown; dirty?: unknown };
  config?: unknown;
  results?: unknown;
}

/** The report's rows when it is whole, from this tool and stamped with the current head. Otherwise undefined. */
function readComplexityReport(root: string, head: string): { document: ReportDocument; rows: Map<string, number> } | undefined {
  const file = reportPath(root, COMPLEXITY_REPORT.command, COMPLEXITY_REPORT.tool);
  if (!existsSync(file)) return undefined;
  let document: ReportDocument;
  try {
    document = JSON.parse(readFileSync(file, "utf8")) as ReportDocument;
  } catch {
    return undefined;
  }
  if (document.tool !== COMPLEXITY_REPORT.tool || document.command !== COMPLEXITY_REPORT.command) return undefined;
  if (document.repo?.head !== head || document.repo?.dirty !== false) return undefined;
  if (!Array.isArray(document.results) || typeof document.config !== "string") return undefined;
  const rows = new Map<string, number>();
  for (const row of document.results as Record<string, unknown>[]) {
    const value = row[COMPLEXITY_FIELD];
    if (typeof row.path === "string" && typeof value === "number") rows.set(row.path, value);
  }
  return { document, rows };
}

/**
 * Complexity for files at the head commit. A complexity report that covers the
 * analysed commit is preferred and named in `inputs`. Without one, the file's
 * indentation complexity is computed from its blob at the head commit.
 */
export async function loadComplexity(
  context: CommandContext,
  headSha: string,
  paths: readonly string[],
): Promise<FileComplexity> {
  const report = readComplexityReport(context.repo.root, headSha);
  if (report) {
    return {
      source: "complexity-report",
      values: new Map(paths.map((path) => [path, report.rows.get(path) ?? null])),
      input: {
        report: `${COMPLEXITY_REPORT.tool}.${COMPLEXITY_REPORT.command}`,
        head: headSha,
        config: report.document.config as string,
      },
    };
  }

  const values = new Map<string, number | null>();
  const batch = 32;
  for (let start = 0; start < paths.length; start += batch) {
    const slice = paths.slice(start, start + batch);
    const texts = await Promise.all(slice.map((path) => readBlobAt(context.repo.root, headSha, path)));
    slice.forEach((path, i) => {
      const text = texts[i];
      values.set(path, text === undefined || text.includes("\0") ? null : indentationComplexity(text, path));
    });
  }
  return { source: "indentation", values, input: null };
}
