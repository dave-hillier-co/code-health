import type { Rule } from "@code-health/cli-kit/run-cli";
import { treeDistance } from "@code-health/graph/tree-distance";
import { analysisCommand } from "../analysis-command.ts";
import { readSettings } from "../config.ts";
import { coupledPairs, integerOption } from "../coupled-pairs.ts";
import { focusPath } from "../focus-path.ts";
import { compareBytes, confidenceOf, degreeOf, reachesDegree, type PairCount } from "../coupling.ts";

export const name = "coupling";

/**
 * Confidence, in percent, at or above which one direction counts as high, and
 * at or below which the other counts as low, for `asymmetric-coupling`.
 */
export const ASYMMETRY = { high: 80, low: 30 } as const;

export const rules: Record<string, Rule> = {
  "distant-coupling": {
    summary: "Two files in far-apart folders change together often",
    explanation: [
      "Raised when a pair's degree, support and tree distance all reach the configured values",
      "(the guideline cochange.minDegree, the floor cochange.minSupport, the guideline cochange.minDistance), counted over eligible logical",
      "changes only: bulk changes above cochange.maxChangesetSize are left out.",
      "",
      "Handoff: a locality review. Should these files live together? If not, check for information",
      "leakage, where one design decision is encoded in both files. Coupling between a file and its",
      "sibling test is expected and has distance 0, so it is not raised.",
      "",
      "This is a prompt for investigation, not a verdict. Weak evidence makes it tentative.",
    ].join("\n"),
  },
  "asymmetric-coupling": {
    summary: "A change to one file usually drags the other along, but not the reverse",
    explanation: [
      `Raised when the confidence from one file to the other is at least ${ASYMMETRY.high} % and the`,
      `reverse is at most ${ASYMMETRY.low} %, on a pair that reaches the configured degree guideline and support floor.`,
      "The result names the file whose changes usually include the other as `dependent`.",
      "",
      "Handoff: that file depends on the other implicitly. Check for information leakage, or for",
      "temporal decomposition: code split by when it runs rather than by what it knows.",
      "",
      "This is a prompt for investigation, not a verdict. Weak evidence makes it tentative.",
    ].join("\n"),
  },
};

const round1 = (value: number) => Math.round(value * 10) / 10;

export const command = analysisCommand(name, {
  summary: "Pairs of files that change together, with degree, confidence both ways, support and distance",
  options: {
    file: { type: "string" },
    "min-degree": { type: "string" },
    "min-support": { type: "string" },
  },
  partial: ({ values }) =>
    values.file !== undefined || values["min-degree"] !== undefined || values["min-support"] !== undefined,
  async analyse({ context, history }) {
    const { settings } = history;
    const minDegree = integerOption(context, "min-degree", settings.minDegree, 0, 100);
    const minSupport = integerOption(context, "min-support", settings.minSupport, 1, Number.MAX_SAFE_INTEGER);

    // The degree is a guideline: no pair is dropped for being under it. The support floor is the only cut.
    const counts = coupledPairs(history, { minSupport });

    const requested = context.values.file;
    const focus = typeof requested === "string" ? await focusPath(context, history, requested) : undefined;

    const rows = counts.pairs
      .filter((pair) => focus === undefined || pair.a === focus || pair.b === focus)
      .map((pair) => describe(pair, focus, settings, minDegree))
      .sort((x, y) => Number(y.aboveGuideline) - Number(x.aboveGuideline) || y.score - x.score || compareBytes(x.path, y.path) || compareBytes(x.with, y.with));

    return {
      inputs: { file: focus ?? null, degreeGuideline: minDegree, minSupport, asymmetry: ASYMMETRY },
      results: rows,
      columns: ["path", "with", "degree", "aboveGuideline", "confidence", "reverseConfidence", "support", "distance", "findings"],
      extra: {
        population: { eligibleChanges: counts.eligibleChanges, oversizedExcluded: counts.oversizedChanges },
        note:
          rows.length === 0
            ? `No pair shares at least ${minSupport} changes. The support floor was not lowered; a young or sparse history has little coupling evidence.`
            : null,
      },
    };
  },
});

function describe(
  pair: PairCount,
  focus: string | undefined,
  settings: { minDegree: number; minSupport: number; minDistance: number },
  guideline: number,
) {
  // With --file the focused file leads, whichever way the pair sorts.
  const flipped = focus !== undefined && pair.b === focus;
  const [path, other] = flipped ? [pair.b, pair.a] : [pair.a, pair.b];
  const [changesPath, changesWith] = flipped ? [pair.changesB, pair.changesA] : [pair.changesA, pair.changesB];

  const confidence = confidenceOf(pair.support, changesPath);
  const reverseConfidence = confidenceOf(pair.support, changesWith);
  const degree = degreeOf(pair);
  const distance = treeDistance(path, other);

  // Findings are classified against the configured minimums, not the listing options,
  // so lowering --min-support to look at weaker pairs never promotes them to findings.
  const clearsMinimum = pair.support >= settings.minSupport;
  const strongEnough = clearsMinimum && degree >= settings.minDegree;
  const findings: string[] = [];
  if (strongEnough && distance >= settings.minDistance) findings.push("distant-coupling");

  let dependent: string | null = null;
  if (strongEnough) {
    if (confidence >= ASYMMETRY.high && reverseConfidence <= ASYMMETRY.low) dependent = path;
    else if (reverseConfidence >= ASYMMETRY.high && confidence <= ASYMMETRY.low) dependent = other;
  }
  if (dependent !== null) findings.push("asymmetric-coupling");

  return {
    path,
    with: other,
    score: round1(degree),
    degree: round1(degree),
    // The degree guideline orders the listing: pairs under it come after the others.
    aboveGuideline: reachesDegree(pair, guideline),
    confidence: round1(confidence),
    reverseConfidence: round1(reverseConfidence),
    support: pair.support,
    distance,
    findings,
    dependent,
    evidence: { support: pair.support, changesPath, changesWith, clearsMinimum },
  };
}
