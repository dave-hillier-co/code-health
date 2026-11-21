import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { folderOf } from "@code-health/graph/tree-distance";
import { monthsBefore } from "@code-health/history/evidence";
import { commitsInSnapshot, lineShares, resolveOwners } from "@code-health/history/blame-owners";
import { readBlame } from "@code-health/history/blame-read";
import { refreshBlame } from "@code-health/history/blame-refresh";
import type { Assessed } from "./assess.ts";
import { componentOf } from "../components.ts";
import { invokingUser } from "./identity.ts";

/** The most reviewers suggested for one area. */
export const REVIEWERS_PER_AREA = 3;

export interface Candidate {
  name: string;
  email: string;
  /** Sum over the area's touched files of the share of lines the developer last wrote (blame), or of changes (history without blame). */
  authorship: number;
  /** The developer's changes in the window to the files that change with the touched ones. */
  coupledChanges: number;
}

export interface Area {
  area: string;
  files: number;
  candidates: Candidate[];
}

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * Suggested reviewers per touched area: active developers ranked by how much of the area's touched files
 * they last wrote and by their changes to files coupled with them. The change's own authors are not
 * suggested to review it, and bots, services and agents never are.
 *
 * An area is a configured component, or else a folder. This is a suggestion drawn from the same evidence
 * as abandonment's successors, and names appear only when the caller asks for them.
 */
export async function reviewersFor(context: CommandContext, assessed: Assessed, noRefresh: boolean): Promise<{ areas: Area[]; basis: "blame" | "history" | "mixed" }> {
  const { change, history, state, risk } = assessed;
  const root = context.repo.root;
  const time = assessed.facts.time;
  const activeSince = monthsBefore(time, history.settings.windowMonths);
  const authors = new Set(assessed.facts.authors);
  // Uncommitted edits are the invoking user's own, so they are not suggested to review them.
  if (change.worktree) {
    const user = await invokingUser(root, history.identities.localMailmap);
    if (user !== null) authors.add(user.email.toLowerCase());
  }

  const names = new Map<string, string>();
  for (const commit of history.view.commits) names.set(commit.mappedEmail.toLowerCase(), commit.mappedName);

  const paths = [...new Set(change.files.filter((f) => f.status !== "A").map((f) => f.oldPath ?? f.path))].sort();
  const options = { ref: change.base, exclude: history.settings.exclude, paths };
  const shares = new Map<string, Map<string, { name: string; email: string; share: number }>>();
  if (paths.length > 0) {
    if (!noRefresh) await refreshBlame(root, options);
    const snapshot = await readBlame(root, options);
    const owners = await resolveOwners(root, commitsInSnapshot(snapshot), { localMailmap: history.identities.localMailmap, matcher: history.identities.matcher });
    for (const file of change.files) {
      const blame = snapshot.files.get(file.oldPath ?? file.path);
      if (!blame) continue;
      const counted = lineShares(blame.ranges, owners);
      if (counted.people === 0) continue;
      const byEmail = new Map<string, { name: string; email: string; share: number }>();
      const person = new Map([...owners.values()].map((o) => [o.key, o]));
      for (const [key, lines] of counted.byOwner) {
        const owner = person.get(key)!;
        const seen = byEmail.get(owner.email.toLowerCase());
        byEmail.set(owner.email.toLowerCase(), { name: owner.name, email: owner.email, share: (seen?.share ?? 0) + lines / counted.people });
      }
      shares.set(file.fileId, byEmail);
    }
  }

  const isActivePerson = (email: string): boolean => {
    const seen = state.identity(email);
    if (seen === null || seen.last < activeSince) return false;
    // A bot or agent is never a reviewer.
    const classified = history.identities.matcher.classify(names.get(email) ?? "", email);
    return classified === null;
  };

  const windowSince = activeSince;
  const byArea = new Map<string, typeof change.files>();
  for (const file of change.files) {
    const area = assessed.context.components.length > 0 ? componentOf(assessed.context.components, file.path) : folderOf(file.path) || ".";
    byArea.set(area, [...(byArea.get(area) ?? []), file]);
  }

  let withBlame = 0;
  const areas: Area[] = [...byArea]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([area, files]) => {
      const scores = new Map<string, Candidate>();
      const credit = (email: string, name: string, patch: Partial<Candidate>) => {
        const key = email.toLowerCase();
        const row = scores.get(key) ?? { name, email, authorship: 0, coupledChanges: 0 };
        scores.set(key, { ...row, authorship: row.authorship + (patch.authorship ?? 0), coupledChanges: row.coupledChanges + (patch.coupledChanges ?? 0) });
      };
      for (const file of files) {
        const blamed = shares.get(file.fileId);
        if (blamed) {
          withBlame++;
          for (const owner of blamed.values()) credit(owner.email, owner.name, { authorship: owner.share });
        } else {
          // Without blame, a developer's share of the file's recent changes stands in for their share of its lines.
          const revisions = state.revisionsSince(file.fileId, windowSince);
          for (const revision of revisions) for (const author of revision.authors) credit(author, names.get(author.toLowerCase()) ?? author, { authorship: 1 / revisions.length });
        }
        for (const [partner, support] of state.partners(file.fileId)) {
          const together = state.eligibleRevisionsInWindow(file.fileId);
          if (support < assessed.context.minSupport || 100 * support < risk.missingConfidence * together) continue;
          for (const revision of state.revisionsSince(partner, windowSince)) {
            for (const author of revision.authors) credit(author, names.get(author.toLowerCase()) ?? author, { coupledChanges: 1 });
          }
        }
      }
      const candidates = [...scores.values()]
        .filter((c) => isActivePerson(c.email) && !authors.has(c.email.toLowerCase()))
        .map((c) => ({ ...c, authorship: round(c.authorship) }))
        .sort((a, b) => b.authorship - a.authorship || b.coupledChanges - a.coupledChanges || (a.email < b.email ? -1 : 1));
      return { area, files: files.length, candidates };
    });
  const total = change.files.length;
  return { areas, basis: withBlame === 0 ? "history" : withBlame === total ? "blame" : "mixed" };
}
