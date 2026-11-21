/**
 * A half-open UTC window between two explicit dates. There is deliberately no
 * default and no relative form ("last 30 days"): the wall clock never enters a
 * measurement, so a baseline and its comparison are always reproducible.
 */
export interface TimeWindow {
  /** First day included, YYYY-MM-DD. */
  from: string;
  /** First day excluded, YYYY-MM-DD. */
  to: string;
  fromMs: number;
  toMs: number;
}

function dateToMs(value: string, label: string): number {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00.000Z`) : Number.NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a calendar date in YYYY-MM-DD form, got "${value}"`);
  }
  return ms;
}

export function parseWindow(from: string, to: string): TimeWindow {
  const fromMs = dateToMs(from, "window start");
  const toMs = dateToMs(to, "window end");
  if (toMs <= fromMs) throw new Error(`window end ${to} must be after window start ${from}`);
  return { from, to, fromMs, toMs };
}

export function inWindow(window: TimeWindow, timestamp: string): boolean {
  const ms = Date.parse(timestamp);
  return !Number.isNaN(ms) && ms >= window.fromMs && ms < window.toMs;
}
