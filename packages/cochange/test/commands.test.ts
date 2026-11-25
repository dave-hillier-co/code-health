import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { commandModules, commands } from "../src/commands.ts";

const commandsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "commands");
const files = readdirSync(commandsDir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => basename(f, ".ts"))
  .sort();

test("every module in src/commands is registered, under the name of its file", () => {
  expect(commandModules.map((m) => m.name).sort()).toEqual(files);
});

test("the registration list is alphabetical, so parallel additions merge cleanly", () => {
  const names = commandModules.map((m) => m.name);
  expect(names).toEqual([...names].sort());
});

test("commands are looked up by name", () => {
  for (const module of commandModules) expect(commands[module.name]).toBe(module.command);
});

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const goldenFiles = readdirSync(join(packageRoot, "test", "golden"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => readdirSync(join(packageRoot, "test", "golden", entry.name)));

test("every command has at least one golden output, and so a schema that check:schemas validates it against", () => {
  for (const { name } of commandModules) {
    expect(
      goldenFiles.some((file) => file === `${name}.json` || file.startsWith(`${name}.`)),
      `no golden for ${name}`,
    ).toBe(true);
    expect(existsSync(join(packageRoot, "..", "..", "plugins", "code-health", "schemas", "cochange", `${name}.schema.json`)), `no schema for ${name}`).toBe(true);
  }
});
