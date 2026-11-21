import { expect, test } from "vitest";
import { parseArguments } from "../src/args.ts";
import { CliError, ExitCode } from "../src/errors.ts";

test("first positional is the command and the rest are positionals", () => {
  const parsed = parseArguments(["config", "explain"]);
  expect(parsed.command).toBe("config");
  expect(parsed.positionals).toEqual(["explain"]);
});

test("defaults: no json flag, limit 20, no fields", () => {
  const parsed = parseArguments(["hotspots"]);
  expect(parsed.json).toBe(false);
  expect(parsed.limit).toBe(20);
  expect(parsed.fields).toBeUndefined();
  expect(parsed.help).toBe(false);
});

test("common options are parsed", () => {
  const parsed = parseArguments(["hotspots", "--json", "--limit", "5", "--fields", "path,score"]);
  expect(parsed.json).toBe(true);
  expect(parsed.limit).toBe(5);
  expect(parsed.fields).toEqual(["path", "score"]);
});

test("--limit all removes the limit", () => {
  expect(parseArguments(["x", "--limit", "all"]).limit).toBe(Infinity);
});

test("options may precede the command", () => {
  expect(parseArguments(["--json", "hotspots"]).command).toBe("hotspots");
});

test("command specific options are returned in values", () => {
  const parsed = parseArguments(["x", "--since", "6m", "--strict"], {
    since: { type: "string" },
    strict: { type: "boolean" },
  });
  expect(parsed.values).toEqual({ since: "6m", strict: true });
});

test("no command is allowed so help can be shown", () => {
  expect(parseArguments([]).command).toBeUndefined();
  expect(parseArguments(["--help"]).help).toBe(true);
});

test.each([
  [["x", "--bogus"]],
  [["x", "--limit", "0"]],
  [["x", "--limit", "abc"]],
  [["x", "--limit", "-3"]],
  [["x", "--fields", ""]],
  [["x", "--limit"]],
])("usage errors exit 2: %j", (argv) => {
  try {
    parseArguments(argv);
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(ExitCode.Usage);
  }
});
