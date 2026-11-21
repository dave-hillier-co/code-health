import { usageError } from "@code-health/cli-kit/errors";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { listTree } from "@code-health/history/tree";
import { readComponents } from "./components.ts";
import { componentUnits, fileUnits, type By, type Unit } from "./file-statistics.ts";
import type { LoadedHistory } from "./history-access.ts";

export const SECONDS_PER_DAY = 86_400;

export const isoDate = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString();

export const byOption = { by: { type: "string" } } as const;

/** The `--by` view: files, unless components are asked for. */
export function readBy(context: CommandContext): By {
  const value = context.values.by;
  if (value === undefined) return "file";
  if (value === "file" || value === "component") return value;
  throw usageError(`--by must be "file" or "component", not "${String(value)}"`);
}

/** A grouped view is a slice of the repository's answer, so it is printed but not stored as the report. */
export const isGrouped = (context: CommandContext): boolean => readBy(context) !== "file";

/** The files or components of the history, restricted to files that still exist at the analysed commit. */
export async function loadUnits(context: CommandContext, history: LoadedHistory): Promise<Unit[]> {
  const by = readBy(context);
  const present = new Set(await listTree(context.repo.root, history.view.headSha));
  const { changes } = history.filtered;
  return by === "file"
    ? fileUnits(changes, present)
    : componentUnits(changes, present, readComponents(context.config.effective.components));
}
