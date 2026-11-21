import { expect, test } from "vitest";
import { buildDocument } from "../src/document.ts";

const parts = {
  schemaVersion: 1,
  tool: "demo",
  command: "list",
  repo: { head: "abc", dirty: false },
  configHash: "0123456789abcdef",
  results: [{ path: "a" }],
  truncated: { limit: null, total: 1, cut: 0 },
};

test("builds the common envelope, with empty inputs when there are none", () => {
  expect(buildDocument(parts)).toEqual({
    schemaVersion: 1,
    tool: "demo",
    command: "list",
    repo: { head: "abc", dirty: false },
    config: "0123456789abcdef",
    inputs: {},
    results: [{ path: "a" }],
    truncated: { limit: null, total: 1, cut: 0 },
  });
});

test("meta appears only when given, and extra sections sit beside the envelope", () => {
  const meta = { durationMs: 1 };
  const document = buildDocument({ ...parts, meta, extra: { evidence: { grade: "weak" } } });
  expect(document.meta).toBe(meta);
  expect(document.evidence).toEqual({ grade: "weak" });
});

test("an extra section cannot replace an envelope field", () => {
  expect(() => buildDocument({ ...parts, extra: { results: [] } })).toThrow(/results/);
  expect(() => buildDocument({ ...parts, extra: { meta: {} } })).toThrow(/meta/);
});
