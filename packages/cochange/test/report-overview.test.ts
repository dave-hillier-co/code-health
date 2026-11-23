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
import { steadyHistory } from "./support/scenarios.ts";

const Ajv2020 = Ajv2020Module.default;
const schema = JSON.parse(readFileSync(join(GOLDEN_DIR, "..", "..", "..", "..", "plugins", "cochange", "schemas", "report.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

let repo: GitFixture;
let scratch: string;
beforeAll(() => {
  repo = steadyHistory();
  scratch = mkdtempSync(join(tmpdir(), "report-overview-"));
});
afterAll(() => {
  repo.dispose();
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
  rmSync(join(repo.path, "code-health.json"), { force: true });
});

const run = (...args: string[]) => runCochange(repo.path, ["report", "overview", ...args]);
const slots = async () => JSON.parse((await run("--slots")).stdout);
const masked = (text: string, config: string) => text.replaceAll(config, GOLDEN_CONFIG_HASH);

function writeNotes(name: string, document: unknown): string {
  const file = join(scratch, name);
  writeFileSync(file, JSON.stringify(document));
  return file;
}

/** Notes that fill every slot of the document, choosing the first candidates. */
function fullNotes(document: { stamp: unknown; slots: { id: string; verdicts: string[]; choose?: { candidates: { ref: string }[] } }[] }) {
  const notes: Record<string, unknown> = {};
  for (const slot of document.slots) {
    notes[slot.id] =
      slot.choose === undefined
        ? { text: "One contributor wrote all of it, so the history says little about ownership." }
        : { items: slot.choose.candidates.slice(0, 2).map((c, i) => ({ subject: c.ref, verdict: slot.verdicts[i], text: "It tops the ranking, and it is the file the fixes touched." })) };
  }
  return { stamp: document.stamp, notes };
}

function writeComplexityAnalyse(head: string, rows: Record<string, unknown>[]) {
  const dir = join(repo.path, ".cache", "code-health", "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "complexity.analyse.json"), JSON.stringify({ schemaVersion: 1, tool: "complexity", command: "analyse", repo: { head, dirty: false }, config: "1".repeat(16), results: rows }));
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

test("--slots prints the stamp, the data and the slots, and matches its schema", async () => {
  const { code, stdout, stderr } = await run("--slots");
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  const document = JSON.parse(stdout);
  expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
  expect(document.report).toBe("overview");
  expect(document.stamp).toMatchObject({ kind: "overview", head: repo.git("rev-parse", "HEAD").trim(), inputs: { storedResultsRead: [] } });
  expect(document.slots.map((s: { id: string }) => s.id)).toEqual(["first-look", "limits"]);
  expect(document.slots[0].choose.max).toBe(3);
  expect(document.data.header).toMatchObject({ repo: "repo", date: "2024-06-01" });
  expectGolden("report.overview.slots.json", masked(stdout, document.stamp.config));
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
  expect(html.stdout).toContain("<h2 id=\"limits-heading\">Limits</h2>");
  expect(md.stdout).toContain("## Limits");
  expectGolden("report.overview.html", masked(html.stdout, document.stamp.config));
  expectGolden("report.overview.md", masked(md.stdout, document.stamp.config));
});

test("--out writes the file and prints where", async () => {
  const document = await slots();
  const notes = writeNotes("notes-out.json", fullNotes(document));
  const out = join(scratch, "nested", "report.html");
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

test("the header names the repo, commit, date, config hash, grade, window and exclusions, and a limits section follows", async () => {
  const document = await slots();
  const { stdout } = await run("--notes", writeNotes("notes-h.json", fullNotes(document)), "--format", "md");
  for (const label of ["Repository:", "Analysed commit:", "Date:", "Config hash:", "Evidence grade:", "History window:", "Excluded:", "## Limits"]) expect(stdout).toContain(label);
});

test("a stored complexity result for HEAD is shown as a top 5 and named in the stamp; an older one is not read", async () => {
  const head = repo.git("rev-parse", "HEAD").trim();
  const rows = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `src/f${n}.ts#fn${n}`, path: `src/f${n}.ts`, cognitive: 40 - n, cyclomatic: 10, nesting: 2, length: 30, labels: ["cognitive-high"] }));
  writeComplexityAnalyse(head, rows);
  const document = await slots();
  expect(document.stamp.inputs.storedResultsRead).toEqual([{ report: "complexity.analyse", head, config: "1".repeat(16) }]);
  const { stdout } = await run("--notes", writeNotes("notes-c.json", fullNotes(document)), "--format", "md");
  expect(stdout).toContain("src/f5.ts#fn5");
  expect(stdout).not.toContain("src/f6.ts#fn6");
  expect(stdout).toContain("Showing 5 of 7 units; 2 not shown.");
  expect(stdout).toContain("No stored structure cycles result for this commit. Run `structure cycles`");

  writeComplexityAnalyse("a".repeat(40), rows);
  const older = await slots();
  expect(older.stamp.inputs.storedResultsRead).toEqual([]);
  expect((await run("--format", "md")).stdout).toContain("Run `complexity analyse`");
});

test("notes written before a stored result appeared are refused, because the stamp's inputs changed", async () => {
  const before = await slots();
  const notes = writeNotes("notes-stale.json", fullNotes(before));
  writeComplexityAnalyse(repo.git("rev-parse", "HEAD").trim(), [{ id: "src/a.ts#a", path: "src/a.ts", cognitive: 20 }]);
  const { code, stderr } = await run("--notes", notes, "--format", "html");
  expect(code).toBe(ExitCode.Usage);
  expect(stderr).toContain("storedResultsRead");
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
  await refused({ stamp: document.stamp, notes: { limits: good.notes.limits } }, 'slot "first-look" has no entry');
  await refused({ stamp: document.stamp, notes: { ...good.notes, limits: { text: "" } } }, 'slot "limits" has empty text');
  await refused({ stamp: document.stamp, notes: { ...good.notes, invented: { text: "x" } } }, 'an entry "invented"');
  await refused({ stamp: document.stamp, notes: { ...good.notes, limits: { text: "x".repeat(501) } } }, "501 characters of text and the limit is 500");
  await refused({ stamp: document.stamp, notes: { ...good.notes, "first-look": { items: [{ subject: document.slots[0].choose.candidates[0].ref, verdict: "maybe", text: "t" }] } } }, 'verdict "maybe"');
  await refused({ stamp: document.stamp, notes: { ...good.notes, "first-look": { items: [{ subject: "nowhere", verdict: "worth-a-look", text: "t" }] } } }, 'subject "nowhere"');
  await refused({ notes: good.notes }, "the notes have no stamp object", "md");
});

test("html without notes, a missing report name, an unknown report and --slots with --notes are usage errors", async () => {
  const usage = async (args: string[], expected: string) => {
    const { code, stderr } = await runCochange(repo.path, ["report", ...args]);
    expect(code).toBe(ExitCode.Usage);
    expect(stderr).toContain(expected);
  };
  await usage(["overview", "--format", "html"], "html needs notes");
  await usage([], "report needs a report name: hotspots, overview");
  await usage(["nothing"], 'unknown report "nothing"');
  await usage(["overview", "--slots", "--format", "md"], "--slots prints the slots");
  await usage(["overview"], "say what to print");
  await usage(["overview", "--notes", join(scratch, "missing.json"), "--format", "md"], "cannot read the notes file");
});

test("the report command is described by --help with its reports, and the protocol options", async () => {
  const help = (await runCochange(repo.path, ["report", "--help"])).stdout;
  expect(help).toMatch(/overview\s+Evidence/);
  expect(help).toContain("--slots");
  const sub = (await runCochange(repo.path, ["report", "overview", "--help"])).stdout;
  expect(sub).toContain("--notes <notes>");
  expect(sub).toContain("--since <since>");
});
