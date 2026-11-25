import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GOLDEN_CONFIG_HASH } from "@code-health/fixtures/cli-testing";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { GOLDEN_DIR } from "./support/golden.ts";
import { runLocality } from "./support/run.ts";
import { distantHelpers } from "./support/scenarios.ts";

const Ajv2020 = Ajv2020Module.default;
const schema = JSON.parse(readFileSync(join(GOLDEN_DIR, "..", "..", "..", "..", "plugins", "code-health", "schemas", "locality", "report.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

let repo: GitFixture;
let scratch: string;
beforeAll(() => {
  repo = distantHelpers();
  scratch = mkdtempSync(join(tmpdir(), "report-locality-"));
});
afterAll(() => {
  repo.dispose();
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
});

const run = (...args: string[]) => runLocality(repo.path, ["report", "locality", ...args]);
const slots = async () => JSON.parse((await run("--slots")).stdout);
const masked = (text: string, config: string) => text.replaceAll(config, GOLDEN_CONFIG_HASH);

interface SlotsDocument {
  stamp: unknown;
  slots: { id: string; verdicts: string[] }[];
}

function writeNotes(name: string, document: unknown): string {
  const file = join(scratch, name);
  writeFileSync(file, JSON.stringify(document));
  return file;
}

/** Notes that fill every slot, giving each candidate the first verdict. */
function fullNotes(document: SlotsDocument) {
  const notes: Record<string, unknown> = {};
  for (const slot of document.slots) {
    notes[slot.id] = slot.verdicts.length === 0 ? { text: "The helpers sit far from their consumers." } : { verdict: slot.verdicts[0], text: "It has few consumers and nothing blocks it. Risk: a missed consumer." };
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

test("--slots prints the stamp, the data and one slot per planned candidate, and matches its schema", async () => {
  const { code, stdout, stderr } = await run("--slots");
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  const document = JSON.parse(stdout);
  expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
  expect(document.report).toBe("locality");
  expect(document.stamp).toMatchObject({ kind: "locality", head: repo.git("rev-parse", "HEAD").trim(), inputs: { source: "structural" } });
  const ids = document.slots.map((s: { id: string }) => s.id);
  expect(ids[0]).toBe("summary");
  expect(ids.at(-1)).toBe("limits");
  expect(ids.slice(1, -1)).toEqual(Array.from({ length: ids.length - 2 }, (_, i) => `candidate-${i + 1}`));
  expect(ids.length - 2).toBeLessThanOrEqual(10);
  expect(document.slots[1]).toMatchObject({ about: { kind: "unit" }, verdicts: ["do-it", "do-it-differently", "leave"] });
  expectGolden("report.locality.slots.json", masked(stdout, document.stamp.config));
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
  expectGolden("report.locality.html", masked(html.stdout, document.stamp.config));
  expectGolden("report.locality.md", masked(md.stdout, document.stamp.config));
});

test("moves come first in their own table, reviews and splits follow, and scrutinise units are ranked by consumer files apart from them", async () => {
  const document = await slots();
  const { stdout } = await run("--notes", writeNotes("notes-grouping.json", fullNotes(document)), "--format", "md");
  const moves = stdout.indexOf("**Moves the planner can plan without --reason");
  const reviews = stdout.indexOf("**Reviews, splits and inlines");
  const scrutinise = stdout.indexOf("**High fan-in units (kind scrutinise)");
  expect(moves).toBeGreaterThan(-1);
  expect(reviews).toBeGreaterThan(moves);
  expect(scrutinise).toBeGreaterThan(reviews);
  const rows = (from: number, to: number) => stdout.slice(from, to).split("\n").filter((line) => /^\| \d+ \|/.test(line));
  for (const row of rows(moves, reviews)) expect(row).toMatch(/\| move \|/);
  for (const row of rows(reviews, scrutinise)) expect(row).not.toMatch(/\| (move|scrutinise|blocked) \|/);
  expect(rows(scrutinise, stdout.indexOf("## 1.")).join("\n")).toContain("src/shared/format.ts");
  // The first planned candidates are the moves, so each has a dry-run plan rather than needs-reason.
  expect(stdout.indexOf("## 1. src/shared/pair")).toBeGreaterThan(-1);
});

test("the page shows the candidates, a dry-run plan, the distance histogram, unresolved imports and what was omitted", async () => {
  const document = await slots();
  const { stdout } = await run("--notes", writeNotes("notes-content.json", fullNotes(document)), "--format", "md");
  for (const text of ["Moves the planner can plan without --reason", "Move plan (dry run)", "imports? rewritten", "Distance from each unit's folder", "Unresolved imports", "Omitted, by reason", "near-consumers"]) {
    expect(stdout).toMatch(new RegExp(text.replace(/[()']/g, "\\$&")));
  }
  expect(stdout).toContain("src/shared/utils/money.ts");
  for (const label of ["Repository:", "Analysed commit:", "Date:", "Config hash:", "Evidence grade:", "History window:", "Excluded:", "## Limits"]) expect(stdout).toContain(label);
});

test("the dry run writes nothing: the working tree and HEAD are unchanged", async () => {
  const head = repo.git("rev-parse", "HEAD");
  const document = await slots();
  await run("--notes", writeNotes("notes-clean.json", fullNotes(document)), "--format", "md");
  expect(repo.git("status", "--porcelain", "--untracked-files=no")).toBe("");
  expect(repo.git("rev-parse", "HEAD")).toBe(head);
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

test("the html is self-contained and follows the accessibility rules", async () => {
  const document = await slots();
  const { stdout: html } = await run("--notes", writeNotes("notes-a11y.json", fullNotes(document)), "--format", "html");
  expect(html).not.toMatch(/<script|<link|<img|<iframe|@import|url\(|src=|href="https?:|xmlns/);
  for (const svg of html.match(/<svg[\s\S]*?<\/svg>/g) ?? []) {
    expect(svg).toMatch(/role="img"/);
    const labelled = /aria-labelledby="([^"]+)"/.exec(svg)?.[1] ?? "";
    for (const id of labelled.split(" ")) expect(svg).toContain(`id="${id}"`);
    expect(svg).toMatch(/<title id="[^"]+">[^<]+<\/title>/);
  }
  const figures = html.match(/<figure[\s\S]*?<\/figure>/g) ?? [];
  expect(figures.length).toBeGreaterThan(0);
  for (const figure of figures) {
    expect(figure).toMatch(/<figcaption>/);
    if (figure.includes("<svg")) expect(figure).toMatch(/<table/);
  }
  expect((html.match(/<svg/g) ?? []).length).toBe(figures.length);
  for (const table of html.match(/<table[\s\S]*?<\/table>/g) ?? []) {
    expect(table).toMatch(/<caption>[^<]+<\/caption>/);
    expect(table).toMatch(/<th scope="col"/);
    for (const th of table.match(/<th(?![a-z])[^>]*>/g) ?? []) expect(th).toMatch(/scope="(col|row)"/);
  }
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const tag of ["<header>", "<nav aria-label=", "<main", "<section", "prefers-color-scheme: dark", "@media print"]) expect(html).toContain(tag);
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
  const { limits: _limits, ...withoutLimits } = good.notes;
  await refused({ ...good, stamp: { ...(document.stamp as object), head: "b".repeat(40) } }, "the stamp is for HEAD bbbbbbb");
  await refused({ stamp: document.stamp, notes: withoutLimits }, 'slot "limits" has no entry');
  await refused({ stamp: document.stamp, notes: { ...good.notes, "candidate-1": { verdict: "do-it", text: "" } } }, 'slot "candidate-1" has empty text');
  await refused({ stamp: document.stamp, notes: { ...good.notes, "candidate-1": { text: "No verdict." } } }, '"candidate-1"');
  await refused({ stamp: document.stamp, notes: { ...good.notes, "candidate-1": { verdict: "apply", text: "t" } } }, 'verdict "apply"');
  await refused({ stamp: document.stamp, notes: { ...good.notes, "candidate-99": { verdict: "leave", text: "x" } } }, 'an entry "candidate-99"');
  await refused({ stamp: document.stamp, notes: { ...good.notes, "candidate-1": { verdict: "leave", text: "x".repeat(401) } } }, "401 characters of text and the limit is 400");
  await refused({ notes: good.notes }, "the notes have no stamp object", "md");
});

test("html without notes, an unknown report and --slots with --notes are usage errors", async () => {
  const usage = async (args: string[], expected: string) => {
    const { code, stderr } = await runLocality(repo.path, ["report", ...args]);
    expect(code).toBe(ExitCode.Usage);
    expect(stderr).toContain(expected);
  };
  await usage(["locality", "--format", "html"], "html needs notes");
  await usage([], "report needs a report name: locality");
  await usage(["nothing"], 'unknown report "nothing"');
  await usage(["locality", "--slots", "--format", "md"], "--slots prints the slots");
});

test("the report command is listed by --help", async () => {
  const help = (await runLocality(repo.path, ["report", "--help"])).stdout;
  expect(help).toMatch(/locality\s+Units far/);
  expect(help).toContain("--slots");
});

const add = (path: string, content: string) => ({ op: "add" as const, path, content });
const goUnit = (name: string) => `package ${name}\n\nfunc Run() int {\n\treturn 1\n}\n`;
const goImports = (pkg: string, imported: string) => `package ${pkg}\n\nimport "example.com/m/${imported}"\n\nfunc Use() int {\n\treturn ${imported.split("/").pop()}.Run()\n}\n`;

const goRepository = (entry: string, files: Record<string, string>) =>
  GitFixture.build([
    { type: "commit", message: "Add the code", date: "2024-01-01T09:00:00Z", changes: [add("code-health.json", JSON.stringify({ entryPoints: ["cmd/main.go"] })), add("go.mod", "module example.com/m\n\ngo 1.22\n"), add("cmd/main.go", entry), ...Object.entries(files).map(([path, content]) => add(path, content))] },
    { type: "commit", message: "Add notes", date: "2025-01-01T09:00:00Z", changes: [add("NOTES.md", "Notes.\n")] },
  ]);

test("the page shows the omitted counts by reason and the omitted units with their detail", async () => {
  const go = goRepository('package main\n\nimport (\n\t"example.com/m/pkg/svc"\n\t"example.com/m/pkg/other"\n)\n\nfunc main() {\n\t_ = svc.Use() + other.Use()\n}\n', {
    "pkg/svc/one.go": goImports("svc", "lib/internal/store"),
    "pkg/other/two.go": goImports("other", "lib/internal/store"),
    "lib/internal/store/store.go": goUnit("store"),
  });
  try {
    const { code, stdout } = await runLocality(go.path, ["report", "locality", "--format", "md"]);
    expect(code).toBe(ExitCode.Success);
    expect(stdout).toContain("| units with no proposed move: no usable target: crosses internal/ | 1 |");
    expect(stdout).toContain("Units with no proposed move");
    expect(stdout).toMatch(/\| 1 \| lib\/internal\/store\/store\.go \| no usable target: crosses internal\/ \| .*internal\/.* \|/);
  } finally {
    go.dispose();
  }
});

test("a candidate shows its reason and the better folder the placement rules refuse", async () => {
  const go = goRepository('package main\n\nimport (\n\t"example.com/m/m/lib/internal/a/x"\n\t"example.com/m/m/lib/internal/b/y"\n)\n\nfunc main() {\n\t_ = x.Use() + y.Use()\n}\n', {
    "m/lib/internal/a/x/x.go": goImports("x", "m/lib/store"),
    "m/lib/internal/b/y/y.go": goImports("y", "m/lib/store"),
    "m/lib/store/store.go": goUnit("store"),
  });
  try {
    const { stdout } = await runLocality(go.path, ["report", "locality", "--format", "md"]);
    expect(stdout).toMatch(/\| Reason \| .+ \|/);
    expect(stdout).toContain("| Better folder refused | m/lib/internal, with gain");
    expect(stdout).toContain("is refused: crosses internal/");
  } finally {
    go.dispose();
  }
});

test("the page lists the blockers of the units recommended blocked, with the gain they would have if the blockers were resolved", async () => {
  const { stdout } = await run("--format", "md");
  expect(stdout).toContain("Units held back by blockers");
  expect(stdout).toContain("| src/lib/kernel/tool.ts | blocked | 0 | 4 | src/lib/kernel/core.ts |");
});

test("a refused move plan is one line: the codes with counts, then the first detail cut short", async () => {
  const { stdout } = await run("--format", "md");
  const plans = stdout.split("\n").filter((line) => line.startsWith("| Move plan (dry run) | no plan:"));
  expect(plans.length).toBeGreaterThan(0);
  for (const line of plans) expect(line).toMatch(/^\| Move plan \(dry run\) \| no plan: [a-z-]+( x\d+)?(, [a-z-]+( x\d+)?)*; first: .{1,121} \|$/);
});
