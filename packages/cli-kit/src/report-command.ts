import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { validateNotes } from "@code-health/report/notes";
import { ReportError, type Format, type Report, type ReportBuild } from "@code-health/report/protocol";
import { renderReport } from "@code-health/report/render";
import { slotsDocument } from "@code-health/report/slots-document";
import { makeStamp } from "@code-health/report/stamp";
import type { OptionSpec } from "./args.ts";
import { usageError } from "./errors.ts";
import type { Command, CommandContext, CommandOutput, SubcommandHelp } from "./run-cli.ts";
import { serialise } from "./serialise.ts";

/** One kind of report a plugin offers: the word typed after `report`, and the data and slots it builds. */
export interface ReportKind {
  summary: string;
  /** The positional arguments after the kind, shown in its usage line: `FILE`, `[BASE..HEAD]`. */
  usage?: string;
  /** The kind's own options. */
  options?: OptionSpec;
  /** What each of the kind's own options means. */
  optionHelp?: Record<string, string>;
  /**
   * Computes the report's data, its slots and its stamp inputs. `context.positionals` holds the arguments after the
   * kind. Everything in the result must follow from the repository, the config and the arguments, so a second run
   * gives the same data and the same stamp. Put whatever else the data depends on (stored results read, a window)
   * in `inputs`.
   */
  build(context: CommandContext): ReportBuild | Promise<ReportBuild>;
}

const protocolOptions = {
  slots: { type: "boolean" },
  notes: { type: "string" },
  format: { type: "string" },
  out: { type: "string" },
  compact: { type: "boolean" },
} satisfies OptionSpec;

const protocolOptionHelp: Record<string, string> = {
  slots: "print the report's data and judgement slots as JSON",
  notes: "the notes file to render: { stamp, notes }, with one entry per slot id",
  format: "html or md. md without --notes is a data-only draft; html needs --notes",
  out: "write the output to this file instead of stdout",
  compact: "md only: the short header used in a pull request comment",
};

const protocolOptionNames = Object.keys(protocolOptions);

/**
 * A plugin's `report` command. Each kind runs in two steps: `--slots` prints JSON (the kind, a stamp, the data and
 * the slots), and `--notes FILE --format html|md` renders the agent's notes. Rendering exits with 2, naming every
 * problem, when the stamp does not match, a slot has no entry or an empty one, an entry names no slot, or a
 * shape or length is wrong. `--format md` alone prints a draft with the slots marked "not yet written".
 * A plugin adds a report by adding a kind here.
 */
export function reportCommand(kinds: Record<string, ReportKind>): Command {
  const names = Object.keys(kinds);
  const kindOptions = Object.assign({}, ...Object.values(kinds).map((k) => k.options ?? {})) as OptionSpec;
  const subcommands: Record<string, SubcommandHelp> = Object.fromEntries(
    Object.entries(kinds).map(([name, kind]): [string, SubcommandHelp] => [name, { summary: kind.summary, options: [...protocolOptionNames, ...Object.keys(kind.options ?? {})] }]),
  );
  return {
    summary: "Write a report: --slots prints its data and judgement slots, --notes renders the notes as html or markdown",
    usage: "<report> [args]",
    options: { ...kindOptions, ...protocolOptions },
    optionHelp: Object.assign({}, ...Object.values(kinds).map((k) => k.optionHelp ?? {}), protocolOptionHelp),
    subcommands,
    async run(context): Promise<CommandOutput> {
      const [name, ...args] = context.positionals;
      if (name === undefined) throw usageError(`report needs a report name: ${names.join(", ")}`);
      const kind = kinds[name];
      if (kind === undefined) throw usageError(`unknown report "${name}"; reports: ${names.join(", ")}`);
      const request = readRequest(context);
      const build = await kind.build({ ...context, positionals: args });
      const report: Report = {
        ...build,
        kind: name,
        header: { repo: repoName(context.repo.root), commit: context.repo.head, date: context.repo.headCommitDate.slice(0, 10), configHash: context.config.hash, ...build.header },
        stamp: makeStamp(name, context.repo.head, context.config.hash, build.inputs),
      };
      try {
        const text = request.slots ? serialise(slotsDocument(report)) : produce(report, request, context.cwd);
        if (request.out === undefined) return { results: [], text };
        const file = resolve(context.cwd, request.out);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
        return { results: [], text: `wrote ${request.out}\n` };
      } catch (error) {
        if (error instanceof ReportError) throw usageError(error.message);
        throw error;
      }
    },
  };
}

interface Request {
  slots: boolean;
  notes: string | undefined;
  format: Format | undefined;
  out: string | undefined;
  compact: boolean;
}

function readRequest(context: CommandContext): Request {
  const { slots, notes, format, out, compact } = context.values;
  const text = (value: unknown, option: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value === "") throw usageError(`--${option} needs a value`);
    return value;
  };
  const chosen = text(format, "format");
  if (chosen !== undefined && chosen !== "html" && chosen !== "md") throw usageError(`--format must be html or md, got "${chosen}"`);
  const request: Request = { slots: slots === true, notes: text(notes, "notes"), format: chosen as Format | undefined, out: text(out, "out"), compact: compact === true };
  if (request.slots) {
    if (request.notes !== undefined || request.format !== undefined || request.compact) throw usageError("--slots prints the slots and takes no --notes, --format or --compact");
  } else if (request.notes === undefined && request.format !== "md") {
    throw usageError(
      request.format === "html"
        ? "html needs notes: run with --slots, write the notes file, then run with --notes FILE --format html"
        : "say what to print: --slots for the data and slots, --notes FILE --format html|md to render notes, or --format md for a draft without notes",
    );
  }
  if (request.compact && (request.format ?? "md") !== "md") throw usageError("--compact is for --format md");
  return request;
}

function produce(report: Report, request: Request, cwd: string): string {
  const format = request.format ?? "md";
  if (request.notes === undefined) return renderReport(report, format, undefined, { compact: request.compact });
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(resolve(cwd, request.notes), "utf8"));
  } catch (error) {
    throw new ReportError(`cannot read the notes file ${request.notes}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return renderReport(report, format, validateNotes(report, document), { compact: request.compact });
}

/** The repository's name for the report header: the folder the working tree is in. */
function repoName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}
