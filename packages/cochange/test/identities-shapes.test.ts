import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { GitFixture, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { runCochange } from "./support/run.ts";

vi.setConfig({ testTimeout: 120_000 });

// Invented people whose addresses take shapes that link strangers unless the evidence is read with care.
const nora: Identity = { name: "Nora Vance", email: "ship@acme.io" };
const omar: Identity = { name: "Omar Ruiz", email: "ship@acme.io" };
const pat: Identity = { name: "Pat Quinn", email: "team@acme.io" };
const patLogin: Identity = { name: "pquinn", email: "team@acme.io" };
const lena: Identity = { name: "Lena Hart", email: "lena@hartmail.net" };
const lenaLogin: Identity = { name: "lhart", email: "lena@hartmail.net" };
const ivo: Identity = { name: "Ivo Brandt", email: "github@brandt.dev" };
const mia: Identity = { name: "Mia Sato", email: "github@sato.io" };
const tomasR: Identity = { name: "Tomas Reyes", email: "tomas@reyes.dev" };
const tomasL: Identity = { name: "Tomas Lindqvist", email: "tomas@lindqvist.se" };
const gusWork: Identity = { name: "Gus Pell", email: "gus.pell@acme.io" };
const gusTagged: Identity = { name: "Gus Pell", email: "gus.pell+ci@acme.io" };
const gusHome: Identity = { name: "Gus Pell", email: "gus@pellhome.net" };
const acmeBot: Identity = { name: "Acme Bot", email: "ci-helper@acme.io" };
const infraSync: Identity = { name: "Infra Sync", email: "robot-sync@acme.io" };
const ann: Identity = { name: "Ann Abbott", email: "ann@abbott.dev" };
const lee: Identity = { name: "Lee Talbot", email: "lee@talbot.dev" };

const START = Date.UTC(2024, 0, 1, 10);
const WEEK = 7 * 24 * 3600 * 1000;

let repo: GitFixture;
beforeAll(() => {
  const authors: [Identity, string][] = [
    [nora, "release/notes.md"],
    [omar, "release/script.sh"],
    [pat, "src/pat.ts"],
    [patLogin, "src/pat.ts"],
    [lena, "src/lena.ts"],
    [lenaLogin, "src/lena.ts"],
    [ivo, "src/ivo.ts"],
    [mia, "lib/mia.ts"],
    [tomasR, "src/tomas.ts"],
    [tomasL, "lib/tomas.ts"],
    [gusWork, "src/gus.ts"],
    [gusTagged, "src/gus.ts"],
    [gusHome, "src/gus.ts"],
    [acmeBot, "ci/config.yml"],
    [infraSync, "infra/main.tf"],
    [ann, "src/ann.ts"],
    [lee, "src/lee.ts"],
  ];
  const steps: Step[] = [];
  const seen = new Set<string>();
  for (let round = 0; round < 3; round++) {
    authors.forEach(([author, path], i) => {
      const op = seen.has(path) ? "modify" : "add";
      seen.add(path);
      steps.push({
        type: "commit",
        message: `${path} ${round}`,
        date: new Date(START + round * WEEK + i * 3600 * 1000).toISOString().replace(".000Z", "Z"),
        author,
        changes: [{ op, path, content: `${path} ${round} ${i}\n` }],
      });
    });
  }
  repo = GitFixture.build(steps);
});
afterAll(() => repo.dispose());

const key = (a: Identity) => `${a.name} <${a.email}>`;
const json = async (...args: string[]) => JSON.parse((await runCochange(repo.path, ["identities", ...args, "--limit", "all"])).stdout);

interface Row {
  kind: string;
  strength: string;
  counterEvidence: boolean;
  members: { identity: string }[];
  links: { strength: string; signals: { signal: string; strength: string; detail: string }[] }[];
}
const containing = (rows: Row[], identity: Identity) => rows.filter((r) => r.members.some((m) => m.identity === key(identity)));

test("an address committed under two people's names is a medium link with counter-evidence, not a strong one", async () => {
  const rows: Row[] = (await json("propose")).results;
  const [shared] = containing(rows, nora);
  expect(shared).toMatchObject({ kind: "cluster", strength: "medium", counterEvidence: true });
  expect(shared!.links[0]!.signals.map((s) => [s.signal, s.strength])).toEqual([
    ["exact-email", "medium"],
    ["shared-mailbox", "counter"],
  ]);
  // A role address at an organisation's domain is shared even when one person's name and login are all it shows.
  expect(containing(rows, pat)[0]).toMatchObject({ strength: "medium", counterEvidence: true });
  // A person's name beside their login at their own address stays strong.
  expect(containing(rows, lena)[0]).toMatchObject({ strength: "strong", counterEvidence: false });
});

test("a generic local part or a shared first name with different surnames links no one", async () => {
  const rows: Row[] = (await json("propose")).results;
  for (const identity of [ivo, mia, tomasR, tomasL, ann, lee]) expect(containing(rows, identity)).toEqual([]);
});

test("each identity is in one cluster at most, strong clusters come first, and a chain shows only its medium links", async () => {
  const rows: Row[] = (await json("propose")).results;
  const clustered = rows.filter((r) => r.kind === "cluster").flatMap((r) => r.members.map((m) => m.identity));
  expect(new Set(clustered).size).toBe(clustered.length);
  const order = { strong: 0, medium: 1, chain: 2 } as Record<string, number>;
  expect(rows.map((r) => order[r.strength])).toEqual(rows.map((r) => order[r.strength]).sort());
  const gus = containing(rows, gusHome);
  expect(gus.map((r) => r.strength)).toEqual(["chain"]);
  expect(gus[0]!.links.every((l) => l.strength === "medium")).toBe(true);
  expect(containing(rows, gusWork).map((r) => r.strength)).toEqual(["strong", "chain"]);
});

test("classify finds bot and robot as words of the name or local part, says which, and leaves Abbott and Talbot alone", async () => {
  const rows: { identity: string; kind: string; signal: string }[] = (await json("classify")).results;
  expect(rows.find((r) => r.identity === key(acmeBot))).toMatchObject({ kind: "bot", signal: "name" });
  expect(rows.find((r) => r.identity === key(infraSync))).toMatchObject({ kind: "bot", signal: "local-part" });
  expect(rows.map((r) => r.identity)).not.toContain(key(ann));
  expect(rows.map((r) => r.identity)).not.toContain(key(lee));
});
