import { isFunctionUnit, type UnitShape } from "./unit.ts";

export interface AgreementCounts {
  /** Structural function units (classes excluded). */
  units: number;
  /** Units overlapped by at least one lexical block. */
  found: number;
  /** Units with a lexical block of exactly the same start and end line. */
  exact: number;
  /** Lexical blocks. */
  blocks: number;
  /** Lexical blocks overlapping no structural function unit. */
  spurious: number;
}

export const noAgreement: AgreementCounts = { units: 0, found: 0, exact: 0, blocks: 0, spurious: 0 };

/** Compares one file's lexical blocks with its structural units, by line range only. */
export function compareUnits(structural: readonly UnitShape[], blocks: readonly UnitShape[]): AgreementCounts {
  const units = structural.filter(isFunctionUnit);
  const overlaps = (a: UnitShape, b: UnitShape) => a.startLine <= b.endLine && b.startLine <= a.endLine;
  let found = 0;
  let exact = 0;
  for (const unit of units) {
    if (blocks.some((block) => overlaps(unit, block))) found++;
    if (blocks.some((block) => block.startLine === unit.startLine && block.endLine === unit.endLine)) exact++;
  }
  const spurious = blocks.filter((block) => !units.some((unit) => overlaps(unit, block))).length;
  return { units: units.length, found, exact, blocks: blocks.length, spurious };
}

export function addAgreement(a: AgreementCounts, b: AgreementCounts): AgreementCounts {
  return {
    units: a.units + b.units,
    found: a.found + b.found,
    exact: a.exact + b.exact,
    blocks: a.blocks + b.blocks,
    spurious: a.spurious + b.spurious,
  };
}

/** Fraction of structural units whose boundaries the lexical layer got exactly right, to four places. */
export function exactRate(counts: AgreementCounts): number {
  return counts.units === 0 ? 0 : Math.round((counts.exact / counts.units) * 10000) / 10000;
}

/** Fraction of lexical blocks that match no structural function, to four places. */
export function spuriousRate(counts: AgreementCounts): number {
  return counts.blocks === 0 ? 0 : Math.round((counts.spurious / counts.blocks) * 10000) / 10000;
}
