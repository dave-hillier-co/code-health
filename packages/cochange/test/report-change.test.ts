import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GOLDEN_CONFIG_HASH } from "@code-health/fixtures/cli-testing";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { reportPath } from "../src/reports.ts";
import { GOLDEN_DIR } from "./support/golden.ts";
import { riskHistory } from "./support/risk-scenario.ts";
import { runCochange } from "./support/run.ts";

const Ajv2020 = Ajv2020Module.default;
const schema = JSON.parse(readFileSync(join(GOLDEN_DIR, "..", "..", "..", "..", "plugins", "cochange", "schemas", "report.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

let repo: GitFixture;
let scratch: string;
beforeAll(() => {
  repo = riskHistory();
  repo.git("config", "user.email", "alice@example.com");
  repo.git("config", "user.name", "Alice");
  scratch = mkdtempSync(join(tmpdir(), "report-change-"));
}, 60_000);
afterAll(() => {
  repo.dispose();
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(join(repo.path, ".cache", "code-health", "reports"), { recursive: true, force: true });
  rmSync(join(repo.path, "code-health.json"), { force: true });
  repo.git("checkout", "--quiet", "main");
});

const sha = (ref: string) => repo.git("rev-parse", ref).trim();
const run = (...args: string[]) => runCochange(repo.path, ["report", "change", ...args]);
const slots = async (...args: string[]) => JSON.parse((await run("--slots", ...args)).stdout);
const masked = (text: string, config: string) => text.replaceAll(config, GOLDEN_CONFIG_HASH);

function writeJson(name: string, document: unknown): string {
  const file = join(scratch, name);
  writeFileSync(file, JSON.stringify(document));
  return file;
}

interface Slot {
  id: string;
  verdicts: string[];
  maxChars: number;
  about: { kind: string; ref: string; label: string };
}

/** Notes that fill every slot with text that fits it. */
function fullNotes(document: { stamp: unknown; slots: Slot[] }) {
  const notes: Record<string, unknown> = {};
  for (const slot of document.slots) {
    notes[slot.id] = slot.verdicts.length === 0 ? { text: "Open the files the tables name first, then ask the author about each item." } : { verdict: slot.verdicts[1], text: "The author's reason is the one the history supports." };
  }
  return { stamp: document.stamp, notes };
}

const complexityCheck = (rows: Record<string, unknown>[], base = sha("main")) => ({
  schemaVersion: 1,
  tool: "complexity",
  command: "check",
  inputs: { base: { rev: "main", sha: base }, against: "head", delta: 0 },
  summary: { compared: 14, added: 2, changed: 5, removed: 0, moved: 0, findings: rows.length },
  unsupportedFiles: 1,
  results: rows,
});

const check = (id: string, finding: "new" | "worsened", before: number | null, after: number, guideline = 15) => ({
  path: id.split("#")[0],
  unit: id.split("#")[1],
  id,
  finding,
  metric: "cognitive",
  before,
  after,
  guideline,
  ratio: Math.round((after / guideline) * 100) / 100,
  delta: before === null ? null : after - before,
});

const structureCheck = (base = sha("main"), head = sha("missing")) => ({
  schemaVersion: 1,
  tool: "structure",
  command: "check",
  inputs: { base: "main", baseSha: base, analysed: head, levels: ["default"] },
  results: [
    { kind: "cycle", id: "cycle:src/billing+src/reports", level: "folder", nodes: ["src/billing", "src/reports"], breakingSet: [{ from: "src/reports", to: "src/billing" }] },
    { kind: "layer-violation", id: "src/billing/invoice.ts->src/reports/summary.ts", fromLayer: "domain", toLayer: "reporting" },
  ],
});

const evidenceArgs = () => [
  "--evidence",
  writeJson("complexity-check.json", complexityCheck([check("src/billing/invoice.ts#total", "worsened", 18, 27), check("src/billing/tax.ts#surcharge", "new", null, 22)])),
  "--evidence",
  writeJson("structure-check.json", structureCheck()),
];

const goldenFile = (name: string) => join(GOLDEN_DIR, "_reports", name);
function expectGolden(name: string, content: string) {
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(join(GOLDEN_DIR, "_reports"), { recursive: true });
    writeFileSync(goldenFile(name), content);
    return;
  }
  expect(content).toBe(readFileSync(goldenFile(name), "utf8"));
}

/** A stored backtest that says the levels separate, as the risk level tests make one. */
async function storeSeparatingBacktest() {
  await runCochange(repo.path, ["risk", "backtest"]);
  const file = reportPath(repo.path, "risk-backtest");
  const document = JSON.parse(readFileSync(file, "utf8"));
  document.results.separation = { status: "separates", reason: "set by the test" };
  writeFileSync(file, JSON.stringify(document));
}

test("--slots prints the stamp, the data and one slot per item needing attention, and matches its schema", async () => {
  const args = evidenceArgs();
  const { code, stdout, stderr } = await run("main..missing", "--slots", ...args);
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  const document = JSON.parse(stdout);
  expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
  expect(document.report).toBe("change");
  expect(document.stamp).toMatchObject({ kind: "change", head: sha("main"), inputs: { base: sha("main"), head: sha("missing"), range: "main..missing" } });
  expect(document.stamp.inputs.evidence.map((e: { tool: string; command: string }) => `${e.tool} ${e.command}`)).toEqual(["complexity check", "structure check"]);
  expect(document.slots.map((s: Slot) => s.id)).toEqual([
    "finding-missing-co-change",
    "finding-test-evidence",
    "structure-1",
    "structure-2",
    "complexity-1",
    "complexity-2",
    "guidance",
    "limits",
  ]);
  const item = document.slots.find((s: Slot) => s.id === "finding-missing-co-change");
  expect(item.verdicts).toEqual(["needs-change", "accepted-with-reason", "false-positive"]);
  expect(item.about).toMatchObject({ kind: "finding", ref: "risk:missing-co-change" });
  expect(item.about.label).toContain("src/billing/tax.ts");
  expectGolden("report.change.slots.json", masked(stdout, document.stamp.config));
});

test("--slots twice gives the same bytes", async () => {
  const args = evidenceArgs();
  expect((await run("main..missing", "--slots", ...args)).stdout).toBe((await run("main..missing", "--slots", ...args)).stdout);
});

test("notes render to html and markdown that match the goldens", async () => {
  const args = evidenceArgs();
  const document = await slots("main..missing", ...args);
  const notes = writeJson("notes.json", fullNotes(document));
  const html = await run("main..missing", "--notes", notes, "--format", "html", ...args);
  const md = await run("main..missing", "--notes", notes, "--format", "md", ...args);
  expect(html.code).toBe(ExitCode.Success);
  expect(md.code).toBe(ExitCode.Success);
  expectGolden("report.change.html", masked(html.stdout, document.stamp.config));
  expectGolden("report.change.md", masked(md.stdout, document.stamp.config));
});

test("the page shows the missing partners, complexity before and after, new structure findings and hotspots", async () => {
  const args = evidenceArgs();
  const document = await slots("main..missing", ...args);
  const { stdout } = await run("main..missing", "--notes", writeJson("notes-body.json", fullNotes(document)), "--format", "md", ...args);
  for (const heading of ["## Missing co-change partners", "## Complexity before and after", "## Structure findings the change adds", "## Hotspots touched", "## Risk factors", "## Limits"]) expect(stdout).toContain(heading);
  expect(stdout).toContain("src/billing/tax.ts");
  expect(stdout).toContain("src/billing/invoice.ts#total");
  expect(stdout).toContain("cycle:src/billing+src/reports");
  for (const label of ["Repository:", "Analysed commit:", "Date:", "Config hash:", "Evidence grade:", "History window:", "Excluded:"]) expect(stdout).toContain(label);
});

test("the compact form is a short pull request comment of what needs attention, under 60 lines", async () => {
  const args = evidenceArgs();
  const document = await slots("main..missing", ...args);
  const notes = writeJson("notes-compact.json", fullNotes(document));
  const { code, stdout } = await run("main..missing", "--notes", notes, "--format", "md", "--compact", ...args);
  expect(code).toBe(ExitCode.Success);
  expect(stdout.split("\n").length).toBeLessThan(60);
  expect(stdout).toContain("## Needs attention");
  expect(stdout).toContain("## Reviewer guidance");
  expect(stdout).not.toContain("## Risk factors");
  expectGolden("report.change.compact.md", masked(stdout, document.stamp.config));
});

test("a change with nothing to attend to says nothing needs attention", async () => {
  const document = await slots("main..complete");
  expect(document.slots.map((s: Slot) => s.id)).toEqual(["guidance", "limits"]);
  const notes = writeJson("notes-nothing.json", fullNotes(document));
  const { stdout } = await run("main..complete", "--notes", notes, "--format", "md", "--compact");
  expect(stdout).toContain("Nothing needs attention");
  expect(stdout.split("\n").length).toBeLessThan(40);
  expectGolden("report.change.nothing.compact.md", masked(stdout, document.stamp.config));
});

test("more items than slots are counted and never dropped silently", async () => {
  const many = Array.from({ length: 10 }, (_, i) => check(`src/billing/f${i}.ts#fn${i}`, "new", null, 30 - i));
  const args = ["--evidence", writeJson("many.json", complexityCheck(many))];
  const document = await slots("main..complete", ...args);
  expect(document.slots.filter((s: Slot) => s.id.startsWith("complexity-"))).toHaveLength(8);
  const { stdout } = await run("main..complete", "--notes", writeJson("notes-many.json", fullNotes(document)), "--format", "md", ...args);
  expect(stdout).toContain("2 more items need attention and have no judgement slot");
  expect(stdout).toContain("src/billing/f9.ts#fn9");
});

test("complexity diff is read too: only the units over a guideline that are new or worse are shown", async () => {
  const row = (id: string, change: string, before: number | null, after: number, labels: string[]) => ({
    path: id.split("#")[0],
    unit: id.split("#")[1],
    id,
    change,
    before: before === null ? null : { cognitive: before },
    after: { cognitive: after },
    delta: before === null ? null : { cognitive: after - before },
    labels,
  });
  const diff = {
    tool: "complexity",
    command: "diff",
    inputs: { base: { sha: sha("main") }, head: { sha: sha("missing") }, against: "revision" },
    results: [
      row("src/billing/invoice.ts#total", "changed", 18, 27, ["cognitive-warn"]),
      row("src/billing/invoice.ts#round", "changed", 20, 12, ["cognitive-warn"]),
      row("src/billing/invoice.ts#fine", "changed", 3, 5, []),
      row("src/billing/tax.ts#surcharge", "added", null, 22, ["cognitive-high"]),
    ],
  };
  const args = ["--evidence", writeJson("diff.json", diff)];
  const document = await slots("main..missing", ...args);
  expect(document.slots.map((s: Slot) => s.id).filter((id: string) => id.startsWith("complexity-"))).toEqual(["complexity-1", "complexity-2"]);
  const { stdout } = await run("main..missing", "--notes", writeJson("notes-diff.json", fullNotes(document)), "--format", "md", ...args);
  expect(stdout).toContain("from complexity diff");
  expect(stdout).toContain("| src/billing/invoice.ts#total | cognitive | worsened | 18 | 27 | – | above guideline |");
  expect(stdout).not.toContain("#round");
  expect(stdout).not.toContain("#fine");
});

test("hotspots touched need attention when the factor's band is moderate or high, with the hot files listed", async () => {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { risk: { moderatePercentile: 1, highPercentile: 90 } } }));
  const document = await slots("main..complete");
  expect(document.slots.map((s: Slot) => s.id)).toEqual(["hotspots-touched", "guidance", "limits"]);
  expect(document.slots[0].about).toMatchObject({ kind: "finding", ref: "risk:hotspots-touched" });
  const { stdout } = await run("main..complete", "--notes", writeJson("notes-hot.json", fullNotes(document)), "--format", "md");
  expect(stdout).toContain("**Hot files the change touches, by revisions in the window**");
  expect(stdout).toContain("src/billing/invoice.ts");
});

