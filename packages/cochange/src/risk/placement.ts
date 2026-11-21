import { folderOf } from "@code-health/graph/tree-distance";
import { monthsBefore } from "@code-health/history/evidence";
import type { HistoryState } from "./history-state.ts";
import type { ChangeFacts, MeasureContext } from "./measure.ts";
import { SECONDS_PER_DAY } from "../units.ts";

export type Label = "owner" | "regular" | "occasional" | "first-touch" | "unknown";
export type PlacementBand = "close" | "mixed" | "distant" | "unknown";

/**
 * What the blame cache says of one touched file at the base, reduced to shares so that no identity
 * leaves the module that read it. Absent for a file that has no valid blame.
 */
export interface BlameFacts {
  /** Lines held by people, as the share denominators. */
  people: number;
  /** The share of those lines last written by the change's authors, 0 to 1. Null when no person holds a line. */
  authorShare: number | null;
  /** The person holding at least the owner share who is not among the authors, as the reviewer to ask. Null when none. */
  distantOwner: { key: string; name: string; email: string; share: number } | null;
  /** Some active developer holds at least the regular share of the lines. */
  hasActiveHolder: boolean;
}

export interface FilePlacement {
  file: string;
  label: Label;
  churn: number;
  /** The authors' earlier merged changes to the file, and those within the recent window. */
  earlierChanges: number;
  recentChanges: number;
  /** Earlier changes weighted by recency: each counts 1 and halves every `recencyHalfLifeMonths`. */
  familiarity: number;
  /** The authors' earlier changes to files that change with this one, and to files in its folder. */
  neighbourhood: { coupled: number; folder: number };
  /** The authors' share of the file's lines, from the blame cache, or null without it. */
  authorship: number | null;
}

export interface Placement {
  band: PlacementBand;
  /** Every person author is a new identity, so no file is placed. */
  newIdentity: boolean;
  /** `blame` when the cache supplied authorship, `history` when labels came from change familiarity alone. */
  basis: "blame" | "history" | "mixed";
  files: FilePlacement[];
  /** Share of the change's churn in each label. */
  shares: Record<Label, number>;
  firstTouchShare: number;
  distantOwners: { file: string; name: string; email: string; share: number }[];
  noOwnerFiles: string[];
}

const round = (value: number, places = 4): number => Math.round(value * 10 ** places) / 10 ** places;
const SECONDS_PER_MONTH = 30.4375 * SECONDS_PER_DAY;

/** True when the identity has too little history to say anything about its ability in this code. */
export function isNewIdentity(state: HistoryState, email: string, time: number, context: MeasureContext): boolean {
  const seen = state.identity(email);
  if (seen === null) return true;
  return seen.first >= time - context.risk.newIdentityDays * SECONDS_PER_DAY || seen.changes < context.risk.newIdentityChanges;
}

function labelOf(
  stats: { earlier: number; recent: number; windowShare: number; windowEarlier: number },
  blame: BlameFacts | undefined,
  context: MeasureContext,
): Label {
  const { risk } = context;
  if (blame !== undefined && blame.authorShare !== null) {
    if (blame.authorShare * 100 >= risk.ownerShare) return "owner";
    if (blame.authorShare * 100 >= risk.regularShare || stats.recent >= risk.regularChanges) return "regular";
    return stats.earlier > 0 || blame.authorShare > 0 ? "occasional" : "first-touch";
  }
  // History alone: the share of the window's changes stands in for the share of lines.
  if (stats.windowShare * 100 >= risk.ownerShare && stats.windowEarlier >= risk.regularChanges) return "owner";
  if (stats.recent >= risk.regularChanges || (stats.windowShare * 100 >= risk.regularShare && stats.windowEarlier >= 2)) return "regular";
  return stats.earlier > 0 ? "occasional" : "first-touch";
}

/**
 * Places a change's authors among the code it touches. Per file a label from the spec's five, then a
 * band for the whole change. The blame cache refines the labels when it is given. Without it they come
 * from change familiarity alone, which is all a backtest can afford at every past commit.
 *
 * Everything here is about one change and one set of authors. Nothing is recorded per person.
 */
