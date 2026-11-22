import type { BlameRange } from "./blame-lines.ts";
import type { BlameSnapshot } from "./blame-read.ts";
import { runGit } from "./git.ts";
import type { NonPersonKind, NonPersonMatcher } from "./identity-classify.ts";
import { mapThroughMailmap } from "./identity-mapping.ts";
import { identityKey } from "./identity-names.ts";

export interface Owner {
  /** The mapped identity as `Name <email>`: one key per person after the mailmap. */
  key: string;
  name: string;
  email: string;
  /** `person`, or the non-person kind the classification gives. Their lines belong to nobody. */
  kind: "person" | NonPersonKind;
}

export interface OwnerOptions {
  /** The local-only mailmap, which is read together with the `.mailmap` in the working tree. */
  localMailmap?: string;
  /** The non-person classification, from the identity decisions and config. Without it everyone is a person. */
  matcher?: Pick<NonPersonMatcher, "classify"> & Partial<Pick<NonPersonMatcher, "humanCoAuthor">>;
}

/**
 * Who wrote each of these commits, resolved now and never stored: the author as
 * written in the commit (or, for a commit an agent authored, the person a `Co-Authored-By` trailer names), mapped through the working tree's `.mailmap` (and the local
 * one), then classified. Every commit is covered, merges included, because a blame
 * can name a merge that resolved a conflict. A commit that is not in the repository is absent from the result.
 */
export async function resolveOwners(root: string, shas: Iterable<string>, options: OwnerOptions = {}): Promise<Map<string, Owner>> {
  const unique = [...new Set(shas)].sort();
  const owners = new Map<string, Owner>();
  if (unique.length === 0) return owners;
  const out = await runGit(root, ["log", "--no-walk=unsorted", "--stdin", "--format=%H%x1f%an%x1f%ae%x1f%B%x1e"], { input: unique.join("\n") + "\n" });
  const authors = new Map<string, { name: string; email: string }>();
  for (const record of out.split("\x1e")) {
    const [sha, name, email, message] = record.replace(/^\n/, "").split("\x1f");
    if (sha === undefined || name === undefined || email === undefined) continue;
    const agent = options.matcher?.classify(name, email)?.kind === "agent";
    authors.set(sha, (agent ? options.matcher?.humanCoAuthor?.(message ?? "") : null) ?? { name, email });
  }
  const mapped = await mapThroughMailmap(root, [...authors.values()], options.localMailmap);
  for (const [sha, author] of authors) {
    const to = mapped.get(identityKey(author)) ?? author;
    const found = options.matcher?.classify(to.name, to.email) ?? null;
    owners.set(sha, { key: identityKey(to), name: to.name, email: to.email, kind: found?.kind ?? "person" });
  }
  return owners;
}

export interface LineShares {
  /** Every line counted. */
  total: number;
  /** Lines held by people. */
  people: number;
  /** Lines held by bots, services and agents, which belong to nobody and are not in `byOwner`. */
  nonPerson: number;
  /** Lines whose commit is not in `owners` (for example a shallow boundary). */
  unattributed: number;
  /** Lines per person, by owner key. */
  byOwner: Map<string, number>;
}

/** Splits the lines of some ranges between the people who last wrote them. */
export function lineShares(ranges: Iterable<BlameRange>, owners: ReadonlyMap<string, Owner>): LineShares {
  const shares: LineShares = { total: 0, people: 0, nonPerson: 0, unattributed: 0, byOwner: new Map() };
  for (const { sha, count } of ranges) {
    shares.total += count;
    const owner = owners.get(sha);
    if (!owner) shares.unattributed += count;
    else if (owner.kind !== "person") shares.nonPerson += count;
    else {
      shares.people += count;
      shares.byOwner.set(owner.key, (shares.byOwner.get(owner.key) ?? 0) + count);
    }
  }
  return shares;
}

/** Every commit that holds lines in the snapshot, to resolve owners for. */
export function commitsInSnapshot(snapshot: BlameSnapshot): Set<string> {
  const shas = new Set<string>();
  for (const file of snapshot.files.values()) for (const range of file.ranges) shas.add(range.sha);
  return shas;
}

/** The people's share of one file held by `ownerKeys`, 0 to 1, or null when no person holds a line. */
export function shareHeldBy(shares: LineShares, ownerKeys: ReadonlySet<string>): number | null {
  if (shares.people === 0) return null;
  let held = 0;
  for (const key of ownerKeys) held += shares.byOwner.get(key) ?? 0;
  return held / shares.people;
}
