import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GOLDEN_CONFIG_HASH } from "@code-health/fixtures/cli-testing";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { GOLDEN_DIR } from "./support/golden.ts";
import { runCochange } from "./support/run.ts";
import { knowledgeHistory } from "./support/knowledge-scenario.ts";
import { pairHistory } from "./support/pair-history.ts";

vi.setConfig({ testTimeout: 180_000 });

const Ajv2020 = Ajv2020Module.default;
const schema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugins", "cochange", "schemas", "report.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

let repo: GitFixture;
let scratch: string;
beforeAll(() => {
  repo = knowledgeHistory();
  scratch = mkdtempSync(join(tmpdir(), "report-knowledge-"));
});
afterAll(() => {
  repo.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

function configure(knowledge: Record<string, unknown> = {}): void {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: true, complexityPercentile: 50, turnoverRate: 15, trials: 300, ...knowledge } } }));
}
beforeEach(() => {
  rmSync(join(repo.path, ".code-health"), { recursive: true, force: true });
  configure();
});

const run = (...args: string[]) => runCochange(repo.path, ["report", "knowledge", ...args]);
const slots = async () => JSON.parse((await run("--slots")).stdout);
const masked = (text: string, config: string) => text.replaceAll(config, GOLDEN_CONFIG_HASH);

function writeNotes(name: string, document: unknown): string {
  const file = join(scratch, name);
  writeFileSync(file, JSON.stringify(document));
  return file;
}

/** Notes that fill every slot of the document with its first verdict. */
function fullNotes(document: { stamp: unknown; slots: { id: string; verdicts: string[] }[] }) {
  const notes: Record<string, unknown> = {};
  for (const slot of document.slots) {
    notes[slot.id] = slot.verdicts.length === 0 ? { text: "Knowledge sits with a few people and the history is short." } : { verdict: slot.verdicts[0], text: "These files follow the pattern in the table above." };
  }
  return { stamp: document.stamp, notes };
}

const goldenFile = (name: string) => join(GOLDEN_DIR, "_reports", name);
function expectGolden(name: string, text: string) {
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(join(GOLDEN_DIR, "_reports"), { recursive: true });
    writeFileSync(goldenFile(name), text);
    return;
  }
  expect(text).toBe(readFileSync(goldenFile(name), "utf8"));
}

test("the report is off until the repository opts in, with the same message as the analysis", async () => {
  writeFileSync(join(repo.path, "code-health.json"), "{}");
  for (const args of [["--slots"], ["--format", "md"]]) {
    const { code, stdout, stderr } = await run(...args);
    expect(code).toBe(ExitCode.Usage);
    expect(stdout).toBe("");
    expect(stderr).toContain("the abandonment analysis is off by default");
    expect(stderr).toContain("cochange.knowledge.enabled");
  }
});

test("--slots prints the stamp, the data and one slot per pattern that has files, and matches its schema", async () => {
  const { code, stdout, stderr } = await run("--slots");
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  const document = JSON.parse(stdout);
  expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
  expect(document.report).toBe("knowledge");
  expect(document.stamp).toMatchObject({ kind: "knowledge", head: repo.git("rev-parse", "HEAD").trim(), inputs: { names: false, subcommand: "report" } });
  expect(document.slots.map((s: { id: string }) => s.id)).toEqual(["summary", "pattern-single-owner-hotspot", "pattern-former-contributors-complex", "pattern-single-owner", "pattern-inconclusive", "limits"]);
  const pattern = document.slots.find((s: { id: string }) => s.id === "pattern-single-owner");
  expect(pattern.verdicts).toEqual(["pair", "document", "rotate-reviews", "leave"]);
  expect(pattern.about).toEqual({ kind: "finding", ref: "single-owner", label: "Single owner" });
  expect(document.slots.find((s: { id: string }) => s.id === "pattern-inconclusive").verdicts).toEqual(["map-identities", "leave"]);
  expect(document.data.header).toMatchObject({ repo: "repo", date: "2025-03-01" });
  expectGolden("report.knowledge.slots.json", masked(stdout, document.stamp.config));
});

