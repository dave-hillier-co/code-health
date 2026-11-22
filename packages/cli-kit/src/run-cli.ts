import { discoverCommand, parseArguments, type OptionSpec, type ParsedArguments } from "./args.ts";
import { explainConfig, loadConfig, type LoadedConfig, type PluginConfigSpec } from "./config.ts";
import { builtinOmissions, resetBuiltinOmissions } from "./builtin-excludes.ts";
import { buildDocument } from "./document.ts";
import { assertNodeVersion } from "./environment.ts";
import { CliError, ExitCode, usageError } from "./errors.ts";
import { readRepoState, type RepoState } from "./repo-state.ts";
import { shapeResults } from "./results.ts";
import { serialise } from "./serialise.ts";
import { renderTable } from "./table.ts";

/** Whether a command stored its result as a report for other plugins to read, and why not when it did not. */
export interface ReportStatus {
  stored: boolean;
  /** Why nothing was stored. Absent when the report was stored. */
  reason?: string;
}

export interface CommandContext {
  repo: RepoState;
  config: LoadedConfig;
  positionals: string[];
  /** Values of the command's own options. */
  values: ParsedArguments["values"];
  /** Set by a command that may store a report, so the run prints whether it did. Left unset by commands that never do. */
  report?: ReportStatus;
  /** Lines a command wants printed to stderr after its output, such as an input it ignored and why. */
  stderrNotices?: string[];
}

export interface CommandOutput {
  /** Everything the results depend on beyond repo, config and history. */
  inputs?: Record<string, unknown>;
  /** Sections emitted beside the envelope in JSON, such as `evidence` or `window`. Not shown in tables. */
  extra?: Record<string, unknown>;
  /** A list of rows (sorted, limited and projected by the kit) or any other JSON value. */
  results: unknown;
  /** Table columns, and the valid values for --fields. Defaults to the keys of the first row. */
  columns?: string[];
  /** Lines a table run prints after the rows, such as a check that does not apply. JSON carries the same facts in the command's own fields. */
  notices?: string[];
  /** The command's check failed (findings above guideline or a regression): exit 1. */
  failed?: boolean;
}

/** What `--help` says about one subcommand of a command that dispatches on its first positional. */
export interface SubcommandHelp {
  summary: string;
  /** Names of the command's options that this subcommand takes. */
  options?: readonly string[];
  /** A maintainer command: runnable, and described by `<subcommand> --help`, but left out of the command's own `--help` listing. */
  hidden?: boolean;
}

export interface Command {
  summary: string;
  /** The positional arguments, shown in the usage line of the command's help: `<path>...`, `<from>-><to>`. */
  usage?: string;
  options?: OptionSpec;
  /** What each of the command's own options means, including the values it accepts, shown in the command's help. */
  optionHelp?: Record<string, string>;
  /** The subcommands the command dispatches to, so `--help` can describe each with only its own options. */
  subcommands?: Record<string, SubcommandHelp>;
  /** Names of options that only hidden subcommands take, left out of the command's `--help` listing. */
  hiddenOptions?: readonly string[];
  run(context: CommandContext): CommandOutput | Promise<CommandOutput>;
}

export interface Rule {
  summary: string;
  explanation: string;
}

export interface CliDefinition {
  tool: string;
  schemaVersion?: number;
  config: PluginConfigSpec;
  commands: Record<string, Command>;
  /** Recommendation rules, described by `explain <rule>`. */
  rules?: Record<string, Rule>;
  /** Turns the errors of the libraries a CLI uses into usage or environment errors. */
  mapError?: (error: unknown) => CliError | undefined;
}

export interface CliIo {
  argv: string[];
  cwd: string;
  stdout: { write(text: string): unknown; isTTY?: boolean };
  stderr: { write(text: string): unknown };
}

const configExplain: Command = {
  summary: "Print the effective config and where each value came from",
  run: ({ config, repo }) => ({
    inputs: { file: config.file === null ? null : config.file.slice(repo.root.length + 1) },
    results: explainConfig(config),
    columns: ["path", "value", "source"],
  }),
};

