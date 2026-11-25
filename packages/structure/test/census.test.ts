import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { runStructure } from "./support/run.ts";
import { conventionsRepository, directRepository, mechanismsRepository, telemetryRepository } from "./support/census-scenario.ts";

let repo: GitFixture;
let direct: GitFixture;
let conventions: GitFixture;
beforeAll(() => {
  repo = mechanismsRepository();
  direct = directRepository();
  conventions = conventionsRepository();
});
afterAll(() => {
  repo?.dispose();
  direct?.dispose();
  conventions?.dispose();
});

interface Example {
  variant: string;
  path: string;
  line: number | null;
  detail: string;
}
interface Row {
  id: string;
  mechanism: string;
  count: number;
  files: number;
  variants: { variant: string; count: number }[];
  folders: { folder: string; count: number }[];
  examples: Example[];
  lookAlikes: { name: string; count: number; definitions: number; detail: string }[];
}

async function census(cwd: string, ...args: string[]) {
  const run = await runStructure(cwd, ["census", "--json", ...args]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  const document = JSON.parse(run.stdout) as { results: Row[] };
  const row = (mechanism: string): Row => document.results.find((r) => r.mechanism === mechanism)!;
  return { stdout: run.stdout, document, row };
}

const counts = (row: Row) => Object.fromEntries(row.variants.map((v) => [v.variant, v.count]));

test("every mechanism has a row, in a fixed order, whether or not the codebase uses it", async () => {
  const { document } = await census(direct.path);
  expect(document.results.map((r) => r.mechanism)).toEqual([
    "callbacks",
    "interfaces",
    "dependency-injection",
    "events",
    "handlers",
    "registries",
    "ports-and-adapters",
  ]);
  for (const row of document.results) expect(row).toMatchObject({ count: 0, files: 0, variants: [], folders: [], examples: [] });
});

test("a function taking a callback counts only when it is called from another folder", async () => {
  const { row } = await census(repo.path);
  const callbacks = row("callbacks");
  expect(callbacks.count).toBe(1);
  expect(callbacks.examples).toEqual([
    { variant: "function-parameter", path: "src/billing/lines.ts", line: 1, detail: "forEachLine(visit) is called from src/orders" },
  ]);
  expect(callbacks.folders).toEqual([
    { folder: "src/billing", count: 1 },
    { folder: "src/orders", count: 1 },
  ]);
});

test("an interface counts when a class in another folder implements it", async () => {
  const { row } = await census(repo.path);
  const interfaces = row("interfaces");
  expect(interfaces.count).toBe(1);
  expect(interfaces.examples).toEqual([
    { variant: "interface", path: "src/ports/storage.ts", line: 1, detail: "Storage is implemented in src/adapters" },
  ]);
});

test("dependency injection counts decorators, container registrations and constructor injection of interfaces from other folders", async () => {
  const { row } = await census(repo.path);
  const di = row("dependency-injection");
  expect(di.count).toBe(3);
  expect(counts(di)).toEqual({ "constructor-injection": 1, "container-registration": 1, decorator: 1 });
  const injection = di.examples.find((e) => e.variant === "constructor-injection")!;
  expect(injection).toMatchObject({ path: "src/app/service.ts", detail: "Service takes Storage from src/ports" });
  expect(di.examples.find((e) => e.variant === "container-registration")).toMatchObject({ path: "src/app/container.ts", line: 4 });
});

test("events count emitting, subscribing and emitter base types, and leave out process.on", async () => {
  const { row } = await census(repo.path);
  const events = row("events");
  expect(events.count).toBe(3);
  expect(counts(events)).toEqual({ "base-type": 1, call: 2 });
  expect(events.examples.map((e) => e.detail).sort()).toEqual(["Bus extends EventEmitter", "bus.emit", "bus.on"]);
});

test("handlers count handler decorators and dispatch through a command bus", async () => {
  const { row } = await census(repo.path);
  const handlers = row("handlers");
  expect(handlers.count).toBe(2);
  expect(counts(handlers)).toEqual({ dispatch: 1, "handler-decorator": 1 });
});

test("registries count keyed maps and register calls, and a container registration is not one of them", async () => {
  const { row } = await census(repo.path);
  const registries = row("registries");
  expect(registries.count).toBe(2);
  expect(counts(registries)).toEqual({ "keyed-map": 1, "register-call": 1 });
  expect(registries.examples.find((e) => e.variant === "keyed-map")).toMatchObject({ path: "src/plugins/registry.ts", detail: "registry" });
});

test("folders named ports, adapters or infrastructure are listed as folders", async () => {
  const { row } = await census(repo.path);
  const folders = row("ports-and-adapters");
  expect(folders.count).toBe(3);
  expect(folders.folders).toEqual([
    { folder: "src/adapters", count: 1 },
    { folder: "src/infrastructure", count: 1 },
    { folder: "src/ports", count: 1 },
  ]);
  expect(folders.files).toBe(0);
});

test("the census output matches the golden", async () => {
  const { stdout } = await census(repo.path);
  expectGolden("census", "census", stdout);
});

test("an interface reaching its implementer through a barrel, and an abstract class, both count", async () => {
  const { row } = await census(conventions.path);
  const interfaces = row("interfaces");
  expect(interfaces.count).toBe(2);
  expect(interfaces.examples.map((e) => e.detail).sort()).toEqual(["Repository is implemented in src/adapters", "Storage is implemented in src/adapters"]);
});

test("a function type alias declared in another file makes its parameter a callback", async () => {
  const { row } = await census(conventions.path);
  expect(row("callbacks").examples).toEqual([
    { variant: "function-parameter", path: "src/walk/walk.ts", line: 2, detail: "walk(visit) is called from src/app" },
  ]);
});

test("names stated under structure.census add to the built-in vocabulary", async () => {
  const { row } = await census(conventions.path);
  expect(row("events").examples.map((e) => e.detail)).toContain("fire");
  expect(row("handlers").examples.map((e) => e.detail)).toContain("wire");
  expect(row("registries").examples.map((e) => e.detail)).toContain("enrol");
  // Folder names add as well: stating gateways keeps ports and adapters.
  expect(row("ports-and-adapters").folders).toEqual([
    { folder: "src/adapters", count: 1 },
    { folder: "src/gateways", count: 1 },
    { folder: "src/ports", count: 1 },
  ]);
});

test("plain JavaScript is read for what needs no type annotation", async () => {
  const { row } = await census(conventions.path);
  expect(row("events").examples.map((e) => e.path)).toContain("src/legacy/emitter.js");
});

test("a send call to the repository's own method with no listen side is a look-alike, counted apart from the events", async () => {
  const telemetry = telemetryRepository();
  try {
    const { row } = await census(telemetry.path);
    const events = row("events");
    expect(events.examples.map((e) => e.detail).sort()).toEqual(["bus.publish", "bus.subscribe"]);
    expect(events.count).toBe(2);
    expect(events.lookAlikes).toEqual([
      {
        name: "emit",
        count: 3,
        definitions: 2,
        detail: "emit is defined in this repository on 2 types or files, and none of them has a listen method or an event base type, so a call runs that code and notifies no listener",
      },
    ]);
  } finally {
    telemetry.dispose();
  }
});

test("every other row has no look-alikes", async () => {
  const { document } = await census(repo.path);
  for (const row of document.results) expect(row.lookAlikes).toEqual([]);
});

test("the census reads no history, so its document has no window or evidence section", async () => {
  const run = await runStructure(repo.path, ["census", "--json"]);
  const document = JSON.parse(run.stdout) as Record<string, unknown>;
  expect(document).not.toHaveProperty("window");
  expect(document).not.toHaveProperty("evidence");
});
