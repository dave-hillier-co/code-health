import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GOLDEN_CONFIG_HASH } from "@code-health/fixtures/cli-testing";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { GOLDEN_DIR } from "./support/golden.ts";
import { runCochange } from "./support/run.ts";
import { indentedHistory } from "./support/scenarios.ts";

const Ajv2020 = Ajv2020Module.default;
const schema = JSON.parse(readFileSync(join(GOLDEN_DIR, "..", "..", "..", "..", "plugins", "cochange", "schemas", "report.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

let repo: GitFixture;
let scratch: string;
beforeAll(() => {
  repo = indentedHistory();
  scratch = mkdtempSync(join(tmpdir(), "report-hotspots-"));
});
afterAll(() => {
  repo.dispose();
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
  // Four files in the window cannot reach the 90th percentile, so the friction list needs a lower one.
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { hotspotPercentile: 50 } }));
});

const run = (...args: string[]) => runCochange(repo.path, ["report", "hotspots", ...args]);
const slots = async () => JSON.parse((await run("--slots")).stdout);
const masked = (text: string, config: string) => text.replaceAll(config, GOLDEN_CONFIG_HASH);

function writeNotes(name: string, document: unknown): string {
  const file = join(scratch, name);
  writeFileSync(file, JSON.stringify(document));
  return file;
}

function fullNotes(document: { stamp: unknown; slots: { id: string; verdicts: string[] }[] }) {
  const notes: Record<string, unknown> = {};
  for (const slot of document.slots) {
    notes[slot.id] = slot.verdicts.length === 0 ? { text: "Nesting and change meet in one file, and the history is short." } : { verdict: slot.verdicts[0], text: "The file changes often and is deeply nested." };
  }
  return { stamp: document.stamp, notes };
}

