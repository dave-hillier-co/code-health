import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GOLDEN_CONFIG_HASH } from "@code-health/fixtures/cli-testing";
import { GitFixture, type Change, type Step } from "@code-health/fixtures/git-fixture";
import { commonRoot, foldersBelow, withAncestors } from "@code-health/graph/folders";
import { sampleByTime, sampleLabels, type Commit } from "@code-health/history/trend-samples";
import { folderFigures } from "../src/folder-trends.ts";
import { GOLDEN_DIR } from "./support/golden.ts";
import { runLocality } from "./support/run.ts";

const edge = (from: string, to: string, weight: number, counted = true) => ({ from, to, weight, counted });

describe("folderFigures", () => {
  const production = ["src/main.ts", "src/a/one.ts", "src/a/deep/two.ts", "src/b/x.ts", "lib/y.ts"];
  const figures = folderFigures(production, [
    edge("src/a/one.ts", "src/b/x.ts", 2), // distance 2
    edge("src/a/deep/two.ts", "src/a/one.ts", 3), // distance 1
    edge("src/main.ts", "lib/y.ts", 1), // distance 2
    edge("src/b/x.ts", "lib/y.ts", 9, false), // from a file no entry point reaches
  ]);

  test("an edge belongs to its importing file's folder and to every folder above it, up to the repository", () => {
    expect(withAncestors("src/a/deep")).toEqual(["", "src", "src/a", "src/a/deep"]);
    expect(figures.get("src/a/deep")).toEqual({ files: 1, edges: 1, uses: 3, totalUseDistance: 3, meanDistancePerUse: 1 });
    expect(figures.get("src/a")).toEqual({ files: 2, edges: 2, uses: 5, totalUseDistance: 7, meanDistancePerUse: 1.4 });
    expect(figures.get("src")).toEqual({ files: 4, edges: 3, uses: 6, totalUseDistance: 9, meanDistancePerUse: 1.5 });
    expect(figures.get("")).toEqual({ files: 5, edges: 3, uses: 6, totalUseDistance: 9, meanDistancePerUse: 1.5 });
  });

  test("a folder with no counted edge has files and no mean", () => {
    expect(figures.get("src/b")).toEqual({ files: 1, edges: 0, uses: 0, totalUseDistance: 0, meanDistancePerUse: null });
    expect(figures.get("lib")).toMatchObject({ files: 1, meanDistancePerUse: null });
  });

  test("the folders of one level add up to the folder that holds them", () => {
    const sum = ["src", "lib"].reduce((total, folder) => total + figures.get(folder)!.totalUseDistance, 0);
    expect(sum).toBe(figures.get("")!.totalUseDistance);
  });

  test("the listing starts under the deepest folder that holds every production file", () => {
    expect(commonRoot(figures)).toBe("");
    const nested = folderFigures(["app/src/a/one.ts", "app/src/b/x.ts"], []);
    expect(commonRoot(nested)).toBe("app/src");
    expect(foldersBelow(nested, "app/src", 2)).toEqual(["app/src/a", "app/src/b"]);
    expect(foldersBelow(figures, "", 1)).toEqual(["lib", "src"]);
    expect(foldersBelow(figures, "", 2)).toEqual(["lib", "src", "src/a", "src/b"]);
    expect(commonRoot(folderFigures([], []))).toBe("");
  });
});

describe("sampleByTime", () => {
  const day = 86400;
  const line: Commit[] = [0, 1, 2, 10, 11, 30].map((d) => ({ sha: `c${d}`, date: d * day }));

  test("takes the last commit at or before each of the evenly spaced instants, the first and the last included", () => {
    // Instants at days 0, 10, 20 and 30: nothing landed between day 11 and day 30, so day 20 gives the commit of day 11.
    expect(sampleByTime(line, 4, 0).map((c) => c.sha)).toEqual(["c0", "c10", "c11", "c30"]);
  });

  test("two instants with no commit between them give one sample", () => {
    expect(sampleByTime(line, 7, 0).map((c) => c.sha)).toEqual(["c0", "c2", "c10", "c11", "c30"]);
  });

  test("starts at the window when the line is older than it, and always ends at the last commit", () => {
    expect(sampleByTime(line, 3, 9 * day).map((c) => c.sha)).toEqual(["c10", "c11", "c30"]);
    expect(sampleByTime(line, 3, 99 * day).map((c) => c.sha)).toEqual(["c30"]);
    expect(sampleByTime([], 3, 0)).toEqual([]);
  });

  test("samples are named by date, by date and time when dates repeat, and with the hash when minutes repeat", () => {
    expect(sampleLabels([{ sha: "a".repeat(40), date: 0 }, { sha: "b".repeat(40), date: day }])).toEqual(["1970-01-01", "1970-01-02"]);
    expect(sampleLabels([{ sha: "a".repeat(40), date: 0 }, { sha: "b".repeat(40), date: 3600 }])).toEqual(["1970-01-01 00:00", "1970-01-01 01:00"]);
    expect(sampleLabels([{ sha: "a".repeat(40), date: 0 }, { sha: "b".repeat(40), date: 20 }])).toEqual(["1970-01-01 00:00 aaaaaaa", "1970-01-01 00:00 bbbbbbb"]);
  });
});

