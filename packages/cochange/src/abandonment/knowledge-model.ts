import type { BlameSnapshot } from "@code-health/history/blame-read";
import { lineShares, type Owner } from "@code-health/history/blame-owners";
import { isActiveDeveloper } from "../active-developers.ts";
import type { Activity } from "./activity.ts";
import type { KnowledgeOverrides } from "./settings.ts";

export interface Developer {
  /** The mapped identity, `Name <email>`. Never printed except by `successors --names`, and then only for active developers. */
  key: string;
  active: boolean;
}

export interface Holder {
  /** Index into `KnowledgeModel.developers`. */
  dev: number;
  lines: number;
}

export interface FileKnowledge {
  path: string;
  /** Lines held by people. Bots, services and agents hold none: their lines belong to nobody. */
  people: number;
  nonPerson: number;
  /** Lines whose commit is unknown, for example beyond a shallow boundary. */
  unattributed: number;
  /** The people holding lines, by developer index. */
  holders: Holder[];
}

/**
 * What the abandonment analysis knows: who is active, and for each file the
 * lines each person holds. Built once, then read by the current view, the
 * simulation and the backtest.
 */
export interface KnowledgeModel {
  /** The date everything is judged at, unix seconds. */
  asOf: number;
  /** Every person with a commit or a line, sorted by identity. */
  developers: Developer[];
  /** Files with at least one line held by a person, sorted by path. */
  files: FileKnowledge[];
  /** Authored files the blame cache holds nothing right for: their authorship is unknown, not zero. */
  missing: string[];
}

export interface ModelInput {
  snapshot: BlameSnapshot;
  owners: ReadonlyMap<string, Owner>;
  activity: Activity;
  asOf: number;
  windowSeconds: number;
  overrides?: KnowledgeOverrides;
}

const compareBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

export function buildKnowledgeModel(input: ModelInput): KnowledgeModel {
  const { snapshot, owners, activity, asOf, windowSeconds, overrides } = input;
  const rule = { windowSeconds, overrides: overrides ?? { active: new Set<string>(), inactive: new Set<string>() } };
  const keys = new Set(activity.commits.keys());
  for (const owner of owners.values()) if (owner.kind === "person") keys.add(owner.key);
  const sorted = [...keys].sort(compareBytes);
  const index = new Map(sorted.map((key, i) => [key, i]));
  const developers = sorted.map((key): Developer => {
    return { key, active: isActiveDeveloper(key, activity.commits.get(key) ?? [], asOf, rule) };
  });

  const files: FileKnowledge[] = [];
  for (const file of snapshot.files.values()) {
    const shares = lineShares(file.ranges, owners);
    if (shares.people === 0) continue;
    const holders = [...shares.byOwner].map(([key, lines]): Holder => ({ dev: index.get(key)!, lines })).sort((a, b) => a.dev - b.dev);
    files.push({ path: file.path, people: shares.people, nonPerson: shares.nonPerson, unattributed: shares.unattributed, holders });
  }
  files.sort((a, b) => compareBytes(a.path, b.path));
  return { asOf, developers, files, missing: snapshot.missing };
}

/** True when `goneLines` of `people` reaches the threshold percentage, in exact integer arithmetic. */
export const reachesThreshold = (goneLines: number, people: number, thresholdPercent: number): boolean =>
  people > 0 && 100 * goneLines >= thresholdPercent * people;

/** Lines of a file held by developers who have left, as the model stands. */
export function goneLinesOf(file: FileKnowledge, developers: readonly Developer[]): number {
  let lines = 0;
  for (const h of file.holders) if (!developers[h.dev]!.active) lines += h.lines;
  return lines;
}
