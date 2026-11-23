import { GitFixture, type Change, type Identity } from "@code-health/fixtures/git-fixture";
import { cyclesRepository } from "./scenarios.ts";

const alice: Identity = { name: "Alice", email: "alice@example.com" };
const add = (path: string, content: string): Change => ({ op: "add", path, content });

const types = [
  "export interface Repo { find(): number }",
  "export abstract class Base { abstract run(): number }",
  "export class Impl extends Base { run(): number { return 1 } }",
  "export function make(): Repo { return { find: () => 1 }; }",
  "",
].join("\n");

/**
 * The cycles repository with layers configured (ui over core, so the model's import of a ui file is a violation)
 * and a third package that exports an interface, an abstract class and a class, which a file of the first package uses.
 */
export function structureReportRepository(): GitFixture {
  const fixture = cyclesRepository();
  fixture.apply([
    {
      type: "commit",
      message: "Configure layers and add a package of types",
      date: "2024-05-25T09:00:00Z",
      author: alice,
      changes: [
        add("code-health.json", JSON.stringify({ structure: { layers: [{ name: "ui", paths: ["src/ui/**"] }, { name: "core", paths: ["src/core/**"] }] } })),
        add("packages/p3/package.json", '{ "name": "p3", "main": "src/types.ts" }\n'),
        add("packages/p3/src/types.ts", types),
        add("packages/p4/package.json", '{ "name": "p4", "main": "src/ports.ts" }\n'),
        add(
          "packages/p4/src/ports.ts",
          'import { make } from "../../p3/src/types.ts";\nexport interface Port { go(): number }\nexport interface Gate { open(): number }\nexport interface Door { shut(): number }\nexport const made = make;\n',
        ),
        add("packages/p5/package.json", '{ "name": "p5", "main": "src/model.ts" }\n'),
        add("packages/p5/src/model.ts", "export class Order {}\nexport class Line {}\nexport class Invoice {}\n"),
        add("packages/p1/src/use.ts", 'import { make } from "../../p3/src/types.ts";\nimport { Order } from "../../p5/src/model.ts";\nexport function use() {\n  return [make(), new Order()];\n}\n'),
      ],
    },
  ]);
  return fixture;
}

/** A C++ tree where most quoted includes name a header that is not in the repository, so the include warning applies. */
export function unresolvedIncludesRepository(): GitFixture {
  return GitFixture.build([
    {
      type: "commit",
      message: "Add the components",
      date: "2024-01-01T09:00:00Z",
      author: alice,
      changes: [
        add("code-health.json", JSON.stringify({ includeRoots: ["src"] })),
        add("src/x/X.h", "#pragma once\nint x();\n"),
        add("src/x/X.cpp", '#include "x/X.h"\n#include "gone/One.h"\n#include "gone/Two.h"\nint x() { return 1; }\n'),
        add("src/y/Y.h", "#pragma once\nint y();\n"),
        add("src/y/Y.cpp", '#include "y/Y.h"\n#include "x/X.h"\n#include "gone/Three.h"\nint y() { return x(); }\n'),
      ],
    },
  ]);
}
