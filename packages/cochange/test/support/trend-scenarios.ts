import { GitFixture, type Identity, type Step } from "@code-health/fixtures/git-fixture";

const author: Identity = { name: "Alice", email: "alice@example.com" };

/**
 * Ten stable lines, so git still sees a rename when the nesting changes, then conditionals `depth`
 * levels deep: indentation complexity `depth * depth`, and `11 + 2 * depth` lines.
 */
export function nested(depth: number): string {
  const lines: string[] = Array.from({ length: 10 }, (_, i) => `export const step${i} = ${i};`);
  for (let level = 0; level < depth; level++) lines.push(`${"  ".repeat(level)}if (check${level}) {`);
  lines.push(`${"  ".repeat(depth)}run();`);
  for (let level = depth - 1; level >= 0; level--) lines.push(`${"  ".repeat(level)}}`);
  return lines.join("\n") + "\n";
}

export const before = "src/old/engine.ts";
export const after = "src/core/engine.ts";

/**
 * A file that grows more deeply nested over eight revisions a month apart, ending
 * 2024-08-01. The fifth revision moves it from `src/old` to `src/core`. A second
 * file, `flat.ts`, never changes shape, and `logo.png` is binary.
 */
export function trendHistory(): GitFixture {
  const steps: Step[] = [];
  for (let version = 1; version <= 8; version++) {
    const date = new Date(Date.UTC(2024, version - 1, 1, 9)).toISOString();
    const path = version < 5 ? before : after;
    steps.push({
      type: "commit",
      message: `Nest the engine ${version}`,
      date,
      author,
      changes: [
        version === 1
          ? { op: "add", path, content: nested(version) }
          : version === 5
            ? { op: "rename", from: before, path, content: nested(version) }
            : { op: "modify", path, content: nested(version) },
        ...(version === 1
          ? [
              { op: "add" as const, path: "src/core/flat.ts", content: "export const flat = 1;\n" },
              { op: "add" as const, path: "assets/logo.png", content: "PNG\0\0data\n" },
            ]
          : []),
      ],
    });
  }
  return GitFixture.build(steps);
}
