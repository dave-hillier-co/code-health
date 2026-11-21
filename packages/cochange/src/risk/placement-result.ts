import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { commitsInSnapshot, lineShares, resolveOwners, shareHeldBy, type Owner } from "@code-health/history/blame-owners";
import { readBlame } from "@code-health/history/blame-read";
import { refreshBlame } from "@code-health/history/blame-refresh";
import { readActiveDevelopers } from "../active-developers.ts";
import type { Assessed } from "./assess.ts";
import type { Factor } from "./factor.ts";
import { invokingUser } from "./identity.ts";
import { placeChange, type BlameFacts, type Placement } from "./placement.ts";

/** Why placement was not computed, or null when it was. */
export interface PlacementOutcome {
  status: "computed" | "withheld" | "off";
  mode: string;
  reason: string | null;
  placement: Placement | null;
  factors: Factor[];
  /** Blame limits worth stating: files with no valid blame. Empty without blame. */
  blame: { used: boolean; missing: number; refreshed: boolean };
}

const none = (mode: string, status: "withheld" | "off", reason: string): PlacementOutcome => ({
  status,
  mode,
  reason,
  placement: null,
  factors: [],
  blame: { used: false, missing: 0, refreshed: false },
});

/** The people holding the lines, as shares only, so no identity leaves this function except the owner to ask. */
async function blameFacts(
  context: CommandContext,
  assessed: Assessed,
  authorKeys: ReadonlySet<string>,
  noRefresh: boolean,
): Promise<{ facts: Map<string, BlameFacts>; missing: number; refreshed: boolean }> {
  const { change, history, risk } = assessed;
  const root = context.repo.root;
  const paths = [...new Set(change.files.filter((f) => f.status !== "A").map((f) => f.oldPath ?? f.path))].sort();
  const facts = new Map<string, BlameFacts>();
  if (paths.length === 0) return { facts, missing: 0, refreshed: false };
  const options = { ref: change.base, exclude: history.settings.exclude, paths };
  if (!noRefresh) await refreshBlame(root, options);
  const snapshot = await readBlame(root, options);

  const owners = await resolveOwners(root, commitsInSnapshot(snapshot), {
    localMailmap: history.identities.localMailmap,
    matcher: history.identities.matcher,
  });
  const developers = await readActiveDevelopers(context, history, assessed.facts.time);
  const active = (owner: Owner): boolean => developers.has(owner.email);
  const byKey = new Map<string, Owner>([...owners.values()].map((o) => [o.key, o]));

  for (const file of change.files) {
    const blame = snapshot.files.get(file.oldPath ?? file.path);
    if (!blame) continue;
    const shares = lineShares(blame.ranges, owners);
    const held = shareHeldBy(shares, authorKeys);
    let distantOwner: BlameFacts["distantOwner"] = null;
    let hasActiveHolder = false;
    for (const [key, lines] of [...shares.byOwner].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
      const owner = byKey.get(key)!;
      const share = lines / shares.people;
      if (!active(owner)) continue;
      if (share * 100 >= risk.regularShare) hasActiveHolder = true;
      if (distantOwner === null && share * 100 >= risk.ownerShare && !authorKeys.has(key)) {
        distantOwner = { key, name: owner.name, email: owner.email, share };
      }
    }
    facts.set(file.fileId, { people: shares.people, authorShare: held, distantOwner, hasActiveHolder });
  }
  return { facts, missing: snapshot.missing.length, refreshed: !noRefresh };
}

/**
 * Places the change's authors in the code it touches, when the privacy rules allow it.
 *
 * - `off` never computes it.
 * - `self` (the default) computes it only when every person among the change's authors is the invoking
 *   git identity: a self-check before asking for review. This is a default, not an access control.
 * - `any` computes it for whoever wrote the change, which is a team's decision to make in the config.
 *
 * Nothing it returns is kept: it is never written to a report.
 */