test("--slots twice gives the same bytes", async () => {
  expect((await run("--slots")).stdout).toBe((await run("--slots")).stdout);
});

test("notes render to html and markdown that match the goldens", async () => {
  const document = await slots();
  const notes = writeNotes("notes.json", fullNotes(document));
  const html = await run("--notes", notes, "--format", "html");
  const md = await run("--notes", notes, "--format", "md");
  expect(html.code).toBe(ExitCode.Success);
  expect(md.code).toBe(ExitCode.Success);
  expect(html.stdout).toContain('<h2 id="limits-heading">Limits</h2>');
  expect(md.stdout).toContain("## Limits");
  expectGolden("report.knowledge.html", masked(html.stdout, document.stamp.config));
  expectGolden("report.knowledge.md", masked(md.stdout, document.stamp.config));
});

test("the page shows the patterns with their rules, a treemap marked by pattern, the bus factor of the hotspots, the knowledge lost and the simulation", async () => {
  const document = await slots();
  const { stdout } = await run("--notes", writeNotes("notes-p.json", fullNotes(document)), "--format", "md");
  for (const heading of ["## Knowledge-risk patterns", "## Bus factor of the top hotspots", "## Knowledge lost so far", "## Simulated turnover"]) expect(stdout).toContain(heading);
  // Each pattern states its rule and guideline, and the guidelines are legend values, not a score.
  expect(stdout).toContain("One active developer holds at least 90% of the lines held by people, and the file is a hotspot");
  expect(stdout).toContain("cochange.knowledge.abandonmentGuideline");
  expect(stdout).toContain("marks: SOH Single-owner hotspot (1 tile)");
  // Routes and auth are the hotspots. Auth has a bus factor of one and routes of two.
  expect(stdout).toMatch(/\| src\/api\/auth\.ts \| [0-9.]+ \| 10 \| 1 \| 1 \| 100 \| 0 \| Single-owner hotspot \|/);
  expect(stdout).toMatch(/\| src\/api\/routes\.ts \| [0-9.]+ \| 10 \| 2 \| 2 \| 50 \| 0 \| – \|/);
  expect(stdout).toContain("Files abandoned (90% or more of the lines held by people belong to people who have left) | 3 (37.5%)");
  expect(stdout).toContain("Simulated turnover over 4 periods of 3 months");
  expect(stdout).not.toMatch(/rating|red, yellow|overall score/i);
});

test("the header names the repo, commit, date, config hash, grade, window and exclusions, and a limits section follows", async () => {
  const document = await slots();
  const { stdout } = await run("--notes", writeNotes("notes-h.json", fullNotes(document)), "--format", "md");
  for (const label of ["Repository:", "Analysed commit:", "Date:", "Config hash:", "Evidence grade:", "History window:", "Excluded:", "## Limits"]) expect(stdout).toContain(label);
});

test("--out writes the file and prints where", async () => {
  const document = await slots();
  const notes = writeNotes("notes-out.json", fullNotes(document));
  const out = join(scratch, "nested", "knowledge.html");
  const { stdout, code } = await run("--notes", notes, "--format", "html", "--out", out);
  expect(code).toBe(ExitCode.Success);
  expect(stdout).toBe(`wrote ${out}\n`);
  expect(readFileSync(out, "utf8")).toContain("<!doctype html>");
});

test("markdown without notes is a draft with the slots marked not yet written", async () => {
  const { code, stdout } = await run("--format", "md");
  expect(code).toBe(ExitCode.Success);
  expect(stdout).toContain("Judgement not yet written");
});

test("a weak turnover estimate and an unmapped share are carried to the page as notices", async () => {
  configure({ turnoverRate: null, minTurnoverPeriods: 50 });
  const { code, stdout, stderr } = await run("--format", "md");
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  expect(stdout).toMatch(/\*\*Notice:\*\* The leaver probabilities come from \d+ observed 3-month period\(s\), under the guideline of 50/);
  expect(stdout).toContain("The notices above say where the identities or the turnover estimate weaken the results.");
});