const add = (path: string, content: string): Change => ({ op: "add", path, content });
const modify = (path: string, content: string): Change => ({ op: "modify", path, content });
const money = "export const format = (amount: number) => `${amount.toFixed(2)}`;\nexport const round = (amount: number) => Math.round(amount);\n";
const invoice = (from: string) => `import { format, round } from "${from}";\nexport const invoice = (amount: number) => format(round(amount));\n`;
const place = (from: string, tax: boolean) =>
  `import { format } from "${from}";\n${tax ? 'import { tax } from "./tax.ts";\n' : ""}export const place = (amount: number) => format(amount${tax ? " + tax(amount)" : ""});\n`;

/** A shop over eight months: orders starts using a distant helper, grows, and then the helper moves beside billing. */
function shopOverTime(): GitFixture {
  const steps: Step[] = [
    { type: "commit", message: "Add the notes", date: "2023-11-02T09:00:00Z", changes: [add("NOTES.md", "Notes.\n")] },
    {
      type: "commit",
      message: "Add the shop",
      date: "2024-01-02T09:00:00Z",
      changes: [
        add("code-health.json", JSON.stringify({ entryPoints: ["src/main.ts"] })),
        add("src/main.ts", 'import { invoice } from "./billing/invoice.ts";\nimport { place } from "./orders/place.ts";\nexport const run = () => [invoice(1), place(2)];\n'),
        add("src/billing/invoice.ts", invoice("../shared/utils/money.ts")),
        add("src/shared/utils/money.ts", money),
        add("src/orders/place.ts", "export const place = (amount: number) => `${amount}`;\n"),
      ],
    },
    { type: "commit", message: "Format orders", date: "2024-03-02T09:00:00Z", changes: [modify("src/orders/place.ts", place("../shared/utils/money.ts", false))] },
    { type: "commit", message: "Tax orders", date: "2024-05-02T09:00:00Z", changes: [add("src/orders/tax.ts", "export const tax = (amount: number) => amount * 0.2;\n"), modify("src/orders/place.ts", place("../shared/utils/money.ts", true))] },
    {
      type: "commit",
      message: "Move money beside billing",
      date: "2024-07-02T09:00:00Z",
      changes: [{ op: "rename", from: "src/shared/utils/money.ts", path: "src/billing/money.ts" }, modify("src/billing/invoice.ts", invoice("./money.ts")), modify("src/orders/place.ts", place("../billing/money.ts", true))],
    },
    { type: "commit", message: "More notes", date: "2024-09-02T09:00:00Z", changes: [modify("NOTES.md", "More notes.\n")] },
  ];
  return GitFixture.build(steps);
}

