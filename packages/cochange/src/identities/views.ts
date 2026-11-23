import { onlyVersionBumpsOrMerges } from "@code-health/history/identity-classify";
import type { IdentityNode } from "@code-health/history/identity-evidence";
import { emailLocalPart, identityKey, parseNoreply } from "@code-health/history/identity-names";
import { isoDay, topAreas, type IdentityAnalysis } from "./analysis.ts";

const compare = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/** One row per identity as written in commits. */
export function listRows(analysis: IdentityAnalysis, onlyUnmapped: boolean) {
  const nodes = new Map(analysis.nodes.map((n) => [n.key, n]));
  const rows = analysis.raws.map((raw) => {
    const key = identityKey(raw);
    const nodeKey = analysis.nodeOfRaw.get(key)!;
    const node = nodes.get(nodeKey)!;
    const nonPerson = analysis.nonPerson.get(nodeKey);
    return {
      score: raw.commits,
      identity: key,
      name: raw.name,
      email: raw.email,
      commits: raw.commits,
      firstSeen: isoDay(raw.first),
      lastSeen: isoDay(raw.last),
      topAreas: topAreas({ ...node, areaCounts: raw.areaCounts }),
      mappedTo: nodeKey === key ? null : nodeKey,
      kind: nonPerson?.kind ?? "person",
      unmapped: analysis.unresolved.has(nodeKey),
    };
  });
  return onlyUnmapped ? rows.filter((r) => r.unmapped) : rows;
}

