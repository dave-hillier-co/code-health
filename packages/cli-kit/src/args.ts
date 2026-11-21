import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { usageError } from "./errors.ts";

export const DEFAULT_LIMIT = 20;

export type OptionSpec = ParseArgsOptionsConfig;

export interface ParsedArguments {
  command: string | undefined;
  positionals: string[];
  json: boolean;
  help: boolean;
  limit: number;
  fields: string[] | undefined;
  /** Values of the command specific options. */
  values: Record<string, string | boolean | (string | boolean)[] | undefined>;
}

const commonOptions = {
  json: { type: "boolean" },
  help: { type: "boolean" },
  limit: { type: "string" },
  fields: { type: "string" },
} satisfies OptionSpec;

/** Parses `<command> [positionals] [options]`. Throws a usage error (exit 2) on bad input. */
export function parseArguments(argv: string[], commandOptions: OptionSpec = {}): ParsedArguments {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { ...commandOptions, ...commonOptions },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }

  const { json, help, limit, fields, ...values } = parsed.values;
  const [command, ...positionals] = parsed.positionals;
  return {
    command,
    positionals,
    json: json === true,
    help: help === true,
    limit: parseLimit(limit as string | undefined),
    fields: parseFields(fields as string | undefined),
    values,
  };
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (raw === "all") return Infinity;
  if (!/^[1-9]\d*$/.test(raw)) throw usageError(`--limit must be a positive integer or "all", got "${raw}"`);
  return Number(raw);
}

function parseFields(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const fields = raw.split(",").map((field) => field.trim());
  if (fields.some((field) => field === "")) throw usageError("--fields must be a comma separated list of field names");
  return fields;
}

/** Finds the command name before its options are known, since those depend on the command. */
export function discoverCommand(argv: string[]): string | undefined {
  return parseArgs({ args: argv, options: commonOptions, allowPositionals: true, strict: false }).positionals[0];
}
