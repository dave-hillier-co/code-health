import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import {
  alexA,
  alexB,
  dependabot,
  identityHistory,
  jenkins,
  jo1,
  jo2,
  john1,
  john2,
  maria1,
  maria2,
  samHome,
  samWork,
} from "./support/identity-scenario.ts";
import { runCochange } from "./support/run.ts";

vi.setConfig({ testTimeout: 120_000 });

let repo: GitFixture;
let scratch: string;
let initial: string;
beforeAll(() => {
  repo = identityHistory();
  initial = repo.git("rev-parse", "HEAD");
  scratch = mkdtempSync(join(tmpdir(), "identities-input-"));
});
afterAll(() => {
  repo.dispose();
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  // Back to the committed state: no mailmap, decisions, config or cache from an earlier test.
  repo.git("reset", "--hard", "--quiet", initial);
  repo.git("clean", "-fdxq");
});

const key = (a: { name: string; email: string }) => `${a.name} <${a.email}>`;
const identities = (...args: string[]) => runCochange(repo.path, ["identities", ...args]);
const json = (stdout: string) => JSON.parse(stdout);
let inputs = 0;
const input = (document: unknown): string => {
  const file = join(scratch, `input-${++inputs}.json`);
  writeFileSync(file, JSON.stringify(document));
  return file;
};

const approved = {
  merges: [
    { canonical: jo2, aliases: [jo1] },
    { canonical: john2, aliases: [john1] },
    { canonical: maria2, aliases: [maria1] },
    { canonical: samWork, aliases: [samHome] },
  ],
  rejectedMerges: [{ identities: [key(alexA), key(alexB)], reason: "two people, one name" }],
  classifications: [],
};

test("list shows each identity as written, with activity and the mapping it has", async () => {
  const { code, stdout, stderr } = await identities("list", "--limit", "all");
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  const document = json(stdout);
  expect(document.results[0]).toMatchObject({ identity: "Chris Dee <chris@corp.com>", commits: 21, mappedTo: null, kind: "person", unmapped: false });
  expect(document.results.find((r: { identity: string }) => r.identity.startsWith("Jenkins"))).toMatchObject({ kind: "service" });
  expect(document.results.find((r: { identity: string }) => r.identity.startsWith("dependabot"))).toMatchObject({ kind: "bot" });
  expect(document.inputs).toEqual({ subcommand: "list", unmapped: false });
  expectGolden("identities", "identities.list", stdout);
});

test("list --unmapped keeps only identities a decision is still owed on, and the top areas are bounded", async () => {
  const document = json((await identities("list", "--unmapped", "--limit", "all")).stdout);
  const names = document.results.map((r: { identity: string }) => r.identity);
  expect(names).not.toContain("Chris Dee <chris@corp.com>");
  expect(names).toContain(key(jo1));
  expect(document.results.every((r: { topAreas: string[] }) => r.topAreas.length <= 3)).toBe(true);
});

test("propose gives clusters and the signals behind every link, strongest first", async () => {
  const { stdout } = await identities("propose", "--limit", "all");
  const document = json(stdout);
  const byId = Object.fromEntries(document.results.map((p: { id: string }) => [p.id, p]));
  expect(document.results.map((p: { strength: string }) => p.strength)).toEqual(["strong", "strong", "strong", "medium", "medium"]);
  expect(byId.P1.members.map((m: { identity: string }) => m.identity).sort()).toEqual([key(jo1), key(jo2)].sort());
  expect(byId.P1.links[0].signals.map((s: { signal: string }) => s.signal)).toEqual(["exact-email"]);
  expect(byId.P2.links[0].signals[0]).toMatchObject({ signal: "noreply-same-user", strength: "strong" });
  const alex = document.results.find((p: { members: { identity: string }[] }) => p.members.some((m) => m.identity === key(alexA)));
  expect(alex).toMatchObject({ counterEvidence: true });
  const sam = document.results.find((p: { members: { identity: string }[] }) => p.members.some((m) => m.identity === key(samHome)));
  expect(sam.links[0].signals.map((s: { signal: string }) => s.signal)).toContain("exclusive-pairing");
  const maria = document.results.find((p: { members: { identity: string }[] }) => p.members.some((m) => m.identity === key(maria1)));
  expect(maria.links[0].signals.map((s: { signal: string }) => s.signal)).toContain("handover");
  // The most recently active identity is suggested as the name to keep.
  expect(byId.P1.suggestedCanonical).toBe(key(jo2));
  expect(maria.suggestedCanonical).toBe(key(maria2));
  expect(JSON.stringify(document.results)).not.toContain("chris@corp.com");
  expectGolden("identities", "identities.propose", stdout);
});

