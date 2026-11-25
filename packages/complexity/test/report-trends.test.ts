import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GOLDEN_CONFIG_HASH } from "@code-health/fixtures/cli-testing";
import { GitFixture, type Change, type Step } from "@code-health/fixtures/git-fixture";
import { splitCheck, weightOf, type FolderMeasures } from "../src/folder-measures.ts";
import { GOLDEN_DIR } from "./support/golden.ts";
import { runComplexity } from "./support/run.ts";

const add = (path: string, content: string): Change => ({ op: "add", path, content });
const modify = (path: string, content: string): Change => ({ op: "modify", path, content });

/** A function with `branches` if statements, so its cyclomatic complexity is `branches + 1` and its code lines `branches + 3`. */
const branchy = (name: string, branches: number) =>
  `export function ${name}(n: number): number {\n${Array.from({ length: branches }, (_, i) => `  if (n === ${i}) return ${i * 2};\n`).join("")}  return n;\n}\n`;
const simple = (name: string) => `export function ${name}(n: number): number {\n  return n + 1;\n}\n`;

/** A shop over eight months: pricing gains branches until it is above the guideline, orders stays simple and grows. */
function shopOverTime(): GitFixture {
  const steps: Step[] = [
    { type: "commit", message: "Add the notes", date: "2023-11-02T09:00:00Z", changes: [add("NOTES.md", "Notes.\n")] },
    {
      type: "commit",
      message: "Add the shop",
      date: "2024-01-02T09:00:00Z",
      changes: [add("src/billing/price.ts", branchy("price", 3)), add("src/billing/price.test.ts", branchy("priceTest", 14)), add("src/orders/place.ts", simple("place"))],
    },
    { type: "commit", message: "More prices", date: "2024-03-02T09:00:00Z", changes: [modify("src/billing/price.ts", branchy("price", 8))] },
    { type: "commit", message: "Still more prices", date: "2024-05-02T09:00:00Z", changes: [modify("src/billing/price.ts", branchy("price", 12))] },
    { type: "commit", message: "Cancel orders", date: "2024-07-02T09:00:00Z", changes: [add("src/orders/cancel.ts", simple("cancel") + simple("refund"))] },
    { type: "commit", message: "More notes", date: "2024-09-02T09:00:00Z", changes: [modify("NOTES.md", "More notes.\n")] },
  ];
  return GitFixture.build(steps);
}

const measures = (values: Partial<FolderMeasures>): FolderMeasures => ({ files: 1, codeLines: 10, functions: 1, cyclomatic: 1, maxCyclomatic: 1, aboveGuideline: 0, weight: 1, weightAbove: 0, meanCyclomatic: 1, shareAbove: 0, ...values });

describe("splitCheck", () => {
  test("flags a mean that fell while functions were added and the exported ones got shallower", () => {
    const check = splitCheck({ measures: measures({ functions: 4, meanCyclomatic: 9 }), depth: 30 }, { measures: measures({ functions: 12, meanCyclomatic: 3 }), depth: 12.5 });
    expect(check.flagged).toBe(true);
    expect(check.reasons[0]).toBe("the number of functions rose from 4 to 12 and mean interface depth fell from 30.00 to 12.50 while mean cyclomatic complexity fell");
  });

  test("does not flag a mean that rose, or one that fell with functions as deep as before", () => {
    expect(splitCheck({ measures: measures({ functions: 4, meanCyclomatic: 3 }), depth: 30 }, { measures: measures({ functions: 12, meanCyclomatic: 9 }), depth: 12 }).flagged).toBe(false);
    expect(splitCheck({ measures: measures({ functions: 4, meanCyclomatic: 9 }), depth: 30 }, { measures: measures({ functions: 12, meanCyclomatic: 3 }), depth: 30 }).flagged).toBe(false);
    expect(splitCheck({ measures: measures({ functions: 4, meanCyclomatic: 9 }), depth: null }, { measures: measures({ functions: 12, meanCyclomatic: 3 }), depth: 2 }).flagged).toBe(false);
  });
});

