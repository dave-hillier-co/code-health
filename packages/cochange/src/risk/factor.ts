import type { BandResult, FactorBand } from "./scoring.ts";

/** A factor as it is reported: its value, band, the evidence behind it and the layer that produced it. */
export interface Factor {
  name: string;
  family: string;
  layer: string;
  /** `unavailable` when it could not be computed (never `low`), `disabled` when the repository switched it off. */
  status: "ok" | "unavailable" | "disabled";
  band: FactorBand | null;
  /** True when the factor counts towards the impact score. */
  scored: boolean;
  value: Record<string, unknown>;
  guidelines: BandResult["guidelines"];
  evidence: Record<string, unknown>[];
  source: string;
  reason: string | null;
}
