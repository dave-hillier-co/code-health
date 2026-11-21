import { emailOf } from "../active-developers.ts";
import { coupledPairs } from "../coupled-pairs.ts";
import { degreeOf } from "../coupling.ts";
import type { LoadedHistory } from "../history-access.ts";
import { round4 } from "./current.ts";
import type { KnowledgeModel } from "./knowledge-model.ts";

/** A file that changes with another, and how strongly. */
export interface CoupledFile {
  path: string;
  /** Percentage, 0 to 100. */
  degree: number;
  support: number;
}

export interface SuccessorEvidence {
  /** The coupled file the developer changed. */
  path: string;
  degree: number;
  /** Eligible logical changes in the analysis window that touched it with this developer as an author. */
  changes: number;
}

export interface Successor {
  /** The developer's mapped identity. It is shown only by `successors --names`. */
  developer: string;
  /** coupledChanges plus ownShare. */
  score: number;
  /** Sum, over files coupled with this one, of the coupling degree (as a fraction) times the developer's changes to that file. */
  coupledChanges: number;
  /** The share of the people's lines in this file that the developer holds, 0 to 1. */
  ownShare: number;
  evidence: SuccessorEvidence[];
}

export interface SuccessorIndex {
  /** Coupled files by file, over the analysis window and at the configured minimum support and degree. */
  partners: Map<string, CoupledFile[]>;
  /** Eligible logical changes per file per author email (lower case). */
  changesBy: Map<string, Map<string, number>>;
}

/**
 * Coordination requirements (Cataldo et al.): who works on the files that change with a file.
 * Built once from the coupling the rest of the suite uses (eligible logical changes only, so bulk
 * edits count for nothing) and the analysis window's authors.
 */
export function buildSuccessorIndex(history: LoadedHistory): SuccessorIndex {
  const { minSupport, minDegree } = history.settings;
  const partners = new Map<string, CoupledFile[]>();
  const add = (file: string, other: string, degree: number, support: number) => {
    const list = partners.get(file) ?? [];
    list.push({ path: other, degree, support });
    partners.set(file, list);
  };
  for (const pair of coupledPairs(history, { minSupport, minDegree }).pairs) {
    const degree = degreeOf(pair);
    add(pair.a, pair.b, degree, pair.support);
    add(pair.b, pair.a, degree, pair.support);
  }
  const changesBy = new Map<string, Map<string, number>>();
  for (const change of history.filtered.changes) {
    if (change.oversized) continue;
    const emails = new Set(change.authors.map((a) => a.toLowerCase()));
    for (const file of new Set(change.files.map((f) => f.fileId))) {
      const byEmail = changesBy.get(file) ?? new Map<string, number>();
      for (const email of emails) byEmail.set(email, (byEmail.get(email) ?? 0) + 1);
      changesBy.set(file, byEmail);
    }
  }
  return { partners, changesBy };
}

/**
 * The active developers ranked as successors for a file: by how much they have changed the files
 * that change with it, weighted by how strongly they are coupled, plus their own share of the
 * file's lines. Developers who have left are never candidates, and a developer with no
 * coupled changes and no lines is not listed.
 */
export function successorsOf(path: string, index: SuccessorIndex, model: KnowledgeModel): Successor[] {
  const file = model.files.find((f) => f.path === path);
  const coupled = [...(index.partners.get(path) ?? [])].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const successors: Successor[] = [];
  model.developers.forEach((dev, i) => {
    if (!dev.active) return;
    const email = emailOf(dev.key);
    let coupledChanges = 0;
    const evidence: SuccessorEvidence[] = [];
    for (const partner of coupled) {
      const changes = index.changesBy.get(partner.path)?.get(email) ?? 0;
      if (changes === 0) continue;
      coupledChanges += (partner.degree / 100) * changes;
      evidence.push({ path: partner.path, degree: round4(partner.degree), changes });
    }
    const lines = file?.holders.find((h) => h.dev === i)?.lines ?? 0;
    const ownShare = file === undefined || file.people === 0 ? 0 : lines / file.people;
    if (coupledChanges === 0 && ownShare === 0) return;
    successors.push({ developer: dev.key, score: round4(coupledChanges + ownShare), coupledChanges: round4(coupledChanges), ownShare: round4(ownShare), evidence });
  });
  return successors.sort((a, b) => b.score - a.score || Buffer.compare(Buffer.from(a.developer), Buffer.from(b.developer)));
}

/** No active developer has changed any file that changes with this one. Such a file has nobody working near it. */
export const hasNoSuccessor = (successors: readonly Successor[]): boolean => successors.every((s) => s.coupledChanges === 0);

/** A check, built once per run, for the `no-successor` finding of the files a command ranks. */
export function noSuccessorCheck(history: LoadedHistory, model: KnowledgeModel): (path: string) => boolean {
  const index = buildSuccessorIndex(history);
  return (path) => hasNoSuccessor(successorsOf(path, index, model));
}
