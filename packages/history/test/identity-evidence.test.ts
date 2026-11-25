import { describe, expect, test } from "vitest";
import {
  COUNTER_MIN_WEEKS,
  HANDOVER_MAX_GAP_DAYS,
  HANDOVER_MAX_OVERLAP_DAYS,
  PAIRING_MIN_COMMITS,
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
  signingKeys?: string[];
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
    signingKeys: new Set(spec.signingKeys ?? []),
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

test.each(["github", "code", "contact", "hello", "team", "release"])("the local part %s on two personal domains links no one", (local) => {
  expect(analyse([{ name: "Ivo Brandt", email: `${local}@brandt.dev` }, { name: "Mia Sato", email: `${local}@sato.io` }]).links).toEqual([]);
});

test("a local part that is only a first name shared by two people with different surnames links no one", () => {
  expect(analyse([{ name: "Tomas Reyes", email: "tomas@reyes.dev" }, { name: "Tomas Lindqvist", email: "tomas@lindqvist.se" }]).links).toEqual([]);
  expect(analyse([{ name: "Tom Reyes", email: "tom@reyes.dev" }, { name: "Tomas Lindqvist", email: "tom@lindqvist.se" }]).links).toEqual([]);
  // The same first name and surname is still a local part match, and with the name it is strong.
  expect(analyse([{ name: "Tomas Reyes", email: "tomas@reyes.dev" }, { name: "Tomas Reyes", email: "tomas@acme.io" }]).links[0]).toMatchObject({ strength: "strong" });
  // A local part that is no first word of either name still matches.
  expect(signalsOf(analyse([{ name: "Tomas Reyes", email: "treyes@reyes.dev" }, { name: "Tomas Lindqvist", email: "treyes@acme.io" }]).links)).toContain("same-local-part");
});

describe("shared mailboxes", () => {
  test("an address committed under two names that are not variants of one another is medium, with counter-evidence", () => {
    const { links, proposals } = analyse([
      { name: "Nora Vance", email: "ship@acme.io" },
      { name: "Omar Ruiz", email: "Ship@acme.io" },
    ]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ strength: "medium", counterEvidence: true });
    expect(links[0]!.signals.map((s) => [s.signal, s.strength])).toEqual([
      ["exact-email", "medium"],
      ["shared-mailbox", "counter"],
    ]);
    expect(links[0]!.signals[1]!.detail).toBe("ship@acme.io: committed under 2 names that are not variants of one another");
    expect(proposals[0]).toMatchObject({ strength: "medium", counterEvidence: true });
  });

  test("a person's name beside their login, a changed surname and a reordered name are one person's address", () => {
    for (const [p, q] of [
      ["Lena Hart", "lhart"],
      ["Lena Hart", "Lena Moss"],
      ["Hart Lena", "Lena Hart"],
      ["Jo Ann Park", "Joann Park"],
    ]) {
      expect(analyse([{ name: p!, email: "lena@hartmail.net" }, { name: q!, email: "lena@hartmail.net" }]).links[0]).toMatchObject({ strength: "strong", counterEvidence: false });
    }
  });

  test("an address at an organisation's domain whose local part names a role or the project is shared", () => {
    const role = analyse([{ name: "Pat Quinn", email: "team@acme.io" }, { name: "pquinn", email: "team@acme.io" }]);
    expect(role.links[0]).toMatchObject({ strength: "medium", counterEvidence: true });
    expect(role.links[0]!.signals.find((s) => s.signal === "shared-mailbox")!.detail).toBe("team@acme.io: the local part names a role, at an organisation's domain");

    const specs: Spec[] = [{ name: "Pat Quinn", email: "widget-release@acme.io" }, { name: "pquinn", email: "widget-release@acme.io" }];
    const raws = specs.map(raw);
    const nodes = buildNodes(raws);
    const project = findLinks(nodes, raws, noPairing, [], { projectNames: ["widget"] });
    expect(project[0]!.signals.find((s) => s.signal === "shared-mailbox")!.detail).toBe("widget-release@acme.io: the local part names the project, at an organisation's domain");
    // Without the project's name, `widget-release` is a person's address like any other.
    expect(findLinks(nodes, raws, noPairing)[0]).toMatchObject({ strength: "strong" });
    // At a mailbox provider the same local part is an individual's.
    expect(analyse([{ name: "Pat Quinn", email: "team@gmail.com" }, { name: "pquinn", email: "team@gmail.com" }]).links[0]).toMatchObject({ strength: "strong" });
  });

  test("a shared address beside a strong signal keeps the link strong", () => {
    const { links } = analyse([
      { name: "Nora Vance", email: "ship@acme.io" },
      { name: "Omar Ruiz", email: "ship@acme.io", mapped: ["Omar Ruiz", "oruiz@users.noreply.github.com"] },
      { name: "O Ruiz", email: "ship@acme.io", mapped: ["oruiz", "12+oruiz@users.noreply.github.com"] },
    ]);
    const omar = links.find((l) => l.a.includes("oruiz") && l.b.includes("oruiz"))!;
    expect(omar).toMatchObject({ strength: "strong", counterEvidence: false });
    expect(omar.signals.map((s) => [s.signal, s.strength])).toContainEqual(["exact-email", "medium"]);
    expect(links.find((l) => l.a.includes("Nora") || l.b.includes("Nora"))).toMatchObject({ strength: "medium", counterEvidence: true });
  });
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

test("the handover window is inclusive at its edges: a gap of 90 days and an overlap of 14 days count, one day more does not", () => {
  const handover = (lastDay: number, firstDay: number, filesLater = ["src/a.ts"]) =>
    signalsOf(
      analyse([
        { name: "Ann Lee", email: "ann@home.net", firstDay: 0, lastDay, files: ["src/a.ts"] },
        { name: "Ann Lee", email: "ann@corp.com", firstDay, lastDay: firstDay + 60, files: filesLater },
      ]).links,
    );
  expect(HANDOVER_MAX_GAP_DAYS).toBe(90);
  expect(HANDOVER_MAX_OVERLAP_DAYS).toBe(14);
  expect(handover(50, 50 + HANDOVER_MAX_GAP_DAYS)).toContain("handover");
  expect(handover(50, 50 + HANDOVER_MAX_GAP_DAYS + 1)).not.toContain("handover");
  expect(handover(50, 50 - HANDOVER_MAX_OVERLAP_DAYS)).toContain("handover");
  expect(handover(50, 50 - HANDOVER_MAX_OVERLAP_DAYS - 1)).not.toContain("handover");
});

test("a handover needs a shared file", () => {
  const signals = signalsOf(
    analyse([
      { name: "Ann Lee", email: "ann@home.net", firstDay: 0, lastDay: 50, files: ["src/a.ts"] },
      { name: "Ann Lee", email: "ann@corp.com", firstDay: 52, lastDay: 120, files: ["src/other.ts"] },
    ]).links,
  );
  expect(signals).toContain("same-name");
  expect(signals).not.toContain("handover");
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

test("the same signing key across identities with nothing else in common is not a link", () => {
  const { links, proposals } = analyse([
    { name: "Jo Bloggs", email: "jo@corp.com", signingKeys: ["ssh:SHA256:abc"] },
    { name: "Pat Quill", email: "pat@home.net", signingKeys: ["ssh:SHA256:abc"] },
    { name: "Sam Reed", email: "sam@else.org", signingKeys: ["ssh:SHA256:other"] },
  ]);
  expect(links).toEqual([]);
  expect(proposals).toEqual([]);
});

test("the same signing key beside a medium signal is a strong link", () => {
  const { links } = analyse([
    { name: "Ann Lee", email: "ann@home.net", signingKeys: ["ssh:SHA256:abc"] },
    { name: "Ann Lee", email: "ax@corp.com", signingKeys: ["ssh:SHA256:abc"] },
  ]);
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({ strength: "strong" });
  expect(signalsOf(links)).toEqual(["same-name", "same-signing-key"]);
});

test("the same normalised name beside a matching GitHub noreply login is a strong link", () => {
  const { links, proposals } = analyse([
    { name: "Jo Smith", email: "1234+josmith@users.noreply.github.com" },
    { name: "jo smith", email: "josmith@corp.com" },
  ]);
  expect(links[0]).toMatchObject({ strength: "strong" });
  expect(proposals[0]).toMatchObject({ kind: "cluster", strength: "strong" });
});

test("the same name and the same email local part on different domains is a strong link", () => {
  const { links } = analyse([
    { name: "Dee Park", email: "dpark@home.net" },
    { name: "Dee Park", email: "dpark@corp.com" },
  ]);
  expect(links[0]).toMatchObject({ strength: "strong" });
});

test("the same name alone stays a medium link", () => {
  const { links } = analyse([
    { name: "Dee Park", email: "one@home.net" },
    { name: "Dee Park", email: "two@corp.com" },
  ]);
  expect(links[0]).toMatchObject({ strength: "medium" });
});

test.each([
  [3, true],
  [4, false],
])("a key on %i identities is %s as evidence, since one shared by many is a platform's or a team's", (holders, linked) => {
  const specs = Array.from({ length: holders }, (_, index) => ({ name: "Ann Lee", email: `p${index}@domain${index}.org`, signingKeys: ["gpg:CAFEBABECAFEBABE"] }));
  expect(signalsOf(analyse(specs).links).includes("same-signing-key")).toBe(linked);
});

test("identities that share no key and nothing else are not linked by their keys", () => {
  const { links } = analyse([
    { name: "Jo Bloggs", email: "jo@corp.com", signingKeys: ["gpg:1111111111111111"] },
    { name: "Pat Quill", email: "pat@home.net", signingKeys: ["gpg:2222222222222222"] },
  ]);
  expect(links).toEqual([]);
});

// Each signal's guideline, pinned on both sides of the boundary, so a changed number cannot pass by regenerating a golden.
describe("guidelines", () => {
  const named = (firstDay: number, lastDay: number, email: string): Spec => ({ name: "Ann Lee", email, firstDay, lastDay, files: ["src/a.ts"] });

  test.each([
    [HANDOVER_MAX_GAP_DAYS, true],
    [HANDOVER_MAX_GAP_DAYS + 1, false],
    [-HANDOVER_MAX_OVERLAP_DAYS, true],
    [-HANDOVER_MAX_OVERLAP_DAYS - 1, false],
  ])("a gap of %i days between one identity stopping and the other starting is a handover: %s", (gap, expected) => {
    const links = analyse([named(0, 100, "ann@home.net"), named(100 + gap, 300, "ann@corp.com")]).links;
    expect(signalsOf(links).includes("handover")).toBe(expected);
  });

  test.each([
    [PAIRING_MIN_COMMITS, true],
    [PAIRING_MIN_COMMITS - 1, false],
  ])("%i commits authored by one identity and all committed by another are exclusive pairing: %s", (count, expected) => {
    const pairing: Pairing = {
      committersOfAuthor: new Map([["jo@home", new Map([["jo@corp", count]])]]),
      authorsOfCommitter: new Map([["jo@corp", new Set(["jo@home"])]]),
    };
    const links = analyse([{ name: "Jo K", email: "jo@home" }, { name: "Jo K", email: "jo@corp" }], pairing).links;
    expect(signalsOf(links).includes("exclusive-pairing")).toBe(expected);
  });

  test.each([
    [COUNTER_MIN_WEEKS, true],
    [COUNTER_MIN_WEEKS - 1, false],
  ])("%i shared weeks in disjoint areas are counter-evidence: %s", (weeks, expected) => {
    const active = (area: string) => Object.fromEntries(Array.from({ length: weeks }, (_, week) => [week + 1, area]));
    const { links } = analyse([
      { name: "Alex Kim", email: "alex@a.com", weeks: active("src/ui") },
      { name: "Alex Kim", email: "akim@b.com", weeks: active("infra/db") },
    ]);
    expect(links[0]!.counterEvidence).toBe(expected);
  });
});

describe("names and addresses", () => {
  test("case, diacritics and spacing do not hide the same name, and a different name with the same shape is not it", () => {
    expect(signalsOf(analyse([{ name: "José  García", email: "a@x.org" }, { name: "jose garcia", email: "b@y.org" }]).links)).toContain("same-name");
    expect(analyse([{ name: "José García", email: "a@x.org" }, { name: "Jose Garza", email: "b@y.org" }]).links).toEqual([]);
  });

  test("Last, First order is the same name", () => {
    expect(signalsOf(analyse([{ name: "García, José", email: "a@x.org" }, { name: "José García", email: "b@y.org" }]).links)).toContain("same-name");
  });

  test("identical names with different emails among many people link only the pair that shares the name", () => {
    const specs: Spec[] = Array.from({ length: 30 }, (_, index) => ({ name: `Person${index} Family${index}`, email: `p${index}@d${index}.org` }));
    specs.push({ name: "Person7 Family7", email: "other@elsewhere.net" });
    const { links } = analyse(specs);
    expect(links).toHaveLength(1);
    expect(links[0]!.signals.map((signal) => signal.signal)).toEqual(["same-name"]);
  });

  test("GitHub noreply addresses with the numeric id before the + are the same user whatever the username", () => {
    const { links } = analyse([
      { name: "A", email: "12345+old@users.noreply.github.com" },
      { name: "B", email: "12345+new@users.noreply.github.com" },
    ]);
    expect(links[0]).toMatchObject({ strength: "strong", signals: [{ signal: "noreply-same-user", detail: "id:12345" }] });
  });

  test("the same username with different numeric ids still yields a username signal, naming the username", () => {
    const { links } = analyse([
      { name: "Ann Lee", email: "1+ann@users.noreply.github.com" },
      { name: "Bo Chen", email: "2+ann@users.noreply.github.com" },
    ]);
    expect(links[0]!.signals.map((signal) => signal.detail)).toContain("user:ann");
  });

  test("a bot named like a person is a link like any other identity: classifying bots is a separate step", () => {
    const { links } = analyse([{ name: "Dependabot Bot", email: "bot@x.org" }, { name: "dependabot bot", email: "bot2@y.org" }]);
    expect(signalsOf(links)).toContain("same-name");
  });
});

describe("shapes found in real histories", () => {
  const strengthOf = (specs: Spec[]) => analyse(specs).proposals.map((p) => [p.strength, p.members.length]);

  test("git's own host address beside the organisation address is one person: same local part, one domain inside the other", () => {
    const { links } = analyse([
      { name: "Sergey Bykov", email: "sbykov@microsoft.com" },
      { name: "unknown", email: "sbykov@SBYKOV-SF3.redmond.corp.microsoft.com" },
    ]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ strength: "strong" });
    expect(signalsOf(links)).toContain("same-organisation-address");
  });

  test("the same local part at sibling subdomains, at a mailbox provider, or under 5 characters is not the organisation's address", () => {
    const strong = (a: string, b: string) => analyse([{ name: "One", email: a }, { name: "Two", email: b }]).links.some((l) => l.strength === "strong");
    expect(strong("sbykov@us.corp.example.com", "sbykov@eu.corp.example.com")).toBe(false);
    expect(strong("sbykov@gmail.com", "sbykov@mail.gmail.com")).toBe(false);
    expect(strong("koen@example.com", "koen@host.example.com")).toBe(false);
    expect(strong("sbykov@example.com", "sbykov@host.other.com")).toBe(false);
  });

  test("a GitHub login written as first initial and last name or first name and last initial matches the name", () => {
    for (const login of ["mbadakhshan", "mazdakb"]) {
      const { links } = analyse([
        { name: "Mazdak", email: `559628+${login}@users.noreply.github.com` },
        { name: "Mazdak Badakhshan", email: "mazdak.badakhshan@authzed.com" },
      ]);
      expect(signalsOf(links)).toContain("noreply-matches-identity");
    }
  });

  test("the same name with an affiliation in brackets, beside a matching login, is strong", () => {
    const { links } = analyse([
      { name: "Ningna Dang (Design Laboratory Inc)", email: "NingnaD@users.noreply.github.com" },
      { name: "Ningna Dang (Design Laboratory Inc)", email: "v-nidang@microsoft.com" },
    ]);
    expect(links[0]).toMatchObject({ strength: "strong" });
  });

  test("a pair of identities that share only a name stay medium, so two people called Attila Hajdrik are not merged", () => {
    expect(strengthOf([{ name: "Attila Hajdrik", email: "athajdri@microsoft.com" }, { name: "Attila Hajdrik", email: "attila@eyedea.hu" }])).toEqual([["medium", 2]]);
  });

  test("a settled group is proposed as strong even when a medium link joins it to a lone identity, and the medium links are a chain", () => {
    // The Gabriel Kliot shape: three addresses with one name and local part, and a noreply address that shares only the name.
    const proposals = analyse([
      { name: "Gabriel Kliot", email: "gkliot@microsoft.com" },
      { name: "Gabriel Kliot", email: "gkliot@gmail.com" },
      { name: "Gabriel Kliot", email: "gkliot@google.com" },
      { name: "Gabriel Kliot", email: "gabikliot@users.noreply.github.com" },
    ]).proposals;
    expect(proposals.map((p) => [p.strength, p.members.length])).toEqual([["strong", 3], ["chain", 4]]);
    expect(proposals[0]!.members.some((m) => m.includes("noreply"))).toBe(false);
    // The chain holds only the medium links from the lone identity: the strong ones are in the strong cluster.
    expect(proposals[1]!.links).toHaveLength(3);
    expect(proposals[1]!.links.every((l) => l.strength === "medium" && (l.a.includes("noreply") || l.b.includes("noreply")))).toBe(true);
  });

  test("an identity is in one cluster at most: two settled groups joined by a medium link are two strong clusters and a chain", () => {
    const { proposals } = analyse([
      { name: "Rosa Imber", email: "rosa@imber.dev" },
      { name: "R Imber", email: "Rosa@imber.dev" },
      { name: "Rosa Imber", email: "rosa.imber@acme.io" },
      { name: "rimber", email: "rosa.imber+ci@acme.io" },
    ]);
    expect(proposals.map((p) => [p.kind, p.strength])).toEqual([["cluster", "strong"], ["cluster", "strong"], ["chain", "chain"]]);
    const clustered = proposals.filter((p) => p.kind === "cluster").flatMap((p) => p.members);
    expect(new Set(clustered).size).toBe(clustered.length);
    expect(proposals[2]!.links.every((l) => l.strength === "medium")).toBe(true);
  });

  test("a chain is not split into strong proposals when no group in it is settled by strong links", () => {
    const { proposals } = analyse([
      { name: "Sam Hill", email: "one@x.com" },
      { name: "Sam Hill", email: "shared@y.com" },
      { name: "Other Person", email: "shared@z.com" },
    ]);
    expect(proposals.map((p) => p.strength)).toEqual(["chain"]);
  });
});
