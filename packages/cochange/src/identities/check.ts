import { counterEvidenceWithin } from "@code-health/history/identity-evidence";
import { identityKey, normaliseEmail } from "@code-health/history/identity-names";
import { isoDay, type IdentityAnalysis } from "./analysis.ts";
import type { MeasurementDetail } from "./measure.ts";
import { proposeRows } from "./views.ts";

export type FindingKind = "email-conflict" | "counter-evidence" | "rejected-merge-applied" | "unmapped";

export interface Finding {
  /** Conflicts rank above unmapped identities. */
  score: number;
  kind: FindingKind;
  /** Identities the finding is about, as `Name <email>`. */
  identities: string[];
  detail: string;
  /** Unmapped only: commits as author in the analysis window (merge commits are not counted), lines at HEAD and the share of people's lines. `propose` and `list` count `commits` over the whole history. */
  windowCommits: number | null;
  lines: number | null;
  linesShare: number | null;
  /** Unmapped only: holds lines at HEAD or has at least `significantCommits` commits in the window. A guideline for reading the list: identities below it are listed too, after those above. */
  aboveGuideline: boolean | null;
  /** People the finding is about who are no longer active. */
  formerContributors: number;
}

/** Who is a former contributor. */
export interface Activity {
  /** By mapped identity (node key): a person with no commit in the activity window. */
  isFormer: (node: string) => boolean;
}

/** A finding as built, with the people it is about. */
type Draft = Omit<Finding, "formerContributors"> & { about: string[] };

const CONFLICT_SCORE = 100;

const compare = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

function conflict(kind: FindingKind, identities: string[], detail: string, about: string[]): Draft {
  return { score: CONFLICT_SCORE, kind, identities: [...new Set(identities)].sort(compare), detail, windowCommits: null, lines: null, linesShare: null, aboveGuideline: null, about };
}

/**
 * Validates the mapping. Conflicts fail the check: one address belonging to two
 * identities, identities joined by the mailmap that look like different people,
 * a merge the decisions say is wrong, and proposals that carry counter-evidence.
 * Every unmapped identity is reported, those holding lines or with many commits first, and none of them fails it.
 */
export function checkMapping(analysis: IdentityAnalysis, detail: MeasurementDetail, activity: Activity): { findings: Finding[]; failed: boolean } {
  const findings: Draft[] = [];
  const { significantCommits } = analysis.history.settings.identities;

  // One address under two mapped identities.
  const byAddress = new Map<string, Set<string>>();
  for (const raw of analysis.raws) {
    const node = analysis.nodeOfRaw.get(identityKey(raw))!;
    for (const email of [normaliseEmail(raw.email), normaliseEmail(raw.mappedEmail)]) {
      const set = byAddress.get(email) ?? new Set<string>();
      set.add(node);
      byAddress.set(email, set);
    }
  }
  // Only when the mailmap acted on one of them: two unreviewed look-alikes are unmapped, not in conflict.
  const rewritten = new Set(analysis.nodes.filter((n) => n.aliases.some((a) => identityKey(a) !== n.key)).map((n) => n.key));
  for (const [email, nodes] of [...byAddress].sort(([p], [q]) => compare(p, q))) {
    if (nodes.size > 1 && [...nodes].some((n) => rewritten.has(n))) findings.push(conflict("email-conflict", [...nodes], `${email} belongs to ${nodes.size} different mapped identities`, [...nodes]));
  }

  // Identities joined by the mailmap that the evidence or a decision says are different people.
  const rejected = analysis.history.identities.decisions.rejectedMerges.map((r) => r.identities.map((i) => i.toLowerCase()));
  const groups = new Map<string, typeof analysis.raws>();
  for (const raw of analysis.raws) {
    const node = analysis.nodeOfRaw.get(identityKey(raw))!;
    groups.set(node, [...(groups.get(node) ?? []), raw]);
  }
  for (const [node, group] of [...groups].sort(([p], [q]) => compare(p, q))) {
    if (group.length < 2) continue;
    const keys = new Set(group.map((r) => identityKey(r).toLowerCase()));
    for (const pair of rejected) {
      if (pair.every((k) => keys.has(k!))) {
        findings.push(
          conflict("rejected-merge-applied", group.map(identityKey), `the mailmap maps ${pair.join(" and ")} to ${node}, which a recorded decision says are different people`, [node]),
        );
      }
    }
    for (const { a, b, signal } of counterEvidenceWithin(group)) {
      findings.push(conflict("counter-evidence", [a, b], `joined into ${node} by the mailmap, but ${signal.detail}`, [node]));
    }
  }

  // Proposals still pending whose evidence points the other way.
  for (const proposal of proposeRows(analysis).filter((p) => p.counterEvidence)) {
    const counter = proposal.links.flatMap((l) => l.signals).find((s) => s.strength === "counter");
    const members = proposal.members.map((m) => m.identity);
    findings.push(conflict("counter-evidence", members, `${proposal.id} is proposed but ${counter?.detail ?? "has counter-evidence"}`, members.map((m) => analysis.nodeOfRaw.get(m) ?? m)));
  }

  // People the mapping has not settled, when they matter.
  const peopleLines = detail.measurement.headLines.people;
  for (const node of analysis.nodes.filter((n) => analysis.unresolved.has(n.key))) {
    const lines = detail.linesByNode.get(node.key) ?? 0;
    const commits = detail.windowCommitsByNode.get(node.key) ?? 0;
    const related = [...new Set(analysis.proposals.filter((p) => p.members.includes(node.key)).flatMap((p) => p.members).filter((m) => m !== node.key))].sort(compare);
    findings.push({
      score: lines,
      kind: "unmapped",
      identities: [node.key],
      detail: `proposed to be the same person as ${related.join("; ")}, last active ${isoDay(node.last)}`,
      about: [node.key, ...related],
      windowCommits: commits,
      lines,
      linesShare: peopleLines === 0 ? 0 : Math.round((lines / peopleLines) * 1000) / 10,
      aboveGuideline: lines > 0 || commits >= significantCommits,
    });
  }

  findings.sort((x, y) => y.score - x.score || (y.windowCommits ?? 0) - (x.windowCommits ?? 0) || compare(x.kind, y.kind) || compare(x.identities.join(), y.identities.join()));
  return {
    findings: findings.map(({ about, ...finding }) => ({ ...finding, formerContributors: new Set(about.filter(activity.isFormer)).size })),
    failed: findings.some((f) => f.kind !== "unmapped"),
  };
}