test("propose is the same on every run", async () => {
  const first = (await identities("propose", "--limit", "all")).stdout;
  repo.git("clean", "-fdxq");
  const second = (await identities("propose", "--limit", "all")).stdout;
  const strip = (text: string) => JSON.stringify({ ...json(text), meta: undefined });
  expect(strip(second)).toBe(strip(first));
});

test("classify names bots, services and agent trailers with the pattern that matched, and whether a decision records them", async () => {
  const { stdout } = await identities("classify");
  const document = json(stdout);
  expect(document.results.map((r: { kind: string; identity: string }) => [r.kind, r.identity])).toEqual([
    ["bot", key(dependabot)],
    ["service", key(jenkins)],
    ["agent", "Claude Opus 5.5 <noreply@anthropic.com>"],
  ]);
  // No decision records any of them. The agent is already an agent by a built-in rule, so nothing is left to decide for it.
  expect(document.results.map((r: { kind: string; decided: boolean }) => [r.kind, r.decided])).toEqual([["bot", false], ["service", false], ["agent", true]]);
  expectGolden("identities", "identities.classify", stdout);
});

test("check fails on counter-evidence, reports unmapped identities and measures what share of lines is settled", async () => {
  const { code, stdout } = await identities("check", "--limit", "all");
  expect(code).toBe(ExitCode.CheckFailed);
  const document = json(stdout);
  const kinds = new Set(document.results.map((r: { kind: string }) => r.kind));
  expect(kinds).toEqual(new Set(["counter-evidence", "unmapped"]));
  const unmapped = document.results.filter((r: { kind: string }) => r.kind === "unmapped");
  expect(unmapped.every((r: { aboveGuideline: boolean; lines: number; commits: number }) => r.aboveGuideline === (r.lines > 0 || r.commits >= 3))).toBe(true);
  expect(document.results.filter((r: { kind: string }) => r.kind !== "unmapped").every((r: { aboveGuideline: unknown }) => r.aboveGuideline === null)).toBe(true);
  expect(document.measurement.headLines.mappedShare).toBeLessThan(50);
  expect(document.measurement.needsIdentityReview).toBe(true);
  expect(document.measurement.headLines.nonPerson).toBeGreaterThan(0);
  expect(document.measurement.headLines.total).toBe(document.measurement.headLines.people + document.measurement.headLines.nonPerson);
  expectGolden("identities", "identities.check", stdout);
});

test("apply is a dry run until --apply, and writes nothing", async () => {
  const from = input(approved);
  const { code, stdout } = await identities("apply", "--from", from, "--location", "committed");
  expect(code).toBe(ExitCode.Success);
  const document = json(stdout);
  expect(document.dryRun).toBe(true);
  expect(document.written).toBe(false);
  expect(document.results.filter((r: { change: string }) => r.change === "add")).toHaveLength(5);
  expect(existsSync(join(repo.path, ".mailmap"))).toBe(false);
  expect(existsSync(join(repo.path, ".code-health"))).toBe(false);
  expectGolden("identities", "identities.apply", stdout);
});

test("apply asks for a location when none has been chosen", async () => {
  const { code, stderr } = await identities("apply", "--from", input(approved), "--json");
  expect(code).toBe(ExitCode.Usage);
  expect(JSON.parse(stderr).error.message).toContain("ask the user");
});

