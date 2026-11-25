import {
  derivedLocalParts,
  emailLocalPart,
  flattenedNames,
  identityKey,
  isTruncatedLogin,
  nameTokens,
  normaliseEmail,
  organisationOf,
  normaliseName,
  parseNoreply,
  type Address,
} from "./identity-names.ts";

/** One identity as written in commits (name and email as authors), with the activity that serves as evidence. */
export interface RawIdentity extends Address {
  /** The identity after the mailmap. Equal to name and email when no entry applies. */
  mappedName: string;
  mappedEmail: string;
  commits: number;
  /** Unix seconds of the first and last commit as author. */
  first: number;
  last: number;
  files: Set<string>;
  /** Areas (the first two folders of a path) touched per week, to see simultaneous work. */
  weeks: Map<number, Set<string>>;
  areaCounts: Map<string, number>;
  /** Keys that signed this identity's commits, as named by `signingKeyOf`. Platform keys are already left out. */
  signingKeys?: Set<string>;
}

/** Who committed whose commits, by lower-cased email, with platform committers already left out. */
export interface Pairing {
  committersOfAuthor: Map<string, Map<string, number>>;
  authorsOfCommitter: Map<string, Set<string>>;
}

/** A person as the mailmap sees them: every raw identity that maps to one name and email. */
export interface IdentityNode extends Address {
  key: string;
  aliases: Address[];
  commits: number;
  first: number;
  last: number;
  files: Set<string>;
  weeks: Map<number, Set<string>>;
  areaCounts: Map<string, number>;
  signingKeys: Set<string>;
}

export type SignalName =
  | "exact-email"
  | "same-organisation-address"
  | "same-signing-key"
  | "noreply-same-user"
  | "noreply-matches-identity"
  | "same-name"
  | "name-from-email"
  | "same-local-part"
  | "handover"
  | "exclusive-pairing"
  | "simultaneous-disjoint-areas"
  | "shared-mailbox";

export type SignalStrength = "strong" | "medium" | "supporting" | "counter";

export interface Signal {
  signal: SignalName;
  strength: SignalStrength;
  /** What matched, in words and values a reader can check. */
  detail: string;
}

export interface Link {
  /** Node keys, the lesser first. */
  a: string;
  b: string;
  strength: "strong" | "medium";
  signals: Signal[];
  counterEvidence: boolean;
}

export interface Rejection {
  /** The two raw identities, as `Name <email>`. */
  identities: [string, string];
}

/** Local parts shared by many people and so no evidence of one. */
const GENERIC_LOCAL_PARTS = new Set([
  "noreply",
  "no-reply",
  "root",
  "admin",
  "git",
  "dev",
  "info",
  "support",
  "mail",
  "user",
  "ci",
  "build",
  "bot",
  "me",
  "none",
  "unknown",
  "nobody",
]);

/**
 * Local parts that name a function of a mailbox and not a person. At an organisation's domain the address is
 * one that several people can send from, so the same address is not evidence of one person.
 */
export const ROLE_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "team",
  "release",
  "releases",
  "releng",
  "maintainer",
  "maintainers",
  "security",
  "ops",
  "devops",
  "infra",
  "platform",
  "engineering",
  "eng",
  "opensource",
  "oss",
  "community",
  "staff",
  "project",
  "office",
  "docs",
  "packaging",
]);

/**
 * Local parts that many people pick for their own address on their own domain (`github@`, `code@`, `contact@`).
 * The whole address still says who it is, but the local part alone matches strangers, so `same-local-part` never
 * fires on one of these, on a role, or on a generic local part.
 */
export const COMMON_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "github",
  "gitlab",
  "bitbucket",
  "code",
  "coding",
  "contact",
  "hello",
  "hi",
  "hey",
  "email",
  "inbox",
  "work",
  "home",
  "personal",
  "private",
  "public",
  "web",
  "website",
  "projects",
  "commits",
  "patches",
]);

