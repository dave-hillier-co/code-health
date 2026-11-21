import type { CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { reportPath as sharedReportPath, writeReport as writeSharedReport } from "@code-health/history/reports";
import { SCHEMA_VERSION, TOOL } from "./tool.ts";

/** Where a command's report lives. Reports are per worktree, unlike the history cache. */
export function reportPath(root: string, command: string, tool: string = TOOL): string {
  return sharedReportPath(root, tool, command);
}

/**
 * Stores the complete result of a command as `reports/cochange.<command>.json`; see `writeReport` in the
 * history package for what a report holds and when it may be written.
 */
export function writeReport(
  context: CommandContext,
  command: string,
  output: CommandOutput,
  analysedHead: string,
): Promise<boolean> {
  return writeSharedReport(context, { tool: TOOL, schemaVersion: SCHEMA_VERSION }, command, output, analysedHead);
}
