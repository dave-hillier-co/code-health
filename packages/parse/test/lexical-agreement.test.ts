import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { corpusDirectories, expectedMisses, languageDirectory } from "@code-health/fixtures/language-conformance";
import { addAgreement, compareUnits, exactRate, noAgreement, spuriousRate, type AgreementCounts } from "@code-health/lexical/agreement";
import { recordedAgreement } from "@code-health/lexical/agreement-rates";
import { analyseSource, DEFAULT_AGREEMENT_BAR } from "@code-health/lexical/analyse-source";
import { profiles } from "@code-health/lexical/profile";
import { isFunctionUnit } from "@code-health/lexical/unit";
import { analyseTree } from "../src/analyse-tree.ts";
import type { LanguageAdapter } from "../src/language-adapter.ts";
import { overrideSupportedAdapters, registeredAdapters } from "../src/languages.ts";
import { treeFromDirectory } from "../src/source-tree.ts";

/**
 * The lexical agreement test (CONTRIBUTING.md, Conformance), for every lexer profile that has a structural adapter. The
 * structural layer is ground truth: each corpus file goes through both layers and lexical function blocks are
 * matched to structural units by start and end line. The corpus of a profile is the `adapter`, `metrics` and
 * `agreement` fixtures of every adapter that uses it. The counts are compared with the ones recorded in the
 * repository, `packages/lexical/src/agreement-rates/<profile>.ts`, so a profile change cannot make them worse unnoticed.
 */
const lexicalSource = fileURLToPath(new URL("../../lexical/src/", import.meta.url));

/** The adapters of each profile, in id order. */
const byProfile = new Map<string, LanguageAdapter[]>();
for (const adapter of registeredAdapters) byProfile.set(adapter.lexerProfile, [...(byProfile.get(adapter.lexerProfile) ?? []), adapter]);
const profileNames = [...byProfile.keys()].sort();

interface Corpus {
  /** Where the file lives, as `area/path` relative to the language folder, for naming a miss. */
  label: string;
  directory: string;
  adapter: LanguageAdapter;
}

function corpusOf(profile: string): Corpus[] {
  return byProfile.get(profile)!.flatMap((adapter) =>
    corpusDirectories(adapter.id).map((directory) => ({ label: directory.slice(languageDirectory(adapter.id).length).replace(/\/$/, ""), directory, adapter })),
  );
}

/** Runs `body` over every file of the corpus that its adapter claims, with the units of the structural layer. */
async function eachFile(profile: string, body: (file: { corpus: Corpus; path: string; text: string; units: Awaited<ReturnType<typeof analyseTree>>["units"] }) => void): Promise<void> {
  for (const corpus of corpusOf(profile)) {
    overrideSupportedAdapters([corpus.adapter]);
    const tree = await treeFromDirectory(corpus.directory);
    const analysis = await analyseTree(tree).finally(() => overrideSupportedAdapters(undefined));
    for (const path of tree.files.keys()) {
      if (!corpus.adapter.grammars.some((binding) => binding.extensions.some((extension) => path.endsWith(extension)))) continue;
      body({ corpus, path, text: (await tree.read(path)) as string, units: analysis.units.filter((unit) => unit.path === path) });
    }
  }
}

interface Measured {
  counts: AgreementCounts;
  /** The structural function units that no lexical block overlaps, as `area/path#name`, so a miss is named and not just counted. */
  missed: string[];
}

const measured = new Map<string, Promise<Measured>>();

/** Both layers over the corpus of a profile, once: parsing every fixture is the cost, and every check of a profile reads the same pass. */
function measure(profile: string): Promise<Measured> {
  const known = measured.get(profile);
  if (known !== undefined) return known;
  const pass = (async (): Promise<Measured> => {
    let counts = noAgreement;
    const missed: string[] = [];
    await eachFile(profile, ({ corpus, path, text, units }) => {
      const blocks = analyseSource(path, text).functions.blocks;
      counts = addAgreement(counts, compareUnits(units, blocks));
      for (const unit of units.filter(isFunctionUnit)) {
        if (!blocks.some((block) => unit.startLine <= block.endLine && block.startLine <= unit.endLine)) missed.push(`${corpus.label}/${path}#${unit.qualifiedName}`);
      }
    });
    return { counts, missed: missed.sort() };
  })();
  measured.set(profile, pass);
  return pass;
}

