import { runGit } from "@code-health/history/git";

export interface Commit {
  sha: string;
  /** Committer date, in seconds. */
  date: number;
}

/** The commits on the first-parent line of `ref`, oldest first. */
export async function firstParentLine(root: string, ref: string): Promise<Commit[]> {
  const out = await runGit(root, ["log", "--first-parent", "--format=%H %ct", ref]);
  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line): Commit => ({ sha: line.slice(0, line.indexOf(" ")), date: Number(line.slice(line.indexOf(" ") + 1)) }))
    .reverse();
}

/**
 * Up to `count` commits of a first-parent line, spread evenly over time from `since` (or the first commit, when
 * that is later) to the last commit. The span is cut at `count` instants, the first and the last included, and each
 * gives the last commit at or before it, so two instants with no commit between them give one sample. The last
 * commit is always a sample.
 */
export function sampleByTime(line: readonly Commit[], count: number, since: number): Commit[] {
  const last = line.at(-1);
  if (last === undefined) return [];
  const within = line.filter((commit) => commit.date >= since);
  const start = within[0]?.date ?? last.date;
  const picked = new Map<string, Commit>();
  for (let i = 0; i < count; i++) {
    const instant = count === 1 ? last.date : start + ((last.date - start) * i) / (count - 1);
    // Dates on a first-parent line are not always in order, so the commit is the latest in line order that is not after the instant.
    const commit = i === count - 1 ? last : line.findLast((candidate) => candidate.date <= instant && candidate.date >= start);
    if (commit !== undefined) picked.set(commit.sha, commit);
  }
  return line.filter((commit) => picked.has(commit.sha));
}

const iso = (date: number) => new Date(date * 1000).toISOString();

/** A name for each sample: its date, with the time when two samples share a date, and the short hash when they share a minute. */
export function sampleLabels(samples: readonly Commit[]): string[] {
  const distinct = (labels: string[]) => new Set(labels).size === labels.length;
  const days = samples.map((sample) => iso(sample.date).slice(0, 10));
  if (distinct(days)) return days;
  const minutes = samples.map((sample) => iso(sample.date).slice(0, 16).replace("T", " "));
  if (distinct(minutes)) return minutes;
  return samples.map((sample, i) => `${minutes[i]} ${sample.sha.slice(0, 7)}`);
}