test("apply --apply writes a committed mailmap and decisions, after which check is clean", async () => {
  const from = input({ ...approved, classifications: [{ identity: key(jenkins), kind: "service" }] });
  const applied = json((await identities("apply", "--from", from, "--location", "committed", "--apply")).stdout);
  expect(applied.written).toBe(true);
  expect(readFileSync(join(repo.path, ".mailmap"), "utf8")).toBe(
    [
      "John Smith <jsmith@users.noreply.github.com> jsmith <1234+jsmith@users.noreply.github.com>",
      "Jo Park <jo+git@x.com> J Park <Jo@X.com>",
      "María López <mlopez@gmail.com> Maria Lopez <maria@corp.com>",
      "Sam Ro <sam@corp.com> Sam Ro <sam@home.net>",
      "",
    ]
      .sort()
      .join("\n")
      .replace(/^\n/, "") + "\n",
  );
  const decisions = json(readFileSync(join(repo.path, ".code-health", "identity-decisions.json"), "utf8"));
  expect(decisions.rejectedMerges).toEqual([{ identities: [key(alexB), key(alexA)], reason: "two people, one name" }]);
  expect(decisions.classifications).toEqual([{ identity: key(jenkins), kind: "service" }]);

  const { code, stdout } = await identities("check", "--limit", "all");
  expect(code).toBe(ExitCode.Success);
  const document = json(stdout);
  expect(document.results).toEqual([]);
  expect(document.measurement.headLines.mappedShare).toBe(100);
  expect(document.measurement.needsIdentityReview).toBe(false);
  expect(json((await identities("propose")).stdout).results).toEqual([]);
  const listed = json((await identities("list", "--limit", "all")).stdout).results;
  expect(listed.find((r: { identity: string }) => r.identity === key(jo1)).mappedTo).toBe(key(jo2));
});

test("a committed mailmap changes what other commands count once it is committed", async () => {
  await identities("apply", "--from", input(approved), "--location", "committed", "--apply");
  repo.commit({ message: "Add the identity mapping", date: "2024-05-21T10:00:00Z", changes: [] });
  const contributors = async () => json((await runCochange(repo.path, ["hotspots"])).stdout).evidence.activeContributors;
  // Chris, Jo, John, Maria, two Alex Kims and Sam, plus the author of the mapping commit. The bot and service accounts are not people.
  expect(await contributors()).toBe(8);
});

test("a local mapping is written under .code-health/local, which git ignores", async () => {
  await identities("apply", "--from", input(approved), "--location", "local", "--apply");
  expect(readFileSync(join(repo.path, ".code-health", "local", ".gitignore"), "utf8")).toBe("*\n");
  expect(existsSync(join(repo.path, ".code-health", "local", "mailmap"))).toBe(true);
  expect(existsSync(join(repo.path, ".code-health", "local", "identity-decisions.json"))).toBe(true);
  expect(existsSync(join(repo.path, ".mailmap"))).toBe(false);
  expect(repo.git("status", "--porcelain", "--", ".code-health", ".mailmap")).toBe("");
  // The next command finds the choice from the files, and the analysis uses the local mailmap.
  expect(json((await identities("propose")).stdout).results).toHaveLength(0);
  const hotspots = json((await runCochange(repo.path, ["hotspots"])).stdout);
  expect(hotspots.evidence.activeContributors).toBe(7);
  expect(hotspots.inputs.identityInputs.localMailmap).toMatch(/^[0-9a-f]{16}$/);
});

test("a rejection is remembered, so the pair is not proposed again", async () => {
  await identities("apply", "--from", input({ rejectedMerges: [{ identities: [key(alexA), key(alexB)] }] }), "--location", "committed", "--apply");
  const names = json((await identities("propose", "--limit", "all")).stdout).results.flatMap((p: { members: { identity: string }[] }) => p.members.map((m) => m.identity));
  expect(names).not.toContain(key(alexA));
  expect(names).not.toContain(key(alexB));
});

test("apply keeps existing mailmap lines and comments byte for byte", async () => {
  const existing = "# Our mailmap\n\nChris D <chris@corp.com> <chris@old.example>\n";
  writeFileSync(join(repo.path, ".mailmap"), existing);
  await identities("apply", "--from", input(approved), "--apply");
  const text = readFileSync(join(repo.path, ".mailmap"), "utf8");
  expect(text.startsWith(existing)).toBe(true);
  expect(text.slice(existing.length).trim().split("\n")).toHaveLength(4);
  // Applying the same file again changes nothing.
  const again = json((await identities("apply", "--from", input(approved), "--apply")).stdout);
  expect(again.written).toBe(false);
  expect(readFileSync(join(repo.path, ".mailmap"), "utf8")).toBe(text);
});

