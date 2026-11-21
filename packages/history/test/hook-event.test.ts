import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { findRepoRoot, readEditEvent, within } from "../src/hook-event.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hook-event-")));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "src"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const event = (body: object) => JSON.stringify({ session_id: "s", cwd: root, tool_name: "Edit", tool_input: { file_path: join(root, "src", "a.ts") }, ...body });

test("an edit inside a repository is the session, the root and the repo-relative file", () => {
  expect(readEditEvent(event({}), "/elsewhere")).toEqual({ sessionId: "s", root, file: "src/a.ts" });
});

test("the root is found from a subfolder with no process spawned, and a folder outside any repository has none", () => {
  expect(findRepoRoot(join(root, "src"))).toBe(root);
  expect(findRepoRoot(mkdtempSync(join(tmpdir(), "no-repo-")))).toBeUndefined();
});

test("the fallback directory is used when the event names none", () => {
  expect(readEditEvent(event({ cwd: undefined }), root)?.root).toBe(root);
});

test("no session, another tool, no file, or a file outside the repository is not an edit event", () => {
  expect(readEditEvent(event({ session_id: undefined }), root)).toBeUndefined();
  expect(readEditEvent(event({ session_id: "" }), root)).toBeUndefined();
  expect(readEditEvent(event({ tool_name: "Read" }), root)).toBeUndefined();
  expect(readEditEvent(event({ tool_input: {} }), root)).toBeUndefined();
  expect(readEditEvent(event({ tool_input: { file_path: "/somewhere/else.ts" } }), root)).toBeUndefined();
  expect(readEditEvent(event({ tool_input: { file_path: "../up.ts" } }), root)).toBeUndefined();
});

test("stdin that is not JSON throws, for the hook to turn into silence", () => {
  expect(() => readEditEvent("not json", root)).toThrow();
});

test("within gives the answer when it comes in time, and silence when the budget is spent first", async () => {
  // Fake timers drive both the timer and performance.now(), so no ordering depends on how busy the machine is.
  vi.useFakeTimers();
  try {
    expect(await within(1_000, performance.now(), Promise.resolve("answer"), "silence")).toBe("answer");

    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200));
    const raced = within(10, performance.now(), slow, "silence");
    await vi.advanceTimersByTimeAsync(10);
    expect(await raced).toBe("silence");

    const started = performance.now();
    vi.setSystemTime(Date.now() + 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    const never = new Promise<string>(() => {});
    const late = within(1_000, started, never, "silence");
    await vi.advanceTimersByTimeAsync(0);
    expect(await late).toBe("silence");
  } finally {
    vi.useRealTimers();
  }
});

test("within passes a failure of the work on", async () => {
  await expect(within(1_000, performance.now(), Promise.reject(new Error("boom")), "silence")).rejects.toThrow("boom");
});
