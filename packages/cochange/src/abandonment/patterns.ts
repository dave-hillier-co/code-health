import type { FileKnowledge, KnowledgeModel } from "./knowledge-model.ts";
import { round4 } from "./current.ts";

/**
 * Knowledge-risk patterns: named shapes of who holds a file's lines, each with a stated guideline. A pattern
 * labels and orders files. It never decides anything, and no file is left out of the listing for lacking one.
 * Listed in the order that picks a file's primary pattern, the first that applies.
 */
export const PATTERNS = ["single-owner-hotspot", "former-contributors-complex", "single-owner", "many-active-developers", "inconclusive"] as const;
export type Pattern = (typeof PATTERNS)[number];

/** The guidelines the patterns are judged against: `cochange.knowledge`, percentages from 1 to 100 unless noted. */
export interface PatternGuidelines {
  singleOwnerShare: number;
  formerContributorShare: number;
  /** The percentile of complexity, 0 to 100, at or above which a file is complex. */
  complexityPercentile: number;
  manyActiveAuthors: number;
  meaningfulShare: number;
  inconclusiveShare: number;
  busFactorShare: number;
}

/** Where a file's lines came from: a blame that names people, a file only bots wrote, or a file whose blame the cache does not hold. */
export type Basis = "blame" | "bots-only" | "blame-unknown";

/** Production code, a test file, or anything else (documents, data, configuration). Only production code has a complexity. */
export type FileKind = "code" | "test" | "other";

export interface PatternFile {
  path: string;
  kind: FileKind;
  /** The first pattern of `patterns`, or null when none applies. */
  pattern: Pattern | null;
  patterns: Pattern[];
  hotspot: boolean;
  /** The hotspot rank percentile, 0 to 1. */
  hotspotPercentile: number;
  complexity: number | null;
  /** The rank percentile of complexity among the scored files, 0 to 1, or null when the complexity is unknown. */
  complexityPercentile: number | null;
  /** Lines held by people. */
  peopleLines: number;
  activeAuthors: number;
  formerAuthors: number;
  /** The share of the lines held by people that the largest active holder has, 0 to 1. */
  topActiveShare: number;
  /** The share of the lines held by people that developers who have left hold, 0 to 1. */
  formerShare: number;
  /** The share of the file's lines that are bots', agents', unattributed or held by unmapped identities, 0 to 1. Null when the blame is unknown. */
  unreliableShare: number | null;
  /** Active developers holding at least `meaningfulShare` of the lines held by people. */
  meaningfulAuthors: number;
  /** The fewest active developers who together hold `busFactorShare` of the lines held by people. Null when active developers hold less than that. */
  busFactor: number | null;
  basis: Basis;
}

export interface HotspotStanding {
  hot: boolean;
  percentile: number;
}

export interface ComplexityStanding {
  value: number;
  /** 0 to 1. */
  percentile: number;
}

export interface PatternInput {
  model: KnowledgeModel;
  guidelines: PatternGuidelines;
  hotspots: ReadonlyMap<string, HotspotStanding>;
  complexity: ReadonlyMap<string, ComplexityStanding>;
  /** Mapped identities whose mapping is not settled: a proposal still names them. */
  unmapped: ReadonlySet<string>;
  /** Files only bots, services and agents (or unknown commits) wrote. */
  botOnly: readonly string[];
  kindOf: (path: string) => FileKind;
}

const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** True when `part` of `whole` reaches `percent`, in exact integer arithmetic. */
const reaches = (part: number, whole: number, percent: number): boolean => whole > 0 && 100 * part >= percent * whole;

/** The fewest holders (largest first) whose lines reach `percent` of `people`, or null when all of them together do not. */
export function busFactorOf(activeLines: readonly number[], people: number, percent: number): number | null {
  const sorted = [...activeLines].sort((a, b) => b - a);
  let held = 0;
  for (const [i, lines] of sorted.entries()) {
    held += lines;
    if (reaches(held, people, percent)) return i + 1;
  }
  return null;
}