const DAY = 86_400;
const WEEK = 7 * DAY;
export const HANDOVER_MAX_GAP_DAYS = 90;
export const HANDOVER_MAX_OVERLAP_DAYS = 14;
export const PAIRING_MIN_COMMITS = 3;
export const COUNTER_MIN_WEEKS = 2;

export const weekOf = (seconds: number): number => Math.floor(seconds / WEEK);

/** The first two folders of a path, or `.` for a file at the root. */
export function areaOf(path: string): string {
  const parts = path.split("/");
  return parts.length === 1 ? "." : parts.slice(0, Math.min(2, parts.length - 1)).join("/");
}

/** Groups raw identities by their mapped identity. Sorted by key. */
export function buildNodes(raws: readonly RawIdentity[]): IdentityNode[] {
  const nodes = new Map<string, IdentityNode>();
  for (const raw of raws) {
    const key = identityKey({ name: raw.mappedName, email: raw.mappedEmail });
    let node = nodes.get(key);
    if (!node) {
      node = {
        key,
        name: raw.mappedName,
        email: raw.mappedEmail,
        aliases: [],
        commits: 0,
        first: raw.first,
        last: raw.last,
        files: new Set(),
        weeks: new Map(),
        areaCounts: new Map(),
        signingKeys: new Set(),
      };
      nodes.set(key, node);
    }
    node.aliases.push({ name: raw.name, email: raw.email });
    node.commits += raw.commits;
    node.first = Math.min(node.first, raw.first);
    node.last = Math.max(node.last, raw.last);
    for (const file of raw.files) node.files.add(file);
    for (const [week, areas] of raw.weeks) {
      const into = node.weeks.get(week) ?? new Set<string>();
      for (const area of areas) into.add(area);
      node.weeks.set(week, into);
    }
    for (const signingKey of raw.signingKeys ?? []) node.signingKeys.add(signingKey);
    for (const [area, count] of raw.areaCounts) node.areaCounts.set(area, (node.areaCounts.get(area) ?? 0) + count);
  }
  const sorted = [...nodes.values()].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  for (const node of sorted) node.aliases.sort((x, y) => compare(identityKey(x), identityKey(y)));
  return sorted;
}

const compare = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

interface NodeFacts {
  node: IdentityNode;
  /** Normalised emails with their local parts, generic ones left out of the local part and email signals. */
  emails: string[];
  /** `local@organisation` of each address at an organisation's own domain, where the host may be a machine inside it. */
  organisational: string[];
  locals: string[];
  noreplies: { id: string | null; username: string }[];
  names: string[];
  /** The names as written, with at least two parts. */
  nameList: string[];
  derived: string[];
  flattened: string[];
  signingKeys: string[];
}

/**
 * A local part shorter than this is too likely to be a first name (`james@`) for the same local part inside one
 * organisation to be one person. A judgement call: it labels a link strong or medium and never removes one.
 */
export const MIN_ORGANISATIONAL_LOCAL_LENGTH = 5;

/** The same normalised local part, and one domain is the other with host labels in front (`pc12.corp.example.com` inside `example.com`). */
function insideEachOther(a: string, b: string): boolean {
  const [localA, domainA] = [a.slice(0, a.lastIndexOf("@")), a.slice(a.lastIndexOf("@") + 1)];
  const [localB, domainB] = [b.slice(0, b.lastIndexOf("@")), b.slice(b.lastIndexOf("@") + 1)];
  if (localA !== localB || domainA === domainB) return false;
  return domainA.endsWith(`.${domainB}`) || domainB.endsWith(`.${domainA}`);
}

/** A key shared by more than this many identities is a platform's or a team's, not one person's. */
export const MAX_IDENTITIES_PER_SIGNING_KEY = 3;

