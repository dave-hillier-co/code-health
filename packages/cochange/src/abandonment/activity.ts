import type { HistoryCommit } from "@code-health/history/read";
import type { NonPersonMatcher } from "@code-health/history/identity-classify";
import { mapThroughMailmap } from "@code-health/history/identity-mapping";
import { identityKey } from "@code-health/history/identity-names";

/** Commit times, in unix seconds, of each person by mapped identity (`Name <email>`), oldest first. Bots and services are not in it. */
export interface Activity {
  commits: Map<string, number[]>;
}

/**
 * The commit times of every person in the history. Authors are mapped through the
 * working tree `.mailmap` and the local one, like the owners of blamed lines, and
 * identities classified as bots, services or agents are left out: they are not
 * part of the population whose leaving loses knowledge.
 */
export async function readActivity(
  root: string,
  commits: readonly Pick<HistoryCommit, "authorName" | "authorEmail" | "committerDate">[],
  options: { localMailmap?: string; matcher?: Pick<NonPersonMatcher, "classify"> },
): Promise<Activity> {
  const raws = new Map<string, { name: string; email: string }>();
  for (const c of commits) raws.set(identityKey({ name: c.authorName, email: c.authorEmail }), { name: c.authorName, email: c.authorEmail });
  const mapped = await mapThroughMailmap(root, [...raws.values()], options.localMailmap);
  const person = new Map<string, string | null>();
  for (const [raw, author] of raws) {
    const to = mapped.get(raw) ?? author;
    person.set(raw, options.matcher?.classify(to.name, to.email) ? null : identityKey(to));
  }
  const byPerson = new Map<string, number[]>();
  for (const c of commits) {
    const key = person.get(identityKey({ name: c.authorName, email: c.authorEmail }));
    if (key === null || key === undefined) continue;
    const times = byPerson.get(key) ?? [];
    times.push(c.committerDate);
    byPerson.set(key, times);
  }
  for (const times of byPerson.values()) times.sort((a, b) => a - b);
  return { commits: new Map([...byPerson].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) };
}

export interface Tenure {
  /** First commit of the tenure. */
  start: number;
  /** Last commit of the tenure: the departure, when it is over. */
  end: number;
  /** Still active at the observation date, so not a departure. */
  ongoing: boolean;
}

/**
 * The stretches of continuous activity of one person up to `asOf`. A tenure ends at its last
 * commit when no further commit follows within the window, so a quiet spell shorter than
 * the window never ends it. The last tenure is over only once a whole window has passed
 * since its last commit. Someone who comes back after a longer gap starts a new tenure.
 */
export function tenuresOf(times: readonly number[], asOf: number, windowSeconds: number): Tenure[] {
  const known = times.filter((t) => t <= asOf);
  const tenures: Tenure[] = [];
  let start: number | undefined;
  let last = 0;
  for (const t of known) {
    if (start !== undefined && t - last >= windowSeconds) {
      tenures.push({ start, end: last, ongoing: false });
      start = undefined;
    }
    start ??= t;
    last = t;
  }
  if (start !== undefined) tenures.push({ start, end: last, ongoing: last > asOf - windowSeconds });
  return tenures;
}

export interface TurnoverPeriod {
  /** The period is `[start, end)`, in unix seconds. */
  start: number;
  end: number;
  /** Developers on the team at the start: a tenure that began at or before it and had not ended. */
  atRisk: number;
  /** Of those, the developers whose departure falls in the period. */
  departed: number;
  rate: number;
}

export interface Turnover {
  /** Oldest first. Periods with nobody at risk are left out. */
  periods: TurnoverPeriod[];
  atRisk: number;
  departed: number;
  /** Departures over developers at risk, pooled over the periods: the per-period turnover rate. Null with no usable period. */
  rate: number | null;
}

export interface TurnoverOptions {
  windowSeconds: number;
  periodSeconds: number;
}

/**
 * Per-period turnover observed at `asOf`. Periods are whole lengths counted back from
 * `asOf`. A departure is known only once a window has passed, so periods that end
 * within the last window are left out, and so is any period nobody was on the team for.
 */
export function estimateTurnover(activity: Activity, asOf: number, options: TurnoverOptions): Turnover {
  const { windowSeconds, periodSeconds } = options;
  const tenures = [...activity.commits.values()].flatMap((times) => tenuresOf(times, asOf, windowSeconds));
  const earliest = tenures.reduce((least, t) => Math.min(least, t.start), Infinity);

  const periods: TurnoverPeriod[] = [];
  const firstUsable = Math.ceil(windowSeconds / periodSeconds);
  for (let k = firstUsable; ; k++) {
    const end = asOf - k * periodSeconds;
    if (end <= earliest) break;
    const start = end - periodSeconds;
    const present = tenures.filter((t) => t.start <= start && t.end >= start);
    if (present.length === 0) continue;
    const departed = present.filter((t) => !t.ongoing && t.end < end).length;
    periods.push({ start, end, atRisk: present.length, departed, rate: departed / present.length });
  }
  periods.reverse();
  const atRisk = periods.reduce((sum, p) => sum + p.atRisk, 0);
  const departed = periods.reduce((sum, p) => sum + p.departed, 0);
  return { periods, atRisk, departed, rate: atRisk === 0 ? null : departed / atRisk };
}
