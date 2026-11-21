import { configError } from "@code-health/cli-kit/errors";
import type { LogicalChange } from "@code-health/history/noise";
import { componentOf, type Component } from "./components.ts";

export type By = "file" | "component";

/** What a file, or a component, did over the history that was read. */
export interface Unit {
  /** The file's path, or the component's name. */
  name: string;
  /** Files in the unit: always 1 for a file. */
  files: number;
  /** Logical changes that touched the unit. A change touching two files of a component counts once. */
  revisions: number;
  /** Lines added plus lines deleted. Binary files add nothing. */
  churn: number;
  /** Committer date of the earliest revision, unix seconds. */
  firstSeen: number;
  /** Committer date of the latest revision, unix seconds. */
  lastChanged: number;
  /** The files of the unit. */
  members: Set<string>;
}

/**
 * Totals per file for files that exist at the head, each file identified by
 * its stable identity so a moved file keeps its history. Pure renames and
 * filtered paths are already gone from `changes`, and oversized changes count
 * here, since frequency includes them.
 */
export function fileUnits(changes: readonly LogicalChange[], present: ReadonlySet<string>): Unit[] {
  const units = new Map<string, Unit>();
  for (const change of changes) {
    const seen = new Set<string>();
    for (const file of change.files) {
      if (!present.has(file.fileId)) continue;
      const churn = (file.added ?? 0) + (file.deleted ?? 0);
      const unit = units.get(file.fileId);
      if (!unit) {
        units.set(file.fileId, {
          name: file.fileId,
          files: 1,
          revisions: 1,
          churn,
          firstSeen: change.committerDate,
          lastChanged: change.committerDate,
          members: new Set([file.fileId]),
        });
        seen.add(file.fileId);
      } else {
        if (!seen.has(file.fileId)) unit.revisions++;
        seen.add(file.fileId);
        unit.churn += churn;
        unit.firstSeen = Math.min(unit.firstSeen, change.committerDate);
        unit.lastChanged = Math.max(unit.lastChanged, change.committerDate);
      }
    }
  }
  return [...units.values()];
}

/** Groups the changes by component instead of by file. Files outside every component form one group. */
export function componentUnits(
  changes: readonly LogicalChange[],
  present: ReadonlySet<string>,
  components: readonly Component[],
): Unit[] {
  if (components.length === 0) {
    throw configError('code-health.json: --by component needs "components" to be configured');
  }
  const groups = new Map<string, Unit>();
  for (const change of changes) {
    const counted = new Set<string>();
    for (const file of change.files) {
      if (!present.has(file.fileId)) continue;
      const name = componentOf(components, file.fileId);
      const churn = (file.added ?? 0) + (file.deleted ?? 0);
      let unit = groups.get(name);
      if (!unit) {
        unit = {
          name,
          files: 0,
          revisions: 0,
          churn: 0,
          firstSeen: change.committerDate,
          lastChanged: change.committerDate,
          members: new Set(),
        };
        groups.set(name, unit);
      }
      unit.members.add(file.fileId);
      unit.files = unit.members.size;
      if (!counted.has(name)) {
        counted.add(name);
        unit.revisions++;
      }
      unit.churn += churn;
      unit.firstSeen = Math.min(unit.firstSeen, change.committerDate);
      unit.lastChanged = Math.max(unit.lastChanged, change.committerDate);
    }
  }
  return [...groups.values()];
}