function factsOf(node: IdentityNode): NodeFacts {
  const addresses: Address[] = [{ name: node.name, email: node.email }, ...node.aliases];
  const emails = new Set<string>();
  const organisational = new Set<string>();
  const locals = new Set<string>();
  const noreplies = new Map<string, { id: string | null; username: string }>();
  const names = new Set<string>();
  const nameList = new Set<string>();
  const derived = new Set<string>();
  const flattened = new Set<string>();
  for (const { name, email } of addresses) {
    const noreply = parseNoreply(email);
    if (noreply) noreplies.set(`${noreply.id ?? ""}+${noreply.username}`, noreply);
    const local = emailLocalPart(email);
    if (!noreply && !GENERIC_LOCAL_PARTS.has(local)) {
      emails.add(normaliseEmail(email));
      locals.add(local);
      const organisation = organisationOf(email);
      if (organisation !== null && local.length >= MIN_ORGANISATIONAL_LOCAL_LENGTH) organisational.add(`${local}@${organisation}`);
    }
    if (nameTokens(name).length >= 2) {
      names.add(normaliseName(name));
      nameList.add(name);
      for (const d of derivedLocalParts(name)) derived.add(d);
      for (const f of flattenedNames(name)) flattened.add(f);
    }
  }
  return {
    node,
    emails: [...emails].sort(),
    organisational: [...organisational].sort(),
    locals: [...locals].sort(),
    noreplies: [...noreplies.values()].sort((x, y) => compare(x.username, y.username)),
    names: [...names].sort(),
    nameList: [...nameList].sort(),
    derived: [...derived].sort(),
    flattened: [...flattened].sort(),
    signingKeys: [...node.signingKeys].sort(),
  };
}

/**
 * Two names of at least two words are variants of one person's name when they are the same name by the rules of
 * `same-name`, when they share a word (a first name kept through a change of surname, a family name written first),
 * when their words run together are the same (`Jo Ann Park` and `Joann Park`), or when the first words and the
 * last words are each one the start of the other (`Jo Bloggs` and `Joseph B`).
 */
export function namesAreVariants(p: string, q: string): boolean {
  const x = nameTokens(p);
  const y = nameTokens(q);
  if (x.join(" ") === y.join(" ") || x.join("") === y.join("")) return true;
  if (x.some((t) => t.length >= 2 && y.includes(t))) return true;
  const prefixed = (s: string, t: string) => s.startsWith(t) || t.startsWith(s);
  return prefixed(x[0]!, y[0]!) && prefixed(x[x.length - 1]!, y[y.length - 1]!);
}

/**
 * Addresses that more than one person commits from, each with the reason, by normalised email. An address is
 * shared when it is committed under two or more names of at least two words that are not variants of one another,
 * or when it is at an organisation's domain and every part of its local part names the project or a role
 * (`release@`, `team@`, `widget-release@` in a project called widget). A one-word name such as a login is left out
 * of the comparison: people commit under their login and their name from one address.
 */
export function sharedMailboxes(nodes: readonly IdentityNode[], projectNames: readonly string[] = []): Map<string, string> {
  const namesOf = new Map<string, Set<string>>();
  for (const node of nodes) {
    for (const { name, email } of [{ name: node.name, email: node.email }, ...node.aliases]) {
      if (parseNoreply(email)) continue;
      const key = normaliseEmail(email);
      const names = namesOf.get(key) ?? new Set<string>();
      if (nameTokens(name).length >= 2) names.add(name);
      namesOf.set(key, names);
    }
  }
  const projects = new Set(projectNames.map((p) => p.toLowerCase()));
  const shared = new Map<string, string>();
  for (const [email, names] of [...namesOf].sort(([p], [q]) => compare(p, q))) {
    const groups: string[][] = [];
    for (const name of [...names].sort(compare)) {
      const into = groups.filter((g) => g.some((other) => namesAreVariants(name, other)));
      const merged = [name, ...into.flat()];
      for (const g of into) groups.splice(groups.indexOf(g), 1);
      groups.push(merged);
    }
    if (groups.length >= 2) {
      shared.set(email, `committed under ${groups.length} names that are not variants of one another`);
      continue;
    }
    const parts = emailLocalPart(email).split(/[.\-_]/).filter((p) => p !== "");
    if (organisationOf(email) !== null && parts.length > 0 && parts.every((p) => projects.has(p) || ROLE_LOCAL_PARTS.has(p))) {
      shared.set(email, parts.some((p) => projects.has(p)) ? "the local part names the project, at an organisation's domain" : "the local part names a role, at an organisation's domain");
    }
  }
  return shared;
}

