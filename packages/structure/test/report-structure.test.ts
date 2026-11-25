import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GOLDEN_CONFIG_HASH } from "@code-health/fixtures/cli-testing";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { withEvidenceFloor } from "../src/reports/structure.ts";
import { GOLDEN_DIR } from "./support/golden.ts";
import { structureReportRepository, unresolvedIncludesRepository } from "./support/report-scenarios.ts";
import { runStructure } from "./support/run.ts";

const Ajv2020 = Ajv2020Module.default;
const schema = JSON.parse(readFileSync(join(GOLDEN_DIR, "..", "..", "..", "..", "plugins", "structure", "schemas", "report.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

let repo: GitFixture;
let cpp: GitFixture;
let scratch: string;
beforeAll(() => {
  repo = structureReportRepository();
  cpp = unresolvedIncludesRepository();
  scratch = mkdtempSync(join(tmpdir(), "report-structure-"));
});
afterAll(() => {
  repo.dispose();
  cpp.dispose();
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  for (const fixture of [repo, cpp]) rmSync(join(fixture.path, ".cache"), { recursive: true, force: true });
});

const run = (...args: string[]) => runStructure(repo.path, ["report", "structure", ...args]);
const slots = async () => JSON.parse((await run("--slots")).stdout);
const masked = (text: string, config: string) => text.replaceAll(config, GOLDEN_CONFIG_HASH);

function writeNotes(name: string, document: unknown): string {
  const file = join(scratch, name);
  writeFileSync(file, JSON.stringify(document));
  return file;
}

interface SlotsDocument {
  stamp: unknown;
  slots: { id: string; verdicts: string[] }[];
}

/** Notes that fill every slot: the first verdict of each slot that takes one. */
function fullNotes(document: SlotsDocument) {
  const notes: Record<string, unknown> = {};
  for (const slot of document.slots) {
    notes[slot.id] = slot.verdicts.length === 0 ? { text: "The cycles are small and the history is short, so little can be said with confidence." } : { verdict: slot.verdicts[0], text: "The edge carries one call, so it is cheap to move." };
  }
  return { stamp: document.stamp, notes };
}

const goldenFile = (name: string) => join(GOLDEN_DIR, "_reports", name);
function expectGolden(name: string, text: string) {
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(dirname(goldenFile(name)), { recursive: true });
    writeFileSync(goldenFile(name), text);
    return;
  }
  expect(text).toBe(readFileSync(goldenFile(name), "utf8"));
}

/** The problems a page has against the report's accessibility rules, as the shared report tests check them. */
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

test("--slots prints the stamp, the data and one slot per cycle and per dependency against stability, and matches its schema", async () => {
  const { code, stdout, stderr } = await run("--slots");
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  const document = JSON.parse(stdout);
  expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
  expect(document.report).toBe("structure");
  expect(document.stamp).toMatchObject({ kind: "structure", head: repo.git("rev-parse", "HEAD").trim() });
  const ids: string[] = document.slots.map((s: { id: string }) => s.id);
  expect(ids[0]).toBe("summary");
  expect(ids.at(-1)).toBe("limits");
  expect(ids.filter((id) => id.startsWith("cycle-")).length).toBeGreaterThan(0);
  expect(document.data.header).toMatchObject({ repo: "repo", date: "2024-05-25" });
  expect(document.data.sections.map((s: { id: string }) => s.id)).toEqual(["summary", "cycles", "layers", "stability", "census", "hubs"]);
  expectGolden("report.structure.slots.json", masked(stdout, document.stamp.config));
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
  expectGolden("report.structure.html", masked(html.stdout, document.stamp.config));
  expectGolden("report.structure.md", masked(md.stdout, document.stamp.config));
});

test("the page shows the cycles with their breaking sets, the chart with its table, the layer violations, the census and the hubs", async () => {
  const document = await slots();
  const { stdout } = await run("--notes", writeNotes("notes-p.json", fullNotes(document)), "--format", "md");
  for (const text of ["## Import cycles", "Cycle 1: the breaking set", "## Layer violations", "src/core/model.ts", "## Stability", "Packages by instability and abstractness", "zone of pain", "## Decoupling mechanisms in use", "**Hubs:** No file is listed as a hub: each of the 2 files with at least 3 changes reached fewer than 2 of the 4 signals"]) {
    expect(stdout, text).toContain(text);
  }
  expect(stdout).toContain("packages/p3");
});

test("the html page is accessible: every chart has its table, every table a caption and scopes, and nothing external", async () => {
  const document = await slots();
  const { stdout } = await run("--notes", writeNotes("notes-a.json", fullNotes(document)), "--format", "html");
  expect(accessibilityProblems(stdout)).toEqual([]);
  expect((stdout.match(/<svg/g) ?? []).length).toBe(2);
  expect(stdout.indexOf("Module dependency matrix")).toBeLessThan(stdout.indexOf("Zone of pain"));
  expect(stdout).toContain("Zone of pain");
  expect(stdout).toContain("Zone of uselessness");
  expect(stdout).toContain("Main sequence");
  expect(stdout).not.toMatch(/<script|<link|<img|<iframe|@import|url\(|src=|href="https?:|xmlns/);
  const ids = [...stdout.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ["summary", "cycles", "layers", "stability", "census", "hubs", "limits"]) expect(stdout).toContain(`href="#${id}"`);
});

test("--out writes the file and prints where", async () => {
  const document = await slots();
  const notes = writeNotes("notes-out.json", fullNotes(document));
  const out = join(scratch, "nested", "structure.html");
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

test("a C++ tree whose includes mostly find no file gets the include resolution section with its warning", async () => {
  const output = await runStructure(cpp.path, ["report", "structure", "--slots"]);
  expect(output.code).toBe(ExitCode.Success);
  const document = JSON.parse(output.stdout);
  const section = document.data.sections.find((s: { id: string }) => s.id === "includes");
  expect(section.heading).toBe("C and C++ include resolution");
  expect(JSON.stringify(section)).toContain("Includes that found no file against the guideline");
  expect(document.data.sections.map((s: { id: string }) => s.id)).not.toContain("layers");
  expect(document.data.limits.join(" ")).toContain("No layers are configured");
  expect(document.data.limits.join(" ")).toContain("found no file than the guideline allows");
  const notes = writeNotes("notes-cpp.json", fullNotes(document));
  const md = await runStructure(cpp.path, ["report", "structure", "--notes", notes, "--format", "md"]);
  expect(md.code).toBe(ExitCode.Success);
  expect(md.stdout).toContain("## C and C++ include resolution");
  expect(md.stdout).toContain("Share that found no file");
  expect(md.stdout).toContain("**Warning:**");
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
  const { summary: _summary, ...withoutSummary } = good.notes;
  await refused({ ...good, stamp: { ...document.stamp, head: "b".repeat(40) } }, "the stamp is for HEAD bbbbbbb");
  await refused({ stamp: document.stamp, notes: withoutSummary }, 'slot "summary" has no entry');
  await refused({ stamp: document.stamp, notes: { ...good.notes, "cycle-1": { verdict: "leave", text: "" } } }, 'slot "cycle-1" has empty text');
  await refused({ stamp: document.stamp, notes: { ...good.notes, "cycle-1": { verdict: "leave", text: "x".repeat(401) } } }, "401 characters of text and the limit is 400");
  await refused({ stamp: document.stamp, notes: { ...good.notes, "cycle-1": { verdict: "maybe", text: "t" } } }, 'verdict "maybe"');
  await refused({ stamp: document.stamp, notes: { ...good.notes, "cycle-1": { text: "t" } } }, "needs a verdict");
  await refused({ stamp: document.stamp, notes: { ...good.notes, summary: { verdict: "leave", text: "t" } } }, "takes text only");
  await refused({ stamp: document.stamp, notes: { ...good.notes, invented: { text: "x" } } }, 'an entry "invented"');
  await refused({ notes: good.notes }, "the notes have no stamp object", "md");
});

test("notes written for other inputs are refused, because the stamp's inputs changed", async () => {
  const document = await slots();
  const notes = writeNotes("notes-stale.json", fullNotes(document));
  const { code, stderr } = await run("--notes", notes, "--format", "md", "--since", "2024-02-01");
  expect(code).toBe(ExitCode.Usage);
  expect(stderr).toContain("since");
});

test("html without notes, a missing report name, an unknown report and --slots with --notes are usage errors", async () => {
  const usage = async (args: string[], expected: string) => {
    const { code, stderr } = await runStructure(repo.path, ["report", ...args]);
    expect(code).toBe(ExitCode.Usage);
    expect(stderr).toContain(expected);
  };
  await usage(["structure", "--format", "html"], "html needs notes");
  await usage([], "report needs a report name: structure");
  await usage(["nothing"], 'unknown report "nothing"');
  await usage(["structure", "--slots", "--format", "md"], "--slots prints the slots");
});

test("the report command is described by --help with its report and the protocol options", async () => {
  const help = (await runStructure(repo.path, ["report", "--help"])).stdout;
  expect(help).toMatch(/structure\s+Import cycles/);
  expect(help).toContain("--slots");
});

test("packages with too few exported types are unplaced: left out of the chart and its zone counts, and counted", async () => {
  const document = await slots();
  const stability = document.data.sections.find((s: { id: string }) => s.id === "stability");
  const chart = stability.blocks.find((b: { type: string }) => b.type === "stability-chart");
  expect(chart.points.map((p: { name: string }) => p.name).sort()).toEqual(["packages/p3", "packages/p4", "packages/p5"]);
  expect(chart.points.every((p: { exportedTypes: number }) => p.exportedTypes > 0)).toBe(true);
  const { stdout } = await run("--notes", writeNotes("notes-types.json", fullNotes(document)), "--format", "md");
  expect(stdout).toContain("2 packages have too few exported types to place (fewer than 3, structure.packages.minExportedTypes, a judgement call); abstractness is not measured for them");
  expect(stdout).not.toContain("| packages/p1 |");
  expect(stdout).not.toContain("A weak");
});

test("the summary's package count names what it counts, and adds up with the chart", async () => {
  const document = await slots();
  const facts = document.data.sections[0].blocks[0].facts as { label: string; value: string }[];
  expect(facts.find((f) => f.label === "Packages")!.value).toBe("5 found from manifests: 5 hold production code in a supported language, and 3 of them are placed on the chart");
  expect(document.data.limits.join(" ")).toContain("`structure cycles --level package` has a module for each package that holds production code in a supported language");
});

test("the limits leave out the layer cap when no layers are configured, and say how many each list shows at most", async () => {
  const output = await runStructure(cpp.path, ["report", "structure", "--slots"]);
  const limits = JSON.parse(output.stdout).data.limits.join(" ");
  expect(limits).not.toContain("layer violations");
  expect(limits).toContain("Each list shows up to 5 cycles, 8 dependencies against stability, 10 hubs and 15 packages in the stability table, and says how many it leaves out.");
  const layered = (await slots()).data.limits.join(" ");
  expect(layered).toContain("Each list shows up to 5 cycles, 8 dependencies against stability, 15 layer violations, 10 hubs and 15 packages in the stability table, and says how many it leaves out.");
});

test("the evidence floor lists a dependency only when the depended-on folder has enough files, and counts the rest", async () => {
  const stability = JSON.parse((await runStructure(repo.path, ["stability", "--json"])).stdout).results as Parameters<typeof withEvidenceFloor>[0];
  expect(stability.length).toBeGreaterThan(0);
  const filesOfTarget = stability[0]!.stability.to.change.files;
  expect(withEvidenceFloor(stability, { minTargetFiles: filesOfTarget })).toMatchObject({ belowFloor: 0 });
  const floored = withEvidenceFloor(stability, { minTargetFiles: filesOfTarget + 1 });
  expect(floored.listed.length + floored.belowFloor).toBe(stability.length);
  expect(floored.belowFloor).toBeGreaterThan(0);
  expect(floored.listed.every((row) => row.stability.to.change.files > filesOfTarget)).toBe(true);
});

test("the cycles table has a locality gain column when a locality report for this commit names a blocked move, and has none without one", async () => {
  expect((await run("--format", "md")).stdout).not.toContain("Locality gain unblocked");
  const cycles = JSON.parse((await runStructure(repo.path, ["cycles", "--json"])).stdout).results as { breakingSet: { from: string; to: string }[] }[];
  const edge = cycles[0]!.breakingSet[0]!;
  const directory = join(repo.path, ".cache", "code-health", "reports");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "locality.analyse.json"),
    JSON.stringify({
      schemaVersion: 1,
      tool: "locality",
      command: "analyse",
      repo: { head: repo.git("rev-parse", "HEAD").trim(), dirty: false },
      config: "0123456789abcdef",
      results: [{ path: "src/leaf.ts", blockers: [{ path: edge.to, from: [edge.from], kind: "dependency", weight: 1, otherConsumers: 0, coChange: null, unblockedGain: 7 }] }],
    }),
  );
  const { stdout } = await run("--no-cache", "--format", "md");
  expect(stdout).toContain("Locality gain unblocked");
  expect(stdout).toMatch(/\| 7 \|/);
});

describe("folder cycles inside one C# project", () => {
  const csproj = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n';
  const klass = (name: string, uses: string) => `namespace Acme;\n\npublic class ${name}\n{\n    public int Run() => new ${uses}().Run();\n}\n`;
  const stub = (name: string) => `namespace Acme;\n\npublic class ${name}\n{\n    public int Run() => 1;\n}\n`;
  const alice = { name: "Alice", email: "alice@example.com" };
  const build = (setting: boolean) =>
    GitFixture.build([
      {
        type: "commit",
        message: "Add the project",
        date: "2024-01-10T09:00:00Z",
        author: alice,
        changes: [
          { op: "add", path: "Core/Core.csproj", content: csproj },
          { op: "add", path: "Core/Orders/Order.cs", content: stub("Order") },
          { op: "add", path: "Core/Billing/Invoice.cs", content: stub("Invoice") },
          { op: "add", path: "code-health.json", content: JSON.stringify({ structure: { csharpFolderCycles: setting } }) },
        ],
      },
      {
        type: "commit",
        message: "Make the folders use each other",
        date: "2024-02-10T09:00:00Z",
        author: alice,
        changes: [
          { op: "modify", path: "Core/Orders/Order.cs", content: klass("Order", "Invoice") },
          { op: "modify", path: "Core/Billing/Invoice.cs", content: klass("Invoice", "Order") },
        ],
      },
    ]);

  test("the page prints one line with the count and the largest when the setting is true, and no line when it is false", async () => {
    const on = build(true);
    const off = build(false);
    try {
      const withSetting = await runStructure(on.path, ["report", "structure", "--format", "md"]);
      expect(withSetting.code).toBe(ExitCode.Success);
      expect(withSetting.stdout).toContain("1 folder cycle lies inside one C# project and is not in the table (structure.csharpFolderCycles is true). Largest: Core/Billing, Core/Orders in Core");
      const without = await runStructure(off.path, ["report", "structure", "--format", "md"]);
      expect(without.stdout).not.toContain("inside one C# project");
    } finally {
      on.dispose();
      off.dispose();
    }
  });
});
