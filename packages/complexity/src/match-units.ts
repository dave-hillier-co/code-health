import type { FileRecord, UnitRecord } from "./measure.ts";

/** One function as it was and as it is. A unit that exists on one side only has the other undefined. */
export interface UnitMatch {
  before: UnitRecord | undefined;
  after: UnitRecord | undefined;
  /** Matched by body similarity under a different identity: the function was renamed or moved. */
  moved: boolean;
  /** The bodies differ once whitespace is ignored. Always true for a unit on one side only. */
  changed: boolean;
}

interface Body {
  unit: UnitRecord;
  text: string;
  tokens: Map<string, number>;
  size: number;
}

function bodiesOf(files: readonly FileRecord[]): Body[] {
  const bodies: Body[] = [];
  for (const file of files) {
    const lines = (file.text ?? "").split("\n");
    for (const unit of file.units) {
      const text = lines.slice(unit.startLine - 1, unit.endLine).join("\n").replace(/\s+/g, " ").trim();
      const tokens = new Map<string, number>();
      let size = 0;
      for (const token of text.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|"[^"]*"|'[^']*'|`[^`]*`|\S/g) ?? []) {
        tokens.set(token, (tokens.get(token) ?? 0) + 1);
        size++;
      }
      bodies.push({ unit, text, tokens, size });
    }
  }
  return bodies;
}

/** Weighted Jaccard similarity of two token multisets: shared tokens over all tokens, 0 to 1. */
function similarity(a: Body, b: Body): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const [token, count] of a.tokens) shared += Math.min(count, b.tokens.get(token) ?? 0);
  return shared / (a.size + b.size - shared);
}

/**
 * Matches the functions of two measurements. Identity (`path#Qualified.name`) matches first. What is left
 * on each side is paired by body similarity, best pair first, so a function that was renamed or moved is
 * compared with itself. A function left unpaired counts as new (or removed), so moving code never hides a
 * regression without anyone having looked at it.
 */
export function matchUnits(before: readonly FileRecord[], after: readonly FileRecord[], threshold: number): UnitMatch[] {
  const oldBodies = new Map(bodiesOf(before).map((body) => [body.unit.id, body]));
  const newBodies = new Map(bodiesOf(after).map((body) => [body.unit.id, body]));
  const matches: UnitMatch[] = [];

  for (const [id, current] of newBodies) {
    const previous = oldBodies.get(id);
    if (previous === undefined) continue;
    matches.push({ before: previous.unit, after: current.unit, moved: false, changed: previous.text !== current.text });
    oldBodies.delete(id);
    newBodies.delete(id);
  }

  const candidates: { from: Body; to: Body; score: number }[] = [];
  for (const from of oldBodies.values()) {
    for (const to of newBodies.values()) {
      // Far apart in size cannot reach the threshold: skip the comparison.
      if (Math.min(from.size, to.size) < threshold * Math.max(from.size, to.size)) continue;
      const score = similarity(from, to);
      if (score >= threshold) candidates.push({ from, to, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || compare(a.from.unit.id, b.from.unit.id) || compare(a.to.unit.id, b.to.unit.id));
  for (const { from, to } of candidates) {
    if (!oldBodies.has(from.unit.id) || !newBodies.has(to.unit.id)) continue;
    matches.push({ before: from.unit, after: to.unit, moved: true, changed: from.text !== to.text });
    oldBodies.delete(from.unit.id);
    newBodies.delete(to.unit.id);
  }

  for (const body of newBodies.values()) matches.push({ before: undefined, after: body.unit, moved: false, changed: true });
  for (const body of oldBodies.values()) matches.push({ before: body.unit, after: undefined, moved: false, changed: true });
  return matches.sort((a, b) => compare((a.after ?? a.before)!.id, (b.after ?? b.before)!.id));
}

function compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
