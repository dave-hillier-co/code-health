import { formatNumber } from "../text.ts";

export const BAND_COUNT = 5;

export interface BandRange {
  /** 1 to 5, the number printed beside a value. */
  band: number;
  from: number;
  to: number;
}

export interface Bands {
  ranges: BandRange[];
  of(value: number): number;
}

/**
 * Five bands for colouring values. With `breaks` (four ascending values) band n holds the values from the
 * (n-1)th break up to the nth. Without them the range from the least value to the greatest splits into five
 * equal steps. A band is a step on a scale and says nothing about good or bad.
 */
export function makeBands(values: readonly number[], breaks?: readonly number[]): Bands {
  if (breaks !== undefined && breaks.length === BAND_COUNT - 1) {
    const edges = [...breaks];
    const least = Math.min(...values, edges[0] ?? 0);
    const greatest = Math.max(...values, edges[edges.length - 1] ?? 0);
    const lower = [least, ...edges];
    const upper = [...edges, greatest];
    return {
      ranges: lower.map((from, i) => ({ band: i + 1, from, to: upper[i] ?? greatest })),
      of: (value) => 1 + edges.filter((edge) => edge <= value).length,
    };
  }
  const least = values.length === 0 ? 0 : Math.min(...values);
  const greatest = values.length === 0 ? 0 : Math.max(...values);
  const step = (greatest - least) / BAND_COUNT;
  return {
    ranges: Array.from({ length: BAND_COUNT }, (_, i) => ({ band: i + 1, from: least + i * step, to: i === BAND_COUNT - 1 ? greatest : least + (i + 1) * step })),
    of: (value) => (step === 0 ? 1 : Math.min(BAND_COUNT, 1 + Math.floor((value - least) / step))),
  };
}

/** The legend of a banded scale as plain text: `band 1 0 to 10, band 2 10 to 20`. */
export function bandLegend(bands: Bands): string {
  return bands.ranges.map((r) => `band ${r.band}: ${formatNumber(r.from)} to ${formatNumber(r.to)}`).join(", ");
}