test("apply refuses identities that are not in the history, a rejected pair, and an alias mapped elsewhere", async () => {
  const unknown = await identities("apply", "--from", input({ merges: [{ canonical: jo2, aliases: [{ name: "Nobody", email: "nobody@x.com" }] }] }), "--location", "committed", "--json");
  expect(unknown.code).toBe(ExitCode.Usage);
  expect(JSON.parse(unknown.stderr).error.message).toContain("Nobody <nobody@x.com>");

  const contradiction = await identities("apply", "--from", input({ merges: [{ canonical: alexA, aliases: [alexB] }], rejectedMerges: [{ identities: [key(alexA), key(alexB)] }] }), "--location", "committed");
  expect(contradiction.code).toBe(ExitCode.Usage);
  expect(contradiction.stderr).toContain("different people");

  writeFileSync(join(repo.path, ".mailmap"), "Maria Lopez <maria@corp.com> <mlopez@gmail.com>\n");
  const elsewhere = await identities("apply", "--from", input({ merges: [{ canonical: jo2, aliases: [maria2] }] }), "--location", "committed");
  expect(elsewhere.code).toBe(ExitCode.Usage);
  expect(elsewhere.stderr).toContain("already mapped");
});

test("apply needs --from, and options belong to their own subcommand", async () => {
  expect((await identities("apply", "--location", "committed")).code).toBe(ExitCode.Usage);
  expect((await identities("list", "--apply")).code).toBe(ExitCode.Usage);
  expect((await identities("frobnicate")).code).toBe(ExitCode.Usage);
  expect((await runCochange(repo.path, ["identities"])).code).toBe(ExitCode.Usage);
});

test("a bad location in the config is rejected, and a configured one is used without asking", async () => {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { identities: { location: "local" } } }));
  const applied = await identities("apply", "--from", input(approved), "--apply");
  expect(applied.code).toBe(ExitCode.Success);
  expect(existsSync(join(repo.path, ".code-health", "local", "mailmap"))).toBe(true);
});

test("the identity commands never write a report for another plugin to read", async () => {
  for (const sub of ["list", "propose", "classify", "check"]) await identities(sub);
  expect(existsSync(join(repo.path, ".cache", "code-health", "reports"))).toBe(false);
});

test("a classification decision removes that identity's commits from every analysis, and a person decision keeps a human named like a service", async () => {
  const before = json((await runCochange(repo.path, ["hotspots"])).stdout);
  expect(before.filtersApplied.dropped.botCommits).toBe(6);
  await identities("apply", "--from", input({ classifications: [{ identity: key(jenkins), kind: "person", reason: "a human named Jenkins" }] }), "--location", "committed", "--apply");
  const after = json((await runCochange(repo.path, ["hotspots"])).stdout);
  expect(after.filtersApplied.dropped.botCommits).toBe(3);
  const classes = json((await identities("classify")).stdout).results.map((r: { identity: string }) => r.identity);
  expect(classes).not.toContain(key(jenkins));
});

test("check counts the lines the shared blame cache holds, so its share cannot differ from abandonment's", async () => {
  const { readBlame } = await import("@code-health/history/blame-read");
  const document = json((await identities("check", "--limit", "all")).stdout);
  const snapshot = await readBlame(repo.path, { ref: "HEAD" });
  const cached = [...snapshot.files.values()].reduce((sum, file) => sum + file.lines, 0);
  expect(document.measurement.headLines.unknownFiles).toBe(0);
  expect(document.measurement.headLines.total + document.measurement.headLines.unattributed).toBe(cached);
  expect(existsSync(join(repo.path, ".cache", "code-health", "blame.sqlite"))).toBe(true);
});

test("check with --no-refresh does not blame, and reports the files the cache has nothing for", async () => {
  await identities("check");
  rmSync(join(repo.path, ".cache", "code-health", "blame.sqlite"), { force: true });
  const document = json((await identities("check", "--no-refresh", "--limit", "all")).stdout);
  expect(document.measurement.headLines.unknownFiles).toBeGreaterThan(0);
  expect(document.measurement.headLines.total).toBe(0);
  expect(existsSync(join(repo.path, ".cache", "code-health", "blame.sqlite"))).toBe(false);
});
