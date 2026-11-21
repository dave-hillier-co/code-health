import { areaOf, weekOf, type Pairing, type RawIdentity } from "./identity-evidence.ts";
import { findAgentTrailers } from "./identity-classify.ts";
import { identityKey, type Address } from "./identity-names.ts";
import { runGit } from "./git.ts";
import { isPlatformKey, signaturesIn } from "./signing-keys.ts";
import type { HistoryView } from "./read.ts";

/** Commits touching more paths than this say little about who works where, so they add no file or area evidence. */
export const MAX_PATHS_FOR_EVIDENCE = 100;

export interface AgentUse {
  /** The `Co-Authored-By` value naming the agent. */
  value: string;
  pattern: string;
  commits: number;
}

export interface IdentityFacts {
  raws: RawIdentity[];
  pairing: Pairing;
  /** Commits in the window per raw identity key (`Name <email>`), by committer date. */
  windowCommits: Map<string, number>;
  /** First lines of each raw identity's commit messages, to spot accounts that only bump versions or merge. */
  subjects: Map<string, string[]>;
  agents: AgentUse[];
  /** The author of each commit as written, by SHA, to attribute blamed lines. */
  authorOfCommit: Map<string, Address>;
}

const isPlatform = (name: string, email: string): boolean =>
  email.toLowerCase() === "noreply@github.com" || name.toLowerCase() === "github" || name.toLowerCase() === "github enterprise";

/** Committer name and email per commit, for the commits reachable from `ref`. */
async function readCommitters(root: string, ref: string): Promise<Map<string, Address>> {
  const out = await runGit(root, ["log", "--format=%H%x1f%cn%x1f%ce", "--no-abbrev", ref]);
  const committers = new Map<string, Address>();
  for (const line of out.split("\n")) {
    if (line === "") continue;
    const [sha, name, email] = line.split("\x1f");
    if (sha !== undefined) committers.set(sha, { name: name ?? "", email: email ?? "" });
  }
  return committers;
}

/** The key that signed each signed commit reachable from `ref`, read from the commits' own signatures so no key needs to be trusted or fetched. */
async function readSigningKeys(root: string, ref: string): Promise<Map<string, string>> {
  return signaturesIn(await runGit(root, ["log", "--format=raw", "--no-abbrev", "--no-merges", ref]));
}

/**
 * Everything the identity commands read from history: each author identity as
 * written with its activity, who committed whose commits, agent trailers and
 * commit subjects. Merges are not in the view and add nothing here.
 *
 * Authors are as written in commits. Mapping them is a separate step, so the
 * working tree's mailmap can be read as the user edits it.
 */
export async function gatherIdentityFacts(
  root: string,
  view: HistoryView,
  options: { windowSince: number; agentPatterns?: readonly string[] },
): Promise<IdentityFacts> {
  const committers = await readCommitters(root, view.headSha);
  const signingKeys = await readSigningKeys(root, view.headSha);
  const raws = new Map<string, RawIdentity>();
  const windowCommits = new Map<string, number>();
  const subjects = new Map<string, string[]>();
  const agents = new Map<string, AgentUse>();
  const authorOfCommit = new Map<string, Address>();
  const committersOfAuthor = new Map<string, Map<string, number>>();
  const authorsOfCommitter = new Map<string, Set<string>>();

  for (const commit of view.commits) {
    const author: Address = { name: commit.authorName, email: commit.authorEmail };
    const key = identityKey(author);
    authorOfCommit.set(commit.sha, author);
    let raw = raws.get(key);
    if (!raw) {
      raw = {
        ...author,
        mappedName: author.name,
        mappedEmail: author.email,
        commits: 0,
        first: commit.authorDate,
        last: commit.authorDate,
        files: new Set(),
        weeks: new Map(),
        areaCounts: new Map(),
        signingKeys: new Set(),
      };
      raws.set(key, raw);
    }
    const signingKey = signingKeys.get(commit.sha);
    if (signingKey !== undefined && !isPlatformKey(signingKey)) raw.signingKeys!.add(signingKey);
    raw.commits++;
    raw.first = Math.min(raw.first, commit.authorDate);
    raw.last = Math.max(raw.last, commit.authorDate);
    if (commit.committerDate >= options.windowSince) windowCommits.set(key, (windowCommits.get(key) ?? 0) + 1);

    if (commit.changes.length <= MAX_PATHS_FOR_EVIDENCE) {
      const week = weekOf(commit.authorDate);
      const areas = raw.weeks.get(week) ?? new Set<string>();
      for (const change of commit.changes) {
        raw.files.add(change.path);
        const area = areaOf(change.path);
        areas.add(area);
        raw.areaCounts.set(area, (raw.areaCounts.get(area) ?? 0) + 1);
      }
      if (areas.size > 0) raw.weeks.set(week, areas);
    }

    const subject = commit.message.split("\n", 1)[0] ?? "";
    const list = subjects.get(key) ?? [];
    list.push(subject);
    subjects.set(key, list);

    for (const trailer of findAgentTrailers(commit.message, options.agentPatterns ?? [])) {
      const use = agents.get(trailer.value) ?? { value: trailer.value, pattern: trailer.pattern, commits: 0 };
      use.commits++;
      agents.set(trailer.value, use);
    }

    const committer = committers.get(commit.sha);
    if (committer && !isPlatform(committer.name, committer.email)) {
      const a = author.email.toLowerCase();
      const c = committer.email.toLowerCase();
      const counts = committersOfAuthor.get(a) ?? new Map<string, number>();
      counts.set(c, (counts.get(c) ?? 0) + 1);
      committersOfAuthor.set(a, counts);
      const authors = authorsOfCommitter.get(c) ?? new Set<string>();
      authors.add(a);
      authorsOfCommitter.set(c, authors);
    }
  }

  const compare = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return {
    raws: [...raws.entries()].sort(([p], [q]) => compare(p, q)).map(([, r]) => r),
    pairing: { committersOfAuthor, authorsOfCommitter },
    windowCommits,
    subjects,
    agents: [...agents.values()].sort((p, q) => compare(p.value, q.value)),
    authorOfCommit,
  };
}
