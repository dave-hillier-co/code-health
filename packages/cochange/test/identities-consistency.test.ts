import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { GitFixture, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { runCochange } from "./support/run.ts";

vi.setConfig({ testTimeout: 120_000 });

const WEEK = 7 * 24 * 3600 * 1000;
const START = Date.UTC(2024, 0, 1, 10, 0, 0);
const at = (week: number, offset: number): string => new Date(START + week * WEEK + offset * 3600 * 1000).toISOString().replace(".000Z", "Z");
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const key = (a: Identity): string => `${a.name} <${a.email}>`;

// One person across a repository: the same weeks, different areas, with a name and a login that agree.
const sergeyWork: Identity = { name: "Sergey Bykov", email: "sbykov@microsoft.com" };
const sergeyLogin: Identity = { name: "Sergey Bykov", email: "sergeybykov@users.noreply.github.com" };
// A login and an address, one name written the same way, one login cut short.
const dmitryLogin: Identity = { name: "Dmitry Vakulenko", email: "dVakulen@users.noreply.github.com" };
const dmitryMail: Identity = { name: "Dmitry Vakulenko", email: "dmitry.vakulenko@outlook.com" };
// Nothing but a cut-short login links this one, and the name is different.
const danielle: Identity = { name: "Danielle Vakulenko", email: "danielle@example.net" };
// Two people with one name, joined by hand against the evidence.
const patA: Identity = { name: "Pat Lee", email: "pat@a.example" };
const patB: Identity = { name: "Pat Lee", email: "plee@b.example" };
// A handle against a real name, one address between them.
const handle: Identity = { name: "jthelin", email: "jon.thelin@example.org" };
const jon: Identity = { name: "Jon Thelin", email: "jon.thelin@example.org" };
// A real name on a noreply address, against a real name on a work address, and a handle with a work address.
const kyleNoreply: Identity = { name: "Kyle McNamara", email: "kylemc@users.noreply.github.com" };
const kyleWork: Identity = { name: "Kyle McNamara", email: "kyle.mcnamara@corp.example" };
const kyleHandle: Identity = { name: "kylemc", email: "kyle.mcnamara@corp.example" };

const specs: { author: Identity; weeks: number[]; path: string }[] = [
  { author: sergeyWork, weeks: range(0, 9), path: "src/silo/a.ts" },
  { author: sergeyLogin, weeks: range(5, 14), path: "docs/guide/b.md" },
  { author: dmitryLogin, weeks: range(0, 8), path: "src/runtime/c.ts" },
  { author: dmitryMail, weeks: range(9, 16), path: "src/core/d.ts" },
  { author: danielle, weeks: range(0, 4), path: "src/other/e.ts" },
  { author: patA, weeks: range(2, 9), path: "app/web/f.ts" },
  { author: patB, weeks: range(2, 9), path: "infra/db/g.ts" },
  { author: jon, weeks: range(0, 8), path: "src/jon/h.ts" },
  { author: handle, weeks: range(9, 16), path: "src/jon/i.ts" },
  { author: kyleNoreply, weeks: range(0, 8), path: "src/kyle/j.ts" },
  { author: kyleWork, weeks: range(0, 5), path: "src/kyle/k.ts" },
  { author: kyleHandle, weeks: range(9, 16), path: "src/kyle/l.ts" },
];

function build(): GitFixture {
  const commits: { date: string; author: Identity; path: string; n: number }[] = [];
  specs.forEach((spec, s) => spec.weeks.forEach((week, n) => commits.push({ date: at(week, s), author: spec.author, path: spec.path, n })));
  commits.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const seen = new Set<string>();
  const steps: Step[] = commits.map((c) => {
    const op = seen.has(c.path) ? ("modify" as const) : ("add" as const);
    seen.add(c.path);
    return { type: "commit", message: `${c.path} ${c.n}`, date: c.date, author: c.author, changes: [{ op, path: c.path, content: `${c.path} ${c.n}\n` }] };
  });
  return GitFixture.build(steps);
}

let repo: GitFixture;
let scratch: string;
beforeAll(() => {
  repo = build();
  scratch = mkdtempSync(join(tmpdir(), "identities-consistency-"));
});
afterAll(() => {
  repo.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

const identities = (...args: string[]) => runCochange(repo.path, ["identities", ...args]);
type Proposal = { strength: string; counterEvidence: boolean; suggestedCanonical: string; members: { identity: string }[] };
const proposals = async (): Promise<Proposal[]> => JSON.parse((await identities("propose", "--limit", "all")).stdout).results;
const containing = (all: Proposal[], ...who: Identity[]): Proposal[] => all.filter((p) => who.every((w) => p.members.some((m) => m.identity === key(w))));

test("a strong join with a name and a login that agree is not counter-evidence for being active in the same weeks in different areas", async () => {
  const all = await proposals();
  const [sergey] = containing(all, sergeyWork, sergeyLogin);
  expect(sergey).toMatchObject({ strength: "strong", counterEvidence: false });

  const file = join(scratch, "sergey.json");
  writeFileSync(file, JSON.stringify({ merges: [{ canonical: sergeyWork, aliases: [sergeyLogin] }] }));
  expect((await identities("apply", "--from", file, "--location", "committed", "--apply")).code).toBe(0);
  const check = JSON.parse((await identities("check", "--limit", "all")).stdout);
  expect(check.results.filter((r: { kind: string; identities: string[] }) => r.kind === "counter-evidence" && r.identities.includes(key(sergeyLogin)))).toEqual([]);
});

test("a join made against the evidence, with nothing strong behind it, still fails check for counter-evidence", async () => {
  const [pat] = containing(await proposals(), patA, patB);
  expect(pat).toMatchObject({ strength: "medium", counterEvidence: true });
  const file = join(scratch, "pat.json");
  writeFileSync(file, JSON.stringify({ merges: [{ canonical: patA, aliases: [patB] }] }));
  await identities("apply", "--from", file, "--location", "committed", "--apply");
  const check = JSON.parse((await identities("check", "--limit", "all")).stdout);
  expect(check.results.filter((r: { kind: string; identities: string[] }) => r.kind === "counter-evidence" && r.identities.includes(key(patB)))).toHaveLength(1);
});

test("one name beside a login cut short from the surname is one strong cluster, and a login alone is not", async () => {
  const all = await proposals();
  const [dmitry] = containing(all, dmitryLogin, dmitryMail);
  expect(dmitry).toMatchObject({ strength: "strong", counterEvidence: false });
  expect(dmitry!.members).toHaveLength(2);
  const [other] = containing(all, dmitryLogin, danielle);
  expect(other?.strength).toBe("medium");
});

test("the suggested name is a personal name before a handle, then an address that is not a noreply, then the latest", async () => {
  const all = await proposals();
  expect(containing(all, jon, handle)[0]!.suggestedCanonical).toBe(key(jon));
  // Both real names, so the work address beats the noreply address even though the noreply identity is as recent as any.
  const kyle = containing(all, kyleNoreply, kyleWork, kyleHandle).find((p) => p.members.length === 3)!;
  expect(kyle.suggestedCanonical).toBe(key(kyleWork));
});
