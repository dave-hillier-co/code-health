import { monthsBefore } from "@code-health/history/evidence";

const DAY_MS = 86_400_000;

/**
 * A half-open window of whole UTC days. The history and the session transcripts are cut at the same days, so a
 * baseline and its comparison always see the same span of both. Nothing here reads the wall clock.
 */
export interface DayWindow {
  /** First day included, YYYY-MM-DD. */
  from: string;
  /** First day excluded, YYYY-MM-DD. */
  to: string;
}

export const dayOf = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

const dayMs = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);

export const addDays = (day: string, days: number): string => new Date(dayMs(day) + days * DAY_MS).toISOString().slice(0, 10);

export const daysBetween = (from: string, to: string): number => Math.round((dayMs(to) - dayMs(from)) / DAY_MS);

/** The window of `months` ending with the day of the anchor commit, which is included. */
export function windowEndingAt(anchor: number, months: number): DayWindow {
  return { from: dayOf(monthsBefore(anchor, months)), to: addDays(dayOf(anchor), 1) };
}

/** The window as unix seconds, `since` inclusive and `until` exclusive, for the history. */
export function windowSeconds(window: DayWindow): { since: number; until: number } {
  return { since: dayMs(window.from) / 1000, until: dayMs(window.to) / 1000 };
}

export const windowLength = (window: DayWindow): number => daysBetween(window.from, window.to);

export interface FollowingWindow extends DayWindow {
  /** The window holds as many days as the one it matches. False when HEAD ends it early. */
  complete: boolean;
}

/**
 * The window that matches `before`: the same number of days, starting at `start`, cut short where the
 * analysed history ends (`ends` is the first day after the anchor commit).
 */
export function matchingWindow(before: DayWindow, start: string, ends: string): FollowingWindow {
  const full = addDays(start, windowLength(before));
  const to = full <= ends ? full : ends;
  return { from: start, to: to < start ? start : to, complete: full <= ends };
}
