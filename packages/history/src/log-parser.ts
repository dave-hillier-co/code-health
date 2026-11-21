export type ChangeStatus = "A" | "M" | "D" | "R" | "T";

export interface ParsedChange {
  /** Path after the change (the old path for deletions). */
  path: string;
  /** Previous path, for renames only. */
  oldPath: string | null;
  status: ChangeStatus;
  /** Rename similarity percentage, for renames only. */
  similarity: number | null;
  added: number | null;
  deleted: number | null;
  binary: boolean;
  /** Blob SHA after the change, null for deletions. */
  blob: string | null;
}

export interface ParsedCommit {
  sha: string;
  parents: string[];
  /** Author as written in the commit. */
  authorName: string;
  authorEmail: string;
  /** Author after .mailmap. */
  mappedName: string;
  mappedEmail: string;
  /** Unix seconds. */
  authorDate: number;
  committerDate: number;
  message: string;
  changes: ParsedChange[];
}

export interface LogSettings {
  /** Rename similarity percentage passed to -M. */
  similarity: number;
  /** diff.renameLimit, passed on the command line. */
  renameLimit: number;
}

const RS = "\x1e";
const US = "\x1f";
const FORMAT = ["%H", "%P", "%an", "%ae", "%aN", "%aE", "%at", "%ct", "%B"].join("%x1f");

/**
 * Arguments for reading specific commits (given on stdin, with --no-walk) with
 * every setting that could change the result passed explicitly, so the user's
 * git config cannot influence what is stored. Merges are included (they
 * produce no file changes) because the parent graph is needed for reachability.
 */
export function logArgs(settings: LogSettings): string[] {
  return [
    "-c",
    `diff.renameLimit=${settings.renameLimit}`,
    "-c",
    "core.quotepath=off",
    "log",
    "--stdin",
    "--no-walk=unsorted",
    `-M${settings.similarity}%`,
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-show-signature",
    "--raw",
    "--numstat",
    "--no-abbrev",
    "-z",
    `--format=${RS}${FORMAT}`,
  ];
}

const RAW = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/;
const NUMSTAT = /^(\d+|-)\t(\d+|-)\t(.*)$/s;
const NULL_SHA = /^0+$/;

export function parseLog(output: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  for (const record of output.split(RS)) {
    if (record === "") continue;
    commits.push(parseRecord(record));
  }
  return commits;
}

function parseRecord(record: string): ParsedCommit {
  const tokens = record.split("\0");
  const header = tokens.shift() ?? "";
  const fields = header.split(US);
  const [sha, parents, authorName, authorEmail, mappedName, mappedEmail, authorDate, committerDate] = fields;
  const message = fields.slice(8).join(US).replace(/\n+$/, "");
  if (sha === undefined || parents === undefined || authorDate === undefined || committerDate === undefined) {
    throw new Error(`Malformed git log record: ${JSON.stringify(header)}`);
  }
  if (tokens[0]?.startsWith("\n")) tokens[0] = tokens[0].slice(1);
  while (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();

  const raws: { status: ChangeStatus; similarity: number | null; path: string; oldPath: string | null; blob: string | null }[] = [];
  let i = 0;
  while (i < tokens.length) {
    const match = RAW.exec(tokens[i]!);
    if (!match) break;
    const [, , , , newBlob, letter, score] = match;
    i++;
    const status = (letter === "R" || letter === "C" ? "R" : letter) as ChangeStatus;
    let path: string;
    let oldPath: string | null = null;
    if (letter === "R" || letter === "C") {
      oldPath = tokens[i++]!;
      path = tokens[i++]!;
    } else {
      path = tokens[i++]!;
    }
    raws.push({
      status,
      similarity: status === "R" ? Number(score) : null,
      path,
      oldPath,
      blob: newBlob === undefined || NULL_SHA.test(newBlob) ? null : newBlob,
    });
  }

  const changes: ParsedChange[] = [];
  for (const raw of raws) {
    const match = NUMSTAT.exec(tokens[i] ?? "");
    if (!match) throw new Error(`Missing numstat for ${raw.path} in commit ${sha}`);
    i++;
    if (match[3] === "") i += 2; // rename: old and new path follow as separate tokens
    const binary = match[1] === "-";
    changes.push({
      ...raw,
      added: binary ? null : Number(match[1]),
      deleted: binary ? null : Number(match[2]),
      binary,
    });
  }

  return {
    sha,
    parents: parents === "" ? [] : parents.split(" "),
    authorName: authorName ?? "",
    authorEmail: authorEmail ?? "",
    mappedName: mappedName ?? "",
    mappedEmail: mappedEmail ?? "",
    authorDate: Number(authorDate),
    committerDate: Number(committerDate),
    message,
    changes,
  };
}
