import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { builtinOmissions } from "@code-health/cli-kit/builtin-excludes";
import { buildDocument } from "@code-health/cli-kit/document";
import { droppedCounts } from "@code-health/cli-kit/dropped-files";
import type { CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { shapeResults } from "@code-health/cli-kit/results";
import { serialise } from "@code-health/cli-kit/serialise";
import { ensureCacheDir, locateCache } from "./cache-location.ts";

export interface ReportIdentity {
  tool: string;
  schemaVersion: number;
}

/**
 * The part of a stored result's file name that says which inputs of the command it was computed for. The
 * stated inputs are the command's own options that change the full result, such as the window, and only
 * those the run states: the default run has none, so its report keeps the plain name other plugins read.
 * Returns undefined for the default run. Keys are sorted, so the order a run states them in never matters.
 */
export function variantOf(stated: Record<string, unknown> | undefined): string | undefined {
  const entries = Object.entries(stated ?? {}).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return undefined;
  return createHash("sha256").update(canonical(Object.fromEntries(entries))).digest("hex").slice(0, 12);
}

/** The JSON of a value with its keys sorted, so two values that differ only in key order are the same string. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Where a command's report lives. Reports are per worktree, unlike the history cache. */
export function reportPath(root: string, tool: string, command: string, variant?: string): string {
  return join(root, ".cache", "code-health", "reports", `${tool}.${command}${variant === undefined ? "" : `.${variant}`}.json`);
}

/** Records on the context that this run stored no report, and why, so the run prints it. */
export function skipReport(context: CommandContext, reason: string): void {
  context.report = { stored: false, reason };
}

export interface WriteReportOptions {
  /** Which stated inputs the result was computed for (see `variantOf`). Absent for the default run. */
  variant?: string;
  /**
   * The result is a function of the commit and the config alone, so uncommitted edits cannot change it. It is
   * then stored from a dirty tree too, stamped as describing the commit `analysedHead`.
   */
  describesCommit?: boolean;
  /**
   * The report is read back to print the command's output as it was. The files the run left out
   * (`dropped`, `omittedByBuiltinExcludes`) are stored with it, and the columns and notices a table run
   * prints go in `meta.printed`.
   */
  replayable?: boolean;
  /** The code that computed the result (`codeIdentity`), stored as `codeIdentity` so a reader can refuse a result that other code wrote. */
  codeIdentity?: string;
}

/**
 * Stores the complete result of a command as `reports/<tool>.<command>[.<variant>].json`, stamped with the HEAD
 * SHA and config hash it was computed from (the same envelope the command prints). `--limit` and `--fields` are
 * never applied: the report holds every result. A replayable report also holds what a printed run adds to
 * the document beside `extra`, so it can be printed exactly as the run that computed it.
 *
 * Returns false, writing nothing, on a dirty tree (unless the result describes the commit), or when the
 * analysed commit (`analysedHead`) is not HEAD (again unless the result describes the commit), so a report
 * always describes the commit it is stamped with. Either way the outcome is left on `context.report`.
 *
 * The file is written to a temporary name and renamed into place, so two commands running at once
 * each leave a whole report and a reader never sees half of one.
 */
export async function writeReport(
  context: CommandContext,
  identity: ReportIdentity,
  command: string,
  output: CommandOutput,
  analysedHead: string,
  options: WriteReportOptions = {},
): Promise<boolean> {
  if (options.describesCommit !== true) {
    if (context.repo.dirty) {
      skipReport(context, "the working tree has uncommitted changes");
      return false;
    }
    if (analysedHead !== context.repo.head) {
      skipReport(context, "the analysed commit is not HEAD");
      return false;
    }
  }
  const { results, truncated } = shapeResults(output.results, { limit: Infinity, presorted: output.presorted });
  const dropped = options.replayable === true ? droppedCounts() : {};
  const builtin = options.replayable === true ? builtinOmissions() : {};
  const printed = {
    ...(output.columns === undefined ? {} : { columns: output.columns }),
    ...(output.notices === undefined || output.notices.length === 0 ? {} : { notices: output.notices }),
    ...(output.failed === true ? { failed: true } : {}),
    ...(output.presorted === true ? { presorted: true } : {}),
  };
  const document = buildDocument({
    schemaVersion: identity.schemaVersion,
    tool: identity.tool,
    command,
    repo: { head: analysedHead, dirty: false },
    configHash: context.config.hash,
    inputs: output.inputs,
    extra: {
      ...output.extra,
      ...(options.codeIdentity === undefined ? {} : { codeIdentity: options.codeIdentity }),
      ...(Object.keys(builtin).length === 0 ? {} : { omittedByBuiltinExcludes: builtin }),
      ...(Object.keys(dropped).length === 0 ? {} : { dropped }),
    },
    results,
    truncated,
    ...(options.replayable === true ? { meta: { printed } } : {}),
  });

  const file = reportPath(context.repo.root, identity.tool, command, options.variant);
  const location = await locateCache(context.repo.root);
  ensureCacheDir({ ...location, cacheDir: join(context.repo.root, ".cache", "code-health") });
  mkdirSync(join(file, ".."), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, serialise(document));
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  context.report = { stored: true };
  return true;
}