function writeStored(command: string, head: string, rows: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  const dir = join(repo.path, ".cache", "code-health", "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `complexity.${command}.json`), JSON.stringify({ schemaVersion: 1, tool: "complexity", command, repo: { head, dirty: false }, config: "1".repeat(16), results: rows, ...extra }));
}

const unit = (name: string, cognitive: number, labels: string[]) => ({ id: `src/core/engine.ts#${name}`, path: "src/core/engine.ts", unit: name, startLine: 1, endLine: 20, cognitive, cyclomatic: 12, nesting: 6, length: 14, labels });

function storeXray(head: string) {
  writeStored("analyse", head, [unit("tune", 30, ["cognitive-high", "nesting-warn"]), unit("start", 4, [])], { guidelines: { cognitiveWarn: 15, cyclomaticWarn: 10, nesting: 4, overrides: 0 } });
  writeStored("fixes", head, [{ id: "src/core/engine.ts#tune", path: "src/core/engine.ts", fixCommits: 2, unitRevisions: 5 }]);
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

/** The problems a page has against the report's accessibility rules. */
function problems(html: string): string[] {
  const out: string[] = [];
  for (const svg of html.match(/<svg[\s\S]*?<\/svg>/g) ?? []) {
    if (!/role="img"/.test(svg)) out.push("an svg has no role=img");
    if (!/aria-labelledby="[^"]+"/.test(svg)) out.push("an svg has no aria-labelledby");
    if (!/<title id="[^"]+">[^<]+<\/title>/.test(svg)) out.push("an svg has no title");
  }
  for (const figure of html.match(/<figure[\s\S]*?<\/figure>/g) ?? []) {
    if (/<svg/.test(figure) && !/<table/.test(figure)) out.push("a chart has no table of its data");
    if (!/<figcaption>/.test(figure)) out.push("a figure has no figcaption");
  }
  if ((html.match(/<svg/g) ?? []).length !== (html.match(/<figure/g) ?? []).length) out.push("an svg is not inside its own figure");
  for (const table of html.match(/<table[\s\S]*?<\/table>/g) ?? []) {
    if (!/<caption>[^<]+<\/caption>/.test(table)) out.push("a table has no caption");
    for (const th of table.match(/<th(?![a-z])[^>]*>/g) ?? []) if (!/scope="(col|row)"/.test(th)) out.push(`a th has no scope: ${th}`);
  }
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  if (new Set(ids).size !== ids.length) out.push("ids are not unique");
  return out;
}

test("--slots has the friction file, its two judgement slots, the whole-report slot and the limits, and matches its schema", async () => {
  storeXray(repo.git("rev-parse", "HEAD").trim());
  const { code, stdout, stderr } = await run("--slots");
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  const document = JSON.parse(stdout);
  expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
  expect(document.report).toBe("hotspots");
  expect(document.slots.map((s: { id: string }) => s.id)).toEqual(["summary", "flag:src/core/engine.ts", "recommend:src/core/engine.ts", "limits"]);
  const recommend = document.slots[2];
  expect(recommend.verdicts).toEqual(["refactor", "split", "leave", "review", "dismiss"]);
  expect(document.slots[1].verdicts).toContain("none-applies");
  expect(document.stamp.inputs.top).toBe(20);
  expect(document.stamp.inputs.storedResultsRead.map((r: { report: string }) => r.report)).toEqual(["complexity.analyse", "complexity.fixes"]);
  expect(document.data.sections.map((s: { id: string }) => s.id)).toEqual(["summary", "map", "friction", "history", "xray-1"]);
  expectGolden("report.hotspots.slots.json", masked(stdout, document.stamp.config));
});

test("--slots twice gives the same bytes", async () => {
  expect((await run("--slots")).stdout).toBe((await run("--slots")).stdout);
});

test("notes render to html and markdown that match the goldens, and the html follows the accessibility rules", async () => {
  storeXray(repo.git("rev-parse", "HEAD").trim());
  const document = await slots();
  const notes = writeNotes("notes.json", fullNotes(document));
  const html = await run("--notes", notes, "--format", "html");
  const md = await run("--notes", notes, "--format", "md");
  expect(html.code).toBe(ExitCode.Success);
  expect(md.code).toBe(ExitCode.Success);
  expect(problems(html.stdout)).toEqual([]);
  expect(html.stdout).not.toMatch(/<script|<link|<img|@import|url\(|src=|href="https?:/);
  expect(html.stdout).toContain("<svg");
  expect(md.stdout).toContain("## Friction list");
  expect(md.stdout).toContain("## Limits");
  expectGolden("report.hotspots.html", masked(html.stdout, document.stamp.config));
  expectGolden("report.hotspots.md", masked(md.stdout, document.stamp.config));
});

test("the X-Ray reads the stored analyse and fixes results, and says which command to run for a missing one", async () => {
  const head = repo.git("rev-parse", "HEAD").trim();
  writeStored("analyse", head, [unit("tune", 30, ["cognitive-high"])], { guidelines: { cognitiveWarn: 15, cyclomaticWarn: 10, nesting: 4, overrides: 0 } });
  const withoutFixes = (await run("--format", "md")).stdout;
  expect(withoutFixes).toContain("tune");
  expect(withoutFixes).toContain("No stored complexity fixes result for this commit. Run `complexity fixes`");
  rmSync(join(repo.path, ".cache", "code-health", "reports", "complexity.analyse.json"));
  const none = (await run("--format", "md")).stdout;
  expect(none).toContain("Run `complexity analyse`");
  expect(none).toContain("Run `complexity fixes`");
  writeStored("analyse", "a".repeat(40), [unit("tune", 30, [])]);
  expect((await slots()).stamp.inputs.storedResultsRead).toEqual([]);
});

test("a stored result that appeared after --slots invalidates the notes", async () => {
  const before = await slots();
  const notes = writeNotes("notes-stale.json", fullNotes(before));
  storeXray(repo.git("rev-parse", "HEAD").trim());
  const { code, stderr } = await run("--notes", notes, "--format", "html");
  expect(code).toBe(ExitCode.Usage);
  expect(stderr).toContain("storedResultsRead");
});

test("--top limits the friction list and is part of the stamp", async () => {
  const document = JSON.parse((await run("--slots", "--top", "1")).stdout);
  expect(document.stamp.inputs.top).toBe(1);
  expect((await runCochange(repo.path, ["report", "hotspots", "--slots", "--top", "0"])).code).toBe(ExitCode.Usage);
});

test("a repository with no file at both percentiles has an empty friction list and only the whole-report slots", async () => {
  rmSync(join(repo.path, "code-health.json"));
  const document = await slots();
  expect(document.slots.map((s: { id: string }) => s.id)).toEqual(["summary", "limits"]);
  const { stdout, code } = await run("--notes", writeNotes("notes-empty.json", fullNotes(document)), "--format", "md");
  expect(code).toBe(ExitCode.Success);
  expect(stdout).toContain("No file is in the top 10 percent");
});

test("rendering is refused with exit 2 and a message naming the problem", async () => {
  const document = await slots();
  const good = fullNotes(document);
  const refused = async (notes: unknown, expected: string) => {
    const { code, stdout, stderr } = await run("--notes", writeNotes("bad.json", notes), "--format", "html");
    expect(code).toBe(ExitCode.Usage);
    expect(stdout).toBe("");
    expect(stderr).toContain(expected);
  };
  const { "recommend:src/core/engine.ts": recommend, ...rest } = good.notes;
  await refused({ ...good, stamp: { ...document.stamp, head: "b".repeat(40) } }, "the stamp is for HEAD bbbbbbb");
  await refused({ stamp: document.stamp, notes: rest }, 'slot "recommend:src/core/engine.ts" has no entry');
  await refused({ stamp: document.stamp, notes: { ...good.notes, "recommend:src/core/engine.ts": { verdict: "rewrite", text: "x" } } }, 'verdict "rewrite"');
  await refused({ stamp: document.stamp, notes: { ...good.notes, "recommend:src/core/engine.ts": { ...(recommend as object), text: "" } } }, "empty text");
  await refused({ stamp: document.stamp, notes: { ...good.notes, "flag:src/other.ts": { verdict: "none-applies", text: "x" } } }, 'an entry "flag:src/other.ts"');
  await refused({ stamp: document.stamp, notes: { ...good.notes, summary: { text: "x".repeat(501) } } }, "501 characters of text and the limit is 500");
});

const frictionTable = (document: { data: { sections: { id: string; blocks: { type: string; rows?: Record<string, unknown>[]; total?: number; columns?: { key: string }[]; fullIn?: string }[] }[] } }) =>
  document.data.sections.find((s) => s.id === "friction")!.blocks.find((b) => b.type === "ranked-table")!;

test("with a stored analyse result a file is complex when a function is above the cognitive guideline, whatever its complexity percentile", async () => {
  const head = repo.git("rev-parse", "HEAD").trim();
  const guidelines = { cognitiveWarn: 15, cyclomaticWarn: 10, nesting: 4, overrides: 0 };
  writeStored("analyse", head, [{ ...unit("tidy", 20, ["cognitive-warn"]), id: "src/core/util.ts#tidy", path: "src/core/util.ts" }, unit("tune", 9, [])], { guidelines });
  const document = await slots();
  const table = frictionTable(document);
  expect(table.rows!.map((row) => row.path)).toEqual(["src/core/util.ts"]);
  expect(table.columns!.map((c) => c.key)).toContain("functionsAbove");
  expect(table.rows![0]!.functionsAbove).toBe(1);
  const md = (await run("--notes", writeNotes("notes-functions.json", fullNotes(document)), "--format", "md")).stdout;
  expect(md).toContain("A file is complex here when it has a function above the cognitive complexity guideline, read from the stored `complexity analyse` result.");
});

test("without a stored analyse result a file is complex by its complexity percentile, and the page says which command stores the function-level result", async () => {
  const document = await slots();
  const table = frictionTable(document);
  expect(table.rows!.map((row) => row.path)).toEqual(["src/core/engine.ts"]);
  expect(table.columns!.map((c) => c.key)).not.toContain("functionsAbove");
  const md = (await run("--notes", writeNotes("notes-percentile.json", fullNotes(document)), "--format", "md")).stdout;
  expect(md).toContain("its complexity percentile is at or above 50, because no stored `complexity analyse` result covers this commit. Run `complexity analyse` and then this report again");
});

test("only the first cochange.hotspotJudged friction files have judgement slots, and the table lists the rest", async () => {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { hotspotPercentile: 1, hotspotJudged: 1 } }));
  const document = await slots();
  const table = frictionTable(document);
  expect(table.rows!.length).toBeGreaterThan(1);
  const ids: string[] = document.slots.map((s: { id: string }) => s.id);
  expect(ids).toEqual(["summary", `flag:${table.rows![0]!.path}`, `recommend:${table.rows![0]!.path}`, "limits"]);
  const md = (await run("--notes", writeNotes("notes-judged.json", fullNotes(document)), "--format", "md")).stdout;
  expect(md).toContain("The first 1 files have a judgement (cochange.hotspotJudged is 1");
});

test("a friction table cut by --top says how many it omits and the command that lists them", async () => {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { hotspotPercentile: 1 } }));
  const table = frictionTable(JSON.parse((await run("--slots", "--top", "2")).stdout));
  expect(table.rows).toHaveLength(2);
  expect(table.total).toBeGreaterThan(2);
  expect(table.fullIn).toBe(`cochange report hotspots --top ${table.total}`);
});

test("the X-Ray has no revisions column, because the stored fix result lists only functions with a fix, and says where to read them", async () => {
  storeXray(repo.git("rev-parse", "HEAD").trim());
  const document = await slots();
  const section = document.data.sections.find((s: { id: string }) => s.id === "xray-1");
  const table = section.blocks.find((b: { type: string }) => b.type === "ranked-table");
  expect(table.columns.map((c: { key: string }) => c.key)).not.toContain("revisions");
  expect(table.columns.map((c: { key: string }) => c.key)).toContain("fixes");
  const notice = section.blocks.find((b: { type: string; text?: string }) => b.type === "notice" && b.text?.includes("no revisions column"));
  expect(notice.text).toContain("complexity report xray src/core/engine.ts");
});
