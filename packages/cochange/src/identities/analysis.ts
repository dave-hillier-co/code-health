import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { monthsBefore } from "@code-health/history/evidence";
import {
  buildNodes,
  buildProposals,
  findLinks,
  type IdentityNode,
  type Link,
  type Proposal,
  type RawIdentity,
} from "@code-health/history/identity-evidence";
import { gatherIdentityFacts, type IdentityFacts } from "@code-health/history/identity-log";
import { mapThroughMailmap } from "@code-health/history/identity-mapping";
import { identityKey, type Address } from "@code-health/history/identity-names";
import type { Classification } from "@code-health/history/identity-classify";
import { loadHistory, type LoadedHistory } from "../history-access.ts";

export interface IdentityAnalysis {
  history: LoadedHistory;
  facts: IdentityFacts;
  /** Raw identities with `mappedName` and `mappedEmail` from the working tree mailmap. */
  raws: RawIdentity[];
  /** One per mapped identity, bots and services included. Sorted by key. */
  nodes: IdentityNode[];
  nodeOfRaw: Map<string, string>;
  /** Non-person classification of a node's mapped identity, by node key. People are absent. */
  nonPerson: Map<string, Classification>;
  links: Link[];
  proposals: Proposal[];
  /** Nodes that appear in a proposal: someone has to decide about them. */
  unresolved: Set<string>;
  /** Nodes that appear in a strong proposal: the evidence settles them, and the skill accepts those without asking. */
  strongProposed: Set<string>;
  /** Start of the analysis window, unix seconds. */
  windowSince: number;
}

export interface AnalyseOptions {
  noRefresh: boolean;
}

/** Everything the identity commands share: facts from history, the mapping as it stands, classification and proposals. */
export async function analyseIdentities(context: CommandContext, options: AnalyseOptions): Promise<IdentityAnalysis> {
  const history = await loadHistory(context, { noRefresh: options.noRefresh, wholeHistory: true });
  const { settings, identities } = history;
  const windowSince = monthsBefore(history.view.headDate, settings.windowMonths);
  const facts = await gatherIdentityFacts(context.repo.root, history.view, {
    windowSince,
    agentPatterns: settings.identities.agentTrailerPatterns,
    matcher: identities.matcher,
  });

  const mapped = await mapThroughMailmap(context.repo.root, facts.raws, identities.localMailmap);
  const raws = facts.raws.map((raw): RawIdentity => {
    const to = mapped.get(identityKey(raw)) ?? raw;
    return { ...raw, mappedName: to.name, mappedEmail: to.email };
  });
  const nodes = buildNodes(raws);
  const nodeOfRaw = new Map(raws.map((r) => [identityKey(r), identityKey({ name: r.mappedName, email: r.mappedEmail })]));

  const nonPerson = new Map<string, Classification>();
  for (const node of nodes) {
    const own = identities.matcher.classify(node.name, node.email);
    const everyAliasNonPerson =
      node.aliases.length > 0 && node.aliases.every((a) => identities.matcher.classify(a.name, a.email) !== null);
    const found = own ?? (everyAliasNonPerson ? identities.matcher.classify(node.aliases[0]!.name, node.aliases[0]!.email) : null);
    if (found) nonPerson.set(node.key, found);
  }

  const people = nodes.filter((n) => !nonPerson.has(n.key));
  const personKeys = new Set(people.map((n) => n.key));
  const personRaws = raws.filter((r) => personKeys.has(identityKey({ name: r.mappedName, email: r.mappedEmail })));
  const links = findLinks(people, personRaws, facts.pairing, identities.decisions.rejectedMerges);
  const proposals = buildProposals(links);
  const unresolved = new Set(proposals.flatMap((p) => p.members));
  const strongProposed = new Set(proposals.filter((p) => p.strength === "strong").flatMap((p) => p.members));

  return { history, facts, raws, nodes, nodeOfRaw, nonPerson, links, proposals, unresolved, strongProposed, windowSince };
}

export const isoDay = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

/** The three areas an identity touched most, for evidence of where someone works. */
export function topAreas(node: IdentityNode, limit = 3): string[] {
  return [...node.areaCounts.entries()]
    .sort(([p, x], [q, y]) => y - x || (p < q ? -1 : p > q ? 1 : 0))
    .slice(0, limit)
    .map(([area]) => area);
}

export const addressKey = (a: Address): string => identityKey(a);
