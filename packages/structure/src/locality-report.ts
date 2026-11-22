import { existsSync, readFileSync } from "node:fs";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { edgeKey } from "./project.ts";
import { reportPath } from "./reports.ts";

/** The locality plugin's report whose blockers say which moves a dependency is holding back. */
export const LOCALITY_REPORT = { tool: "locality", command: "analyse" } as const;

/** The `schemaVersion` values of locality's report that this plugin knows how to read. */
export const RECOGNISED_LOCALITY_SCHEMA_VERSIONS: readonly number[] = [1];

/** A move held back by a dependency, and what it would gain if the dependency went. */
export interface Unblock {
  /** The unit (file or symbol id) whose move is blocked. */
  unit: string;
  unblockedGain: number;
}

export interface LocalityInput {
  report: string;
  head: string;
  config: string;
}

export interface LocalityUnblocks {
  input: LocalityInput;
  /** Blocked moves by `edgeKey(from file, to file)` of the blocking dependency. */
  byFileEdge: ReadonlyMap<string, readonly Unblock[]>;
}

interface Blocker {
  from?: unknown;
  path?: unknown;
  unblockedGain?: unknown;
}

/**
 * Reads locality's report, which this plugin may do only when it is whole: from locality,
 * stamped with the current head, taken on a clean tree. Rows carry `path` (or `id`) and
 * `blockers`, each naming the dependency (`from`, the unit's files that import it, and `path`, the file they
 * depend on) and its `unblockedGain`.
 * Anything else, or no report, gives undefined, and the caller works without it. A report whose `schemaVersion`
 * is not one of `RECOGNISED_LOCALITY_SCHEMA_VERSIONS` is ignored, and a line on stderr says so and why.
 */
export function readLocalityUnblocks(context: CommandContext, head: string): LocalityUnblocks | undefined {
  const file = reportPath(context.repo.root, LOCALITY_REPORT.command, LOCALITY_REPORT.tool);
  if (!existsSync(file)) return undefined;
  let document: { schemaVersion?: unknown; tool?: unknown; command?: unknown; repo?: { head?: unknown; dirty?: unknown }; config?: unknown; results?: unknown };
  try {
    document = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (document.schemaVersion !== 1) return undefined;
  if (document.tool !== LOCALITY_REPORT.tool || document.command !== LOCALITY_REPORT.command) return undefined;
  if (typeof document.schemaVersion !== "number" || !RECOGNISED_LOCALITY_SCHEMA_VERSIONS.includes(document.schemaVersion)) {
    const found = document.schemaVersion === undefined ? "has no schemaVersion" : `has schemaVersion ${JSON.stringify(document.schemaVersion)}`;
    (context.stderrNotices ??= []).push(
      `structure: ignored ${LOCALITY_REPORT.tool}.${LOCALITY_REPORT.command}.json because it ${found}, and this version of structure reads schemaVersion ${RECOGNISED_LOCALITY_SCHEMA_VERSIONS.join(", ")}`,
    );
    return undefined;
  }
  if (document.repo?.head !== head || document.repo?.dirty !== false) return undefined;
  if (!Array.isArray(document.results) || typeof document.config !== "string") return undefined;

  const byFileEdge = new Map<string, Unblock[]>();
  for (const row of document.results as Record<string, unknown>[]) {
    const unit = typeof row.path === "string" ? row.path : typeof row.id === "string" ? row.id : undefined;
    if (unit === undefined || !Array.isArray(row.blockers)) continue;
    for (const blocker of row.blockers as Blocker[]) {
      if (!Array.isArray(blocker.from) || typeof blocker.path !== "string" || typeof blocker.unblockedGain !== "number") continue;
      for (const from of blocker.from) {
        if (typeof from !== "string") continue;
        const key = edgeKey(from, blocker.path);
        byFileEdge.set(key, [...(byFileEdge.get(key) ?? []), { unit, unblockedGain: blocker.unblockedGain }]);
      }
    }
  }
  for (const list of byFileEdge.values()) list.sort((a, b) => b.unblockedGain - a.unblockedGain || (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
  return {
    input: { report: `${LOCALITY_REPORT.tool}.${LOCALITY_REPORT.command}`, head, config: document.config },
    byFileEdge,
  };
}