test("the level is shown only where a stored backtest says the levels separate", async () => {
  const none = await run("main..missing", "--format", "md");
  expect(none.stdout).toContain("No level is shown");
  expect(none.stdout).toContain("a level is shown only where a stored backtest");
  await storeSeparatingBacktest();
  const shown = await run("main..missing", "--format", "md");
  expect(shown.stdout).toContain("Level, from a stored backtest of this repository");
  expect(shown.stdout).toMatch(/\| Level \| attention \|/);
  expect(shown.stdout).not.toContain("No level is shown");
  // The stored backtest is an input: notes written before it existed are refused.
  const before = (await slots("main..missing")).stamp;
  expect(before.inputs.backtest).not.toBeNull();
});

test("notes written before the evidence changed are refused, because the stamp's inputs changed", async () => {
  const document = await slots("main..missing");
  const notes = writeJson("notes-stale.json", fullNotes(document));
  const { code, stderr } = await run("main..missing", "--notes", notes, "--format", "html", ...evidenceArgs());
  expect(code).toBe(ExitCode.Usage);
  expect(stderr).toContain("evidence");
});

test("evidence made against another base, or that is not evidence this report reads, is a usage error", async () => {
  const wrongBase = writeJson("wrong-base.json", complexityCheck([], "c".repeat(40)));
  const first = await run("main..missing", "--slots", "--evidence", wrongBase);
  expect(first.code).toBe(ExitCode.Usage);
  expect(first.stderr).toContain("made against cccccccccc");
  const other = writeJson("other.json", { tool: "complexity", command: "analyse", results: [] });
  const second = await run("main..missing", "--slots", "--evidence", other);
  expect(second.code).toBe(ExitCode.Usage);
  expect(second.stderr).toContain("is not evidence this report reads");
  const third = await run("main..missing", "--slots", "--evidence", join(scratch, "absent.json"));
  expect(third.code).toBe(ExitCode.Usage);
  expect(third.stderr).toContain("cannot read it");
});

