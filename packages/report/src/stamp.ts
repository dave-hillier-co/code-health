import { canonical, normalise } from "./json.ts";
import { PROTOCOL_VERSION, type Stamp } from "./protocol.ts";

/** The stamp of a report: what the data was computed from. `inputs` is normalised, so a stamp read back from JSON equals one computed again. */
export function makeStamp(kind: string, head: string, config: string, inputs: Record<string, unknown>): Stamp {
  return normalise({ protocol: PROTOCOL_VERSION, kind, head, config, inputs });
}

const short = (sha: unknown) => (typeof sha === "string" ? sha.slice(0, 7) : String(sha));

/** What differs between the stamp a run computes and the one in the notes, one sentence each. Empty when they match. */
export function stampProblems(expected: Stamp, actual: unknown): string[] {
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return ["the notes have no stamp object; copy the stamp from --slots unchanged"];
  const given = actual as Record<string, unknown>;
  const problems: string[] = [];
  if (given.protocol !== expected.protocol) problems.push(`the stamp is for protocol ${String(given.protocol)} and this report uses protocol ${expected.protocol}`);
  if (given.kind !== expected.kind) problems.push(`the stamp is for the "${String(given.kind)}" report and this is "${expected.kind}"`);
  if (given.head !== expected.head) problems.push(`the stamp is for HEAD ${short(given.head)} and the repository is at ${short(expected.head)}; run --slots again and write the notes from its output`);
  if (given.config !== expected.config) problems.push(`the stamp has config hash ${String(given.config)} and the effective config hash is ${expected.config}; run --slots again`);
  if (canonical(given.inputs ?? null) !== canonical(expected.inputs)) {
    const was = (given.inputs ?? {}) as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(was), ...Object.keys(expected.inputs)])].sort().filter((key) => canonical(was[key] ?? null) !== canonical(expected.inputs[key] ?? null));
    problems.push(`the stamp's inputs differ from this run's${keys.length === 0 ? "" : ` (${keys.join(", ")})`}; run --slots again with the same arguments`);
  }
  return problems;
}
