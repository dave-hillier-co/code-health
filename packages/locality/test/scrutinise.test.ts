import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import type { Scrutiny } from "../src/scrutiny.ts";
import { expectGolden } from "./support/golden.ts";
import { runLocality } from "./support/run.ts";
import { distantHelpers } from "./support/scenarios.ts";
import { widelyUsed } from "./support/scrutiny-scenarios.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = widelyUsed();
});
afterAll(() => repo.dispose());

async function scrutiny(target: GitFixture, ...args: string[]) {
  const run = await runLocality(target.path, ["scrutinise", "--json", "--limit", "all", ...args]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  const results = JSON.parse(run.stdout).results as Scrutiny[];
  return { results, stdout: run.stdout };
}

test("the units the analyser sends to review are the ones scrutinised", async () => {
  const { results, stdout } = await scrutiny(repo);
  expect(results.map((entry) => ({ path: entry.path, reason: entry.reason, fanIn: entry.fanIn, rule: entry.rule }))).toEqual([
    { path: "src/shared/text.ts", reason: "high-fan-in", fanIn: 6, rule: "high-fan-in" },
  ]);
  expectGolden("widely-used", "scrutinise", stdout);
});

test("a flag that switches behaviour is reported with what the call sites pass", async () => {
  const [unit] = (await scrutiny(repo)).results as [Scrutiny];
  expect(unit.findings.filter((finding) => finding.flag === "special-general-mixture").map((finding) => finding.detail)).toEqual([
    "trim switches behaviour for different callers: true x4, false x1 over 5 call sites",
    "upper switches behaviour for different callers: false x4, true x1 over 5 call sites",
  ]);
});

test("a flag that every caller passes the same way names the branch nobody uses", async () => {
  const { results } = await scrutiny(distantHelpers(), "src/shared/format.ts");
  expect(results[0]?.reason).toBe("high-fan-in");
  const mixture = results[0]?.findings.find((finding) => finding.flag === "special-general-mixture");
  expect(mixture?.detail).toBe("compact switches behaviour, and every one of 8 call sites passes true: the other branch serves no caller");
  // Eight consumers that each call it with a literal are consumers, not wrappers that fix its arguments.
  expect(results[0]?.findings.map((finding) => finding.flag)).not.toContain("divergent-use");
});

test("an option most callers never pass is overexposure", async () => {
  const [unit] = (await scrutiny(repo)).results as [Scrutiny];
  expect(unit.findings.filter((finding) => finding.flag === "overexposure").map((finding) => [finding.subject, finding.detail])).toEqual([
    ["pad", "fill is passed by 1 of 3 call sites: an option most callers never use"],
  ]);
});

test("callers that change or work around the result, or wrap the unit with fixed arguments, show divergent use", async () => {
  const [unit] = (await scrutiny(repo)).results as [Scrutiny];
  const divergent = unit.findings.filter((finding) => finding.flag === "divergent-use");
  expect(divergent).toHaveLength(1);
  expect(divergent[0]).toMatchObject({
    subject: "clean",
    consumers: ["src/orders/label.ts", "src/orders/title.ts", "src/reports/head.ts"],
  });
  expect(divergent[0]?.detail).toBe(
    "3 of 5 call sites in 3 files change or work around what it returns (.toUpperCase, ?? fallback, wrapper shout fixes arguments): it may be doing the wrong thing for them",
  );
  const clean = unit.exports.find((entry) => entry.name === "clean");
  expect(clean?.postProcessed).toEqual([
    { path: "src/orders/label.ts", line: 2, how: ".toUpperCase" },
    { path: "src/orders/title.ts", line: 2, how: "?? fallback" },
    { path: "src/reports/head.ts", line: 2, how: "wrapper shout fixes arguments" },
  ]);
});

test("a function whose body is a single statement behind several parameters is shallow", async () => {
  const [unit] = (await scrutiny(repo)).results as [Scrutiny];
  const shallow = unit.findings.filter((finding) => finding.flag === "shallow-module").map((finding) => finding.subject);
  expect(shallow).toEqual(["pad"]);
});

test("lines whose correctness depends on the caller are hinted, by kind and line", async () => {
  const [unit] = (await scrutiny(repo)).results as [Scrutiny];
  expect(unit.hints.map(({ kind, subject, line }) => ({ kind, subject, line }))).toEqual([
    { kind: "mutates-argument", subject: "ordered", line: 12 },
    { kind: "locale", subject: "stamp", line: 17 },
    { kind: "time-zone", subject: "stamp", line: 17 },
    { kind: "nondeterministic", subject: "roll", line: 21 },
  ]);
});

test("the consumers' folders are reported, and nothing counts as a test call site when no test uses the unit", async () => {
  const [unit] = (await scrutiny(repo)).results as [Scrutiny];
  expect(unit.consumerFolders).toEqual(["src/billing", "src/orders", "src/reports"]);
  expect(unit.notes).toEqual([]);
  expect(unit.exports.every((entry) => entry.testCallSites === 0)).toBe(true);
});

test("consumers that all sit in one folder suggest a misplaced unit rather than a shared one", async () => {
  const { results } = await scrutiny(distantHelpers(), "src/shared/format.ts");
  expect(results[0]?.notes.map((note) => note.code)).toEqual(["consumers-in-one-folder"]);
});

test("naming a unit that was not sent to review scrutinises it anyway", async () => {
  const { results } = await scrutiny(repo, "src/shared/text.ts");
  expect(results.map((entry) => entry.reason)).toEqual(["high-fan-in"]);
  const other = await scrutiny(distantHelpers(), "src/shared/utils/money.ts");
  expect(other.results.map((entry) => [entry.path, entry.reason])).toEqual([["src/shared/utils/money.ts", "requested"]]);
});

test("with nothing to scrutinise the result is empty", async () => {
  const { results } = await scrutiny(repo, "src/orders");
  expect(results).toEqual([]);
});