test("rendering is refused with exit 2 and a message naming the problem", async () => {
  const args = evidenceArgs();
  const document = await slots("main..missing", ...args);
  const good = fullNotes(document);
  const refused = async (notes: unknown, expected: string, format = "html") => {
    const { code, stdout, stderr } = await run("main..missing", "--notes", writeJson("bad.json", notes), "--format", format, ...args);
    expect(code).toBe(ExitCode.Usage);
    expect(stdout).toBe("");
    expect(stderr).toContain(expected);
  };
  await refused({ ...good, stamp: { ...document.stamp, head: "b".repeat(40) } }, "the stamp is for HEAD bbbbbbb");
  await refused({ stamp: document.stamp, notes: { ...good.notes, "finding-test-evidence": undefined } }, 'slot "finding-test-evidence" has no entry');
  await refused({ stamp: document.stamp, notes: { ...good.notes, guidance: { text: "" } } }, 'slot "guidance" has empty text');
  await refused({ stamp: document.stamp, notes: { ...good.notes, invented: { text: "x" } } }, 'an entry "invented"');
  await refused({ stamp: document.stamp, notes: { ...good.notes, limits: { text: "x".repeat(501) } } }, "501 characters of text and the limit is 500");
  await refused({ stamp: document.stamp, notes: { ...good.notes, "structure-1": { verdict: "maybe", text: "t" } } }, 'verdict "maybe"');
  await refused({ stamp: document.stamp, notes: { ...good.notes, "structure-1": { text: "no verdict" } } }, "structure-1");
  await refused({ stamp: { ...document.stamp, inputs: { ...document.stamp.inputs, range: "main..complete" } }, notes: good.notes }, "range");
  await refused({ notes: good.notes }, "the notes have no stamp object", "md");
});

