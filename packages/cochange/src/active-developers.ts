import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { readActivity } from "./abandonment/activity.ts";
import { readKnowledgeSettings, readOverrides, type KnowledgeOverrides, type KnowledgeSettings } from "./abandonment/settings.ts";
import type { LoadedHistory } from "./history-access.ts";

/**
 * The one definition of an active developer, for everything in cochange that says someone is still here:
 * the abandonment model and its successors, the reviewers change-risk suggests, and the file holders
 * placement looks for. A developer is active at a date when they have a commit in the window that ends
 * there (`cochange.knowledge.activityWindowMonths`, default 6), unless the local overrides say otherwise.
 * Bots, services and agents are never developers (see `readActivity`).
 */

/**
 * A month as the activity window measures it: 30.4375 days. Windows and periods are fixed lengths of
 * time, so a date is active or not by exact arithmetic and never by the calendar.
 */
export const SECONDS_PER_MONTH = 2_629_800;

export const windowSecondsOf = (settings: Pick<KnowledgeSettings, "activityWindowMonths">): number => settings.activityWindowMonths * SECONDS_PER_MONTH;

export interface ActivityRule {
  windowSeconds: number;
  /** Corrections kept locally, by mapped identity (`Name <email>`). They describe the present. */
  overrides: Pick<KnowledgeOverrides, "active" | "inactive">;
}

/** Whether someone with these commit times is active at `asOf`: a commit in the window ending there, and none is known after it. */
export function activeAt(times: readonly number[], asOf: number, windowSeconds: number): boolean {
  let last: number | undefined;
  for (const t of times) {
    if (t > asOf) break;
    last = t;
  }
  return last !== undefined && last > asOf - windowSeconds;
}

/** `activeAt`, corrected by the overrides: someone marked inactive is not active, someone marked active is. */
export function isActiveDeveloper(key: string, times: readonly number[], asOf: number, rule: ActivityRule): boolean {
  if (rule.overrides.inactive.has(key)) return false;
  if (rule.overrides.active.has(key)) return true;
  return activeAt(times, asOf, rule.windowSeconds);
}

/** The name of a mapped identity, `Name <email>`, without the address; the part of the address before `@` when the name is empty. */
export const displayNameOf = (identity: string): string => identity.replace(/\s*<[^>]*>$/, "").trim() || emailOf(identity).split("@")[0]!;

/** The lower-case address of a mapped identity, `Name <email>`. */
export const emailOf = (identity: string): string => (/<([^>]*)>$/.exec(identity)?.[1] ?? "").toLowerCase();

export interface ActiveDevelopers {
  /** Whether the person with this address is active at the date the set was read for. */
  has(email: string): boolean;
}

/**
 * Who is active at `asOf`, by address, under the configured window and the local overrides. It reads the
 * same activity the abandonment analysis does, so both name the same people. It does not need
 * `cochange.knowledge.enabled`: that gates the analysis of lost knowledge, not who has committed lately.
 */
export async function readActiveDevelopers(context: CommandContext, history: LoadedHistory, asOf: number): Promise<ActiveDevelopers> {
  const { root } = context.repo;
  const settings = readKnowledgeSettings(context.config.effective);
  const rule: ActivityRule = { windowSeconds: windowSecondsOf(settings), overrides: readOverrides(root) };
  const activity = await readActivity(root, history.view.commits, { localMailmap: history.identities.localMailmap, matcher: history.identities.matcher });
  const active = new Set<string>();
  for (const [key, times] of activity.commits) if (isActiveDeveloper(key, times, asOf, rule)) active.add(emailOf(key));
  return { has: (email) => active.has(email.toLowerCase()) };
}
