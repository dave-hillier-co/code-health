import { GitFixture, type Step } from "@code-health/fixtures/git-fixture";

/** A knotted function: nesting 3 and several branches. `n` varies the text so every revision is a real change. */
const knotted = (name: string, n: number): string => `export function ${name}(a: number, b: number, c: number): number {
  let total = ${n};
  if (a > 0) {
    if (b > 0) {
      if (c > 0) {
        total += a + b + c;
      }
    }
  }
  for (const x of [a, b, c]) {
    if (x > ${n}) {
      total += x;
    }
  }
  return total;
}
`;

/** The same behaviour with the nesting taken out, as a simplification would leave it. */
const flattened = (name: string, n: number): string => `export function ${name}(a: number, b: number, c: number): number {
  let total = ${n};
  if (a > 0 && b > 0 && c > 0) total += a + b + c;
  for (const x of [a, b, c]) {
    if (x > ${n}) total += x;
  }
  return total;
}
`;

/** Two functions that split the same work, to show what the gaming check watches for. */
export const splitHot = `export function hotParts(a: number, b: number, c: number): number {
  return a + b + c;
}

export function hotRest(a: number): number {
  return a;
}

export function hotWrap(a: number): number {
  return hotRest(a);
}
`;

const at = (day: string): string => `${day}T09:00:00+00:00`;

/**
 * Two files that start out equally knotted, one simplified in a commit with a `Code-Health:` trailer and the
 * other left alone, and a third that is already flat. Before the simplification both knotted files change
 * three times, once to fix a defect. Afterwards the simplified one changes once and the one left alone four times.
 */
export function outcomeSteps(): Step[] {
  const edit = (path: string, content: string, message: string, day: string): Step => ({
    type: "commit",
    message,
    date: at(day),
    changes: [{ op: "modify", path, content }],
  });
  return [
    {
      type: "commit",
      message: "Add modules",
      date: at("2024-01-01"),
      changes: [
        { op: "add", path: "code-health.json", content: JSON.stringify({ complexity: { changeWeighting: true } }) },
        { op: "add", path: "src/hot.ts", content: knotted("hot", 1) },
        { op: "add", path: "src/warm.ts", content: knotted("warm", 1) },
        { op: "add", path: "src/flat.ts", content: "export const flat = (a: number): number => a + 1;\n" },
      ],
    },
    edit("src/hot.ts", knotted("hot", 2), "Handle larger inputs in hot", "2024-02-01"),
    edit("src/warm.ts", knotted("warm", 2), "Handle larger inputs in warm", "2024-02-02"),
    edit("src/hot.ts", knotted("hot", 3), "Fix crash in hot", "2024-03-01"),
    edit("src/warm.ts", knotted("warm", 3), "Fix crash in warm", "2024-03-02"),
    edit("src/hot.ts", knotted("hot", 4), "Tune hot", "2024-04-01"),
    edit("src/warm.ts", knotted("warm", 4), "Tune warm", "2024-04-02"),
    {
      type: "commit",
      message: "Flatten hot\n\nCode-Health: complexity nesting",
      date: at("2024-06-01"),
      changes: [{ op: "modify", path: "src/hot.ts", content: flattened("hot", 4) }],
    },
    edit("src/hot.ts", flattened("hot", 5), "Handle edge case in hot", "2024-07-01"),
    edit("src/warm.ts", knotted("warm", 5), "Handle edge case in warm", "2024-07-02"),
    edit("src/warm.ts", knotted("warm", 6), "Fix off-by-one in warm", "2024-08-01"),
    edit("src/warm.ts", knotted("warm", 7), "Tune warm again", "2024-08-15"),
    edit("src/warm.ts", knotted("warm", 8), "Fix rounding in warm", "2024-09-01"),
  ];
}

export function buildOutcomeRepo(): GitFixture {
  return GitFixture.build(outcomeSteps());
}