/**
 * True when a shared local part is only a first name: it is the first word of a name of one identity, both
 * identities have names of at least two words, and the rest of their names share no word. `michael@` for
 * Michael Jones and Michael Brandt is two people with one first name. Deciding this from the names keeps a list
 * of first names out of the tool.
 */
function onlyAFirstName(local: string, x: NodeFacts, y: NodeFacts): boolean {
  const tokensX = x.nameList.map(nameTokens);
  const tokensY = y.nameList.map(nameTokens);
  if (tokensX.length === 0 || tokensY.length === 0) return false;
  if (![...tokensX, ...tokensY].some((t) => t[0] === local)) return false;
  return tokensX.every((p) => tokensY.every((q) => !p.slice(1).some((t) => q.slice(1).includes(t))));
}

type Candidates = Map<string, Map<string, Signal>>;

function pairKey(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

function addSignal(candidates: Candidates, x: NodeFacts, y: NodeFacts, signal: Signal): void {
  if (x.node.key === y.node.key) return;
  const [a, b] = pairKey(x.node.key, y.node.key);
  const key = `${a}\u0000${b}`;
  const signals = candidates.get(key) ?? new Map<string, Signal>();
  signals.set(`${signal.signal}:${signal.detail}`, signal);
  candidates.set(key, signals);
}

/** Maps a value to the facts that carry it, so pairs are found by lookup and not by comparing every node with every other. */
function index(facts: readonly NodeFacts[], values: (f: NodeFacts) => string[]): Map<string, NodeFacts[]> {
  const map = new Map<string, NodeFacts[]>();
  for (const f of facts) {
    for (const value of values(f)) {
      const list = map.get(value) ?? [];
      list.push(f);
      map.set(value, list);
    }
  }
  return map;
}

function eachPair(map: Map<string, NodeFacts[]>, visit: (value: string, x: NodeFacts, y: NodeFacts) => void): void {
  for (const [value, list] of [...map].sort(([p], [q]) => compare(p, q))) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) visit(value, list[i]!, list[j]!);
  }
}

/**
 * Finds links between nodes from names and addresses, then adds supporting and
 * counter evidence from activity. A pair with no strong or medium signal is not a link.
 */
