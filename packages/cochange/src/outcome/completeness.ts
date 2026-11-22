export interface SessionRecord {
  sessionId: string;
  /** Unix seconds of the session's first event: the history the hook could have drawn on ends here. */
  startedAt: number;
  /** Repo paths in the order edited, one entry per edit call, as identities at the analysed commit. */
  edits: readonly string[];
  /** The hook ran in this session. */
  hook: boolean;
  /** Files the hook spoke about in this session. */
  spokenAbout: ReadonlySet<string>;
}

export interface Opportunity {
  sessionId: string;
  file: string;
  /** Some coupled partner was edited later in the session. */
  followed: boolean;
  /** The hook spoke about the file. */
  briefed: boolean;
}

/**
 * The agent outcome of the completeness hook: for each file the agent edited that has coupled partners
 * not yet edited in the session, whether one of them was edited later in the same session. A file counts
 * once per session, at its first edit. Partners already edited before that point are not an opportunity,
 * since the hook only names partners not yet edited. `partnersOf` is asked for the session's own moment, so
 * the changes the session went on to commit cannot have made a partner it is then counted as following.
 */
export function findOpportunities(sessions: readonly SessionRecord[], partnersOf: (file: string, session: SessionRecord) => readonly string[]): Opportunity[] {
  const found: Opportunity[] = [];
  for (const session of sessions) {
    const firstEdit = new Map<string, number>();
    session.edits.forEach((file, position) => {
      if (!firstEdit.has(file)) firstEdit.set(file, position);
    });
    for (const [file, position] of firstEdit) {
      const unedited = partnersOf(file, session).filter((partner) => {
        const at = firstEdit.get(partner);
        return at === undefined || at > position;
      });
      if (unedited.length === 0) continue;
      found.push({
        sessionId: session.sessionId,
        file,
        followed: unedited.some((partner) => firstEdit.has(partner)),
        briefed: session.spokenAbout.has(file),
      });
    }
  }
  return found;
}

export interface Rate {
  opportunities: number;
  followed: number;
  /** followed / opportunities, null when there are none. */
  rate: number | null;
}

export const rateOf = (items: readonly Opportunity[]): Rate => {
  const followed = items.filter((o) => o.followed).length;
  return { opportunities: items.length, followed, rate: items.length === 0 ? null : followed / items.length };
};

export type Conclusion = "higher" | "lower" | "no-change" | "insufficient-sample" | "not-measured";

/**
 * Hook sessions against sessions without the hook. Nothing is concluded from fewer than `minSamples`
 * opportunities in either arm, nor from a difference within `noisePercent` of the no-hook rate.
 */
export function compareArms(hook: Rate, noHook: Rate, minSamples: number, noisePercent: number): { difference: number | null; conclusion: Conclusion } {
  if (hook.rate === null || noHook.rate === null) return { difference: null, conclusion: "not-measured" };
  const difference = hook.rate - noHook.rate;
  if (Math.min(hook.opportunities, noHook.opportunities) < minSamples) return { difference, conclusion: "insufficient-sample" };
  const noise = (noHook.rate * noisePercent) / 100;
  return { difference, conclusion: Math.abs(difference) <= noise ? "no-change" : difference > 0 ? "higher" : "lower" };
}
