import { runGit } from "./git.ts";

/**
 * A change as it landed on the first-parent line of a ref: a merge commit together with the commits it brought in, or one
 * commit on the line (a squash, a rebase or a direct commit). Landed changes are what a count of fixes counts, because a fix
 * made on a branch before it merged was caught in review and is not a regression.
 */
export interface Landing {
  /** The commit on the first-parent line. */
  id: string;
  /** Its committer date, in unix seconds. */
  time: number;
  how: "merge" | "direct";
  /** The change's own title: the pull request title of a merge when the message carries one, otherwise the subject. */
  title: string;
  /** What the change is classified by: the title and the rest of the message. For a squash or direct commit, the message itself. */
  text: string;
  /** The non-merge commits of the change, oldest first: the commit itself, or what the merge brought in. */
  members: string[];
  /** The commits only the merge's later parents reach, with their full messages, oldest first. Empty for a direct commit. A merge among them is not listed. */
  branch: { sha: string; message: string }[];
}

interface CommitLine {
  sha: string;
  parents: string[];
  time: number;
  message: string;
}

export interface LandedText {
  /** The pull request title, or null when the message names none. */
  title: string | null;
  /** The title and what follows it when there is a title, otherwise the whole message. */
  text: string;
}

const firstContent = (lines: readonly string[], skip: RegExp): number => lines.findIndex((line) => line.trim() !== "" && !skip.test(line.trim()));

/**
 * What a commit on the first-parent line says about its own change. A squash or direct commit says it in its message. A merge
 * commit says it in the pull request title: GitHub writes "Merge pull request #N from owner/branch", a blank line and the title,
 * some repositories put the title in the subject ("Merge pull request #681: title"), and GitLab writes "Merge branch 'x' into
 * 'main'" and the title on the line after the blank one. A merge that names no title is classified by its subject, as it is.
 */
export function landedText(message: string): LandedText {
  const normalised = message.replace(/\r\n/g, "\n").trim();
  const lines = normalised.split("\n");
  const subject = lines[0]!.trim();
  const body = lines.slice(1);
  const bodyTitle = (skip: RegExp): LandedText => {
    const at = firstContent(body, skip);
    if (at === -1) return { title: null, text: normalised };
    return { title: body[at]!.trim(), text: [body[at]!.trim(), ...body.slice(at + 1)].join("\n").trim() };
  };
  const pull = /^Merge pull request #\d+\b(.*)$/i.exec(subject);
  if (pull) {
    const inSubject = /^(?:\s*:\s*|\s+[-–—]\s+)(\S.*)$/.exec(pull[1]!);
    if (inSubject) return { title: inSubject[1]!.trim(), text: [inSubject[1]!.trim(), ...body].join("\n").trim() };
    return bodyTitle(/^$/);
  }
  if (/^Merge branch '.+' into '.+'/i.test(subject)) return bodyTitle(/^See merge request\b/i);
  return { title: null, text: normalised };
}

async function readGraph(root: string, tip: string): Promise<Map<string, CommitLine>> {
  const out = await runGit(root, ["log", "--format=%H%x1f%P%x1f%ct%x1f%B%x1e", tip]);
  const graph = new Map<string, CommitLine>();
  for (const record of out.split("\x1e")) {
    if (record.trim() === "") continue;
    const [sha, parents, time, ...message] = record.replace(/^\n/, "").split("\x1f");
    graph.set(sha!, { sha: sha!, parents: parents === "" ? [] : parents!.split(" "), time: Number(time), message: message.join("\x1f").trim() });
  }
  return graph;
}

/**
 * The changes on the first-parent line of `tip`, oldest first. The merge style is read from the graph itself: a commit with
 * several parents brings in everything reachable from its later parents that the line did not already have, any other commit
 * on the line stands for itself.
 */
export async function readLandings(root: string, tip: string): Promise<Landing[]> {
  const graph = await readGraph(root, tip);
  const head = (await runGit(root, ["rev-parse", "--verify", `${tip}^{commit}`])).trim();
  const line: CommitLine[] = [];
  for (let at = graph.get(head); at !== undefined; at = at.parents[0] === undefined ? undefined : graph.get(at.parents[0])) line.push(at);
  line.reverse();

  const assigned = new Set<string>(line.map((c) => c.sha));
  const landings: Landing[] = [];
  for (const entry of line) {
    const { title, text } = landedText(entry.message);
    if (entry.parents.length < 2) {
      landings.push({ id: entry.sha, time: entry.time, how: "direct", title: title ?? entry.message.split("\n", 1)[0]!.trim(), text, members: [entry.sha], branch: [] });
      continue;
    }
    const stack = entry.parents.slice(1);
    const found: CommitLine[] = [];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (assigned.has(sha)) continue;
      assigned.add(sha);
      const commit = graph.get(sha);
      if (!commit) continue;
      found.push(commit);
      stack.push(...commit.parents);
    }
    found.sort((a, b) => a.time - b.time || (a.sha < b.sha ? -1 : 1));
    const branch = found.filter((commit) => commit.parents.length < 2).map((commit) => ({ sha: commit.sha, message: commit.message }));
    landings.push({
      id: entry.sha,
      time: entry.time,
      how: "merge",
      title: title ?? entry.message.split("\n", 1)[0]!.trim(),
      text,
      members: branch.map((commit) => commit.sha),
      branch,
    });
  }
  return landings;
}

/** Each non-merge commit's landing, by SHA. */
export function landingOf(landings: readonly Landing[]): Map<string, Landing> {
  const of = new Map<string, Landing>();
  for (const landing of landings) for (const sha of landing.members) of.set(sha, landing);
  return of;
}

/**
 * The changes, which are commits or groups of commits, collected under the landed change each belongs to, in the order the
 * changes landed. A change whose commits landed in several changes is listed under each.
 */
export function groupByLanding<C extends { shas: readonly string[] }>(changes: readonly C[], landings: readonly Landing[]): { landing: Landing; changes: C[] }[] {
  const of = landingOf(landings);
  const groups = new Map<Landing, C[]>();
  for (const change of changes) {
    for (const landing of new Set(change.shas.flatMap((sha) => of.get(sha) ?? []))) {
      const list = groups.get(landing);
      if (list) list.push(change);
      else groups.set(landing, [change]);
    }
  }
  return landings.flatMap((landing) => (groups.has(landing) ? [{ landing, changes: groups.get(landing)! }] : []));
}