export function findLinks(
  nodes: readonly IdentityNode[],
  raws: readonly RawIdentity[],
  pairing: Pairing,
  rejections: readonly Rejection[] = [],
  options: { projectNames?: readonly string[] } = {},
): Link[] {
  const facts = nodes.map(factsOf);
  const candidates: Candidates = new Map();
  const shared = sharedMailboxes(nodes, options.projectNames);

  eachPair(index(facts, (f) => f.emails), (email, x, y) =>
    addSignal(candidates, x, y, { signal: "exact-email", strength: shared.has(email) ? "medium" : "strong", detail: email }),
  );
  // The same local part at one organisation's domain, where one host is a machine inside it
  // (`sbykov@pc12.corp.example.com` and `sbykov@example.com`): git writes that address when it has no configured one.
  eachPair(index(facts, (f) => f.organisational), (address, x, y) => {
    if (!x.emails.some((e) => y.emails.some((o) => insideEachOther(e, o)))) return;
    addSignal(candidates, x, y, { signal: "same-organisation-address", strength: "strong", detail: address });
  });
  // The same key across identities, unless so many share it that it is a platform's (the web-flow key) and not a person's.
  const byKey = index(facts, (f) => f.signingKeys);
  for (const [key, holders] of byKey) if (holders.length > MAX_IDENTITIES_PER_SIGNING_KEY) byKey.delete(key);
  eachPair(byKey, (key, x, y) => addSignal(candidates, x, y, { signal: "same-signing-key", strength: "supporting", detail: key }));
  eachPair(
    index(facts, (f) => f.noreplies.flatMap((n) => [`user:${n.username}`, ...(n.id ? [`id:${n.id}`] : [])])),
    (value, x, y) => addSignal(candidates, x, y, { signal: "noreply-same-user", strength: "strong", detail: value }),
  );
  eachPair(index(facts, (f) => f.names), (name, x, y) =>
    addSignal(candidates, x, y, { signal: "same-name", strength: "medium", detail: name }),
  );
  eachPair(index(facts, (f) => f.locals), (local, x, y) => {
    if (x.emails.some((e) => y.emails.includes(e))) return;
    if (COMMON_LOCAL_PARTS.has(local) || ROLE_LOCAL_PARTS.has(local) || onlyAFirstName(local, x, y)) return;
    addSignal(candidates, x, y, { signal: "same-local-part", strength: "medium", detail: local });
  });

  const byLocal = index(facts, (f) => f.locals);
  const byFlat = index(facts, (f) => f.flattened);
  for (const f of facts) {
    for (const variant of f.derived) {
      for (const other of byLocal.get(variant) ?? []) {
        addSignal(candidates, f, other, { signal: "name-from-email", strength: "medium", detail: variant });
      }
    }
    for (const { username } of f.noreplies) {
      for (const other of byLocal.get(username) ?? []) {
        addSignal(candidates, f, other, { signal: "noreply-matches-identity", strength: "medium", detail: username });
      }
      for (const other of byFlat.get(username) ?? []) {
        addSignal(candidates, f, other, { signal: "noreply-matches-identity", strength: "medium", detail: username });
      }
      for (const other of facts) {
        if (other !== f && other.nameList.some((name) => isTruncatedLogin(name, username))) {
          addSignal(candidates, f, other, { signal: "noreply-matches-identity", strength: "medium", detail: username });
        }
      }
    }
  }

  const nodeOfEmail = new Map<string, string>();
  const nodeByKey = new Map(nodes.map((n) => [n.key, n]));
  for (const raw of raws) nodeOfEmail.set(raw.email.toLowerCase(), identityKey({ name: raw.mappedName, email: raw.mappedEmail }));
  const factsByKey = new Map(facts.map((f) => [f.node.key, f]));

  // Exclusive pairing: the author's commits are only ever committed by the other identity, who commits for no one else.
  for (const [author, committers] of [...pairing.committersOfAuthor].sort(([p], [q]) => compare(p, q))) {
    if (committers.size !== 1) continue;
    const [[committer, count]] = [...committers] as [[string, number]];
    if (count < PAIRING_MIN_COMMITS || committer === author) continue;
    const authorsOfCommitter = pairing.authorsOfCommitter.get(committer);
    if (!authorsOfCommitter || [...authorsOfCommitter].some((a) => a !== author && a !== committer)) continue;
    const x = nodeOfEmail.get(author);
    const y = nodeOfEmail.get(committer);
    if (x === undefined || y === undefined) continue;
    addSignal(candidates, factsByKey.get(x)!, factsByKey.get(y)!, {
      signal: "exclusive-pairing",
      strength: "supporting",
      detail: `${author} authored ${count} commits, all committed by ${committer}`,
    });
  }

  const rejected = new Set(
    rejections.flatMap((r) => {
      const [x, y] = r.identities.map((i) => i.toLowerCase());
      return [`${x}\u0000${y}`, `${y}\u0000${x}`];
    }),
  );
  const links: Link[] = [];
  for (const [key, signals] of [...candidates].sort(([p], [q]) => compare(p, q))) {
    const [a, b] = key.split("\u0000") as [string, string];
    const x = nodeByKey.get(a)!;
    const y = nodeByKey.get(b)!;
    if (x.aliases.some((p) => y.aliases.some((q) => rejected.has(`${identityKey(p).toLowerCase()}\u0000${identityKey(q).toLowerCase()}`)))) {
      continue;
    }
    const list = [...signals.values()];
    if (!list.some((s) => s.strength === "strong" || s.strength === "medium")) continue;
    const handover = handoverSignal(x, y);
    if (handover) list.push(handover);
    const strong = list.some((s) => s.strength === "strong") || corroborated(list);
    const counters: Signal[] = [];
    if (!strong) {
      const disjoint = counterSignal(x, y);
      if (disjoint) counters.push(disjoint);
      for (const s of list) {
        if (s.signal === "exact-email" && shared.has(s.detail)) counters.push({ signal: "shared-mailbox", strength: "counter", detail: `${s.detail}: ${shared.get(s.detail)}` });
      }
    }
    list.push(...counters);
    list.sort((s, t) => compare(rank(s) + s.signal + s.detail, rank(t) + t.signal + t.detail));
    links.push({ a, b, strength: strong ? "strong" : "medium", signals: list, counterEvidence: counters.length > 0 });
  }
  return links;
}

