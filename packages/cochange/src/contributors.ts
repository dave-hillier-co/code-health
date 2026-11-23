import type { LoadedHistory } from "./history-access.ts";

/** The distinct author addresses of the window's logical changes, split by whether the suite classifies them as agents. */
export interface Contributors {
  people: number;
  /** Agent identities (a coding agent's own commit address), counted apart from people. */
  agents: number;
}

/**
 * Who authored the changes in the analysis window, the way the knowledge report counts them: an address the
 * identity matcher classifies as an agent is an agent identity, every other address is a person. Bots and
 * services are dropped from the history as noise before this point.
 */
export function contributorsOf(history: LoadedHistory): Contributors {
  const { since, until } = history.evidence.window;
  const names = new Map<string, string>();
  for (const commit of history.view.commits) names.set(commit.mappedEmail.toLowerCase(), commit.mappedName);
  const addresses = new Set<string>();
  for (const change of history.filtered.changes) {
    if (change.committerDate < since || change.committerDate > until) continue;
    for (const author of change.authors) addresses.add(author.toLowerCase());
  }
  let agents = 0;
  for (const address of addresses) if (history.identities.matcher.classify(names.get(address) ?? "", address)?.kind === "agent") agents++;
  return { people: addresses.size - agents, agents };
}

/** "1 person", or "1 person, plus 1 agent identity" when the window has agent identities. */
export function contributorsText({ people, agents }: Contributors): string {
  const person = `${people} ${people === 1 ? "person" : "people"}`;
  return agents === 0 ? person : `${person}, plus ${agents} agent ${agents === 1 ? "identity" : "identities"}`;
}
