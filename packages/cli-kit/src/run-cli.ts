import { discoverCommand, parseArguments, type OptionSpec, type ParsedArguments } from "./args.ts";
import { explainConfig, loadConfig, type LoadedConfig, type PluginConfigSpec } from "./config.ts";
import { assertNodeVersion } from "./environment.ts";
import { CliError, ExitCode, usageError } from "./errors.ts";
import { readRepoState, type RepoState } from "./repo-state.ts";
import { shapeResults } from "./results.ts";
import { serialise } from "./serialise.ts";
import { renderTable } from "./table.ts";

export interface CommandContext {
  repo: RepoState;
  config: LoadedConfig;
  positionals: string[];
  /** Values of the command's own options. */
  values: ParsedArguments["values"];
}

export interface CommandOutput {
  /** Everything the results depend on beyond repo, config and history. */
  inputs?: Record<string, unknown>;
  /** A list of rows (sorted, limited and projected by the kit) or any other JSON value. */
  results: unknown;
  /** Table columns, and the valid values for --fields. Defaults to the keys of the first row. */
  columns?: string[];
  /** The command's check failed (findings over threshold or a regression): exit 1. */
  failed?: boolean;
}

export interface Command {
  summary: string;
  options?: OptionSpec;
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
    io.stdout.write(commandHelp(cli, name, command));
    return ExitCode.Success;
  }

  let commandName = name;
  if (name === "config") {
    if (args.positionals[0] !== "explain") throw usageError("usage: config explain");
    commandName = "config explain";
  }

  const repo = readRepoState(io.cwd);
  const config = loadConfig(repo.root, cli.config);
  const output = await command.run({ repo, config, positionals: args.positionals, values: args.values });

  const columns = output.columns ?? (Array.isArray(output.results) ? Object.keys(output.results[0] ?? {}) : []);
  const { results, truncated } = shapeResults(output.results, { limit: args.limit, fields: args.fields, columns });

  if (args.json || !io.stdout.isTTY) {
    io.stdout.write(
      serialise({
        schemaVersion: cli.schemaVersion ?? 1,
        tool: cli.tool,
        command: commandName,
        repo: { head: repo.head, dirty: repo.dirty },
        config: config.hash,
        inputs: output.inputs ?? {},
        results,
        truncated,
        meta: {
          durationMs: Date.now() - started,
          generatedAt: new Date().toISOString(),
          gitVersion: repo.gitVersion,
          node: process.versions.node,
        },
      }),
    );
  } else if (Array.isArray(results)) {
    io.stdout.write(renderTable(results as Record<string, unknown>[], args.fields ?? columns, truncated));
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

function commandHelp(cli: CliDefinition, name: string, command: Command): string {
  const own = Object.entries(command.options ?? {}).map(([option, spec]) => {
    const argument = spec.type === "string" ? ` <${option}>` : "";
    return `  --${option}${argument}`;
  });
  return [
    `Usage: ${cli.tool} ${name} [options]`,
    "",
    command.summary,
    "",
    "Options:",
    ...own,
    ...commonOptionHelp,
    "",
  ].join("\n");
}
