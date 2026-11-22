export interface SessionRecord {
  sessionId: string;
  /** Unix seconds of the session's first event: the history a partner is drawn from ends here. */
  startedAt: number;
  /** Repo paths in the order edited, one entry per edit call, as identities at the analysed commit. */
  edits: readonly string[];
}

export interface Opportunity {
  sessionId: string;
  file: string;
  /** Some coupled partner was edited later in the session. */
  followed: boolean;
}

/**
 * The agent completeness outcome: for each file the agent edited that has coupled partners
 * not yet edited in the session, whether one of them was edited later in the same session. A file counts
 * once per session, at its first edit. Partners already edited before that point are not an opportunity,
 * since only partners not yet edited could still follow. `partnersOf` is asked for the session's own moment, so
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