test("html without notes, --slots with --notes, and more than one range are usage errors", async () => {
  const usage = async (args: string[], expected: string) => {
    const { code, stderr } = await run(...args);
    expect(code).toBe(ExitCode.Usage);
    expect(stderr).toContain(expected);
  };
  await usage(["main..missing", "--format", "html"], "html needs notes");
  await usage(["main..missing", "--slots", "--format", "md"], "--slots prints the slots");
  await usage(["main..missing", "extra", "--slots"], "usage: report change");
  await usage(["nowhere..missing", "--slots"], "nowhere");
  await usage(["main..missing", "--slots", "--compact"], "--slots prints the slots");
  await usage(["main..missing", "--format", "html", "--compact", "--notes", join(scratch, "x.json")], "--compact is for --format md");
});

test("markdown without notes is a draft with the slots marked not yet written", async () => {
  const { code, stdout } = await run("main..missing", "--format", "md");
  expect(code).toBe(ExitCode.Success);
  expect(stdout).toContain("Judgement not yet written");
});

test("--out writes the file and prints where", async () => {
  const document = await slots("main..missing");
  const notes = writeJson("notes-out.json", fullNotes(document));
  const out = join(scratch, "nested", "change.html");
  const { stdout, code } = await run("main..missing", "--notes", notes, "--format", "html", "--out", out);
  expect(code).toBe(ExitCode.Success);
  expect(stdout).toBe(`wrote ${out}\n`);
  expect(readFileSync(out, "utf8")).toContain("<!doctype html>");
});