/**
 * Medium signals that are strong together. A name is shared by strangers, and so is a local part, but the same
 * normalised name beside a matching GitHub login or the same local part is not a coincidence. A shared signing key
 * is only supporting alone, since keys are shared between people, and becomes strong beside any medium signal.
 */
function corroborated(signals: readonly Signal[]): boolean {
  const has = (name: SignalName) => signals.some((s) => s.signal === name);
  if (has("same-name") && (has("noreply-matches-identity") || has("same-local-part"))) return true;
  return has("same-signing-key") && signals.some((s) => s.strength === "medium");
}

const rank = (s: Signal): string => ({ strong: "0", medium: "1", supporting: "2", counter: "3" })[s.strength];

function handoverSignal(x: IdentityNode, y: IdentityNode): Signal | undefined {
  const [earlier, later] = x.last <= y.last ? [x, y] : [y, x];
  const gapDays = (later.first - earlier.last) / DAY;
  if (gapDays < -HANDOVER_MAX_OVERLAP_DAYS || gapDays > HANDOVER_MAX_GAP_DAYS) return undefined;
  const shared = [...earlier.files].filter((f) => later.files.has(f)).length;
  if (shared === 0) return undefined;
  return {
    signal: "handover",
    strength: "supporting",
    detail: `${earlier.email} stops ${isoDay(earlier.last)}, ${later.email} starts ${isoDay(later.first)}, ${shared} shared files`,
  };
}

export function counterSignal(x: IdentityNode, y: IdentityNode): Signal | undefined {
  const weeks = [...x.weeks.keys()].filter((w) => y.weeks.has(w)).sort((p, q) => p - q);
  if (weeks.length < COUNTER_MIN_WEEKS) return undefined;
  const areasX = new Set(weeks.flatMap((w) => [...x.weeks.get(w)!]));
  const areasY = new Set(weeks.flatMap((w) => [...y.weeks.get(w)!]));
  if ([...areasX].some((a) => areasY.has(a))) return undefined;
  return {
    signal: "simultaneous-disjoint-areas",
    strength: "counter",
    detail: `both active in ${weeks.length} of the same weeks, never in the same area`,
  };
}