export function placeChange(
  facts: ChangeFacts,
  state: HistoryState,
  context: MeasureContext,
  options: { blame?: ReadonlyMap<string, BlameFacts> } = {},
): Placement {
  const authors = new Set(facts.authors);
  const newIdentity = authors.size > 0 && [...authors].every((author) => isNewIdentity(state, author, facts.time, context));
  // With nobody to place (every commit by a bot, say) or only newcomers, no file is placed.
  const unplaced = newIdentity || authors.size === 0;
  const recentSince = monthsBefore(facts.time, context.risk.recentChangesToFile);
  const windowSince = monthsBefore(facts.time, context.windowMonths);
  const halfLife = context.risk.recencyHalfLifeMonths * SECONDS_PER_MONTH;
  const by = (revision: { authors: readonly string[] }) => revision.authors.some((author) => authors.has(author.toLowerCase()));

  const files: FilePlacement[] = facts.files.map((file) => {
    const revisions = state.revisionsOf(file.fileId);
    const mine = revisions.filter(by);
    const inWindow = revisions.filter((revision) => revision.time >= windowSince);
    const windowMine = inWindow.filter(by);
    const blame = options.blame?.get(file.fileId);
    const stats = {
      earlier: mine.length,
      recent: mine.filter((revision) => revision.time >= recentSince).length,
      windowEarlier: windowMine.length,
      windowShare: inWindow.length === 0 ? 0 : windowMine.length / inWindow.length,
    };
    const brandNew = file.status === "A" || revisions.length === 0;
    const label: Label = unplaced || brandNew ? "unknown" : labelOf(stats, blame, context);

    let coupled = 0;
    for (const [other, support] of state.partners(file.fileId)) {
      const together = state.eligibleRevisionsInWindow(file.fileId);
      if (support >= context.minSupport && 100 * support >= context.risk.missingConfidence * together) {
        coupled += state.revisionsOf(other).filter(by).length;
      }
    }
    let nearby = 0;
    for (const other of state.filesInFolder(folderOf(file.fileId))) {
      if (other !== file.fileId) nearby += state.revisionsOf(other).filter(by).length;
    }
    return {
      file: file.fileId,
      label,
      churn: (file.added ?? 0) + (file.deleted ?? 0),
      earlierChanges: stats.earlier,
      recentChanges: stats.recent,
      familiarity: round(mine.reduce((sum, revision) => sum + 0.5 ** ((facts.time - revision.time) / halfLife), 0), 2),
      neighbourhood: { coupled, folder: nearby },
      authorship: blame?.authorShare === undefined || blame?.authorShare === null ? null : round(blame.authorShare),
    };
  });

  const total = files.reduce((sum, file) => sum + file.churn, 0);
  const weight = (file: FilePlacement) => (total === 0 ? 1 : file.churn);
  const denominator = total === 0 ? files.length : total;
  const shares = { owner: 0, regular: 0, occasional: 0, "first-touch": 0, unknown: 0 } satisfies Record<Label, number>;
  for (const file of files) shares[file.label] += denominator === 0 ? 0 : weight(file) / denominator;
  for (const label of Object.keys(shares) as Label[]) shares[label] = round(shares[label]);

  const distantOwners = files.flatMap((file) => {
    const owner = options.blame?.get(file.file)?.distantOwner;
    return owner ? [{ file: file.file, name: owner.name, email: owner.email, share: round(owner.share) }] : [];
  });
  const noOwnerFiles = files
    .filter((file) => {
      const blame = options.blame?.get(file.file);
      return blame !== undefined && blame.people > 0 && !blame.hasActiveHolder;
    })
    .map((file) => file.file);
  const noOwnerShare = denominator === 0 ? 0 : files.filter((f) => noOwnerFiles.includes(f.file)).reduce((sum, f) => sum + weight(f), 0) / denominator;

  const band: PlacementBand =
    files.length === 0 || shares.unknown > 0.5
      ? "unknown"
      : shares.owner + shares.regular > 0.5
        ? "close"
        : shares["first-touch"] > 0.5 || noOwnerShare > 0.5
          ? "distant"
          : "mixed";

  const withBlame = files.filter((file) => file.authorship !== null).length;
  return {
    band,
    newIdentity,
    basis: withBlame === 0 ? "history" : withBlame === files.length ? "blame" : "mixed",
    files,
    shares,
    firstTouchShare: shares["first-touch"],
    distantOwners,
    noOwnerFiles,
  };
}