function render(profile: string, counts: AgreementCounts): string {
  return [
    'import type { AgreementCounts } from "../agreement.ts";',
    "",
    "/**",
    ` * Agreement of the ${profile} lexer profile with the structural layer over the corpus of every adapter that uses it`,
    " * (fixtures/languages/<id>/adapter, metrics and agreement). Written by the agreement test: run it with",
    " * UPDATE_AGREEMENT=1 after a deliberate change. Checked by it in CI, so a profile change cannot make the rates worse unnoticed.",
    " */",
    `export const recorded: AgreementCounts = { units: ${counts.units}, found: ${counts.found}, exact: ${counts.exact}, blocks: ${counts.blocks}, spurious: ${counts.spurious} };`,
    "",
  ].join("\n");
}

/** Writes agreement-rates/<profile>.ts and, when the profile is new, its one registration line. */
function record(profile: string, counts: AgreementCounts): void {
  writeFileSync(`${lexicalSource}agreement-rates/${profile}.ts`, render(profile, counts));
  const registry = `${lexicalSource}recorded-agreement.ts`;
  const line = `export { recorded as ${profile} } from "./agreement-rates/${profile}.ts";`;
  if (!readFileSync(registry, "utf8").includes(line)) appendFileSync(registry, `${line}\n`);
}

/** The most lexical blocks that may match no structural function: a regenerated record cannot make the lexer noisier than this. */
const MAX_SPURIOUS_RATE = 0.1;
/** Fewer structural function units than this and a rate says little. */
const MIN_CORPUS_UNITS = 40;

beforeAll(() => overrideSupportedAdapters(undefined));
afterAll(() => overrideSupportedAdapters(undefined));

describe("lexer profiles", () => {
  it("exist for every adapter", () => {
    for (const adapter of registeredAdapters) expect(Object.keys(profiles), adapter.id).toContain(adapter.lexerProfile);
  });

  it("have a recorded rate only when an adapter uses them", () => {
    expect(Object.keys(recordedAgreement).sort().filter((profile) => !byProfile.has(profile))).toEqual([]);
  });
});

describe.each(profileNames)("%s", (profile) => {
  it("agrees with the structural units at the recorded rate", async () => {
    const now = (await measure(profile)).counts;
    if (process.env.UPDATE_AGREEMENT === "1") {
      // Recording the rates is a deliberate local act. Run in CI it would rewrite the file and pass with nothing checked.
      expect(process.env.CI, "UPDATE_AGREEMENT=1 must not be set in CI").toBeUndefined();
      record(profile, now);
      return;
    }
    const recorded = recordedAgreement[profile];
    expect(recorded, `no recorded agreement for ${profile}; run with UPDATE_AGREEMENT=1`).toBeDefined();
    expect(now, `${profile} agreement changed (exact ${exactRate(now)}, spurious ${spuriousRate(now)}); if deliberate, rerun with UPDATE_AGREEMENT=1 and commit`).toEqual(recorded);
  });

  it("has a recorded and a measured rate of spurious blocks within the ceiling", async () => {
    expect(spuriousRate(recordedAgreement[profile] ?? noAgreement), `${profile} recorded spurious rate`).toBeLessThanOrEqual(MAX_SPURIOUS_RATE);
    expect(spuriousRate((await measure(profile)).counts), `${profile} measured spurious rate`).toBeLessThanOrEqual(MAX_SPURIOUS_RATE);
  });

  it("misses the units known to be missed, so a new miss is a failure that names the unit", async () => {
    const expected = byProfile.get(profile)!.flatMap((adapter) => expectedMisses(adapter.id).map((miss) => miss)).sort();
    expect((await measure(profile)).missed).toEqual(expected);
  });

  it("has a corpus big enough for the rates to mean something", async () => {
    const { counts } = await measure(profile);
    expect(counts.units).toBeGreaterThanOrEqual(MIN_CORPUS_UNITS);
    expect(counts.found).toBeLessThanOrEqual(counts.units);
  });

  it("clears the configured bar for every supported adapter, so per-function metrics are released", () => {
    // The bar is not lowered to fit a profile. If a change drops the rate below it, fix the profile.
    expect(DEFAULT_AGREEMENT_BAR).toBe(0.9);
    if (byProfile.get(profile)!.some((adapter) => adapter.support === "supported")) {
      expect(exactRate(recordedAgreement[profile] ?? noAgreement)).toBeGreaterThanOrEqual(DEFAULT_AGREEMENT_BAR);
    }
  });
});
