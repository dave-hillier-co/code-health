import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";

const alice: Identity = { name: "Alice", email: "alice@example.com" };
const bob: Identity = { name: "Bob", email: "bob@example.com" };

/** A file exporting each name in `exports`, and calling every import once. */
export function source(exports: string[], imports: { from: string; names: string[] }[] = [], revision = 1): string {
  const head = imports.map(({ from, names }) => `import { ${names.join(", ")} } from "${from}";`);
  const uses = imports.flatMap(({ names }) => names.map((name) => `${name}()`));
  return [
    ...head,
    ...exports.map((name) => `export function ${name}(): number {\n  return ${[...uses, String(revision)].join(" + ")};\n}`),
    "",
  ].join("\n");
}

interface File {
  exports: string[];
  imports?: { from: string; names: string[] }[];
}

/**
 * Each folder pair under src is one shape of the coupling quadrants. Imports use three names (three
 * reference sites) unless the shape says otherwise.
 */
export const files: Record<string, File> = {
  // real: pricing uses three things of tax, and they change together
  "src/pricing/engine.ts": { exports: ["price"], imports: [{ from: "../tax/rates.ts", names: ["rate", "round", "band"] }] },
  "src/tax/rates.ts": { exports: ["rate", "round", "band"] },
  // incidental: ui uses three things of format, and they change on their own
  "src/ui/panel.ts": { exports: ["panel"], imports: [{ from: "../format/text.ts", names: ["pad", "trim", "join"] }] },
  "src/format/text.ts": { exports: ["pad", "trim", "join"] },
  // stable: app uses three things of kernel, which never changes after it was added
  "src/app/main.ts": { exports: ["main"], imports: [{ from: "../kernel/core.ts", names: ["boot", "halt", "tick"] }] },
  "src/kernel/core.ts": { exports: ["boot", "halt", "tick"] },
  // hidden: no import between orders and billing, yet they change together
  "src/orders/place.ts": { exports: ["place"] },
  "src/billing/charge.ts": { exports: ["charge"] },
  // independent: tools uses one thing of misc, and they change on their own
  "src/tools/run.ts": { exports: ["run"], imports: [{ from: "../misc/util.ts", names: ["util"] }] },
  "src/misc/util.ts": { exports: ["util"] },
  // insufficient evidence: lonely uses three things of shared but is itself never changed again
  "src/lonely/x.ts": { exports: ["lonely"], imports: [{ from: "../shared/y.ts", names: ["one", "two", "three"] }] },
  "src/shared/y.ts": { exports: ["one", "two", "three"] },
};

const content = (path: string, revision: number): string => {
  const file = files[path]!;
  return source(file.exports, file.imports, revision);
};

const modify = (path: string, revision: number): Change => ({ op: "modify", path, content: content(path, revision) });

export function couplingSteps(): Step[] {
  const steps: Step[] = [
    {
      type: "commit",
      message: "Add the modules",
      date: "2024-01-05T09:00:00Z",
      author: alice,
      changes: Object.keys(files).map((path): Change => ({ op: "add", path, content: content(path, 1) })),
    },
  ];
  let day = 0;
  const edit = (message: string, paths: string[], revision: number) => {
    day += 2;
    const date = new Date(Date.UTC(2024, 0, 6 + day, 9)).toISOString().replace(".000Z", "Z");
    steps.push({ type: "commit", message, date, author: day % 4 === 0 ? bob : alice, changes: paths.map((p) => modify(p, revision)) });
  };
  for (let r = 2; r <= 7; r++) edit(`Reprice ${r}`, ["src/pricing/engine.ts", "src/tax/rates.ts"], r);
  for (let r = 2; r <= 7; r++) edit(`Rework the panel ${r}`, ["src/ui/panel.ts"], r);
  for (let r = 2; r <= 7; r++) edit(`Reformat ${r}`, ["src/format/text.ts"], r);
  for (let r = 2; r <= 6; r++) edit(`Tune the app ${r}`, ["src/app/main.ts"], r);
  for (let r = 2; r <= 7; r++) edit(`Bill the order ${r}`, ["src/orders/place.ts", "src/billing/charge.ts"], r);
  for (let r = 2; r <= 5; r++) edit(`Run the tool ${r}`, ["src/tools/run.ts"], r);
  for (let r = 2; r <= 5; r++) edit(`Extend the utilities ${r}`, ["src/misc/util.ts"], r);
  for (let r = 2; r <= 5; r++) edit(`Share more ${r}`, ["src/shared/y.ts"], r);
  return steps;
}

/** One repository holding every shape of the coupling quadrants, 42 logical changes between January and April 2024. */
export function couplingRepository(): GitFixture {
  return GitFixture.build(couplingSteps());
}
