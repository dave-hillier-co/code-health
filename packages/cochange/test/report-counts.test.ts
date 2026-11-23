import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { GitFixture, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { contributorsText } from "../src/contributors.ts";
import { percentText, percentTextOfCounts } from "../src/percent-text.ts";
import { localityLeftOutNotice } from "../src/reports/overview.ts";
import { runCochange } from "./support/run.ts";

vi.setConfig({ testTimeout: 180_000 });

const alice: Identity = { name: "Alice", email: "alice@example.com" };
const claude: Identity = { name: "Claude", email: "noreply@anthropic.com" };

test("a share above 0 never prints as 0% and a share below 1 never prints as 100%", () => {
  expect(percentText(0.00023)).toBe("<0.1%");
  expect(percentText(0)).toBe("0%");
  expect(percentText(0.001)).toBe("0.1%");
  expect(percentText(0.125)).toBe("12.5%");
  expect(percentText(0.9999)).toBe(">99.9%");
  expect(percentText(1)).toBe("100%");
  expect(percentTextOfCounts(1, 4348)).toBe("<0.1%");
  expect(percentTextOfCounts(0, 0)).toBe("0%");
});

test("contributors are counted as people, plus agent identities when there are any", () => {
  expect(contributorsText({ people: 1, agents: 0 })).toBe("1 person");
  expect(contributorsText({ people: 2, agents: 1 })).toBe("2 people, plus 1 agent identity");
  expect(contributorsText({ people: 1, agents: 3 })).toBe("1 person, plus 3 agent identities");
});

test("the locality notice counts by recommendation over the whole stored result and counts gain 0 units apart", () => {
  const row = (recommendation: string, value: number) => ({ recommendation, ranking: { value } });
  const rows = [
    ...Array.from({ length: 452 }, () => row("review", 0)),
    ...Array.from({ length: 20 }, () => row("review", 5)),
    ...Array.from({ length: 24 }, () => row("split", 0)),
    ...Array.from({ length: 234 }, () => row("scrutinise", 10)),
    ...Array.from({ length: 4 }, () => row("blocked", 3)),
    ...Array.from({ length: 2 }, () => row("keep", 0)),
  ];
  const notice = localityLeftOutNotice(rows)!;
  expect(notice).toContain("476 units have a gain of 0 and are not listed here: 452 review, 24 split.");
  expect(notice).toContain("240 units are ranked by other measures and not listed here: 234 to scrutinise for high fan-in, 4 blocked, 2 to keep.");
  expect(localityLeftOutNotice([row("review", 5)])).toBeNull();
});

let scratch: string;
let repo: GitFixture;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "report-counts-"));
  // A changelog and two code files change together every week; the last commit is by an agent and
  // touches only the changelog and one code file, so the change report has a hot code file and a hot changelog.
  const steps: Step[] = [];
  const body = (name: string, v: number) => Array.from({ length: 9 }, (_, i) => `export const ${name}${i} = ${i};`).concat([`export const ${name} = ${v};`, ""]).join("\n");
  steps.push({
    type: "commit",
    message: "Start",
    date: "2024-01-01T09:00:00Z",
    author: alice,
    changes: [
      { op: "add", path: "CHANGELOG.md", content: "# 0\n" },
      { op: "add", path: "src/a.ts", content: body("a", 0) },
      { op: "add", path: "src/b.ts", content: body("b", 0) },
    ],
  });
  for (let n = 1; n <= 12; n++) {
    steps.push({
      type: "commit",
      message: `Change ${n}`,
      date: `2024-0${Math.min(5, 1 + Math.floor(n / 3))}-${String(1 + n).padStart(2, "0")}T09:00:00Z`,
      author: alice,
      changes: [
        { op: "modify", path: "CHANGELOG.md", content: `# ${n}\n` },
        { op: "modify", path: "src/a.ts", content: body("a", n) },
        ...(n % 4 === 0 ? [{ op: "modify" as const, path: "src/b.ts", content: body("b", n) }] : []),
      ],
    });
  }
  steps.push({
    type: "commit",
    message: "Agent edit",
    date: "2024-06-01T09:00:00Z",
    author: claude,
    changes: [
      { op: "modify", path: "CHANGELOG.md", content: "# agent\n" },
      { op: "modify", path: "src/a.ts", content: body("a", 99) },
    ],
  });
  repo = GitFixture.build(steps);
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { hotspotPercentile: 50 } }));
});
afterAll(() => {
  repo.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

/** The markdown draft of a report, whose judgement slots are marked not yet written. */
const md = async (args: string[]): Promise<string> => {
  const rendered = await runCochange(repo.path, ["report", ...args, "--format", "md"]);
  if (rendered.code !== 0) throw new Error(rendered.stderr);
  return rendered.stdout;
};

test("the overview counts people apart from agent identities", async () => {
  const out = await md(["overview"]);
  expect(out).toContain("Active contributors in the window | 1 person, plus 1 agent identity");
  expect(out).not.toContain("Active contributors in the window | 2");
});

test("the hotspots friction list names the denominator of the fix share", async () => {
  const out = await md(["hotspots"]);
  expect(out).toContain("Landed changes");
  expect(out).toContain("Fix share of landed changes (%)");
  expect(out).not.toContain("| Fix share (%)");
});

test("the change report lists only code files as hot files, counts the others, and always has an evidence line", async () => {
  const out = await md(["change", "HEAD~1..HEAD"]);
  const hot = out.slice(out.indexOf("## Hotspots touched"), out.indexOf("## Abandoned"));
  expect(hot).toContain("src/a.ts");
  expect(hot).not.toContain("CHANGELOG.md");
  expect(hot).toContain("Hot files left out because they are not code | 1");
  expect(hot).not.toMatch(/Share of the change's churn in hot files \| 0%/);
  const evidence = out.slice(out.indexOf("## Evidence behind the factors"));
  expect(evidence.split("\n").slice(0, 5).join("\n")).toMatch(/Evidence for|No factor has evidence items to list/);
});

test("the knowledge report states once that no file has lines held by people who have left", async () => {
  mkdirSync(join(repo.path, ".code-health"), { recursive: true });
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { hotspotPercentile: 50, knowledge: { enabled: true, trials: 50 } } }));
  const out = await md(["knowledge"]);
  const mentions = out.split("\n").filter((line) => /no lines held by people who have left|No file has lines held by people who have left/.test(line));
  expect(mentions).toHaveLength(1);
});
