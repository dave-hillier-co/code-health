import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ReportBuild } from "@code-health/report/report-model";
import type { CommandContext } from "./run-cli.ts";

/**
 * A stored report build, so that `--notes ... --format html` does not compute the report a second time after
 * `--slots` computed it. A build is reused only when everything it can depend on is the same as when it was
 * computed:
 *
 * - the kind, its positional arguments, its option values (`--slots`, `--notes`, `--format`, `--out` and `--no-cache` left out), the
 *   directory the command ran from, and `ReportKind.dependsOn`: the file name of the entry;
 * - HEAD, the config hash, and the program that built it (the size and modification time of the running script);
 * - a clean working tree: no edit to a tracked file and no untracked file that is not ignored (except the files
 *   named by `--notes` and `--out`), because the analyses read the files on disk when there is uncommitted work.
 *   A run on an unclean tree neither reads nor stores a build;
 * - the stored results in `.cache/code-health/reports/`, the identity files (`.mailmap`,
 *   `.code-health/identity-decisions.json` and the local ones), `.gitattributes`, and the shallow file: each
 *   one's size and modification time, taken after the build. The history store and the blame store are not in
 *   the list: they are keyed by commit and blob, so they hold the same data for the same HEAD, and opening them
 *   changes their modification time.
 *
 * A build is not stored when a file other than the stored results changed while it ran. Stored results change
 * during a build because the analyses it runs write them, so the snapshot of them is taken after the build;
 * another command that writes stored results at the same moment can leave a build that matches the later
 * snapshot, and `--no-cache` replaces it.
 */

const FORMAT = 1;
/** The options that choose what to print and not what to compute. `compact` is not one of them: the change report builds a shorter page for it. */
const OUTPUT_KEYS = ["slots", "notes", "format", "out", "no-cache"];

/** Files whose content changes what an analysis reads, and that are not covered by HEAD when they are untracked or ignored. */
const WATCHED = [".mailmap", ".code-health/identity-decisions.json", ".code-health/local/mailmap", ".code-health/local/identity-decisions.json", ".gitattributes"];

interface Entry {
  format: number;
  head: string;
  config: string;
  program: string;
  dependsOn: unknown;
  /** Stored results and stores, as they were after the build. */
  state: string;
  build: ReportBuild;
  stderrNotices: string[];
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** The stat of a file as one string, or "-" when it does not exist. */
function stat(file: string): string {
  try {
    const s = statSync(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "-";
  }
}

function statDirectory(dir: string, accept: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(accept)
    .sort()
    .map((name) => `${name}=${stat(join(dir, name))}`);
}

/** What the analyses read that is not in HEAD or the config: stored results and identity files. Split in two: the files a build writes itself (stored results), and the files it does not. */
export function dependencyState(root: string): { written: string; other: string } {
  const common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const written = statDirectory(join(root, ".cache", "code-health", "reports"), (name) => name.endsWith(".json")).map((s) => `reports/${s}`);
  const other = [...WATCHED.map((file) => `${file}=${stat(join(root, file))}`), `shallow=${stat(join(common, "shallow"))}`];
  return { written: written.join("\n"), other: other.join("\n") };
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function programId(): string {
  const script = process.argv[1];
  return script === undefined ? "-" : stat(script);
}

/** The text of a value with its keys sorted, so equal values give equal text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The path with symbolic links in its folders resolved, so a path given from a linked folder equals the one git prints. The file itself need not exist. */
function real(path: string): string {
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    return path;
  }
}

/**
 * Whether the working tree holds nothing the commit at HEAD does not: no edit to a tracked file and no untracked
 * file that is not ignored. The files this run itself reads or writes (`--notes`, `--out`) are not counted, since
 * the agent writes the notes between the two steps.
 */
function isClean(context: CommandContext): boolean {
  const root = context.repo.root;
  const own = [context.values.notes, context.values.out].flatMap((value) => (typeof value === "string" ? [real(resolve(context.cwd, value))] : []));
  try {
    const entries = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=normal"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\0")
      .filter((entry) => entry !== "");
    return entries.every((entry) => entry.startsWith("?? ") && own.includes(real(resolve(root, entry.slice(3)))));
  } catch {
    return false;
  }
}

function entryFile(context: CommandContext, kind: string, dependsOn: unknown): string {
  const values = Object.fromEntries(Object.entries(context.values).filter(([key]) => !OUTPUT_KEYS.includes(key)));
  const key = digest(canonical({ positionals: context.positionals, values, cwd: context.cwd, dependsOn })).slice(0, 16);
  return join(context.repo.root, ".cache", "code-health", "report-builds", `${kind}.${key}.json`);
}

function read(file: string): Entry | undefined {
  try {
    const entry = JSON.parse(readFileSync(file, "utf8")) as Entry;
    return entry.format === FORMAT ? entry : undefined;
  } catch {
    return undefined;
  }
}

function write(file: string, entry: Entry): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(entry));
    renameSync(temporary, file);
  } catch {
    rmSync(temporary, { force: true });
  }
}

/**
 * The build for `kind`, from the stored one when every dependency listed above is unchanged, and otherwise
 * computed and stored. `--no-cache` computes and stores. `dependsOn` is `ReportKind.dependsOn`: what else the
 * build depends on, such as the commits a branch name resolves to.
 */
export async function cachedBuild(
  context: CommandContext,
  kind: string,
  dependsOn: (() => unknown | Promise<unknown>) | undefined,
  compute: () => Promise<ReportBuild>,
): Promise<ReportBuild> {
  const root = context.repo.root;
  if (!isClean(context)) return compute();
  const extra = dependsOn === undefined ? null : await dependsOn();
  const file = entryFile(context, kind, extra);
  const program = programId();
  const before = dependencyState(root);
  if (context.values["no-cache"] !== true) {
    const entry = read(file);
    if (
      entry !== undefined &&
      entry.head === context.repo.head &&
      entry.config === context.config.hash &&
      entry.program === program &&
      canonical(entry.dependsOn) === canonical(extra) &&
      entry.state === digest(`${before.written}\n--\n${before.other}`)
    ) {
      context.stderrNotices = [...(context.stderrNotices ?? []), ...entry.stderrNotices];
      return entry.build;
    }
  }
  const notices = context.stderrNotices?.length ?? 0;
  const build = await compute();
  const after = dependencyState(root);
  if (after.other !== before.other || !isClean(context)) return build;
  let stored: ReportBuild;
  try {
    stored = JSON.parse(JSON.stringify(build)) as ReportBuild;
  } catch {
    return build;
  }
  write(file, {
    format: FORMAT,
    head: context.repo.head,
    config: context.config.hash,
    program,
    dependsOn: extra,
    state: digest(`${after.written}\n--\n${after.other}`),
    build: stored,
    stderrNotices: (context.stderrNotices ?? []).slice(notices),
  });
  return stored;
}