const Ajv2020 = Ajv2020Module.default;
const schema = JSON.parse(readFileSync(join(GOLDEN_DIR, "..", "..", "..", "..", "plugins", "complexity", "schemas", "report.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

interface TrendBlock {
  type: string;
  title?: string;
  labels?: string[];
  series?: { name: string; values: (number | null)[] }[];
  items?: { name: string; values: (number | null)[] }[];
  bars?: { label: string; from: number; to: number }[];
  rows?: Record<string, unknown>[];
  points?: { label: string; value: number }[];
  facts?: { label: string; value: string }[];
  text?: string;
}

describe("report trends", () => {
  let repo: GitFixture;
  let scratch: string;
  let document: { stamp: { inputs: { revisions: string[] } }; data: { header: { historyWindow: string; excluded: { what: string; count: number }[]; configHash: string }; sections: { id: string; blocks: TrendBlock[] }[]; limits: string[] }; slots: { id: string; verdicts: string[]; choose?: { candidates: { ref: string }[] } }[] };
  const run = (...args: string[]) => runComplexity(repo.path, ["report", "trends", ...args]);
  const block = (section: string, title: string) => document.data.sections.find((s) => s.id === section)!.blocks.find((b) => b.title === title)!;
  const values = (section: string, title: string, series = 0) => block(section, title).series![series]!.values;
  // The share of weight that price has once it is above the guideline, with `others` simple functions of three code lines beside it.
  const share = (branches: number, others: number) => {
    const price = weightOf(branches + 1, branches + 3);
    return Number(((price / (price + others * weightOf(1, 3))) * 100).toFixed(1));
  };

  beforeAll(async () => {
    repo = shopOverTime();
    scratch = mkdtempSync(join(tmpdir(), "report-trends-"));
    const { code, stdout, stderr } = await run("--samples", "6", "--slots");
    expect(stderr).toBe("");
    expect(code).toBe(ExitCode.Success);
    document = JSON.parse(stdout);
  }, 60_000);
  afterAll(() => {
    repo.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });

  test("--slots matches its schema and names the revisions it sampled", () => {
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
    // Six instants over ten months: the first is the commit from before any code file, which is left out.
    expect(document.stamp.inputs.revisions).toHaveLength(5);
    expect(document.stamp.inputs.revisions.at(-1)).toBe(repo.git("rev-parse", "HEAD"));
    expect(document.data.header.excluded).toEqual([{ what: "sampled revisions from before the first production code file", count: 1 }]);
    expect(document.data.header.historyWindow).toMatch(/^5 of 6 commits on the first-parent line were sampled, evenly over time from 2024-01-02 to 2024-09-02/);
  });

  test("the mean and the largest cyclomatic complexity follow the pricing function, and the tests are left out", () => {
    expect(block("repository", "Mean cyclomatic complexity of the repository").labels).toEqual(["2024-01-02", "2024-03-02", "2024-05-02", "2024-07-02", "2024-09-02"]);
    // price and place, then price alone gains branches, then two simple functions are added: (13 + 1 + 1 + 1) / 4.
    expect(values("repository", "Mean cyclomatic complexity of the repository")).toEqual([2.5, 5, 7, 4, 4]);
    // The test file's function has a cyclomatic complexity of 15 and is never the largest.
    expect(values("repository", "Largest cyclomatic complexity of one function")).toEqual([4, 9, 13, 13, 13]);
  });

  test("the percent above the guideline is 0 until a function crosses it, then the share of weight that function has", () => {
    const title = "Weighted complexity in functions above the guideline, for the repository";
    expect(values("repository", title)).toEqual([0, 0, share(12, 1), share(12, 3), share(12, 3)]);
    expect(values("repository", title)[2]).toBeGreaterThan(values("repository", title)[3] as number);
    const marker = document.data.sections[0]!.blocks.find((b) => b.type === "trend-marker") as unknown as { earlier: number; later: number; wording: Record<string, string> };
    expect(marker).toMatchObject({ earlier: 0, later: share(12, 3), wording: { stronger: "more concentrated", weaker: "less concentrated" } });
  });

  test("growth is indexed to the first sample, so complexity can be set against code lines", () => {
    const chart = block("repository", "Growth of complexity against code lines and functions");
    expect(chart.series!.map((s) => s.name)).toEqual(["total cyclomatic complexity", "code lines", "functions"]);
    const [complexity, lines, functions] = chart.series!.map((s) => s.values);
    expect(complexity![0]).toBe(100);
    expect(lines![0]).toBe(100);
    expect(functions!.at(-1)).toBe(200);
    expect(complexity!.at(-1) as number).toBeGreaterThan(lines!.at(-1) as number);
  });

  test("folders are listed below the folder that holds all the code, and add up to it", () => {
    const table = document.data.sections.find((s) => s.id === "folders")!.blocks.find((b) => b.type === "ranked-table")!;
    expect(table.rows!.map((row) => row.folder)).toEqual(["the repository (/)", "src", "src/billing", "src/orders"]);
    const of = (folder: string) => table.rows!.find((row) => row.folder === folder)!;
    expect((of("src/billing").linesLast as number) + (of("src/orders").linesLast as number)).toBe(of("src").linesLast);
    expect(of("src/billing")).toMatchObject({ files: 1, linesFirst: 6, linesLast: 15, functions: 1, meanFirst: 4, meanLast: 13, maxLast: 13, above: 1, shareFirst: 0, shareLast: 100, trend: "more concentrated" });
    expect(of("src/orders")).toMatchObject({ files: 2, linesFirst: 3, linesLast: 9, functions: 3, meanLast: 1, above: 0, shareLast: 0, trend: "no clear change" });
  });

  test("the grid, the chart of folders and the bars cover the folders, the one with the most code lines first", () => {
    expect(block("folders", "Folders by weighted complexity in functions above the guideline").items!.map((item) => item.name)).toEqual(["src/billing", "src/orders"]);
    expect(block("folders", "Weighted complexity in functions above the guideline, for the largest folders").series!.map((s) => s.name)).toEqual(["src/billing", "src/orders"]);
    expect(block("folders", "Change in code lines by folder").bars).toEqual([
      { label: "src/billing", from: 6, to: 15 },
      { label: "src/orders", from: 3, to: 9 },
    ]);
  });

  test("the gaming check draws the number of functions and mean interface depth over the same samples", () => {
    const gaming = document.data.sections.find((s) => s.id === "gaming")!.blocks.filter((b) => b.type === "sparkline");
    expect(gaming.map((b) => b.title)).toEqual(["Functions measured", "Mean interface depth"]);
    expect(gaming[0]!.points!.map((p) => p.value)).toEqual([2, 2, 2, 4, 4]);
    expect(gaming[1]!.points).toHaveLength(5);
    // The mean fell from the third sample to the fourth, but it rose from the first to the last, so nothing is flagged.
    expect(document.data.sections.find((s) => s.id === "gaming")!.blocks.some((b) => b.type === "notice")).toBe(false);
  });

  test("the limits state what the figures cannot show and cite no study", () => {
    expect(document.data.limits.some((limit) => limit.includes("was checked against what changes cost in this repository"))).toBe(true);
    expect(document.data.limits.join("\n")).not.toMatch(/SlopCodeBench|paper/);
  });

  test("the slots ask for the trend and for folders to look at", () => {
    expect(document.slots.map((slot) => slot.id)).toEqual(["trend", "folders"]);
    expect(document.slots[0]!.verdicts).toEqual(["less-concentrated", "no-clear-change", "more-concentrated"]);
    expect(document.slots[1]!.choose!.candidates.map((c) => c.ref)).toEqual(["src/billing", "src/orders"]);
  });

  test("renders html with the charts and their tables, and a markdown draft without notes", async () => {
    const notes = join(scratch, "notes.json");
    writeFileSync(notes, JSON.stringify({ stamp: document.stamp, notes: { trend: { verdict: "more-concentrated", text: "The pricing function crossed the guideline in May and holds most of the weighted complexity." }, folders: { items: [{ subject: "src/billing", verdict: "look", text: "Its one function went from 4 to 13." }] } } }));
    const html = await run("--samples", "6", "--notes", notes, "--format", "html");
    expect(html.stderr).toBe("");
    for (const kind of ["trend-chart", "trend-grid", "change-bars", "sparkline"]) expect(html.stdout).toContain(`<figure class="chart ${kind}">`);
    expect(html.stdout.match(/<svg/g)).toHaveLength(9);
    expect(html.stdout).toContain("Verdict: more-concentrated.");
    const text = html.stdout.replaceAll(document.data.header.configHash, GOLDEN_CONFIG_HASH).replaceAll(scratch, "SCRATCH");
    const file = join(GOLDEN_DIR, "_reports", "trends.html");
    if (process.env.UPDATE_GOLDEN === "1") {
      mkdirSync(join(GOLDEN_DIR, "_reports"), { recursive: true });
      writeFileSync(file, text);
    } else expect(text).toBe(readFileSync(file, "utf8"));

    const draft = await run("--samples", "6", "--format", "md");
    expect(draft.code).toBe(ExitCode.Success);
    expect(draft.stdout).toContain("# Size and complexity trends");
    expect(draft.stdout).toContain("_Judgement not yet written:");
  });

  test("--samples changes what is sampled and refuses a number out of range", async () => {
    const two = JSON.parse((await run("--samples", "2", "--slots")).stdout);
    expect(two.stamp.inputs.revisions).toEqual([repo.git("rev-parse", "HEAD")]);
    expect(two.data.sections[0].blocks.some((b: TrendBlock) => b.type === "notice" && /Only 1 revision was sampled/.test(b.text ?? ""))).toBe(true);
    for (const value of ["1", "61", "many"]) {
      const refused = await run("--samples", value, "--slots");
      expect(refused.code).toBe(ExitCode.Usage);
      expect(refused.stderr).toMatch(/--samples must be a whole number from 2 to 60/);
    }
    expect((await run("extra", "--slots")).code).toBe(ExitCode.Usage);
  });
});