test("no names appear, and with --names only the active developers who hold a file's lines", async () => {
  const document = await slots();
  const plain = await run("--notes", writeNotes("notes-n0.json", fullNotes(document)), "--format", "md");
  for (const name of ["example.com", "Ann Active", "Bob Builder", "Cy Gone", "Di Departed", "Eve Newer", "dependabot"]) expect(plain.stdout).not.toContain(name);

  const named = await slots2("--names");
  expect(named.stamp.inputs.names).toBe(true);
  const { stdout } = await run("--names", "--notes", writeNotes("notes-n1.json", fullNotes(named)), "--format", "md");
  expect(stdout).toContain("Active developers holding lines");
  expect(stdout).toContain("Ann Active");
  expect(stdout).toContain("Bob Builder");
  expect(stdout).toContain("Eve Newer");
  // Developers who have left, and bots, are never named.
  for (const name of ["Cy Gone", "Di Departed", "dependabot", "example.com"]) expect(stdout).not.toContain(name);
  // The names are part of the stamp, so notes written without them are refused with them.
  const refused = await run("--names", "--notes", writeNotes("notes-n2.json", fullNotes(document)), "--format", "md");
  expect(refused.code).toBe(ExitCode.Usage);
  expect(refused.stderr).toContain("names");
});

async function slots2(...args: string[]) {
  return JSON.parse((await run("--slots", ...args)).stdout);
}

test("rendering is refused with exit 2 and a message naming the problem", async () => {
  const document = await slots();
  const good = fullNotes(document);
  const refused = async (notes: unknown, expected: string, format = "html") => {
    const { code, stdout, stderr } = await run("--notes", writeNotes("bad.json", notes), "--format", format);
    expect(code).toBe(ExitCode.Usage);
    expect(stdout).toBe("");
    expect(stderr).toContain(expected);
  };
  await refused({ ...good, stamp: { ...document.stamp, head: "b".repeat(40) } }, "the stamp is for HEAD bbbbbbb");
  await refused({ ...good, stamp: { ...document.stamp, inputs: { ...document.stamp.inputs, guidelines: { ...document.stamp.inputs.guidelines, singleOwnerShare: 80 } } } }, "guidelines");
  const { "pattern-single-owner": _removed, ...without } = good.notes;
  await refused({ stamp: document.stamp, notes: without }, 'slot "pattern-single-owner" has no entry');
  await refused({ stamp: document.stamp, notes: { ...good.notes, summary: { text: "" } } }, 'slot "summary" has empty text');
  await refused({ stamp: document.stamp, notes: { ...good.notes, invented: { text: "x" } } }, 'an entry "invented"');
  await refused({ stamp: document.stamp, notes: { ...good.notes, limits: { text: "x".repeat(501) } } }, "501 characters of text and the limit is 500");
  await refused({ stamp: document.stamp, notes: { ...good.notes, "pattern-single-owner": { verdict: "ignore", text: "t" } } }, 'verdict "ignore"');
  await refused({ stamp: document.stamp, notes: { ...good.notes, "pattern-inconclusive": { verdict: "pair", text: "t" } } }, 'verdict "pair"');
  await refused({ notes: good.notes }, "the notes have no stamp object", "md");
  // Notes written under other guideline values do not match after a config change.
  configure({ singleOwnerShare: 80 });
  const stale = await run("--notes", writeNotes("stale.json", good), "--format", "md");
  expect(stale.code).toBe(ExitCode.Usage);
  expect(stale.stderr).toContain("config");
});

test("html without notes, an unknown report and --slots with --notes are usage errors", async () => {
  const usage = async (args: string[], expected: string) => {
    const { code, stderr } = await runCochange(repo.path, ["report", ...args]);
    expect(code).toBe(ExitCode.Usage);
    expect(stderr).toContain(expected);
  };
  await usage(["knowledge", "--format", "html"], "html needs notes");
  await usage(["knowledge", "--slots", "--format", "md"], "--slots prints the slots");
  await usage(["nothing"], 'unknown report "nothing"');
});

