import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { addAgreement, compareUnits, exactRate, noAgreement, spuriousRate, type AgreementCounts } from "@code-health/lexical/agreement";
import { recordedAgreement } from "@code-health/lexical/agreement-rates";
import { analyseSource, DEFAULT_AGREEMENT_BAR } from "@code-health/lexical/analyse-source";
import { analyseTree } from "../src/analyse-tree.ts";
import { treeFromDirectory } from "../src/source-tree.ts";

/**
 * The lexical agreement test (suite.md, Testing). The structural layer is ground truth: each corpus
 * file goes through both layers and lexical function blocks are matched to structural units by start
 * and end line. The counts are compared with the ones recorded in the repository.
 */
const fixtures = (path: string) => fileURLToPath(new URL(`../../../fixtures/${path}`, import.meta.url));
const ratesFile = fileURLToPath(new URL("../../lexical/src/agreement-rates.ts", import.meta.url));

/** Corpus directories per profile: the conformance fixtures, plus files with the awkward shapes. */
const corpora: Record<string, string[]> = {
  typescript: [fixtures("ts-adapter"), fixtures("lexical-agreement/typescript")],
};

async function measure(directories: string[]): Promise<AgreementCounts> {
  let total = noAgreement;
  for (const directory of directories) {
    const tree = await treeFromDirectory(directory);
    const analysis = await analyseTree(tree);
    for (const path of tree.files.keys()) {
      if (!/\.(?:[cm]?[jt]s|tsx)$/.test(path)) continue;
      const text = (await tree.read(path)) as string;
      const blocks = analyseSource(path, text).functions.blocks;
      total = addAgreement(total, compareUnits(analysis.units.filter((unit) => unit.path === path), blocks));
    }
  }
  return total;
}

function render(measured: Record<string, AgreementCounts>): string {
  const rows = Object.keys(measured)
    .sort()
    .map((name) => {
      const c = measured[name]!;
      return `  ${name}: { units: ${c.units}, found: ${c.found}, exact: ${c.exact}, blocks: ${c.blocks}, spurious: ${c.spurious} },`;
    });
  const source = [
    'import type { AgreementCounts } from "./agreement.ts";',
    "",
    "/**",
    " * Agreement of each lexer profile with the structural layer over the corpus in fixtures/lexical-agreement",
    " * and fixtures/ts-adapter. Written by the agreement test (run it with UPDATE_AGREEMENT=1 after a deliberate",
    " * change) and checked by it in CI, so a profile change cannot make the rates worse unnoticed.",
    " * Only profiles with a structural adapter appear here.",
    " */",
    "export const recordedAgreement: Record<string, AgreementCounts> = {",
    ...rows,
    "};",
    "",
  ];
  return source.join("\n");
}

test("lexical function blocks agree with the structural units at the recorded rates", async () => {
  const measured: Record<string, AgreementCounts> = {};
  for (const [name, directories] of Object.entries(corpora)) measured[name] = await measure(directories);

  if (process.env.UPDATE_AGREEMENT === "1") writeFileSync(ratesFile, render(measured));
  else {
    for (const name of Object.keys(measured)) {
      const recorded = recordedAgreement[name];
      expect(recorded, `no recorded agreement for ${name}; run with UPDATE_AGREEMENT=1`).toBeDefined();
      const now = measured[name]!;
      expect(
        now,
        `${name} agreement changed (exact ${exactRate(now)}, spurious ${spuriousRate(now)}); if deliberate, rerun with UPDATE_AGREEMENT=1 and commit`,
      ).toEqual(recorded);
    }
  }
});

test("the corpus is big enough for the rates to mean something", async () => {
  const counts = await measure(corpora.typescript!);
  expect(counts.units).toBeGreaterThanOrEqual(40);
  expect(counts.found).toBeLessThanOrEqual(counts.units);
});

test("TypeScript's recorded agreement clears the configured bar, so its per-function metrics are released", () => {
  // The bar is not lowered to fit a profile. If a change drops the rate below it, fix the profile.
  expect(DEFAULT_AGREEMENT_BAR).toBe(0.9);
  expect(exactRate(recordedAgreement.typescript!)).toBeGreaterThanOrEqual(DEFAULT_AGREEMENT_BAR);
});
