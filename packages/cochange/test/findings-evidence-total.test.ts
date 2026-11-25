import { expect, test } from "vitest";
import type { Assessed } from "../src/risk/assess.ts";
import type { Factor } from "../src/risk/factor.ts";
import { findingsOf } from "../src/risk/findings.ts";

const pairs = Array.from({ length: 5 }, (_, i) => ({ a: `src/a${i}.ts`, b: `lib/b${i}.ts` }));

const novel = (evidenceTotal: number | undefined): Factor => ({
  name: "novel-coupling",
  family: "coupling",
  layer: "history",
  status: "ok",
  band: "high",
  scored: true,
  value: { count: 3168 },
  guidelines: {},
  evidence: pairs,
  ...(evidenceTotal === undefined ? {} : { evidenceTotal }),
  source: "test",
  reason: null,
});

const assessed = (factor: Factor) =>
  ({ factors: [factor], history: { evidence: { usableHistoryMonths: 12 }, settings: { maxChangesetSize: 30 } } }) as unknown as Assessed;

test("a finding carries how many evidence records its factor had before the list was cut", () => {
  const [finding] = findingsOf(assessed(novel(3168)), null);
  expect(finding!.id).toBe("novel-coupling");
  expect(finding!.evidence).toHaveLength(5);
  expect(finding!.evidenceTotal).toBe(3168);
});

test("a finding of an uncut factor has no evidenceTotal", () => {
  const [finding] = findingsOf(assessed(novel(undefined)), null);
  expect(finding!.evidenceTotal).toBeUndefined();
});
