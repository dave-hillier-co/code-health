import { readdirSync } from "node:fs";
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
