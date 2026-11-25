import { midRankPercentiles } from "@code-health/cli-kit/ranking";
import type { CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { readBlame } from "@code-health/history/blame-read";
import { analyseIdentities } from "../identities/analysis.ts";
import { isCodePath } from "@code-health/parse/code-files";
import { testClassifier } from "@code-health/parse/test-files";
import { loadComplexity, type FileComplexity } from "../complexity-source.ts";
import { rankHotspots, type HotspotRow } from "../hotspot-ranking.ts";
import { blameOptions } from "./load.ts";
import { classifyPatterns, summarisePatterns, type ComplexityStanding, type FileKind, type PatternFile, type PatternGuidelines, type PatternSummary } from "./patterns.ts";
import { commonExtra, commonInputs, prepare, type Prepared } from "./prepare.ts";
import { weightsOf, type HotspotWeight } from "./ranking.ts";

export interface MeasuredPatterns {
  files: PatternFile[];
  summary: PatternSummary;
  guidelines: PatternGuidelines;
  /** The hotspot ranking the patterns were judged against, every file. */
  hotspotRows: HotspotRow[];
  weights: Map<string, HotspotWeight>;
  /** Where the complexity came from: a stored complexity report for this commit, or the indentation proxy. */
  complexity: FileComplexity;
}

export const guidelinesOf = (settings: PatternGuidelines): PatternGuidelines => ({
  singleOwnerShare: settings.singleOwnerShare,
  formerContributorShare: settings.formerContributorShare,
  complexityPercentile: settings.complexityPercentile,
  manyActiveAuthors: settings.manyActiveAuthors,
  meaningfulShare: settings.meaningfulShare,
  inconclusiveShare: settings.inconclusiveShare,
  busFactorShare: settings.busFactorShare,
});

/** The rank percentile of each file's complexity among the files that have one. */
function complexityStandings(values: ReadonlyMap<string, number | null>): Map<string, ComplexityStanding> {
  const scored = [...values].flatMap(([path, value]) => (value === null ? [] : [{ path, value }]));
  const percentiles = midRankPercentiles(scored.map((row) => row.value));
  return new Map(scored.map((row, i) => [row.path, { value: row.value, percentile: percentiles[i]! }]));
}

/**
 * Classifies every file with a blame into knowledge-risk patterns. Hotspot standing and complexity come from the
 * same ranking `hotspots` uses, and an identity the mapping has not settled counts as unreliable authorship.
 */
export async function measurePatterns(context: CommandContext, p: Prepared): Promise<MeasuredPatterns> {
  const { model } = p.knowledge;
  const { rows } = await rankHotspots(context, p.history, "file");
  const weights = weightsOf(rows);
  const identities = await analyseIdentities(context, { noRefresh: true });
  const snapshot = await readBlame(context.repo.root, { ref: p.history.view.headSha, ...blameOptions(p.history, p.settings) });
  const known = new Set([...model.files.map((f) => f.path), ...model.missing]);
  const botOnly = [...snapshot.files.keys()].filter((path) => !known.has(path));
  const guidelines = guidelinesOf(p.settings);
  // Complexity is read for every production code file with a blame, as of the analysed commit and not of the analysis window: code nobody has changed lately is the code that most needs it.
  const isTest = testClassifier(context.config.effective.testPatterns);
  const languages = context.config.effective.languages;
  const kindOf = (path: string): FileKind => (isTest(path) ? "test" : isCodePath(path, languages) ? "code" : "other");
  const codePaths = [...model.files.map((f) => f.path), ...botOnly].filter((path) => kindOf(path) === "code");
  const complexity = await loadComplexity(context, p.history.view.headSha, codePaths);
  const files = classifyPatterns({ model, guidelines, hotspots: weights, complexity: complexityStandings(complexity.values), unmapped: identities.unresolved, botOnly, kindOf });
  return { files, summary: summarisePatterns(files), guidelines, hotspotRows: rows, weights, complexity };
}

/** `abandonment patterns`: every file with a blame, labelled with its knowledge-risk pattern and the numbers behind it, and no names. */
export async function patternsCommand(context: CommandContext): Promise<CommandOutput> {
  const p = await prepare(context);
  const measured = await measurePatterns(context, p);
  return {
    inputs: commonInputs(p, "patterns", { guidelines: measured.guidelines, complexityReport: measured.complexity.input }),
    extra: commonExtra(p, { summary: measured.summary, complexitySource: measured.complexity.source }),
    notices: p.notices,
    results: measured.files,
    presorted: true,
    columns: ["path", "kind", "pattern", "hotspot", "hotspotPercentile", "complexity", "peopleLines", "activeAuthors", "formerAuthors", "topActiveShare", "formerShare", "meaningfulAuthors", "busFactor", "patterns"],
  };
}