function isoDay(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export interface Proposal {
  kind: "cluster" | "chain";
  /**
   * `strong`: strong links join them. `medium`: every pair is linked, by medium links only. `chain`: medium links
   * in a line, or between strong clusters, shown for review and not to be merged as one. A chain holds only its
   * medium links, and its members can be in a strong cluster too.
   */
  strength: "strong" | "medium" | "chain";
  members: string[];
  links: Link[];
  counterEvidence: boolean;
}

class Groups {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    const p = this.parent.get(x) ?? x;
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(x: string, y: string): void {
    const [a, b] = pairKey(this.find(x), this.find(y));
    if (a !== b) this.parent.set(b, a);
  }
}

/**
 * Builds proposals from links. Strong links join identities transitively. Medium
 * links never do: when every pair of a connected set is linked it is one
 * cluster, otherwise it is a chain for review. A set held together by medium links
 * between groups that strong links settled is proposed as those strong groups and
 * a chain of the medium links between them, so the settled part is not held back by
 * the rest and no identity is in two clusters.
 */
export function buildProposals(links: readonly Link[]): Proposal[] {
  const groups = new Groups();
  for (const link of links) if (link.strength === "strong") groups.union(link.a, link.b);
  const all = new Set(links.flatMap((l) => [l.a, l.b]));
  const allRoots = new Set([...all].map((n) => groups.find(n)));
  // Connect groups by medium links.
  const meta = new Groups();
  for (const link of links) if (link.strength === "medium") meta.union(groups.find(link.a), groups.find(link.b));
  const components = new Map<string, Set<string>>();
  for (const root of allRoots) {
    const c = meta.find(root);
    const set = components.get(c) ?? new Set<string>();
    set.add(root);
    components.set(c, set);
  }

  const proposals: Proposal[] = [];
  for (const rootSet of components.values()) {
    const nodes = [...all].filter((n) => rootSet.has(groups.find(n))).sort(compare);
    const inside = links.filter((l) => nodes.includes(l.a) && nodes.includes(l.b));
    const linked = (x: string, y: string) =>
      inside.some((l) => (groups.find(l.a) === x && groups.find(l.b) === y) || (groups.find(l.a) === y && groups.find(l.b) === x));
    const roots = [...rootSet];
    if (roots.length === 1) {
      proposals.push({ kind: "cluster", strength: "strong", members: nodes, links: inside, counterEvidence: inside.some((l) => l.counterEvidence) });
      continue;
    }
    // Strong links settle a group whatever else the group is linked to by name alone, so each is proposed as a
    // strong cluster, and the medium links between the groups are a chain: each identity is in one cluster only.
    const settled = roots.filter((root) => nodes.filter((n) => groups.find(n) === root).length >= 2);
    for (const root of settled.sort(compare)) {
      const members = nodes.filter((n) => groups.find(n) === root);
      const within = inside.filter((l) => members.includes(l.a) && members.includes(l.b));
      proposals.push({ kind: "cluster", strength: "strong", members, links: within, counterEvidence: within.some((l) => l.counterEvidence) });
    }
    const between = inside.filter((l) => groups.find(l.a) !== groups.find(l.b));
    const complete = settled.length === 0 && roots.every((x, i) => roots.slice(i + 1).every((y) => linked(x, y)));
    const members = [...new Set(between.flatMap((l) => [l.a, l.b]))].sort(compare);
    proposals.push({
      kind: complete ? "cluster" : "chain",
      strength: complete ? "medium" : "chain",
      members,
      links: between,
      counterEvidence: between.some((l) => l.counterEvidence),
    });
  }
  const order = { strong: 0, medium: 1, chain: 2 };
  return proposals.sort((p, q) => order[p.strength] - order[q.strength] || compare(p.members[0]!, q.members[0]!));
}

/**
 * Pairs among identities a mailmap has joined that look like different people:
 * active in the same weeks and never in the same area. Compares each raw
 * identity with every other one in the group. A pair that the name and address evidence settles as strong is not
 * compared, by the rule `findLinks` applies when it proposes: a strong link outranks counter-evidence, so a join
 * that `propose` marks strong never fails `check` for a reason `propose` could have seen.
 */
export function counterEvidenceWithin(group: readonly RawIdentity[]): { a: string; b: string; signal: Signal }[] {
  const mapped = group.map((r) => ({ ...r, mappedName: r.name, mappedEmail: r.email }));
  const nodes = buildNodes(mapped);
  const settled = new Set(
    findLinks(nodes, mapped, { committersOfAuthor: new Map(), authorsOfCommitter: new Map() })
      .filter((link) => link.strength === "strong")
      .map((link) => pairKey(link.a, link.b).join("\u0000")),
  );
  const found: { a: string; b: string; signal: Signal }[] = [];
  nodes.forEach((x, i) => {
    for (const y of nodes.slice(i + 1)) {
      if (settled.has(pairKey(x.key, y.key).join("\u0000"))) continue;
      const signal = counterSignal(x, y);
      if (signal) found.push({ a: x.key, b: y.key, signal });
    }
  });
  return found;
}
