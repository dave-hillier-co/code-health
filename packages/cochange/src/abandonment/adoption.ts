import { emailOf } from "../active-developers.ts";
import { round4 } from "./current.ts";
import type { Activity } from "./activity.ts";
import type { KnowledgeModel } from "./knowledge-model.ts";
import { successorsOf, type SuccessorIndex } from "./successors.ts";

export interface AdoptionChange {
  committerDate: number;
  /** Mapped author emails. */
  authors: readonly string[];
  /** Files as named at the analysed commit. */
  files: readonly string[];
}

export interface AdoptionFile {
  path: string;
  /** Changed at all between the two dates. */
  changed: boolean;
  /** Changed by a developer who is active at the outcome date. */
  adopted: boolean;
  /** Adopted by someone among the top recommended successors as of the start date. */
  byRecommended: boolean;
  /** Adopted only by people who had made no commit by the start date. */
  byNewcomer: boolean;
}

export interface AdoptionInput {
  /** The model at the start date and at the outcome date. */
  before: KnowledgeModel;
  after: KnowledgeModel;
  activity: Activity;
  /** Files abandoned at the start date. */
  abandoned: readonly string[];
  /** Eligible logical changes after the start date, up to and including the outcome date. */
  changes: readonly AdoptionChange[];
  /** Coupling evidence from changes before the start date. */
  index: SuccessorIndex;
  /** How many of the ranked successors count as recommended. */
  recommended: number;
}

/**
 * For each file abandoned at the start date: was it picked up by an active developer within the
 * horizon, and was that developer one the model would have recommended, using only what was known
 * at the start date.
 */
export function measureAdoption(input: AdoptionInput): AdoptionFile[] {
  const { before, after, activity, abandoned, changes, index, recommended } = input;
  const activeAfter = new Set(after.developers.filter((d) => d.active).map((d) => emailOf(d.key)));
  const startDate = before.asOf;
  const firstCommit = new Map<string, number>();
  for (const [key, times] of activity.commits) firstCommit.set(emailOf(key), Math.min(...times));
  const isNewcomer = (email: string) => (firstCommit.get(email) ?? Number.POSITIVE_INFINITY) > startDate;

  return abandoned.map((path) => {
    const touching = changes.filter((c) => c.files.includes(path));
    const adopters = new Set(touching.flatMap((c) => c.authors.map((a) => a.toLowerCase())).filter((email) => activeAfter.has(email)));
    const top = new Set(successorsOf(path, index, before).slice(0, recommended).map((s) => emailOf(s.developer)));
    const adopted = adopters.size > 0;
    return {
      path,
      changed: touching.length > 0,
      adopted,
      byRecommended: [...adopters].some((email) => top.has(email)),
      byNewcomer: adopted && [...adopters].every(isNewcomer),
    };
  });
}

export interface AdoptionSummary {
  abandoned: number;
  changed: number;
  adopted: number;
  byRecommended: number;
  byNewcomer: number;
  /** adopted / abandoned, null when nothing was abandoned. */
  adoptionRate: number | null;
  /** byRecommended / adopted, null when nothing was adopted. */
  recommendationHitRate: number | null;
}

export function summariseAdoption(files: readonly AdoptionFile[]): AdoptionSummary {
  const count = (pick: (f: AdoptionFile) => boolean) => files.filter(pick).length;
  const adopted = count((f) => f.adopted);
  const byRecommended = count((f) => f.byRecommended);
  return {
    abandoned: files.length,
    changed: count((f) => f.changed),
    adopted,
    byRecommended,
    byNewcomer: count((f) => f.byNewcomer),
    adoptionRate: files.length === 0 ? null : round4(adopted / files.length),
    recommendationHitRate: adopted === 0 ? null : round4(byRecommended / adopted),
  };
}
