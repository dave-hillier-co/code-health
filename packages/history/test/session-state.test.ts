import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readSession, sessionFile, updateSession } from "../src/session-state.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "session-state-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("each hook keeps its own state for a session, so one hook's silence never hides another's news", () => {
  updateSession(root, "s1", "alpha", (state) => state.spokenAbout.push("a.ts"));
  expect(readSession(root, "s1", "alpha").spokenAbout).toEqual(["a.ts"]);
  expect(readSession(root, "s1", "beta").spokenAbout).toEqual([]);
  expect(sessionFile(root, "s1", "alpha")).not.toBe(sessionFile(root, "s1", "beta"));
});

test("the last measurement of a file survives to the next hook process", () => {
  updateSession(root, "s1", "alpha", (state) => {
    state.measurements["a.ts"] = { "a.ts#run": { keyword: 4, nesting: 2 } };
  });
  expect(readSession(root, "s1", "alpha").measurements).toEqual({ "a.ts": { "a.ts#run": { keyword: 4, nesting: 2 } } });
});

test("a state file from before measurements existed reads as having none", () => {
  updateSession(root, "s1", "alpha", () => {});
  expect(readSession(root, "s1", "alpha").measurements).toEqual({});
});
