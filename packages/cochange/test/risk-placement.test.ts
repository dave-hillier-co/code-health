import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { ledger, placementHistory } from "./support/placement-scenario.ts";
import { expectGolden } from "./support/golden.ts";
import { runCochange, runCochangeOnTerminal } from "./support/run.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = placementHistory();
}, 60_000);
afterAll(() => repo.dispose());

const config = (risk: Record<string, unknown> = {}) =>
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { risk: { newIdentityChanges: 2, placement: "any", ...risk } } }));

beforeEach(() => {
  repo.git("checkout", "--quiet", "main");
  repo.git("config", "user.email", "alice@example.com");
  repo.git("config", "user.name", "Alice");
  config();
});
afterEach(() => rmSync(join(repo.path, ".cache"), { recursive: true, force: true }));

interface FilePlace {
  file: string;
  label: string;
  authorship: number | null;
  earlierChanges: number;
  recentChanges: number;
  familiarity: number;
}
interface FactorRow {
  name: string;
  status: string;
  value: Record<string, number>;
  evidence: Record<string, unknown>[];
  reason: string | null;
}
interface Placed {
  status: string;
  mode: string;
  reason: string | null;
  band: string | null;
  basis: string | null;
  newIdentity: boolean;
  shares: Record<string, number> | null;
  files: FilePlace[];
  blame: { used: boolean; missing: number; refreshed: boolean };
  factors: FactorRow[];
}

async function place(...args: string[]): Promise<{ code: number; stdout: string; placement: Placed; change: Record<string, unknown> }> {
  const { code, stdout } = await runCochange(repo.path, ["risk", ...args, "--json"]);
  const document = stdout === "" ? undefined : JSON.parse(stdout);
  return { code, stdout, placement: document?.results.placement, change: document?.results.change };
}

const factor = (placed: Placed, name: string): FactorRow => placed.factors.find((f) => f.name === name)!;

describe("labels from hand-computed blame", () => {
  test("a regular: the author rewrote 4 of the ledger's 10 lines, so holds 40 %, meaningful but not a major share", async () => {
    const { placement } = await place("main..alice");
    expect(placement.files).toHaveLength(1);
    expect(placement.files[0]).toMatchObject({ file: ledger, label: "regular", authorship: 0.4, earlierChanges: 1, recentChanges: 0 });
    expect(placement.band).toBe("close");
    expect(placement.basis).toBe("blame");
    expect(factor(placement, "authorship").value).toEqual({ files: 1, meanShare: 0.4 });
  });

  test("an owner: Bob's 6 lines are 60 % of the ledger, at least the major share", async () => {
    const { placement } = await place("main..bob");
    expect(placement.files[0]).toMatchObject({ label: "owner", authorship: 0.6 });
    expect(placement.band).toBe("close");
    // He changed the ledger once, 139 days before the branch's tip, and familiarity halves every twelve months.
    const expected = Math.round(0.5 ** ((139 * 86_400) / (12 * 30.4375 * 86_400)) * 100) / 100;
    expect(placement.files[0]!.familiarity).toBe(expected);
  });

  test("two authors together hold the whole ledger, 100 % of the lines the change's authors wrote", async () => {
    const { placement, change } = await place("main..both");
    expect(change.authors).toBe(2);
    expect(placement.files[0]).toMatchObject({ label: "owner", authorship: 1 });
  });

  test("a first touch: Dave knows the repository but has never changed the ledger, and holds none of it", async () => {
    const { placement } = await place("main..dave");
    expect(placement.files[0]).toMatchObject({ label: "first-touch", authorship: 0, earlierChanges: 0 });
    expect(placement.band).toBe("distant");
    expect(factor(placement, "first-touch-share").value).toEqual({ share: 1 });
  });

  test("a new contributor is unknown, not first-touch: someone with no history may know this code from elsewhere", async () => {
    const { placement } = await place("main..carol");
    expect(placement.newIdentity).toBe(true);
    expect(placement.files[0]!.label).toBe("unknown");
    expect(placement.band).toBe("unknown");
    expect(placement.shares).toMatchObject({ unknown: 1, "first-touch": 0 });
  });

  test("a new file has no history to place anyone against", async () => {
    const { placement } = await place("main..alice-other");
    expect(placement.files[0]!.label).toBe("unknown");
    expect(placement.band).toBe("unknown");
    // New files have nothing to blame, so no blame was used.
    expect(placement.blame.used).toBe(false);
    expect(factor(placement, "authorship")).toMatchObject({ status: "unavailable" });
  });

  test("a new identity is also one with fewer changes than the configured number", async () => {
    config({ newIdentityChanges: 3 });
    const { placement } = await place("main..alice");
    // Alice made two changes, one fewer than three.
    expect(placement.newIdentity).toBe(true);
    expect(placement.band).toBe("unknown");
  });

  test("a clear owner who did not write the change is the owner to ask: counted, never named", async () => {
    const { placement, stdout } = await place("main..dave");
    expect(factor(placement, "owner-distance")).toMatchObject({ value: { files: 1 }, evidence: [{ file: ledger, share: 0.6 }] });
    expect(stdout).not.toMatch(/Bob|bob@/);
  });

  test("no one holds a meaningful share when the owners are no longer active", async () => {
    // Bob and Alice last changed anything in February. With the window at one month, nobody is active at the branch's tip.
    writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { activityWindowMonths: 1 }, risk: { newIdentityChanges: 2, placement: "any" } } }));
    const { placement } = await place("main..dave");
    expect(factor(placement, "no-owner")).toMatchObject({ value: { files: 1 }, evidence: [{ file: ledger }] });
  });
});

