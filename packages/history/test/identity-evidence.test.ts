import { expect, test } from "vitest";
import {
  buildNodes,
  buildProposals,
  findLinks,
  type Pairing,
  type RawIdentity,
} from "../src/identity-evidence.ts";

const DAY = 86_400;
const T0 = Date.UTC(2024, 0, 1) / 1000;

interface Spec {
  name: string;
  email: string;
  mapped?: [string, string];
  firstDay?: number;
  lastDay?: number;
  commits?: number;
  files?: string[];
  /** Weeks, relative to the start, in which the identity was active, and the area. */
  weeks?: Record<number, string>;
}

function raw(spec: Spec): RawIdentity {
  const weeks = new Map<number, Set<string>>();
  for (const [week, area] of Object.entries(spec.weeks ?? {})) weeks.set(Math.floor(T0 / (7 * DAY)) + Number(week), new Set([area]));
  return {
    name: spec.name,
    email: spec.email,
    mappedName: spec.mapped?.[0] ?? spec.name,
    mappedEmail: spec.mapped?.[1] ?? spec.email,
    commits: spec.commits ?? 5,
    first: T0 + (spec.firstDay ?? 0) * DAY,
    last: T0 + (spec.lastDay ?? 100) * DAY,
    files: new Set(spec.files ?? []),
    weeks,
    areaCounts: new Map(),
  };
}

const noPairing: Pairing = { committersOfAuthor: new Map(), authorsOfCommitter: new Map() };

function analyse(specs: Spec[], pairing: Pairing = noPairing, rejections: { identities: [string, string] }[] = []) {
  const raws = specs.map(raw);
  const nodes = buildNodes(raws);
  const links = findLinks(nodes, raws, pairing, rejections);
  return { nodes, links, proposals: buildProposals(links) };
}

const signalsOf = (links: ReturnType<typeof findLinks>) => links.flatMap((l) => l.signals.map((s) => s.signal)).sort();

test("the same email apart from case and +tag is a strong link", () => {
  const { links } = analyse([
    { name: "Jo Bloggs", email: "Jo@corp.com" },
    { name: "Joseph B", email: "jo+git@corp.com" },
  ]);
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({ strength: "strong" });
  expect(signalsOf(links)).toContain("exact-email");
});

test("two noreply addresses with the same username or id are a strong link", () => {
  const { links } = analyse([
    { name: "jsmith", email: "1234+jsmith@users.noreply.github.com" },
    { name: "J Smith", email: "jsmith@users.noreply.github.com" },
  ]);
  expect(links[0]).toMatchObject({ strength: "strong" });
  expect(signalsOf(links)).toContain("noreply-same-user");
  const byId = analyse([
    { name: "old-name", email: "77+old-name@users.noreply.github.com" },
    { name: "new-name", email: "77+new-name@users.noreply.github.com" },
  ]);
  expect(signalsOf(byId.links)).toContain("noreply-same-user");
});

test("a noreply username matching another identity's local part is medium", () => {
  const { links } = analyse([
    { name: "jsmith", email: "1234+jsmith@users.noreply.github.com" },
    { name: "Someone", email: "jsmith@corp.com" },
  ]);
  expect(links).toHaveLength(1);
  expect(links[0]!.strength).toBe("medium");
  expect(signalsOf(links)).toContain("noreply-matches-identity");
});

test("the same normalised name is medium, and a lone first name is not a signal", () => {
  expect(analyse([{ name: "José Pérez", email: "a@x.com" }, { name: "jose perez", email: "b@y.org" }]).links[0]!.strength).toBe("medium");
  expect(analyse([{ name: "Jo", email: "a@x.com" }, { name: "Jo", email: "b@y.org" }]).links).toEqual([]);
});

test("a name derivable from another identity's local part is medium", () => {
  for (const local of ["j.smith", "jsmith", "john.smith"]) {
    const { links } = analyse([{ name: "John Smith", email: "x@corp.com" }, { name: "Dev", email: `${local}@home.net` }]);
    expect(signalsOf(links)).toContain("name-from-email");
  }
});

test("the same local part on different domains is medium, but not a generic one", () => {
  expect(signalsOf(analyse([{ name: "A", email: "jsmith@corp.com" }, { name: "B", email: "jsmith@gmail.com" }]).links)).toContain("same-local-part");
  expect(analyse([{ name: "A", email: "admin@corp.com" }, { name: "B", email: "admin@gmail.com" }]).links).toEqual([]);
});

test("a handover in time on shared files supports a link but never makes one", () => {
  const specs: Spec[] = [
    { name: "Ann Lee", email: "ann@home.net", firstDay: 0, lastDay: 50, files: ["src/a.ts"] },
    { name: "Ann Lee", email: "ann@corp.com", firstDay: 52, lastDay: 120, files: ["src/a.ts"] },
  ];
  expect(signalsOf(analyse(specs).links)).toEqual(expect.arrayContaining(["same-name", "handover"]));
  const alone = analyse([
    { name: "P", email: "p@home.net", lastDay: 50, files: ["src/a.ts"] },
    { name: "Q", email: "q@corp.com", firstDay: 52, files: ["src/a.ts"] },
  ]);
  expect(alone.links).toEqual([]);
});