function classifyFile(file: FileKnowledge, input: PatternInput): PatternFile {
  const { model, guidelines: g } = input;
  const hotspot = input.hotspots.get(file.path) ?? { hot: false, percentile: 0 };
  const complexity = input.complexity.get(file.path) ?? null;
  const active = file.holders.filter((h) => model.developers[h.dev]!.active);
  const activeLines = active.map((h) => h.lines);
  const gone = file.holders.filter((h) => !model.developers[h.dev]!.active).reduce((sum, h) => sum + h.lines, 0);
  const unmappedLines = file.holders.filter((h) => input.unmapped.has(model.developers[h.dev]!.key)).reduce((sum, h) => sum + h.lines, 0);
  const total = file.people + file.nonPerson + file.unattributed;
  const unreliable = file.nonPerson + file.unattributed + unmappedLines;
  const top = Math.max(0, ...activeLines);
  const meaningful = activeLines.filter((lines) => reaches(lines, file.people, g.meaningfulShare)).length;

  const patterns: Pattern[] = [];
  if (reaches(unreliable, total, g.inconclusiveShare)) patterns.push("inconclusive");
  else {
    const singleOwner = reaches(top, file.people, g.singleOwnerShare);
    const complex = complexity !== null && complexity.percentile * 100 >= g.complexityPercentile;
    if (singleOwner && hotspot.hot) patterns.push("single-owner-hotspot");
    if (complex && reaches(gone, file.people, g.formerContributorShare)) patterns.push("former-contributors-complex");
    if (singleOwner) patterns.push("single-owner");
    if (meaningful >= g.manyActiveAuthors) patterns.push("many-active-developers");
  }
  const ordered = PATTERNS.filter((p) => patterns.includes(p));
  return {
    path: file.path,
    kind: input.kindOf(file.path),
    pattern: ordered[0] ?? null,
    patterns: ordered,
    hotspot: hotspot.hot,
    hotspotPercentile: round4(hotspot.percentile),
    complexity: complexity?.value ?? null,
    complexityPercentile: complexity === null ? null : round4(complexity.percentile),
    peopleLines: file.people,
    activeAuthors: active.length,
    formerAuthors: file.holders.length - active.length,
    topActiveShare: round4(top / file.people),
    formerShare: round4(gone / file.people),
    unreliableShare: round4(unreliable / total),
    meaningfulAuthors: meaningful,
    busFactor: busFactorOf(activeLines, file.people, g.busFactorShare),
    basis: "blame",
  };
}

function withoutPeople(path: string, basis: Basis, input: PatternInput): PatternFile {
  const hotspot = input.hotspots.get(path) ?? { hot: false, percentile: 0 };
  const complexity = input.complexity.get(path) ?? null;
  return {
    path,
    kind: input.kindOf(path),
    pattern: "inconclusive",
    patterns: ["inconclusive"],
    hotspot: hotspot.hot,
    hotspotPercentile: round4(hotspot.percentile),
    complexity: complexity?.value ?? null,
    complexityPercentile: complexity === null ? null : round4(complexity.percentile),
    peopleLines: 0,
    activeAuthors: 0,
    formerAuthors: 0,
    topActiveShare: 0,
    formerShare: 0,
    unreliableShare: basis === "blame-unknown" ? null : 1,
    meaningfulAuthors: 0,
    busFactor: null,
    basis,
  };
}

/**
 * Every file with a blame, classified. A file that bots wrote, or whose blame is not cached, has no author to
 * reason about and is inconclusive. Sorted by the primary pattern in `PATTERNS` order (files with none last),
 * then by hotspot percentile, then by path.
 */
export function classifyPatterns(input: PatternInput): PatternFile[] {
  const files = [
    ...input.model.files.map((file) => classifyFile(file, input)),
    ...input.botOnly.map((path) => withoutPeople(path, "bots-only", input)),
    ...input.model.missing.map((path) => withoutPeople(path, "blame-unknown", input)),
  ];
  const rank = (f: PatternFile): number => (f.pattern === null ? PATTERNS.length : PATTERNS.indexOf(f.pattern));
  return files.sort((a, b) => rank(a) - rank(b) || b.hotspotPercentile - a.hotspotPercentile || byBytes(a.path, b.path));
}

export interface PatternCount {
  pattern: Pattern;
  /** Files whose primary pattern it is. */
  primary: number;
  /** Files it applies to, which includes those where another pattern comes first. */
  matching: number;
}

export interface PatternSummary {
  files: number;
  /** Files no pattern applies to. */
  none: number;
  counts: PatternCount[];
  /** Files with no known complexity, which the complex-code pattern cannot judge. */
  complexityUnknown: number;
  hotspotFiles: number;
}

export function summarisePatterns(files: readonly PatternFile[]): PatternSummary {
  return {
    files: files.length,
    none: files.filter((f) => f.pattern === null).length,
    counts: PATTERNS.map((pattern) => ({ pattern, primary: files.filter((f) => f.pattern === pattern).length, matching: files.filter((f) => f.patterns.includes(pattern)).length })),
    complexityUnknown: files.filter((f) => f.basis === "blame" && f.complexity === null).length,
    hotspotFiles: files.filter((f) => f.hotspot).length,
  };
}