describe("the blame cache", () => {
  test("it is refreshed for the touched files at the base, and nothing else is blamed", async () => {
    await place("main..alice");
    expect(existsSync(join(repo.path, ".cache", "code-health", "blame.sqlite"))).toBe(true);
  });

  test("without it, labels come from change familiarity alone, and authorship is unavailable", async () => {
    await place("main..alice");
    rmSync(join(repo.path, ".cache", "code-health", "blame.sqlite"), { force: true });
    rmSync(join(repo.path, ".cache", "code-health", "blame.sqlite-wal"), { force: true });
    rmSync(join(repo.path, ".cache", "code-health", "blame.sqlite-shm"), { force: true });
    const { placement } = await place("main..alice", "--no-refresh");
    expect(placement.basis).toBe("history");
    expect(placement.blame).toEqual({ used: false, missing: 1, refreshed: false });
    expect(factor(placement, "authorship")).toMatchObject({ status: "unavailable", value: {} });
    expect(factor(placement, "authorship").reason).toMatch(/no blame/);
    // One change in the window out of two is half, but a single change is not several: occasional, not regular.
    expect(placement.files[0]!.label).toBe("occasional");
    expect(factor(placement, "change-familiarity").status).toBe("ok");
  });
});

describe("privacy", () => {
  test("by default placement is computed for the invoking git identity's own change", async () => {
    config({ placement: "self" });
    const { placement } = await place("main..alice");
    expect(placement).toMatchObject({ status: "computed", mode: "self", band: "close" });
  });

  test("by default it is withheld for someone else's branch, with the reason and nothing else", async () => {
    config({ placement: "self" });
    const { code, placement, stdout } = await place("main..bob");
    expect(code).toBe(ExitCode.Success);
    expect(placement).toMatchObject({ status: "withheld", mode: "self", band: null, shares: null, files: [], factors: [] });
    expect(placement.reason).toMatch(/placement: any/);
    expect(stdout).not.toMatch(/Bob|bob@/);
  });

  test("a branch with several authors is withheld unless all of them are the invoking identity", async () => {
    config({ placement: "self" });
    expect((await place("main..both")).placement.status).toBe("withheld");
  });

  test("the setting any computes it for a colleague's branch, which is the team's decision to make in the config", async () => {
    config({ placement: "any" });
    expect((await place("main..bob")).placement.status).toBe("computed");
  });

  test("the setting off never computes it", async () => {
    config({ placement: "off" });
    const { placement } = await place("main..alice");
    expect(placement).toMatchObject({ status: "off", band: null, files: [] });
  });

  test("with no git identity configured the self check cannot pass, so it is withheld", async () => {
    config({ placement: "self" });
    repo.git("config", "--unset", "user.email");
    const keep = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM, author: process.env.GIT_AUTHOR_EMAIL };
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    delete process.env.GIT_AUTHOR_EMAIL;
    try {
      const { placement } = await place("main..alice");
      expect(placement.status).toBe("withheld");
      expect(placement.reason).toMatch(/no git identity/);
    } finally {
      for (const [key, value] of [["GIT_CONFIG_GLOBAL", keep.global], ["GIT_CONFIG_NOSYSTEM", keep.system], ["GIT_AUTHOR_EMAIL", keep.author]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("uncommitted edits are the invoking user's, so a worktree check on one's own branch is computed", async () => {
    config({ placement: "self" });
    repo.git("checkout", "--quiet", "alice");
    writeFileSync(join(repo.path, "docs/notes.md"), "edited\n");
    try {
      const { placement } = await place("--worktree");
      expect(placement.status).toBe("computed");
    } finally {
      repo.git("checkout", "--quiet", "--", "docs/notes.md");
    }
  });

  test("placement and anything derived from it are never written down", async () => {
    repo.git("checkout", "--quiet", "alice");
    const { placement } = await place();
    expect(placement.status).toBe("computed");
    const reports = join(repo.path, ".cache", "code-health", "reports");
    const stored = readdirSync(reports).filter((f) => f.startsWith("cochange.risk"));
    expect(stored).toEqual(["cochange.risk.json"]);
    const text = readFileSync(join(reports, stored[0]!), "utf8");
    expect(text).not.toMatch(/placement|level|first-touch|authorship|owner-distance|familiarity/);
    // The impact factors are kept.
    expect(JSON.parse(text).results.factors.map((f: { name: string }) => f.name)).toContain("size");
    // And the blame cache holds commits, never identities.
    const blame = readFileSync(join(repo.path, ".cache", "code-health", "blame.sqlite"));
    expect(blame.includes("example.com")).toBe(false);
  });

  test("no command lists placement by author: the output names no one", async () => {
    const { stdout } = await place("main..bob");
    expect(stdout).not.toMatch(/Bob|Alice|Dave|Carol|@example\.com/);
  });
});

test("the assessment of one's own change with its placement, byte for byte", async () => {
  const { stdout } = await runCochange(repo.path, ["risk", "main..alice"]);
  expectGolden("placement", "risk.alice", stdout);
});

test("the same branch as a colleague's, with placement withheld, byte for byte", async () => {
  config({ placement: "self" });
  const { stdout } = await runCochange(repo.path, ["risk", "main..bob"]);
  expectGolden("placement", "risk.withheld", stdout);
});

describe("reviewers", () => {
  interface Area {
    area: string;
    files: number;
    candidates: number;
    suggested: { name: string; email: string; authorship: number; coupledChanges: number }[] | null;
  }
  async function reviewers(...args: string[]): Promise<{ code: number; stdout: string; stderr: string; areas: Area[]; basis: string }> {
    const { code, stdout, stderr } = await runCochange(repo.path, ["risk", "reviewers", ...args, "--json"]);
    const results = stdout === "" ? undefined : JSON.parse(stdout).results;
    return { code, stdout, stderr, areas: results?.areas, basis: results?.basis };
  }

  test("without --names the areas are listed with counts of who could review them, and no one is named", async () => {
    const { areas, stdout, basis } = await reviewers("main..dave");
    expect(basis).toBe("blame");
    expect(areas).toEqual([{ area: "src/ledger", files: 1, candidates: 2, suggested: null }]);
    expect(stdout).not.toMatch(/Bob|Alice|@example\.com/);
  });

  test("with --names they are the active developers who last wrote the touched files, most lines first", async () => {
    const { areas } = await reviewers("main..dave", "--names");
    expect(areas[0]!.suggested).toEqual([
      { name: "Bob", email: "bob@example.com", authorship: 0.6, coupledChanges: 0 },
      { name: "Alice", email: "alice@example.com", authorship: 0.4, coupledChanges: 0 },
    ]);
  });

  test("the change's own authors are not suggested to review it", async () => {
    const { areas } = await reviewers("main..alice", "--names");
    expect(areas[0]!.suggested!.map((c) => c.name)).toEqual(["Bob"]);
  });

  test("with --worktree the invoking user wrote the uncommitted edits, so they are not suggested to review them", async () => {
    repo.git("config", "user.email", "bob@example.com");
    repo.git("config", "user.name", "Bob");
    const file = join(repo.path, "src/ledger/ledger.ts");
    const before = readFileSync(file, "utf8");
    writeFileSync(file, `${before}// an uncommitted edit\n`);
    try {
      const named = await reviewers("main", "--worktree", "--names");
      expect(named.code).toBe(ExitCode.Success);
      expect(named.areas[0]!.suggested!.map((c) => c.name)).toEqual(["Alice"]);
      const counted = await reviewers("main", "--worktree");
      expect(counted.areas[0]!.candidates).toBe(1);
    } finally {
      writeFileSync(file, before);
    }
  });

  test("a bot is never suggested, and its lines belong to nobody", async () => {
    writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { risk: { newIdentityChanges: 2 }, identities: { botPatterns: ["^Bob "] } } }));
    const { areas } = await reviewers("main..dave", "--names");
    expect(areas[0]!.suggested!.map((c) => c.name)).toEqual(["Alice"]);
  });

  test("a developer who has left the recent window is not active, so not suggested", async () => {
    writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { activityWindowMonths: 1 }, risk: { newIdentityChanges: 2 } } }));
    const { areas } = await reviewers("main..dave", "--names");
    expect(areas[0]).toMatchObject({ candidates: 0, suggested: [] });
  });

  test("reviewers are suggested for a colleague's branch whatever the placement setting, since they describe code", async () => {
    config({ placement: "self" });
    repo.git("config", "user.email", "carol@example.com");
    const { code, areas } = await reviewers("main..bob");
    expect(code).toBe(ExitCode.Success);
    expect(areas[0]!.candidates).toBe(1);
  });

  test("--evidence is not taken", async () => {
    expect((await reviewers("main..dave", "--evidence", "x.json")).code).toBe(ExitCode.Usage);
  });

  test("the suggestions, byte for byte", async () => {
    const { stdout } = await runCochange(repo.path, ["risk", "reviewers", "main..dave", "--names"]);
    expectGolden("placement", "risk.reviewers", stdout);
  });
});