const Ajv2020 = Ajv2020Module.default;
const schema = JSON.parse(readFileSync(join(GOLDEN_DIR, "..", "..", "..", "..", "plugins", "locality", "schemas", "report.schema.json"), "utf8"));
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
  const run = (...args: string[]) => runLocality(repo.path, ["report", "trends", ...args]);
  const block = (section: string, title: string) => document.data.sections.find((s) => s.id === section)!.blocks.find((b) => b.title === title)!;

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
    // Six instants over ten months: the first is the commit from before any production file, which is left out.
    expect(document.stamp.inputs.revisions).toHaveLength(5);
    expect(document.stamp.inputs.revisions.at(-1)).toBe(repo.git("rev-parse", "HEAD"));
    expect(document.data.header.excluded).toEqual([{ what: "sampled revisions from before the first production file", count: 1 }]);
    expect(document.data.header.historyWindow).toMatch(/^5 of 6 commits on the first-parent line were sampled, evenly over time from 2024-01-02 to 2024-09-02/);
  });

  test("the repository's mean distance per use follows the helper: further when orders uses it, closer after it moves", () => {
    const chart = block("repository", "Mean distance per use of the repository");
    expect(chart.labels).toEqual(["2024-01-02", "2024-03-02", "2024-05-02", "2024-07-02", "2024-09-02"]);
    const values = chart.series![0]!.values as number[];
    // invoice uses the helper twice at distance 3, main uses invoice and place at distance 1: (6 + 2) / 4.
    expect(values[0]).toBe(2);
    expect(values[1]).toBeGreaterThan(values[0]!);
    expect(values[3]).toBeLessThan(values[2]!);
    expect(values[4]).toBe(values[3]);
    const marker = document.data.sections[0]!.blocks.find((b) => b.type === "trend-marker") as unknown as { earlier: number; later: number; wording: Record<string, string> };
    expect(marker).toMatchObject({ earlier: 2, later: values[4], wording: { weaker: "closer", stronger: "further apart" } });
  });

  test("growth is indexed to the first sample, so distance can be set against uses", () => {
    const chart = block("repository", "Growth of import distance against uses and files");
    expect(chart.series!.map((s) => s.name)).toEqual(["total import distance", "uses", "production files"]);
    for (const series of chart.series!) expect(series.values[0]).toBe(100);
    const [distance, uses] = chart.series!.map((s) => s.values.at(-1) as number);
    expect(distance).toBeLessThan(uses!);
  });

  test("folders are listed below the folder that holds all the code, and add up to it", () => {
    const table = document.data.sections.find((s) => s.id === "folders")!.blocks.find((b) => b.type === "ranked-table")!;
    expect(table.rows!.map((row) => row.folder)).toEqual(["the repository (/)", "src", "src/billing", "src/orders"]);
    const total = (folder: string) => table.rows!.find((row) => row.folder === folder)!.totalLast as number;
    // main.ts sits in src itself, so src holds its own edges as well as its folders'.
    expect(total("src")).toBe(total("the repository (/)"));
    expect(total("src/billing") + total("src/orders")).toBeLessThanOrEqual(total("src"));
    expect(table.rows!.find((row) => row.folder === "src/billing")).toMatchObject({ meanFirst: 3, meanLast: 0, trend: "closer" });
  });

  test("the grid, the chart of folders and the bars cover the folders with uses", () => {
    // Both folders have two uses at the last sample, so they are in path order.
    expect(block("folders", "Folders by mean distance per use").items!.map((item) => item.name)).toEqual(["src/billing", "src/orders"]);
    expect(block("folders", "Mean distance per use of the largest folders").series!.map((s) => s.name)).toEqual(["src/billing", "src/orders"]);
    const orders = block("folders", "Folders by mean distance per use").items![1]!.values;
    // Orders has no use at the first sample, so its line starts at the second.
    expect(orders[0]).toBeNull();
    expect(orders[1]).toBe(3);
    expect(block("folders", "Change in total import distance by folder").bars).toEqual([
      { label: "src/billing", from: 6, to: 0 },
      { label: "src/orders", from: 0, to: 2 },
    ]);
  });

  test("the gaming check's figures are drawn over the same samples", () => {
    const gaming = document.data.sections.find((s) => s.id === "gaming")!.blocks.filter((b) => b.type === "sparkline");
    expect(gaming.map((b) => b.title)).toEqual(["Folders holding a single production file", "Maximum folder depth"]);
    expect(gaming[1]!.points!.map((p) => p.value)).toEqual([3, 3, 3, 2, 2]);
    expect(document.data.sections.find((s) => s.id === "gaming")!.blocks.some((b) => b.type === "notice")).toBe(false);
  });

  test("the slots ask for the trend and for folders to look at", () => {
    expect(document.slots.map((slot) => slot.id)).toEqual(["trend", "folders"]);
    expect(document.slots[0]!.verdicts).toEqual(["closer", "no-clear-change", "further-apart"]);
    expect(document.slots[1]!.choose!.candidates.map((c) => c.ref)).toEqual(["src/billing", "src/orders"]);
  });

  test("renders html with the charts and their tables, and a markdown draft without notes", async () => {
    const notes = join(scratch, "notes.json");
    writeFileSync(notes, JSON.stringify({ stamp: document.stamp, notes: { trend: { verdict: "closer", text: "Mean distance per use went from 2 to 0.83." }, folders: { items: [{ subject: "src/orders", verdict: "expected-growth", text: "Orders grew by one use of the money helper." }] } } }));
    const html = await run("--samples", "6", "--notes", notes, "--format", "html");
    expect(html.stderr).toBe("");
    for (const kind of ["trend-chart", "trend-grid", "change-bars", "sparkline"]) expect(html.stdout).toContain(`<figure class="chart ${kind}">`);
    expect(html.stdout.match(/<svg/g)).toHaveLength(7);
    expect(html.stdout).toContain("Verdict: closer.");
    const text = html.stdout.replaceAll(document.data.header.configHash, GOLDEN_CONFIG_HASH).replaceAll(scratch, "SCRATCH");
    const file = join(GOLDEN_DIR, "_reports", "trends.html");
    if (process.env.UPDATE_GOLDEN === "1") {
      mkdirSync(join(GOLDEN_DIR, "_reports"), { recursive: true });
      writeFileSync(file, text);
    } else expect(text).toBe(readFileSync(file, "utf8"));

    const draft = await run("--samples", "6", "--format", "md");
    expect(draft.code).toBe(ExitCode.Success);
    expect(draft.stdout).toContain("# Import distance trends");
    expect(draft.stdout).toContain("_Judgement not yet written:");
    expect(draft.stdout).toContain("| src/billing | 2024-01-02 | 3 | 0 | -3 | closer |");
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