test("the report command lists knowledge and its options in --help", async () => {
  const help = (await runCochange(repo.path, ["report", "--help"])).stdout;
  expect(help).toMatch(/knowledge\s+Where knowledge/);
  const sub = (await runCochange(repo.path, ["report", "knowledge", "--help"])).stdout;
  expect(sub).toContain("--names");
  expect(sub).toContain("--notes <notes>");
});

/** The problems a page has against the report accessibility rules, as the overview and component tests check them. */
function accessibilityProblems(html: string): string[] {
  const out: string[] = [];
  for (const svg of html.match(/<svg[\s\S]*?<\/svg>/g) ?? []) {
    if (!/role="img"/.test(svg)) out.push("an svg has no role=img");
    const labelled = /aria-labelledby="([^"]+)"/.exec(svg)?.[1];
    if (labelled === undefined) out.push("an svg has no aria-labelledby");
    else for (const id of labelled.split(" ")) if (!svg.includes(`id="${id}"`)) out.push(`an svg names ${id}, which it does not hold`);
    if (!/<title id="[^"]+">[^<]+<\/title>/.test(svg)) out.push("an svg has no title");
  }
  for (const figure of html.match(/<figure[\s\S]*?<\/figure>/g) ?? []) {
    if (/<svg/.test(figure) && !/<table/.test(figure)) out.push("a chart has no table of its data");
    if (!/<figcaption>/.test(figure)) out.push("a figure has no figcaption");
  }
  if ((html.match(/<svg/g) ?? []).length !== (html.match(/<figure/g) ?? []).length) out.push("an svg is not inside its own figure");
  for (const table of html.match(/<table[\s\S]*?<\/table>/g) ?? []) {
    if (!/<caption>[^<]+<\/caption>/.test(table)) out.push("a table has no caption");
    if (/<td/.test(table) && !/<th scope="col"/.test(table)) out.push("a table has no th scope=col");
    for (const th of table.match(/<th(?![a-z])[^>]*>/g) ?? []) if (!/scope="(col|row)"/.test(th)) out.push(`a th has no scope: ${th}`);
  }
  return out;
}

test("the html page is accessible, self-contained and themed, and the treemap marks each tile in words as well as colour", async () => {
  const document = await slots();
  const { stdout: html } = await run("--notes", writeNotes("notes-a.json", fullNotes(document)), "--format", "html");
  expect(accessibilityProblems(html)).toEqual([]);
  for (const tag of ["<header>", "<nav aria-label=", "<main", "<footer>", '<html lang="en">', "<title>"]) expect(html).toContain(tag);
  expect(html).toContain("prefers-color-scheme: dark");
  expect(html).toContain("@media print");
  expect(html).not.toMatch(/<script|<link|<img|<iframe|@import|url\(|src=|href="https?:|xmlns/);
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ["summary", "patterns", "bus-factor", "knowledge-lost", "simulation", "limits"]) expect(html).toContain(`href="#${id}"`);
  // The marks are printed in the tiles and listed with their words in the legend.
  expect(html).toContain("<li><strong>SOH</strong> Single-owner hotspot: 1 tile</li>");
  expect(html).toContain("<title>src/api/auth.ts: 10 lines held by people, First pattern Single-owner hotspot</title>");
  // Values beside their guidelines carry words as well as the triangle.
  expect(html).toContain("above guideline");
});

test("a repository with one contributor says that bus-factor and turnover figures do not apply, and leaves out the sections that would be empty", async () => {
  const solo = pairHistory([["src/a.ts", "src/b.ts", 6]], 1);
  try {
    writeFileSync(join(solo.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: true, turnoverRate: 15, trials: 100 } } }));
    const { code, stdout } = await runCochange(solo.path, ["report", "knowledge", "--format", "md"]);
    expect(code).toBe(ExitCode.Success);
    expect(stdout).toContain("The repository has one contributor in the window, so bus-factor and turnover figures do not apply.");
    expect(stdout).not.toContain("## Bus factor of the top hotspots");
    expect(stdout).not.toContain("## Simulated turnover");
    expect(stdout).toContain("**Simulated turnover:** not listed. The repository has one contributor in the window");
  } finally {
    solo.dispose();
  }
});
