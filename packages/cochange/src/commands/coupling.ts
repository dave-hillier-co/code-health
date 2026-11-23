import type { CommandContext, CommandOutput, Rule } from "@code-health/cli-kit/run-cli";
import { treeDistance } from "@code-health/graph/tree-distance";
import { isCodePath } from "@code-health/parse/code-files";
import { analysisCommand } from "../analysis-command.ts";
import type { Derived } from "../derived-results.ts";
import { loadHistory, type LoadedHistory } from "../history-access.ts";
import { readSettings } from "../config.ts";
import { coupledPairs, integerOption } from "../coupled-pairs.ts";
import { focusPath } from "../focus-path.ts";
import { pairIndex, pairTrend, type PairTrend } from "../coupling-trend.ts";
import { compareBytes, confidenceOf, countCoupling, degreeOf, reachesDegree, type PairCount } from "../coupling.ts";

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

/** The pairs are stored for each file focus, listing option and window the run states. */
export const derived: Derived = {
  command: name,
  stated: ({ values }) => ({ file: values.file, minDegree: values["min-degree"], minSupport: values["min-support"], trend: values.trend === true ? true : undefined }),
};

export const command = analysisCommand(name, {
  summary: "Pairs of files that change together, with degree, confidence both ways, support and distance",
  cache: derived,
  options: {
    file: { type: "string" },
    "min-degree": { type: "string" },
    "min-support": { type: "string" },
    trend: { type: "boolean" },
  },
  partial: ({ values }) =>
    values.file !== undefined || values["min-degree"] !== undefined || values["min-support"] !== undefined,
  analyse: ({ context, history }) => couplingOutput(context, history),
});

/** The complete result of the command for the focus and listing options the run states. */
export async function couplingOutput(context: CommandContext, history: LoadedHistory): Promise<CommandOutput> {
  const { settings } = history;
  const minDegree = integerOption(context, "min-degree", settings.minDegree, 0, 100);
  const minSupport = integerOption(context, "min-support", settings.minSupport, 1, Number.MAX_SAFE_INTEGER);

  // The degree is a guideline: no pair is dropped for being under it. The support floor is the only cut.
  const counts = coupledPairs(history, { minSupport });

  const languages = context.config.effective.languages;
  const requested = context.values.file;
  const focus = typeof requested === "string" ? await focusPath(context, history, requested) : undefined;

  const previous = context.values.trend === true ? await previousWindow(context, history) : undefined;
  const tolerance = settings.couplingTrendTolerance;

  const rows = counts.pairs
    .filter((pair) => focus === undefined || pair.a === focus || pair.b === focus)
    .map((pair) => describe(pair, focus, settings, minDegree, previous === undefined ? undefined : pairTrend(pair, previous.index, tolerance), (path) => (isCodePath(path, languages) ? "code" : "non-code")))
    .sort((x, y) => Number(y.aboveGuideline) - Number(x.aboveGuideline) || y.score - x.score || compareBytes(x.path, y.path) || compareBytes(x.with, y.with));

  return {
    inputs: {
      file: focus ?? null,
      degreeGuideline: minDegree,
      minSupport,
      asymmetry: ASYMMETRY,
      ...(context.values.trend === true ? { trend: { toleranceGuideline: tolerance } } : {}),
    },
    results: rows,
    columns: [
      "path", "pathKind", "with", "withKind", "degree", "aboveGuideline", "confidence", "reverseConfidence", "support", "distance",
      ...(context.values.trend === true ? ["trend", "degreeChange"] : []),
      "findings",
    ],
    extra: {
      population: { eligibleChanges: counts.eligibleChanges, oversizedExcluded: counts.oversizedChanges },
      ...(previous === undefined ? {} : { trendWindows: previous.windows }),
      note:
        rows.length === 0
          ? `No pair shares at least ${minSupport} changes. The support floor was not lowered; a young or sparse history has little coupling evidence.`
          : null,
    },
  };
}

function describe(
  pair: PairCount,
  focus: string | undefined,
  settings: { minDegree: number; minSupport: number; minDistance: number },
  guideline: number,
  trend: PairTrend | undefined,
  kindOf: (path: string) => "code" | "non-code",
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
    // Coupling includes files that are not code, such as a lockfile that changes with its manifest, and labels them.
    pathKind: kindOf(path),
    with: other,
    withKind: kindOf(other),
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
    ...(trend === undefined ? {} : trend),
    evidence: { support: pair.support, changesPath, changesWith, clearsMinimum },
  };
}

/**
 * The pairs of the window before the current one, of the same length and ending where the current one starts, read with the
 * same filters. Pairs are counted from one shared change, with no support floor, so a pair that was weak before has its real
 * earlier degree. `index` is undefined when that window holds no eligible change, and the trend is then null.
 */
async function previousWindow(context: CommandContext, history: LoadedHistory) {
  const { since, until } = history.window;
  const earlierSince = since - (until - since);
  const earlier = await loadHistory(context, { noRefresh: true, window: { since: earlierSince, until: since } });
  const counts = countCoupling(
    earlier.filtered.changes.map((change) => ({ files: change.files.map((file) => file.fileId), oversized: change.oversized })),
    { minSupport: 1 },
  );
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  return {
    index: counts.eligibleChanges === 0 ? undefined : pairIndex(counts.pairs),
    windows: { previous: { since: iso(earlierSince), until: iso(since), eligibleChanges: counts.eligibleChanges, oversizedExcluded: counts.oversizedChanges } },
  };
}
