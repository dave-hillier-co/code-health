const FLOAT_PRECISION = 6;

/**
 * Deterministic JSON: object keys sorted recursively, floats rounded to a fixed
 * precision, two-space indent and a trailing newline.
 */
export function serialise(value: unknown): string {
  return JSON.stringify(normalise(value), null, 2) + "\n";
}

export function roundFloat(value: number): number {
  if (!Number.isFinite(value)) throw new Error(`cannot serialise non-finite number ${value}`);
  return Number(value.toFixed(FLOAT_PRECISION));
}

function normalise(value: unknown): unknown {
  if (typeof value === "number") return roundFloat(value);
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) sorted[key] = normalise(entry);
    }
    return sorted;
  }
  return value;
}
