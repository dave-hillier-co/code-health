import { usageError } from "@code-health/cli-kit/errors";
import type { Assessed } from "./assess.ts";
import type { Factor } from "./factor.ts";
import { FACTOR_DOCS, factorDoc, LEVEL_RULES, type FactorDoc } from "./factor-docs.ts";
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

/** `risk explain FACTOR` with no change named: the factor's definition and guidelines. No history is read. */
export function staticFactor(name: string): { kind: "explain"; topic: string; doc: FactorDoc; branch: Factor | null } {
  const doc = factorDoc(name);
  if (!doc) throw usageError(`unknown factor "${name}"; factors: ${FACTOR_DOCS.map((d) => d.name).join(", ")}`);
  return { kind: "explain", topic: name, doc: { ...doc }, branch: null };
}

/**
 * `risk explain FACTOR BASE[..HEAD]`: the factor's definition and guidelines, and what drove it on that change: its
 * value, band and the files behind it. Placement factors are defined here and computed by `risk`, because placement
 * is bounded by the privacy rules.
 */
export async function explainFactor(name: string, assess: () => Promise<Assessed>) {
  const explained = staticFactor(name);
  if (explained.doc.family === "placement") return explained;
  const assessed = await assess();
  return { ...explained, branch: assessed.factors.find((factor) => factor.name === name) ?? null };
}
