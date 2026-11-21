import { GitFixture, type Change } from "@code-health/fixtures/git-fixture";

const add = (path: string, lines: string[]): Change => ({ op: "add", path, content: `${lines.join("\n")}\n` });

/**
 * One commit holding a small application that decouples code in each of the ways the census looks for,
 * and a few look-alikes it must not count. The expected counts are stated in census.test.ts.
 */
export function mechanismsRepository(): GitFixture {
  return GitFixture.build([
    {
      type: "commit",
      message: "Add the application",
      date: "2024-03-01T09:00:00Z",
      author: { name: "Alice", email: "alice@example.com" },
      changes: [
        // Interfaces: Storage is implemented in another folder, Clock only in its own, Plain nowhere.
        add("src/ports/storage.ts", ["export interface Storage {", "  save(value: string): void;", "}"]),
        add("src/ports/clock.ts", ["export interface Clock {", "  now(): number;", "}", "export class SystemClock implements Clock {", "  now(): number {", "    return 0;", "  }", "}"]),
        add("src/ports/plain.ts", ["export interface Plain {", "  value: number;", "}"]),
        add("src/adapters/file-storage.ts", [
          'import type { Storage } from "../ports/storage.ts";',
          "export class FileStorage implements Storage {",
          "  save(value: string): void {",
          "    void value;",
          "  }",
          "}",
        ]),
        // Callbacks: forEachLine is called from another folder, twice only from its own.
        add("src/billing/lines.ts", [
          "export function forEachLine(lines: string[], visit: (line: string) => void): void {",
          "  lines.forEach(visit);",
          "}",
          "export function twice(action: () => void): void {",
          "  action();",
          "  action();",
          "}",
          "export function plain(value: number): number {",
          "  return value + 1;",
          "}",
        ]),
        add("src/billing/invoice.ts", [
          'import { forEachLine, twice } from "./lines.ts";',
          "export function print(lines: string[]): void {",
          "  forEachLine(lines, () => {});",
          "  twice(() => {});",
          "}",
        ]),
        add("src/orders/report.ts", [
          'import { forEachLine } from "../billing/lines.ts";',
          "export function report(lines: string[]): void {",
          "  forEachLine(lines, (line) => void line);",
          "}",
        ]),
        // Dependency injection: a decorator, constructor injection of an interface from another folder, a container registration.
        add("src/app/service.ts", [
          'import { Injectable } from "./injection.ts";',
          'import type { Storage } from "../ports/storage.ts";',
          "@Injectable()",
          "export class Service {",
          "  constructor(private readonly storage: Storage, private readonly name: string) {}",
          "  run(): void {",
          '    this.storage.save("x");',
          "  }",
          "}",
        ]),
        add("src/app/injection.ts", [
          "export function Injectable(): ClassDecorator {",
          "  return () => {};",
          "}",
          "export class Container {",
          "  register(key: string, value: unknown): void {",
          "    void key;",
          "    void value;",
          "  }",
          "}",
        ]),
        add("src/app/container.ts", [
          'import { Container } from "./injection.ts";',
          'import { FileStorage } from "../adapters/file-storage.ts";',
          "export const container = new Container();",
          'container.register("storage", new FileStorage());',
        ]),
        // Events: an emitter subclass, an emit and a subscription, and two look-alikes (process.on, a plain method named on).
        add("src/events/bus.ts", [
          'import { EventEmitter } from "node:events";',
          "export class Bus extends EventEmitter {}",
          "export const bus = new Bus();",
        ]),
        add("src/orders/place.ts", [
          'import { bus } from "../events/bus.ts";',
          "export function place(id: number): void {",
          '  bus.emit("placed", id);',
          "}",
        ]),
        add("src/billing/listen.ts", [
          'import { bus } from "../events/bus.ts";',
          'bus.on("placed", () => {});',
          'process.on("exit", () => {});',
        ]),
        // Handlers: a decorated handler class and a dispatch through a command bus.
        add("src/handlers/place-order.ts", [
          'import { CommandHandler } from "./decorators.ts";',
          "export class PlaceOrder {}",
          "@CommandHandler(PlaceOrder)",
          "export class PlaceOrderHandler {",
          "  execute(): void {}",
          "}",
        ]),
        add("src/handlers/decorators.ts", ["export function CommandHandler(command: unknown): ClassDecorator {", "  void command;", "  return () => {};", "}"]),
        add("src/app/dispatch.ts", [
          'import { PlaceOrder } from "../handlers/place-order.ts";',
          "declare const commandBus: { execute(command: unknown): void };",
          "commandBus.execute(new PlaceOrder());",
        ]),
        // Registries: a keyed map, and a register call.
        add("src/plugins/registry.ts", [
          "export interface Plugin {",
          "  name: string;",
          "}",
          "const registry = new Map<string, Plugin>();",
          "export function registerPlugin(name: string, plugin: Plugin): void {",
          "  registry.set(name, plugin);",
          "}",
        ]),
        add("src/plugins/csv.ts", ['import { registerPlugin } from "./registry.ts";', 'registerPlugin("csv", { name: "csv" });']),
        // Ports and adapters by folder name.
        add("src/infrastructure/database.ts", ["export const database = 1;"]),
        add("src/infrastructure/cache.ts", ["export const cache = 1;"]),
      ],
    },
  ]);
}