test("exclusive pairing as author and committer supports a link", () => {
  const pairing: Pairing = {
    committersOfAuthor: new Map([["jo@home", new Map([["jo@corp", 4]])]]),
    authorsOfCommitter: new Map([["jo@corp", new Set(["jo@home"])]]),
  };
  const specs: Spec[] = [
    { name: "Jo K", email: "jo@home" },
    { name: "Jo K", email: "jo@corp" },
  ];
  expect(signalsOf(analyse(specs, pairing).links)).toContain("exclusive-pairing");
});

test("a maintainer who commits other people's patches is not paired with them", () => {
  const pairing: Pairing = {
    committersOfAuthor: new Map([["jo@home", new Map([["maint@corp", 4]])]]),
    authorsOfCommitter: new Map([["maint@corp", new Set(["jo@home", "other@x"])]]),
  };
  const specs: Spec[] = [
    { name: "Jo K", email: "jo@home" },
    { name: "Jo K", email: "maint@corp" },
  ];
  expect(signalsOf(analyse(specs, pairing).links)).not.toContain("exclusive-pairing");
});

test("two people with one name active in the same weeks in unrelated folders are counter-evidence", () => {
  const { links, proposals } = analyse([
    { name: "Alex Kim", email: "alex@a.com", weeks: { 1: "src/ui", 2: "src/ui", 3: "src/ui" } },
    { name: "Alex Kim", email: "akim@b.com", weeks: { 1: "infra/db", 2: "infra/db", 3: "infra/db" } },
  ]);
  expect(links[0]).toMatchObject({ strength: "medium", counterEvidence: true });
  expect(proposals[0]).toMatchObject({ counterEvidence: true });
});

test("shared areas in the same weeks are not counter-evidence", () => {
  const { links } = analyse([
    { name: "Alex Kim", email: "alex@a.com", weeks: { 1: "src/ui", 2: "src/ui" } },
    { name: "Alex Kim", email: "akim@b.com", weeks: { 1: "src/ui", 2: "src/ui" } },
  ]);
  expect(links[0]!.counterEvidence).toBe(false);
});

test("strong links join identities transitively into one cluster", () => {
  const { proposals } = analyse([
    { name: "A", email: "a@x.com" },
    { name: "B", email: "a+1@x.com" },
    { name: "C", email: "1+bob@users.noreply.github.com" },
    { name: "D", email: "bob@users.noreply.github.com" },
  ]);
  expect(proposals).toHaveLength(2);
  expect(proposals.every((p) => p.kind === "cluster" && p.strength === "strong")).toBe(true);
});

test("a chain of medium links is shown as a chain and not merged", () => {
  // A~B by name, B~C by local part, A and C share nothing.
  const { proposals } = analyse([
    { name: "Sam Hill", email: "one@x.com" },
    { name: "Sam Hill", email: "shared@y.com" },
    { name: "Other Person", email: "shared@z.com" },
  ]);
  expect(proposals).toHaveLength(1);
  expect(proposals[0]).toMatchObject({ kind: "chain", strength: "chain" });
  expect(proposals[0]!.members).toHaveLength(3);
});

test("a pair joined by a medium link is a medium cluster", () => {
  const { proposals } = analyse([{ name: "Sam Hill", email: "one@x.com" }, { name: "Sam Hill", email: "two@y.com" }]);
  expect(proposals[0]).toMatchObject({ kind: "cluster", strength: "medium" });
});

test("a recorded rejection removes the link", () => {
  const { links } = analyse(
    [{ name: "Sam Hill", email: "one@x.com" }, { name: "Sam Hill", email: "two@y.com" }],
    noPairing,
    [{ identities: ["sam hill <TWO@y.com>", "Sam Hill <one@x.com>"] }],
  );
  expect(links).toEqual([]);
});

test("identities the mailmap already joined are one node and are not linked to themselves", () => {
  const { nodes, links } = analyse([
    { name: "Sam Hill", email: "one@x.com", mapped: ["Sam Hill", "one@x.com"] },
    { name: "Sam H", email: "two@y.com", mapped: ["Sam Hill", "one@x.com"] },
  ]);
  expect(nodes).toHaveLength(1);
  expect(nodes[0]!.aliases).toHaveLength(2);
  expect(links).toEqual([]);
});

test("output order does not depend on input order", () => {
  const specs: Spec[] = [
    { name: "Sam Hill", email: "one@x.com" },
    { name: "Sam Hill", email: "two@y.com" },
    { name: "Ann Lee", email: "ann@x.com" },
    { name: "ann lee", email: "ann2@y.com" },
  ];
  expect(analyse([...specs].reverse())).toEqual(analyse(specs));
});
