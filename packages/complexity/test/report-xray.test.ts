import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GOLDEN_CONFIG_HASH } from "@code-health/fixtures/cli-testing";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { buildFixRepo } from "./support/fix-history.ts";
import { GOLDEN_DIR } from "./support/golden.ts";
import { runComplexity } from "./support/run.ts";

vi.setConfig({ testTimeout: 180_000 });

const Ajv2020 = Ajv2020Module.default;
const schema = JSON.parse(readFileSync(join(GOLDEN_DIR, "..", "..", "..", "..", "plugins", "code-health", "schemas", "complexity", "report.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

let repo: GitFixture;
let scratch: string;
beforeAll(() => {
  repo = buildFixRepo();
  scratch = mkdtempSync(join(tmpdir(), "report-xray-"));
});
afterAll(() => {
  repo.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

const FILE = "src/billing.ts";
const run = (...args: string[]) => runComplexity(repo.path, ["report", "xray", ...args]);
const slots = async () => JSON.parse((await run(FILE, "--slots")).stdout);
const masked = (text: string, config: string) => text.replaceAll(config, GOLDEN_CONFIG_HASH);

function writeNotes(name: string, document: unknown): string {
  const file = join(scratch, name);
  writeFileSync(file, JSON.stringify(document));
  return file;
}

function fullNotes(document: { stamp: unknown; slots: { id: string; verdicts: string[] }[] }) {
  const notes: Record<string, unknown> = {};
  for (const slot of document.slots) {
    notes[slot.id] = slot.verdicts.length === 0 ? { text: "The pricing function holds most of the complexity and most of the fixes." } : { verdict: slot.verdicts[1], text: "It is long and has been fixed more than once." };
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

function problems(html: string): string[] {
  const out: string[] = [];
  for (const table of html.match(/<table[\s\S]*?<\/table>/g) ?? []) {
    if (!/<caption>[^<]+<\/caption>/.test(table)) out.push("a table has no caption");
    for (const th of table.match(/<th(?![a-z])[^>]*>/g) ?? []) if (!/scope="(col|row)"/.test(th)) out.push(`a th has no scope: ${th}`);
  }
  for (const svg of html.match(/<svg[\s\S]*?<\/svg>/g) ?? []) if (!/role="img"/.test(svg)) out.push("an svg has no role=img");
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  if (new Set(ids).size !== ids.length) out.push("ids are not unique");
  return out;
}

test("--slots has one judgement slot per top function, the file summary and the limits, and matches its schema", async () => {
  const { code, stdout, stderr } = await run(FILE, "--slots");
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  const document = JSON.parse(stdout);
  expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
  expect(document.report).toBe("xray");
  const ids: string[] = document.slots.map((s: { id: string }) => s.id);
  expect(ids[0]).toBe("summary");
  expect(ids.at(-1)).toBe("limits");
  expect(ids.filter((id) => id.startsWith("function:")).length).toBeLessThanOrEqual(5);
  expect(ids).toContain("function:src/billing.ts#priceOrder");
  expect(document.stamp.inputs.file).toBe(FILE);
  expectGolden("report.xray.slots.json", masked(stdout, document.stamp.config));
});

test("the table lists every function with revisions and fixes from the fix statistics", async () => {
  const document = await slots();
  const table = document.data.sections.find((s: { id: string }) => s.id === "xray").blocks[0];
  const price = table.rows.find((row: { function: string }) => row.function === "priceOrder");
  expect(price.fixes).toBeGreaterThan(0);
  expect(price.revisions).toBeGreaterThanOrEqual(price.fixes);
  expect(table.total).toBe(table.rows.length);
  const cognitive = table.columns.find((c: { key: string }) => c.key === "cognitive");
  expect(cognitive.guideline.value).toBe(15);
});

test("notes render to html and markdown that match the goldens", async () => {
  const document = await slots();
  const notes = writeNotes("notes.json", fullNotes(document));
  const html = await run(FILE, "--notes", notes, "--format", "html");
  const md = await run(FILE, "--notes", notes, "--format", "md");
  expect(html.code).toBe(ExitCode.Success);
  expect(md.code).toBe(ExitCode.Success);
  expect(problems(html.stdout)).toEqual([]);
  expect(html.stdout).not.toMatch(/<script|<link|<img|@import|url\(|src=|href="https?:/);
  expect(md.stdout).toContain("## Limits");
  expectGolden("report.xray.html", masked(html.stdout, document.stamp.config));
  expectGolden("report.xray.md", masked(md.stdout, document.stamp.config));
});

test("markdown without notes is a draft, and html without notes is refused", async () => {
  expect((await run(FILE, "--format", "md")).stdout).toContain("Judgement not yet written");
  const refused = await run(FILE, "--format", "html");
  expect(refused.code).toBe(ExitCode.Usage);
  expect(refused.stderr).toContain("html needs notes");
});

test("a missing file argument or a file with no functions is a usage error", async () => {
  const none = await run("--slots");
  expect(none.code).toBe(ExitCode.Usage);
  expect(none.stderr).toContain("usage: complexity report xray FILE");
  const missing = await run("src/nothing.ts", "--slots");
  expect(missing.code).toBe(ExitCode.Usage);
  expect(missing.stderr).toContain("no functions were measured");
});

test("rendering is refused with exit 2 and a message naming the problem", async () => {
  const document = await slots();
  const good = fullNotes(document);
  const refused = async (notes: unknown, expected: string) => {
    const { code, stdout, stderr } = await run(FILE, "--notes", writeNotes("bad.json", notes), "--format", "html");
    expect(code).toBe(ExitCode.Usage);
    expect(stdout).toBe("");
    expect(stderr).toContain(expected);
  };
  const price = "function:src/billing.ts#priceOrder";
  const { [price]: dropped, ...rest } = good.notes;
  await refused({ ...good, stamp: { ...document.stamp, head: "b".repeat(40) } }, "the stamp is for HEAD bbbbbbb");
  await refused({ stamp: document.stamp, notes: rest }, `slot "${price}" has no entry`);
  await refused({ stamp: document.stamp, notes: { ...good.notes, [price]: { verdict: "rewrite", text: "x" } } }, 'verdict "rewrite"');
  await refused({ stamp: document.stamp, notes: { ...good.notes, [price]: { ...(dropped as object), text: "" } } }, "empty text");
  await refused({ stamp: document.stamp, notes: { ...good.notes, "function:nowhere": { verdict: "none-applies", text: "x" } } }, 'an entry "function:nowhere"');
  await refused({ stamp: { ...document.stamp, inputs: { ...document.stamp.inputs, file: "src/other.ts" } }, notes: good.notes }, "inputs");
});