const isWord = (word: string): boolean => /^\p{L}[\p{L}'.\-]*$/u.test(word);
const looksPersonal = (name: string): boolean => {
  const words = name.trim().split(/\s+/);
  return words.length >= 2 && words.every(isWord);
};
/** One word, letters only, not all lower case, no joined words in camelCase, and neither the address's local part nor the login: `Alvin`, not `bluexo`, `dVakulen` or `jthelin`. */
const looksLikeFirstName = (member: IdentityNode): boolean => {
  const name = member.name.trim();
  const login = parseNoreply(member.email)?.username;
  return (
    /^(?:\p{Lu}\p{Ll}+|\p{Lo}+)$/u.test(name) &&
    name.toLowerCase() !== emailLocalPart(member.email) &&
    name.toLowerCase() !== login
  );
};
const isNoreply = (email: string): boolean => parseNoreply(email) !== null || /^noreply@/i.test(email.trim());

/**
 * The member to keep as the name of a merged person. A name that looks like a personal name comes first: two or more
 * words, all letters, so `Dmitry Vakulenko` is preferred to `dVakulen` and to `jthelin`. Failing a two word name, a one word name
 * that is not the address's local part or the login, and is not all lower case or a handle shape, so `Alvin` is preferred to
 * `bluexo`. When no member has one, the
 * members that carry the name most of the cluster's members share come first. Then a member with an address that is
 * not a GitHub noreply address, then the most recently active, then the one with most commits, then the key.
 */
export function suggestCanonical(members: readonly IdentityNode[]): IdentityNode {
  const nameCounts = new Map<string, number>();
  for (const m of members) nameCounts.set(m.name.trim().toLowerCase(), (nameCounts.get(m.name.trim().toLowerCase()) ?? 0) + 1);
  const commonest = Math.max(...nameCounts.values());
  const twoWords = members.some((m) => looksPersonal(m.name));
  const personal = twoWords || members.some(looksLikeFirstName);
  const nameRank = (m: IdentityNode): number =>
    personal ? ((twoWords ? looksPersonal(m.name) : looksLikeFirstName(m)) ? 0 : 1) : commonest > 1 && nameCounts.get(m.name.trim().toLowerCase()) === commonest ? 0 : 1;
  return [...members].sort(
    (x, y) =>
      nameRank(x) - nameRank(y) ||
      Number(isNoreply(x.email)) - Number(isNoreply(y.email)) ||
      y.last - x.last ||
      y.commits - x.commits ||
      compare(x.key, y.key),
  )[0]!;
}

export const PROPOSE_ORDER = "members' commits, largest first, then strength (strong, medium, chain), then suggested name";

/** Clusters and chains, the most commits held by their members first, then the strongest, then by name, each with its links' signals. */
export function proposeRows(analysis: IdentityAnalysis) {
  const nodes = new Map(analysis.nodes.map((n) => [n.key, n]));
  const strengthOrder = { strong: 0, medium: 1, chain: 2 };
  const rows = analysis.proposals.map((proposal) => {
    const members = proposal.members.map((key) => nodes.get(key)!);
    const current = suggestCanonical(members);
    return {
      commits: members.reduce((sum, m) => sum + m.commits, 0),
      id: "",
      kind: proposal.kind,
      strength: proposal.strength,
      counterEvidence: proposal.counterEvidence,
      suggestedCanonical: current.key,
      members: members.map((m) => ({
        identity: m.key,
        aliases: m.aliases.map(identityKey).filter((a) => a !== m.key),
        commits: m.commits,
        firstSeen: isoDay(m.first),
        lastSeen: isoDay(m.last),
        topAreas: topAreas(m),
      })),
      links: proposal.links.map((l) => ({
        a: l.a,
        b: l.b,
        strength: l.strength,
        counterEvidence: l.counterEvidence,
        signals: l.signals,
      })),
    };
  });
  rows.sort((x, y) => y.commits - x.commits || strengthOrder[x.strength] - strengthOrder[y.strength] || compare(x.suggestedCanonical, y.suggestedCanonical));
  return rows.map(({ commits: _held, ...row }, i) => ({ ...row, id: `P${i + 1}` }));
}

const MIN_SERVICE_COMMITS = 3;

/** Proposed bot, service and agent classifications with the pattern that matched, and whether a decision records them. */
export function classifyRows(analysis: IdentityAnalysis) {
  const { decisions, matcher } = analysis.history.identities;
  const decided = new Set(decisions.classifications.map((c) => emailOf(c.identity)));
  const rows: { kind: "bot" | "service" | "agent"; identity: string; commits: number; source: string; pattern: string; decided: boolean }[] = [];

  for (const raw of analysis.raws) {
    const key = identityKey(raw);
    const found = matcher.classify(raw.name, raw.email);
    if (found) {
      rows.push({ kind: found.kind, identity: key, commits: raw.commits, source: found.source, pattern: found.pattern, decided: decided.has(raw.email.toLowerCase()) });
      continue;
    }
    if (decided.has(raw.email.toLowerCase())) continue; // decided to be a person
    const subjects = analysis.facts.subjects.get(key) ?? [];
    if (subjects.length >= MIN_SERVICE_COMMITS && onlyVersionBumpsOrMerges(subjects)) {
      rows.push({ kind: "service", identity: key, commits: raw.commits, source: "heuristic", pattern: "only version bumps, releases or merges", decided: false });
    }
  }
  for (const agent of analysis.facts.agents) {
    rows.push({
      kind: "agent",
      identity: agent.value,
      commits: agent.commits,
      source: "trailer",
      pattern: agent.pattern,
      // Decided by a record, or by a rule that already classifies the trailer's address as an agent.
      decided: decided.has(emailOf(agent.value)) || matcher.classify(nameOf(agent.value), emailOf(agent.value))?.kind === "agent",
    });
  }
  const order = { bot: 0, service: 1, agent: 2 };
  return rows.sort((x, y) => order[x.kind] - order[y.kind] || compare(x.identity, y.identity));
}

export const emailOf = (identity: string): string => {
  const open = identity.lastIndexOf("<");
  return (open === -1 ? identity : identity.slice(open + 1, identity.lastIndexOf(">"))).trim().toLowerCase();
};

const nameOf = (identity: string): string => {
  const open = identity.lastIndexOf("<");
  return (open === -1 ? "" : identity.slice(0, open)).trim();
};