/** A repository that decouples nothing: modules call each other directly. */
export function directRepository(): GitFixture {
  return GitFixture.build([
    {
      type: "commit",
      message: "Add the modules",
      date: "2024-03-01T09:00:00Z",
      author: { name: "Alice", email: "alice@example.com" },
      changes: [
        add("src/a.ts", ['import { b } from "./b.ts";', "export const a = (): number => b() + 1;"]),
        add("src/b.ts", ["export const b = (): number => 1;"]),
      ],
    },
  ]);
}

/**
 * Conventions the built-in vocabulary does not know, stated in code-health.json, and two ways a type reaches
 * its user: through a barrel, and as a function type alias declared in another file.
 */
export function conventionsRepository(): GitFixture {
  return GitFixture.build([
    {
      type: "commit",
      message: "Add the application",
      date: "2024-03-01T09:00:00Z",
      author: { name: "Alice", email: "alice@example.com" },
      changes: [
        add("code-health.json", [
          JSON.stringify({ structure: { census: { folderNames: ["gateways"], eventCalls: ["fire"], handlerCalls: ["wire"], registerCalls: ["enrol"] } } }, null, 2),
        ]),
        add("src/gateways/mail.ts", ["export const mail = 1;"]),
        add("src/ports/storage.ts", ["export interface Storage {", "  save(): void;", "}"]),
        add("src/ports/barrel.ts", ['export type { Storage } from "./storage.ts";']),
        add("src/ports/visitor.ts", ["export type Visitor = (name: string) => void;"]),
        add("src/ports/base.ts", ["export abstract class Repository {", "  abstract find(): void;", "}"]),
        add("src/adapters/disk.ts", [
          'import type { Storage } from "../ports/barrel.ts";',
          'import { Repository } from "../ports/base.ts";',
          "export class Disk implements Storage {",
          "  save(): void {}",
          "}",
          "export class DiskRepository extends Repository {",
          "  find(): void {}",
          "}",
        ]),
        add("src/walk/walk.ts", ['import type { Visitor } from "../ports/visitor.ts";', "export function walk(names: string[], visit: Visitor): void {", "  names.forEach(visit);", "}"]),
        add("src/app/main.ts", ['import { walk } from "../walk/walk.ts";', "walk([], () => {});", 'fire("started");', 'wire("start", () => {});', 'enrol("main");']),
        add("src/legacy/emitter.js", [
          'const { EventEmitter } = require("node:events");',
          "class Legacy extends EventEmitter {}",
          "module.exports = { Legacy };",
        ]),
      ],
    },
  ]);
}