export async function placementFor(context: CommandContext, assessed: Assessed, noRefresh: boolean): Promise<PlacementOutcome> {
  const { risk, change, history } = assessed;
  if (risk.placement === "off") return none("off", "off", "cochange.risk.placement is off");

  const authors = [...assessed.facts.authors];
  const user = await invokingUser(context.repo.root, history.identities.localMailmap);
  if (change.worktree && user !== null && !authors.includes(user.email.toLowerCase())) authors.push(user.email.toLowerCase());
  if (risk.placement === "self") {
    if (user === null) return none("self", "withheld", "no git identity is configured (user.email), so the change cannot be shown to be yours");
    const mine = user.email.toLowerCase();
    if (authors.some((author) => author !== mine)) {
      return none("self", "withheld", "the change was not written only by the invoking git identity; cochange.risk.placement: any computes placement for someone else's branch");
    }
  }

  const authorKeys = new Set([...change.owners.values()].filter((o) => o.kind === "person").map((o) => o.key));
  if (change.worktree && user !== null) authorKeys.add(`${user.name} <${user.email}>`);
  const blame = await blameFacts(context, assessed, authorKeys, noRefresh);
  const placement = placeChange({ ...assessed.facts, authors }, assessed.state, assessed.context, { blame: blame.facts });
  return {
    status: "computed",
    mode: risk.placement,
    reason: null,
    placement,
    factors: placementFactors(placement, blame.facts.size > 0),
    blame: { used: blame.facts.size > 0, missing: blame.missing, refreshed: blame.refreshed },
  };
}

const row = (name: string, value: Record<string, number | null>, evidence: Record<string, unknown>[], unavailable: string | null = null): Factor => ({
  name,
  family: "placement",
  layer: "placement",
  status: unavailable === null ? "ok" : "unavailable",
  band: null,
  scored: false,
  value: unavailable === null ? value : {},
  thresholds: {},
  evidence: unavailable === null ? evidence : [],
  source: name === "authorship" || name === "owner-distance" || name === "no-owner" ? "blame" : "history",
  reason: unavailable,
});

/** The six placement factors. Counts and paths only: no factor's evidence names anyone but the change's own authors. */
export function placementFactors(placement: Placement, withBlame: boolean): Factor[] {
  const noBlame = "no blame is cached for the touched files at the base; the labels come from change-familiarity alone";
  const measured = placement.files.filter((file) => file.authorship !== null);
  const mean = measured.length === 0 ? 0 : Math.round((measured.reduce((sum, f) => sum + f.authorship!, 0) / measured.length) * 10_000) / 10_000;
  return [
    row(
      "authorship",
      { files: measured.length, meanShare: mean },
      measured.map((f) => ({ file: f.file, share: f.authorship })),
      withBlame ? null : noBlame,
    ),
    row(
      "change-familiarity",
      { files: placement.files.length, familiarity: Math.round(placement.files.reduce((sum, f) => sum + f.familiarity, 0) * 100) / 100 },
      placement.files.map((f) => ({ file: f.file, earlierChanges: f.earlierChanges, recentChanges: f.recentChanges, familiarity: f.familiarity })),
    ),
    row(
      "neighbourhood",
      {
        coupled: placement.files.reduce((s, f) => s + f.neighbourhood.coupled, 0),
        folder: placement.files.reduce((s, f) => s + f.neighbourhood.folder, 0),
        component: placement.files.some((f) => f.neighbourhood.component === null) ? null : placement.files.reduce((s, f) => s + (f.neighbourhood.component ?? 0), 0),
      },
      placement.files.map((f) => ({ file: f.file, coupled: f.neighbourhood.coupled, folder: f.neighbourhood.folder, component: f.neighbourhood.component })),
    ),
    row("first-touch-share", { share: placement.firstTouchShare }, placement.files.filter((f) => f.label === "first-touch").map((f) => ({ file: f.file, churn: f.churn }))),
    row("owner-distance", { files: placement.distantOwners.length }, placement.distantOwners.map((o) => ({ file: o.file, share: o.share })), withBlame ? null : noBlame),
    row("no-owner", { files: placement.noOwnerFiles.length }, placement.noOwnerFiles.map((file) => ({ file })), withBlame ? null : noBlame),
  ];
}

/** The placement as the output shows it: labels, shares and counts, never the owner's name. */
export function describePlacement(outcome: PlacementOutcome) {
  const { placement } = outcome;
  return {
    status: outcome.status,
    mode: outcome.mode,
    reason: outcome.reason,
    band: placement?.band ?? null,
    basis: placement?.basis ?? null,
    newIdentity: placement?.newIdentity ?? false,
    shares: placement?.shares ?? null,
    files: (placement?.files ?? []).map((f) => ({
      file: f.file,
      label: f.label,
      churn: f.churn,
      earlierChanges: f.earlierChanges,
      recentChanges: f.recentChanges,
      familiarity: f.familiarity,
      authorship: f.authorship,
    })),
    blame: outcome.blame,
    factors: outcome.factors,
  };
}
