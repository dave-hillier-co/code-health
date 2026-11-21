import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";

const alice: Identity = { name: "Alice", email: "alice@example.com" };

export const calc = "src/app/calc.ts";

const total = `export function total(items: number[]): number {
  let sum = 0;
  for (const item of items) sum += item;
  return sum;
}
`;

/** Ten nested conditions: cognitive complexity of 55, and a great deal more indentation than the file had. */
const classify = `
export function classify(a: number, b: number, c: number): string {
  if (a > 0) {
    if (b > 0) {
      if (c > 0) {
        if (a > b) {
          if (b > c) {
            if (a > c) {
              if (a + b > c) {
                if (a + c > b) {
                  if (b + c > a) {
                    return "scalene";
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return "none";
}
`;

/** Prose indented the way licence texts are: a great deal of indentation and not a line of code. */
const licence = Array.from({ length: 40 }, (_, i) => `${"    ".repeat(1 + (i % 4))}Permission is granted to anyone who asks, ${i}.`).join("\n") + "\n";

/**
 * Real TypeScript, so the complexity plugin can parse it. `main` has a small module and a few commits;
 * `nest` adds one deeply nested function to it, `quiet` changes a comment-free constant and `licence` adds indented prose.
 */
export function compositionHistory(): GitFixture {
  const at = (day: number) => new Date(Date.UTC(2024, 0, 8 + day * 7, 9)).toISOString();
  return GitFixture.build([
    { type: "commit", message: "Add the calculator", date: at(0), author: alice, changes: [{ op: "add", path: calc, content: total }] },
    { type: "commit", message: "Add a helper", date: at(1), author: alice, changes: [{ op: "add", path: "src/app/helper.ts", content: "export const helper = 1;\n" }] },
    { type: "commit", message: "Change the helper", date: at(2), author: alice, changes: [{ op: "modify", path: "src/app/helper.ts", content: "export const helper = 2;\n" }] },
    { type: "branch", name: "nest" },
    { type: "commit", message: "Classify triangles", date: "2024-06-03T09:00:00Z", author: alice, changes: [{ op: "modify", path: calc, content: total + classify }] },
    { type: "checkout", name: "main" },
    { type: "branch", name: "quiet" },
    { type: "commit", message: "Change the helper again", date: "2024-06-04T09:00:00Z", author: alice, changes: [{ op: "modify", path: "src/app/helper.ts", content: "export const helper = 3;\n" }] },
    { type: "checkout", name: "main" },
    { type: "branch", name: "licence" },
    { type: "commit", message: "Add the licence", date: "2024-06-05T09:00:00Z", author: alice, changes: [{ op: "add", path: "LICENSE", content: licence }] },
    { type: "checkout", name: "main" },
  ]);
}

export const api = "src/lib/api.ts";

const exportedFunction = (index: number, parameters = 1): string => {
  const names = ["x", "y"].slice(0, parameters);
  return `export function f${index}(${names.map((name) => `${name}: number`).join(", ")}): number {\n  return ${names.join(" + ")} + ${index};\n}\n`;
};

const apiSource = (first: string): string => [first, ...Array.from({ length: 11 }, (_, i) => exportedFunction(i + 1))].join("\n");

/**
 * A library of twelve exported functions, `f0` used by four files and `f1` by one. Branches: `signature` gives
 * `f0` a second parameter, `body` changes only what it returns, `removal` deletes it and `notes` touches a file
 * no adapter reads.
 */
export function signatureHistory(): GitFixture {
  const at = (day: number) => new Date(Date.UTC(2024, 0, 8 + day * 7, 9)).toISOString();
  const consumer = (index: number): string =>
    `import { f0${index === 0 ? ", f1" : ""} } from "../lib/api.ts";\nexport const use${index} = f0(${index})${index === 0 ? " + f1(1)" : ""};\n`;
  const onBranch = (name: string, day: string, message: string, changes: Change[]): Step[] => [
    { type: "branch", name },
    { type: "commit", message, date: day, author: alice, changes },
    { type: "checkout", name: "main" },
  ];
  return GitFixture.build([
    {
      type: "commit",
      message: "Add the library",
      date: at(0),
      author: alice,
      changes: [{ op: "add", path: api, content: apiSource(exportedFunction(0)) }, { op: "add", path: "NOTES.md", content: "notes\n" }],
    },
    ...Array.from({ length: 4 }, (_, i): Step => ({
      type: "commit",
      message: `Use the library ${i}`,
      date: at(i + 1),
      author: alice,
      changes: [{ op: "add", path: `src/app/use${i}.ts`, content: consumer(i) }],
    })),
    ...onBranch("signature", "2024-06-03T09:00:00Z", "Give f0 a second parameter", [{ op: "modify", path: api, content: apiSource(exportedFunction(0, 2)) }]),
    ...onBranch("body", "2024-06-04T09:00:00Z", "Change what f0 returns", [{ op: "modify", path: api, content: apiSource(exportedFunction(0).replace("+ 0;", "+ 100;")) }]),
    ...onBranch("removal", "2024-06-05T09:00:00Z", "Remove f0", [{ op: "modify", path: api, content: apiSource("") }]),
    ...onBranch("notes", "2024-06-06T09:00:00Z", "Edit the notes", [{ op: "modify", path: "NOTES.md", content: "more notes\n" }]),
  ]);
}