/** Runs one CLI invocation and returns its exit code. The caller exits the process. */
export async function runCli(cli: CliDefinition, io: CliIo): Promise<number> {
  const jsonErrors = io.argv.includes("--json");
  try {
    assertNodeVersion();
    return await execute(cli, io);
  } catch (error) {
    const failure =
      error instanceof CliError
        ? error
        : (cli.mapError?.(error) ??
          new CliError(ExitCode.Environment, "internal", error instanceof Error ? error.message : String(error)));
    io.stderr.write(
      jsonErrors
        ? serialise({ error: { code: failure.code, message: failure.message, exitCode: failure.exitCode } })
        : `${cli.tool}: ${failure.message}\n`,
    );
    return failure.exitCode;
  }
}

async function execute(cli: CliDefinition, io: CliIo): Promise<number> {
  const started = Date.now();
  const name = discoverCommand(io.argv);

  if (name === undefined) {
    if (io.argv.includes("--help")) {
      io.stdout.write(helpText(cli));
      return ExitCode.Success;
    }
    io.stderr.write(helpText(cli));
    return ExitCode.Usage;
  }

  if (name === "explain" && cli.rules && !cli.commands.explain) return explain(cli, discoverPositionals(io.argv), io);

  const command = name === "config" ? configExplain : cli.commands[name];
  if (!command) throw usageError(`unknown command "${name}"; run with --help to list commands`);

  const args = parseArguments(io.argv, command.options);
  if (args.help) {
    io.stdout.write(commandHelp(cli, name, command, args.positionals[0]));
    return ExitCode.Success;
  }

  let commandName = name;
  if (name === "config") {
    if (args.positionals[0] !== "explain") throw usageError("usage: config explain");
    commandName = "config explain";
  }

  const repo = readRepoState(io.cwd);
  const config = loadConfig(repo.root, cli.config);
  const context: CommandContext = { repo, config, positionals: args.positionals, values: args.values };
  resetBuiltinOmissions();
  const output = await command.run(context);
  const builtin = builtinOmissions();
  const omittedByBuiltin = Object.keys(builtin).length === 0 ? {} : { omittedByBuiltinExcludes: builtin };
  for (const line of context.stderrNotices ?? []) io.stderr.write(`${line}\n`);

  const columns = output.columns ?? (Array.isArray(output.results) ? Object.keys(output.results[0] ?? {}) : []);
  const { results, truncated } = shapeResults(output.results, { limit: args.limit, fields: args.fields, columns });

  if (args.json || !io.stdout.isTTY) {
    io.stdout.write(
      serialise(
        buildDocument({
          schemaVersion: cli.schemaVersion ?? 1,
          tool: cli.tool,
          command: commandName,
          repo: { head: repo.head, dirty: repo.dirty },
          configHash: config.hash,
          inputs: output.inputs,
          extra: { ...output.extra, ...omittedByBuiltin },
          results,
          truncated,
          meta: {
            durationMs: Date.now() - started,
            generatedAt: new Date().toISOString(),
            gitVersion: repo.gitVersion,
            node: process.versions.node,
            ...(context.report === undefined ? {} : { report: context.report }),
          },
        }),
      ),
    );
  } else if (Array.isArray(results)) {
    io.stdout.write(renderTable(results as Record<string, unknown>[], args.fields ?? columns, truncated));
    for (const notice of output.notices ?? []) io.stdout.write(`Notice: ${notice}.\n`);
    const counted = Object.entries(builtin);
    if (counted.length > 0) {
      io.stdout.write(`Notice: built-in excludes omitted ${counted.map(([entry, count]) => `${count} ${count === 1 ? "file" : "files"} (${entry})`).join(", ")}.\n`);
    }
    if (context.report?.stored === false) io.stdout.write(`No report stored for other plugins: ${context.report.reason}.\n`);
  } else {
    io.stdout.write(serialise(results));
  }
  return output.failed ? ExitCode.CheckFailed : ExitCode.Success;
}