/** The problems a page has against the report's accessibility rules. */
function problems(html: string): string[] {
  const out: string[] = [];
  for (const table of html.match(/<table[\s\S]*?<\/table>/g) ?? []) {
    if (!/<caption>[^<]+<\/caption>/.test(table)) out.push("a table has no caption");
    if (/<td/.test(table) && !/<th scope="col"/.test(table)) out.push("a table has no th scope=col");
    for (const th of table.match(/<th(?![a-z])[^>]*>/g) ?? []) if (!/scope="(col|row)"/.test(th)) out.push(`a th has no scope: ${th}`);
  }
  for (const svg of html.match(/<svg[\s\S]*?<\/svg>/g) ?? []) if (!/role="img"/.test(svg) || !/aria-labelledby=/.test(svg)) out.push("an svg is not labelled");
  return out;
}

test("the html page is semantic, self-contained, themed and accessible", async () => {
  const args = evidenceArgs();
  const document = await slots("main..missing", ...args);
  const { stdout: html } = await run("main..missing", "--notes", writeJson("notes-a11y.json", fullNotes(document)), "--format", "html", ...args);
  expect(problems(html)).toEqual([]);
  for (const tag of ["<header>", "<nav aria-label=", "<main", '<html lang="en">', "<title>Change summary"]) expect(html).toContain(tag);
  expect(html).toContain("prefers-color-scheme: dark");
  expect(html).toContain("@media print");
  expect(html).not.toMatch(/<script|<link|<img|<iframe|@import|url\(|src=|href="https?:|xmlns/);
  expect(html).not.toContain("http://");
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ["change", "guidance", "attention", "factors", "missing-co-change", "complexity", "structure", "hotspots", "limits"]) expect(html).toContain(`href="#${id}"`);
  // No person is named, and no verdict is a score or a rating.
  expect(html).not.toMatch(/Alice|Bob|Carol|alice@|bob@/);
});

test("the report command lists the change report with its evidence option", async () => {
  const help = (await runCochange(repo.path, ["report", "--help"])).stdout;
  expect(help).toMatch(/change\s+What a branch/);
  const sub = (await runCochange(repo.path, ["report", "change", "--help"])).stdout;
  expect(sub).toContain("--evidence <evidence>");
});
