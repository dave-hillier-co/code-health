import { afterAll, beforeAll, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { riskHistory } from "./support/risk-scenario.ts";
import { runCochange } from "./support/run.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = riskHistory();
}, 60_000);
afterAll(() => repo.dispose());

const page = async (range: string, ...args: string[]) => (await runCochange(repo.path, ["report", "change", range, "--format", "md", ...args])).stdout;
const footprint = (md: string) => md.slice(md.indexOf("## The change"), md.indexOf("## Reviewer guidance"));
const missingSection = (md: string) => md.slice(md.indexOf("## Missing co-change partners"), md.indexOf("## Complexity before and after"));

test("the footprint marks each missing partner at the file it usually changes with, matching the missing partners section", async () => {
  const md = await page("main..missing");
  const part = footprint(md);
  expect(part).toContain("**Change footprint");
  expect(part.match(/\| a usual partner of the row file that the change left out/g)).toHaveLength(2);
  expect(missingSection(md)).toContain("src/billing/tax.ts");
  expect(missingSection(md).match(/^\| \d+ \|/gm)).toHaveLength(2);
  expect(part).toContain("! is a usual partner of the row file that the change left out");
  expect(md.indexOf("**Change footprint")).toBeLessThan(md.indexOf("## Reviewer guidance"));
});

test("a pair inside the change is marked as in the change, and no partner is missing", async () => {
  const part = footprint(await page("main..complete"));
  expect(part).toContain("+ is a usual partner of the row file that the change also changed");
  expect(part).not.toContain("left out, as listed");
});

test("a change whose files have no usual partner prints the notice line instead of a grid", async () => {
  const part = footprint(await page("main..bulk"));
  expect(part).toContain("Change footprint: no changed file has a usual co-change partner");
  expect(part).not.toContain("**Change footprint");
});

test("the compact form leaves the footprint out", async () => {
  expect(await page("main..missing", "--compact")).not.toContain("Change footprint");
});