function discoverPositionals(argv: string[]): string[] {
  return parseArguments(argv).positionals;
}

function explain(cli: CliDefinition, positionals: string[], io: CliIo): number {
  const rules = cli.rules ?? {};
  const [id] = positionals;
  if (id === undefined) {
    const width = Math.max(...Object.keys(rules).map((r) => r.length));
    io.stdout.write(
      [`Rules:`, ...Object.entries(rules).map(([r, rule]) => `  ${r.padEnd(width)}  ${rule.summary}`), ""].join("\n"),
    );
    return ExitCode.Success;
  }
  const rule = rules[id];
  if (!rule) throw usageError(`unknown rule "${id}"; rules: ${Object.keys(rules).join(", ")}`);
  io.stdout.write(`${id}: ${rule.summary}\n\n${rule.explanation}\n`);
  return ExitCode.Success;
}

const commonOptionHelp = [
  "  --json            JSON output (default when stdout is not a terminal)",
  "  --limit <n|all>   maximum rows (default 20)",
  "  --fields <a,b>    project result columns",
  "  --help            show help",
];

function helpText(cli: CliDefinition): string {
  const commands: [string, string][] = [
    ...Object.entries(cli.commands).map(([name, command]): [string, string] => [name, command.summary]),
    ["config explain", configExplain.summary],
    ...(cli.rules ? [["explain <rule>", "Describe a recommendation rule"] as [string, string]] : []),
  ];
  const width = Math.max(...commands.map(([name]) => name.length));
  return [
    `Usage: ${cli.tool} <command> [options]`,
    "",
    "Commands:",
    ...commands.map(([name, summary]) => `  ${name.padEnd(width)}  ${summary}`),
    "",
    "Options:",
    ...commonOptionHelp,
    "",
  ].join("\n");
}

function commandHelp(cli: CliDefinition, name: string, command: Command, requested?: string): string {
  const sub = requested === undefined ? undefined : command.subcommands?.[requested];
  const optionLines = (entries: [string, { type: string }][]): string[] => {
    const flags = entries.map(([option, spec]): [string, string] => [
      `--${option}${spec.type === "string" ? ` <${option}>` : ""}`,
      command.optionHelp?.[option] ?? "",
    ]);
    const width = Math.max(0, ...flags.map(([flag]) => flag.length));
    return flags.map(([flag, description]) => (description === "" ? `  ${flag}` : `  ${flag.padEnd(width)}  ${description}`));
  };
  const all = Object.entries(command.options ?? {});
  const hiddenOptions = new Set(command.hiddenOptions ?? []);
  if (sub !== undefined) {
    const taken = new Set(sub.options ?? []);
    return [
      `Usage: ${cli.tool} ${name} ${requested}${command.usage === undefined ? "" : ` ${command.usage}`} [options]`,
      "",
      sub.summary,
      "",
      "Options:",
      ...optionLines(all.filter(([option]) => taken.has(option))),
      ...commonOptionHelp,
      "",
    ].join("\n");
  }
  const subcommands = Object.entries(command.subcommands ?? {}).filter(([, s]) => s.hidden !== true);
  const width = Math.max(0, ...subcommands.map(([sname]) => sname.length));
  return [
    `Usage: ${cli.tool} ${name}${command.usage === undefined ? "" : ` ${command.usage}`}${subcommands.length > 0 ? " <subcommand>" : ""} [options]`,
    "",
    command.summary,
    "",
    ...(subcommands.length > 0 ? ["Subcommands:", ...subcommands.map(([sname, s]) => `  ${sname.padEnd(width)}  ${s.summary}`), `Run ${cli.tool} ${name} <subcommand> --help for the options of one.`, ""] : []),
    "Options:",
    ...optionLines(all.filter(([option]) => !hiddenOptions.has(option))),
    ...commonOptionHelp,
    "",
  ].join("\n");
}
