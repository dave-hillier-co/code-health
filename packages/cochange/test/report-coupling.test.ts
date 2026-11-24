import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GOLDEN_CONFIG_HASH } from "@code-health/fixtures/cli-testing";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { couplingTrendHistory } from "./support/coupling-trend-scenarios.ts";
import { GOLDEN_DIR } from "./support/golden.ts";
import { runCochange } from "./support/run.ts";

const Ajv2020 = Ajv2020Module.default;
const schema = JSON.parse(readFileSync(join(GOLDEN_DIR, "..", "..", "..", "..", "plugins", "cochange", "schemas", "report.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

let repo: GitFixture;
let scratch: string;
beforeAll(() => {
  repo = couplingTrendHistory();
  scratch = mkdtempSync(join(tmpdir(), "report-coupling-"));
});
afterAll(() => {
  repo.dispose();
  rmSync(scratch, { recursive: true, force: true });
});
afterEach(() => {
  rmSync(join(repo.path, ".cache", "code-health", "reports", "structure.hidden.json"), { force: true });
  rmSync(join(repo.path, "code-health.json"), { force: true });
});

const run = (...args: string[]) => runCochange(repo.path, ["report", "coupling", ...args]);
const slots = async () => JSON.parse((await run("--slots")).stdout);
const masked = (text: string, config: string) => text.replaceAll(config, GOLDEN_CONFIG_HASH);

function writeNotes(name: string, document: unknown): string {
  const file = join(scratch, name);
  writeFileSync(file, JSON.stringify(document));
  return file;
}

type SlotsDocument = { stamp: unknown; slots: { id: string; verdicts: string[] }[] };

/** Notes that fill every slot: the pair slots with their first verdict, the others text only. */
function fullNotes(document: SlotsDocument) {
  const notes: Record<string, unknown> = {};
  for (const slot of document.slots) {
    notes[slot.id] = slot.verdicts.length === 0 ? { text: "Four pairs only, from a history with two authors, so the trends are tentative." } : { verdict: slot.verdicts[0], text: "Shared design decision: the two files change in one commit." };
  }
  return { stamp: document.stamp, notes };
}

function writeHidden(head: string, rows: Record<string, unknown>[]) {
  const dir = join(repo.path, ".cache", "code-health", "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "structure.hidden.json"), JSON.stringify({ schemaVersion: 1, tool: "structure", command: "hidden", repo: { head, dirty: false }, config: "2".repeat(16), results: rows }));
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

/** The accessibility rules every page follows, as packages/report/test/accessibility.test.ts states them. */
function problems(html: string): string[] {
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

test("--slots prints the stamp, the data and one slot per top pair, the whole report and the limits, and matches its schema", async () => {
  const { code, stdout, stderr } = await run("--slots");
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  const document = JSON.parse(stdout);
  expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
  expect(document.report).toBe("coupling");
  expect(document.stamp).toMatchObject({ kind: "coupling", head: repo.git("rev-parse", "HEAD").trim(), inputs: { storedResultsRead: [], trendTolerance: 10, minSupport: 5 } });
  // The ledger and its test are an expected pair: they are listed apart and get no judgement.
  expect(document.slots.map((s: { id: string }) => s.id)).toEqual(["pair-1", "pair-2", "pair-3", "summary", "limits"]);
  expect(document.slots[0]).toMatchObject({ about: { kind: "pair", ref: "src/search/index.ts <-> src/search/ranking.ts" } });
  expect(document.slots[0].verdicts).toEqual([
    "real-locality-review",
    "real-structure-break",
    "real-leave",
    "incidental-locality-review",
    "incidental-structure-break",
    "incidental-leave",
  ]);
  expectGolden("report.coupling.slots.json", masked(stdout, document.stamp.config));
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
  expectGolden("report.coupling.html", masked(html.stdout, document.stamp.config));
  expectGolden("report.coupling.md", masked(md.stdout, document.stamp.config));
});

test("the page shows the pairs with their trend, the sums, the matrix, the clusters and the header and limits", async () => {
  const document = await slots();
  const { stdout } = await run("--notes", writeNotes("notes-page.json", fullNotes(document)), "--format", "md");
  for (const label of ["Repository:", "Analysed commit:", "Date:", "Config hash:", "Evidence grade:", "History window:", "Excluded:", "## Limits"]) expect(stdout).toContain(label);
  expect(stdout).toContain("↑ stronger (+60 points)");
  expect(stdout).toContain("Expected pairs, listed apart and not judged");
  expect(stdout).toContain("a test and the code it tests");
  expect(stdout).toContain("↓ weaker (-40 points)");
  expect(stdout).toContain("↑ stronger (+100 points, shared no change before)");
  expect(stdout).toContain("## Sum of coupling per file");
  expect(stdout).toContain("Co-change between the 8 files of the strongest clusters");
  expect(stdout).toContain("## Clusters");
  expect(stdout).toContain("Degree (%) 30 (cochange.minDegree), ▲ marks a value above it");
  expect(stdout).not.toContain("not shown");
});

test("the matrix opens the page, is ordered by cluster, boxes each cluster and marks the expected pair", async () => {
  const document = await slots();
  const { stdout } = await run("--notes", writeNotes("notes-matrix.json", fullNotes(document)), "--format", "md");
  expect(stdout.indexOf("**Co-change between")).toBeGreaterThan(stdout.indexOf("## What the coupling says"));
  expect(stdout.indexOf("**Co-change between")).toBeLessThan(stdout.indexOf("## Coupled pairs"));
  expect(stdout).toContain("| src/api/orders.ts | src/web/orders-view.ts | 80 |  | cluster 1 | cluster 1 |");
  expect(stdout).toContain("Boxes along the diagonal mark 4 groups: cluster 1 (2 rows)");
  expect(stdout).toContain("Rows and columns are ordered by cluster");
  expect(stdout).toContain("Draws 8 files and 4 of 4 clusters");
  expect(stdout).toContain("| src/billing/ledger.test.ts | src/billing/ledger.ts | 70 | an expected pair");
  expect(stdout).toMatch(/\| [0-9.]+ \| an expected pair/);
  expect(stdout).toContain("e is an expected pair");
  const clusters = document.data.sections.find((s: { id: string }) => s.id === "clusters").blocks[0];
  expect(clusters.total).toBe(4);
  const matrices = document.data.sections.find((s: { id: string }) => s.id === "summary").blocks.filter((b: { type: string }) => b.type === "matrix");
  const matrix = matrices[1];
  expect(document.data.sections.find((s: { id: string }) => s.id === "sums").blocks.some((b: { type: string }) => b.type === "matrix")).toBe(false);
  expect(matrix.groups).toHaveLength(4);
});

test("the first figure is the co-change matrix of components, grouped by tree, and says the map is inferred", async () => {
  const document = await slots();
  const { stdout } = await run("--notes", writeNotes("notes-components.json", fullNotes(document)), "--format", "md");
  expect(stdout.indexOf("**Co-change between the 7 components")).toBeLessThan(stdout.indexOf("**Co-change between the 8 files"));
  expect(stdout).toContain("| api | web | 80 |  | src | src |");
  expect(stdout).toContain("Bars above the columns and left of the rows mark 2 spans: src (6 rows), top level (1 row).");
  expect(stdout).toContain("The component map is inferred from folders");
  expect(stdout).toContain("0 production code files are in no component");
  expect(document.stamp.inputs.componentMap).toBe("inferred");
  const [first] = document.data.sections.find((s: { id: string }) => s.id === "summary").blocks.filter((b: { type: string }) => b.type === "matrix");
  expect(first.spans.map((s: { label: string }) => s.label)).toEqual(["src", "top level"]);
});

test("every number on the page is the CLI's: pairs beyond the top are counted, none is hidden silently", async () => {
  const document = await slots();
  const pairs = document.data.sections.find((s: { id: string }) => s.id === "pairs").blocks.find((b: { type: string }) => b.type === "ranked-table");
  expect(pairs.rows).toHaveLength(3);
  expect(pairs.total).toBe(3);
  const expected = document.data.sections.find((s: { id: string }) => s.id === "pairs").blocks.filter((b: { type: string }) => b.type === "ranked-table")[1];
  expect(expected.rows.map((r: { file: string }) => r.file)).toEqual(["src/billing/ledger.test.ts"]);
});

test("a stored structure hidden result for HEAD is shown and named in the stamp; an older one is not read", async () => {
  const head = repo.git("rev-parse", "HEAD").trim();
  const rows = [1, 2, 3].map((n) => ({ id: `coupling:folder:src/a${n}->src/b${n}`, level: "folder", from: `src/a${n}`, to: `src/b${n}`, quadrant: "hidden", staticCoupling: { sites: 0 }, coChange: { shared: 20 - n, expected: 1.25 } }));
  writeHidden(head, rows);
  const document = await slots();
  expect(document.stamp.inputs.storedResultsRead).toEqual([{ report: "structure.hidden", head, config: "2".repeat(16) }]);
  const { stdout } = await run("--notes", writeNotes("notes-hidden.json", fullNotes(document)), "--format", "md");
  expect(stdout).toContain("from structure hidden");
  expect(stdout).toContain("| 1 | src/a1 | src/b1 | folder | 19 | 1.3 | 0 |");

  writeHidden("a".repeat(40), rows);
  const older = await slots();
  expect(older.stamp.inputs.storedResultsRead).toEqual([]);
  expect((await run("--format", "md")).stdout).toContain("Run `structure hidden`");
});

test("notes written before a stored result appeared are refused, because the stamp's inputs changed", async () => {
  const notes = writeNotes("notes-stale.json", fullNotes(await slots()));
  writeHidden(repo.git("rev-parse", "HEAD").trim(), []);
  const { code, stderr } = await run("--notes", notes, "--format", "html");
  expect(code).toBe(ExitCode.Usage);
  expect(stderr).toContain("storedResultsRead");
});

test("the html page passes the accessibility rules, is self-contained and has unique ids", async () => {
  const document = await slots();
  const { stdout: html } = await run("--notes", writeNotes("notes-a11y.json", fullNotes(document)), "--format", "html");
  expect(problems(html)).toEqual([]);
  for (const tag of ["<header>", "<nav aria-label=", "<main", '<html lang="en">', "<title>"]) expect(html).toContain(tag);
  expect(html).toContain("prefers-color-scheme: dark");
  expect(html).toContain("@media print");
  expect(html).not.toMatch(/<script|<link|<img|<iframe|@import|url\(|src=|href="https?:|xmlns/);
  expect(html).toContain("<svg");
  for (const id of ["summary", "pairs", "sums", "clusters", "hidden", "excluded", "limits"]) expect(html).toContain(`href="#${id}"`);
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  expect(new Set(ids).size).toBe(ids.length);
  expect(html).toContain("weaker");
});

test("--out writes the file and prints where", async () => {
  const notes = writeNotes("notes-out.json", fullNotes(await slots()));
  const out = join(scratch, "nested", "coupling.html");
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
  await refused({ ...good, stamp: { ...document.stamp, kind: "overview" } }, "overview");
  const { "pair-2": _dropped, ...withoutPair } = good.notes;
  await refused({ stamp: document.stamp, notes: withoutPair }, 'slot "pair-2" has no entry');
  await refused({ stamp: document.stamp, notes: { ...good.notes, limits: { text: "" } } }, 'slot "limits" has empty text');
  await refused({ stamp: document.stamp, notes: { ...good.notes, "pair-9": { verdict: "real-leave", text: "x" } } }, 'an entry "pair-9"');
  await refused({ stamp: document.stamp, notes: { ...good.notes, summary: { text: "x".repeat(501) } } }, "501 characters of text and the limit is 500");
  await refused({ stamp: document.stamp, notes: { ...good.notes, "pair-1": { verdict: "maybe", text: "t" } } }, 'verdict "maybe"');
  await refused({ stamp: document.stamp, notes: { ...good.notes, "pair-1": { text: "no verdict" } } }, "pair-1");
  await refused({ notes: good.notes }, "the notes have no stamp object", "md");
});

test("a changed window or config makes the old notes stale", async () => {
  const notes = writeNotes("notes-window.json", fullNotes(await slots()));
  const windowed = await run("--notes", notes, "--format", "md", "--since", "2025-03-01");
  expect(windowed.code).toBe(ExitCode.Usage);
  writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"couplingTrendTolerance":20}}\n');
  const configured = await run("--notes", notes, "--format", "md");
  expect(configured.code).toBe(ExitCode.Usage);
  expect(configured.stderr).toContain("config");
});

test("html without notes and --slots with --notes are usage errors", async () => {
  const usage = async (args: string[], expected: string) => {
    const { code, stderr } = await runCochange(repo.path, ["report", ...args]);
    expect(code).toBe(ExitCode.Usage);
    expect(stderr).toContain(expected);
  };
  await usage(["coupling", "--format", "html"], "html needs notes");
  await usage(["coupling", "--slots", "--format", "md"], "--slots prints the slots");
});

test("a repository with no pair at the support floor says so and still renders", async () => {
  const { stdout } = await runCochange(repo.path, ["report", "coupling", "--slots", "--since", "2025-12-01"]);
  const document = JSON.parse(stdout);
  expect(document.slots.map((s: { id: string }) => s.id)).toEqual(["summary", "limits"]);
  const notes = writeNotes("notes-empty.json", fullNotes(document));
  const md = await runCochange(repo.path, ["report", "coupling", "--since", "2025-12-01", "--notes", notes, "--format", "md"]);
  expect(md.code).toBe(ExitCode.Success);
  expect(md.stdout).toContain("0 pairs reach the support floor of 5 shared changes");
  expect(md.stdout).toContain("The floor was not lowered");
});
