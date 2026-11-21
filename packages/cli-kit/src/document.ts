export interface DocumentParts {
  schemaVersion: number;
  tool: string;
  command: string;
  repo: { head: string; dirty: boolean };
  configHash: string;
  inputs?: Record<string, unknown>;
  /** Sections a tool adds beside the envelope, such as `evidence`. They cannot replace envelope fields. */
  extra?: Record<string, unknown>;
  results: unknown;
  truncated: unknown;
  /** Wall-clock facts. Left out of anything stored or compared byte for byte. */
  meta?: Record<string, unknown>;
}

const ENVELOPE_KEYS = [
  "schemaVersion",
  "tool",
  "command",
  "repo",
  "config",
  "inputs",
  "results",
  "truncated",
  "meta",
];

/** The JSON document every command prints and every report stores (reports omit `meta`). */
export function buildDocument(parts: DocumentParts): Record<string, unknown> {
  for (const key of Object.keys(parts.extra ?? {})) {
    if (ENVELOPE_KEYS.includes(key)) throw new Error(`extra section "${key}" would replace an envelope field`);
  }
  return {
    schemaVersion: parts.schemaVersion,
    tool: parts.tool,
    command: parts.command,
    repo: parts.repo,
    config: parts.configHash,
    inputs: parts.inputs ?? {},
    ...parts.extra,
    results: parts.results,
    truncated: parts.truncated,
    ...(parts.meta ? { meta: parts.meta } : {}),
  };
}