describe("a sweep for names", () => {
  const people = /Alice|Bob|Carol|Dave|@example\.com/;
  // Every subcommand and every branch, in JSON and in the terminal table. Only `reviewers --names` may name anyone.
  const commands: string[][] = [
    ["risk", "main..alice"],
    ["risk", "main..bob"],
    ["risk", "main..both"],
    ["risk", "main..carol"],
    ["risk", "main..alice-other"],
    ["risk", "explain"],
    ["risk", "explain", "owner-distance"],
    ["risk", "explain", "no-owner"],
    ["risk", "reviewers", "main..bob"],
    ["risk", "reviewers", "main..dave"],
    ["risk", "backtest"],
  ];

  function filesUnder(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)]));
  }

  test.each(["self", "any"])("with placement %s no risk output names a developer or prints an address", async (placement) => {
    config({ placement });
    for (const argv of commands) {
      for (const run of [await runCochange(repo.path, argv), await runCochange(repo.path, [...argv, "--json"]), await runCochangeOnTerminal(repo.path, argv)]) {
        expect(`${run.stdout}\n${run.stderr}`, argv.join(" ")).not.toMatch(people);
      }
    }
  }, 180_000);

  test("only --names names anyone, and only the developers who could review", async () => {
    config({ placement: "any" });
    const { stdout } = await runCochange(repo.path, ["risk", "reviewers", "main..dave", "--names", "--json"]);
    expect(stdout).toMatch(/Bob|Alice/);
    expect(stdout).not.toMatch(/Carol|Dave/);
  });

  // The history cache holds commit authors by design, to count them. What risk adds to disk is the blame cache and the stored reports.
  test("the blame cache and the stored reports carry no address or name, whichever commands ran", async () => {
    config({ placement: "any" });
    for (const argv of commands) await runCochange(repo.path, argv);
    await runCochange(repo.path, ["risk", "reviewers", "main..dave", "--names"]);
    const cache = join(repo.path, ".cache", "code-health");
    const files = [join(cache, "blame.sqlite"), ...filesUnder(join(cache, "reports"))];
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      expect(readFileSync(file).toString("latin1"), file).not.toMatch(/@example\.com|Alice|Bob|Carol|Dave/);
    }
  }, 180_000);

  test.each([["main..alice"], ["main..both"]])("with no git identity every risk table and document withholds placement on %s, rather than falling back to first touch", async (range) => {
    config({ placement: "self" });
    repo.git("config", "--unset", "user.email");
    const keep = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM, author: process.env.GIT_AUTHOR_EMAIL };
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    delete process.env.GIT_AUTHOR_EMAIL;
    try {
      const json = JSON.parse((await runCochange(repo.path, ["risk", range, "--json"])).stdout);
      expect(json.results.placement).toMatchObject({ status: "withheld", band: null, files: [] });
      expect(json.results.findings.filter((f: { fromPlacement: boolean }) => f.fromPlacement)).toEqual([]);
      const table = await runCochangeOnTerminal(repo.path, ["risk", range]);
      expect(table.stdout).not.toMatch(/first-touch/);
    } finally {
      for (const [key, value] of [["GIT_CONFIG_GLOBAL", keep.global], ["GIT_CONFIG_NOSYSTEM", keep.system], ["GIT_AUTHOR_EMAIL", keep.author]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 60_000);
});

describe("findings that rest on placement", () => {
  async function findings(...args: string[]): Promise<{ id: string; fromPlacement: boolean; response: string; evidence: Record<string, unknown>[] }[]> {
    const { stdout } = await runCochange(repo.path, ["risk", ...args, "--json"]);
    return JSON.parse(stdout).results.findings;
  }

  test("an owner who did not write the change is to be added as a reviewer", async () => {
    const found = (await findings("main..dave")).find((f) => f.id === "owner-distance")!;
    expect(found).toMatchObject({ fromPlacement: true, response: "Add the owner as a reviewer.", evidence: [{ file: ledger, share: 0.6 }] });
  });

  test("a first touch of a hotspot is to be reviewed by an owner, with a pre-change briefing for the author", async () => {
    writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { hotspotPercentile: 50, recentMonths: 6, risk: { newIdentityChanges: 2, placement: "any" } } }));
    const found = (await findings("main..dave")).find((f) => f.id === "distant-placement")!;
    expect(found.response).toBe("Review by an owner of those files, and a pre-change briefing (`cochange brief`) for the author.");
    expect(found.evidence).toEqual([{ file: ledger }]);
  });

  test("files nobody active holds a share of call for characterisation tests", async () => {
    writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { activityWindowMonths: 1 }, risk: { newIdentityChanges: 2, placement: "any" } } }));
    const found = (await findings("main..dave")).find((f) => f.id === "no-owner")!;
    expect(found.response).toBe("Characterisation tests before the change, and a short note capturing what was learned.");
  });

  test("none of them exists when placement is withheld", async () => {
    config({ placement: "self" });
    const found = await findings("main..bob");
    expect(found.some((f) => f.fromPlacement)).toBe(false);
  });
});
