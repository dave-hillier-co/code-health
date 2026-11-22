import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { blameLineCounts } from "@code-health/history/blame-lines";
import { identityKey } from "@code-health/history/identity-names";
import type { IdentityAnalysis } from "./analysis.ts";

export interface Share {
  /** Everything counted, including bots and services. */
  total: number;
  /** Held by identities classified as bots, services or agents, and left out of the share. */
  nonPerson: number;
  /** Held by people: total less non-person. */
  people: number;
  /** Held by people the mapping has not settled, because a proposal still names them. */
  unmapped: number;
  /** Percentage of people's share held by identities with nothing left to decide. 100 when nobody holds any. */
  mappedShare: number;
}

export interface Measurement {
  headLines: Share & {
    /** Lines whose commit is not in the analysed history (for example, a shallow boundary). Not counted. */
    unattributed: number;
  };
  windowCommits: Share;
  /** The configured percentage of lines that unmapped identities may hold before the identities skill is needed. */
  unmappedShareGuideline: number;
  /** Unmapped identities hold more than the guideline of people's lines. */
  needsIdentityReview: boolean;
}

export interface MeasurementDetail {
  measurement: Measurement;
  linesByNode: Map<string, number>;
  windowCommitsByNode: Map<string, number>;
}

const percent = (part: number, whole: number): number => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);

function share(byNode: Map<string, number>, analysis: IdentityAnalysis): Share {
  let total = 0;
  let nonPerson = 0;
  let unmapped = 0;
  for (const [node, count] of byNode) {
    total += count;
    if (analysis.nonPerson.has(node)) nonPerson += count;
    else if (analysis.unresolved.has(node)) unmapped += count;
  }
  const people = total - nonPerson;
  return { total, nonPerson, people, unmapped, mappedShare: people === 0 ? 100 : Math.round((100 - percent(unmapped, people)) * 10) / 10 };
}

/**
 * The share of HEAD lines, and of commits in the analysis window, held by
 * identities the mapping has settled. Lines are blamed at the analysed commit,
 * ignoring whitespace and the ignore-revs file.
 */
export async function measureMapping(context: CommandContext, analysis: IdentityAnalysis): Promise<MeasurementDetail> {
  const { history, facts, nodeOfRaw } = analysis;
  const blamed = await blameLineCounts(context.repo.root, history.view.headSha, { exclude: history.settings.exclude });

  const linesByNode = new Map<string, number>();
  let unattributed = 0;
  for (const [sha, lines] of blamed.bySha) {
    const author = facts.authorOfCommit.get(sha);
    const node = author && nodeOfRaw.get(identityKey(author));
    if (!node) unattributed += lines;
    else linesByNode.set(node, (linesByNode.get(node) ?? 0) + lines);
  }
  const windowCommitsByNode = new Map<string, number>();
  for (const [raw, count] of facts.windowCommits) {
    const node = nodeOfRaw.get(raw);
    if (node) windowCommitsByNode.set(node, (windowCommitsByNode.get(node) ?? 0) + count);
  }

  const headLines = { ...share(linesByNode, analysis), unattributed };
  const guideline = history.settings.identities.unmappedShareGuideline;
  return {
    measurement: {
      headLines,
      windowCommits: share(windowCommitsByNode, analysis),
      unmappedShareGuideline: guideline,
      needsIdentityReview: headLines.people > 0 && percent(headLines.unmapped, headLines.people) > guideline,
    },
    linesByNode,
    windowCommitsByNode,
  };
}
