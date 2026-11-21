import { usageError } from "@code-health/cli-kit/errors";
import type { Assessed } from "./assess.ts";
import type { Factor } from "./factor.ts";
import { FACTOR_DOCS, factorDoc, LEVEL_RULES } from "./factor-docs.ts";
import type { RiskSettings } from "./settings.ts";

/** `risk explain`: the rules behind the level, and what each factor is. No history is read. */
export function explainRules(risk: RiskSettings) {
  return {
    kind: "explain" as const,
    topic: "level",
    rules: LEVEL_RULES.map((rule) => ({ ...rule })),
    settings: {
      moderatePercentile: risk.moderatePercentile,
      highPercentile: risk.highPercentile,
      baselineChanges: risk.baselineChanges,
      minBaseline: risk.minBaseline,
      countModerate: risk.countModerate,
      countHigh: risk.countHigh,
      disabled: [...risk.disabled].sort(),
    },
    factors: FACTOR_DOCS.map(({ name, family, layer, banding, signal }) => ({ name, family, layer, banding, signal })),
  };
}

/**
 * `risk explain FACTOR`: the factor's definition and thresholds, and what drove it on the branch: its
 * value, band and the files behind it. Placement factors are defined here and computed by `risk`,
 * because placement is bounded by the privacy rules.
 */
export async function explainFactor(name: string, assess: () => Promise<Assessed>) {
  const doc = factorDoc(name);
  if (!doc) throw usageError(`unknown factor "${name}"; factors: ${FACTOR_DOCS.map((d) => d.name).join(", ")}`);
  let driven: Factor | null = null;
  if (doc.family !== "placement") {
    const assessed = await assess();
    driven = assessed.factors.find((factor) => factor.name === name) ?? null;
  }
  return { kind: "explain" as const, topic: name, doc: { ...doc }, branch: driven };
}
