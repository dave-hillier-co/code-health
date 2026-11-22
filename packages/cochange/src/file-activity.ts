import type { CommandOutput } from "@code-health/cli-kit/run-cli";
import { monthsBefore } from "@code-health/history/evidence";
import type { Derived } from "./derived-results.ts";
import type { LoadedHistory } from "./history-access.ts";

export const name = "units";

/** Per-file activity, stored for each window. It is read by `brief`, never printed by a command of its own. */
export const derived: Derived = { command: name, stated: () => ({}) };

export interface FileActivity {
  path: string;
  /** Logical changes in the window that touched the file, oversized ones included. */
  revisions: number;
  /** Of those, the ones in the recent window before the analysed commit. */
  recentRevisions: number;
  /** Committer date of the latest of them, unix seconds. */
  lastChanged: number;
}

/** What each file that changed in the window did, by the file's stable identity, whether or not it still exists. */
export function fileActivity(history: LoadedHistory): FileActivity[] {
  const recentSince = monthsBefore(history.view.headDate, history.settings.recentMonths);
  const activity = new Map<string, FileActivity>();
  for (const change of history.filtered.changes) {
    for (const id of new Set(change.files.map((file) => file.fileId))) {
      const entry = activity.get(id) ?? { path: id, revisions: 0, recentRevisions: 0, lastChanged: change.committerDate };
      entry.revisions++;
      if (change.committerDate >= recentSince) entry.recentRevisions++;
      entry.lastChanged = Math.max(entry.lastChanged, change.committerDate);
      activity.set(id, entry);
    }
  }
  return [...activity.values()];
}

export function activityOutput(history: LoadedHistory): CommandOutput {
  return {
    inputs: { recentMonths: history.settings.recentMonths },
    results: fileActivity(history),
    columns: ["path", "revisions", "recentRevisions", "lastChanged"],
    // Ages are counted from the analysed commit's date, which a stated window's end does not change.
    extra: { headDate: history.view.headDate },
  };
}
