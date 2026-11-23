const FLOAT_PRECISION = 6;

/**
 * A copy of a JSON value with keys sorted recursively and floats rounded to six places, the form the suite
 * prints. Stamps go through it, so a stamp read back from a notes file equals the one a run computes.
 */
export function normalise<T>(value: T): T {
  return normaliseValue(value) as T;
}

function normaliseValue(value: unknown): unknown {
  if (typeof value === "number") return Number(value.toFixed(FLOAT_PRECISION));
  if (Array.isArray(value)) return value.map(normaliseValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) if (record[key] !== undefined) sorted[key] = normaliseValue(record[key]);
    return sorted;
  }
  return value;
}

/** The JSON of a value after `normalise`, one line, so two values that differ only in key order are the same string. */
export function canonical(value: unknown): string {
  return JSON.stringify(normaliseValue(value)) ?? "null";
}
