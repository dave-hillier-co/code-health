import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { activeAt, isActiveDeveloper, SECONDS_PER_MONTH } from "../src/active-developers.ts";
import { ann, bob, knowledgeHistory } from "./support/knowledge-scenario.ts";
import { runCochange } from "./support/run.ts";

vi.setConfig({ testTimeout: 120_000 });

const DAY = 86_400;
const WINDOW = 6 * SECONDS_PER_MONTH;
const noOverrides = { active: new Set<string>(), inactive: new Set<string>() };

describe("the definition of an active developer", () => {
  const asOf = 1_700_000_000;

  test("is a commit inside the window that ends at the date, exactly", () => {
    expect(activeAt([asOf - WINDOW + 1], asOf, WINDOW)).toBe(true);
    expect(activeAt([asOf - WINDOW], asOf, WINDOW)).toBe(false);
    expect(activeAt([], asOf, WINDOW)).toBe(false);
  });

  test("knows nothing after the date, and a quiet spell inside the window does not end it", () => {
    expect(activeAt([asOf - 100 * DAY, asOf + DAY], asOf, WINDOW)).toBe(true);
    expect(activeAt([asOf + DAY], asOf, WINDOW)).toBe(false);
  });

  test("is corrected by the local overrides: someone away is active, someone gone is not, and gone wins over recent", () => {
    const rule = { windowSeconds: WINDOW, overrides: { active: new Set(["Away <away@example.com>"]), inactive: new Set(["Gone <gone@example.com>"]) } };
    expect(isActiveDeveloper("Away <away@example.com>", [asOf - 2 * WINDOW], asOf, rule)).toBe(true);
    expect(isActiveDeveloper("Gone <gone@example.com>", [asOf - DAY], asOf, rule)).toBe(false);
    expect(isActiveDeveloper("Other <other@example.com>", [asOf - DAY], asOf, rule)).toBe(true);
    expect(isActiveDeveloper("Other <other@example.com>", [asOf - DAY], asOf, { windowSeconds: WINDOW, overrides: noOverrides })).toBe(true);
  });
});

describe("suggested reviewers use that same definition", () => {
  let repo: GitFixture;
  beforeAll(() => {
    repo = knowledgeHistory();
    repo.apply([
      { type: "branch", name: "lex", from: "main" },
      { type: "checkout", name: "lex" },
      {
        type: "commit",
        message: "Touch the lexer, held by Di who left and Bob who is here",
        date: "2025-03-10T09:00:00Z",
        author: ann,
        changes: [{ op: "modify", path: "src/core/lexer.ts", content: `${readFileSync(join(repo.path, "src/core/lexer.ts"), "utf8")}export const more = 1;\n` }],
      },
    ]);
    repo.git("checkout", "--quiet", "main");
  });
  afterAll(() => repo.dispose());
  beforeEach(() => {
    rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
    rmSync(join(repo.path, ".code-health"), { recursive: true, force: true });
    rmSync(join(repo.path, "code-health.json"), { force: true });
  });

  const configure = (knowledge: Record<string, unknown>) => writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { knowledge } }));
  async function suggested(): Promise<string[]> {
    const run = await runCochange(repo.path, ["risk", "reviewers", "main..lex", "--names", "--json"]);
    expect(run.code, run.stderr).toBe(0);
    const areas = JSON.parse(run.stdout).results.areas as { suggested: { email: string }[] }[];
    return areas.flatMap((a) => a.suggested.map((s) => s.email)).sort();
  }

  test("someone whose last commit is a year old is not a reviewer under the default six months, the window of abandonment", async () => {
    expect(await suggested()).toEqual([bob.email]);
  });

  test("widening the window of the knowledge analysis widens who can be asked", async () => {
    configure({ activityWindowMonths: 18 });
    expect(await suggested()).toEqual(["bob@example.com", "di@example.com"]);
  });

  test("the local overrides apply: someone marked as gone is not asked", async () => {
    mkdirSync(join(repo.path, ".code-health", "local"), { recursive: true });
    writeFileSync(join(repo.path, ".code-health", "local", "knowledge-overrides.json"), JSON.stringify({ schemaVersion: 1, inactive: ["Bob Builder <bob@example.com>"] }));
    expect(await suggested()).toEqual([]);
  });
});
