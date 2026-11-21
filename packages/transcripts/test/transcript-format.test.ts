import { expect, test } from "vitest";
import { parseTranscript } from "../src/transcript-format.ts";
import { SyntheticSession, bash, edit, grep, read } from "./synthetic-transcript.ts";

function events(session: SyntheticSession) {
  const parsed = parseTranscript(session.toJsonl());
  if (parsed.status !== "recognised") throw new Error(`expected recognised, got ${parsed.reason}`);
  return parsed.events;
}

test("a recognised version yields prompts and agent turns in order", () => {
  const session = new SyntheticSession()
    .prompt()
    .assistant("m1", [read("/work/repo/a.ts")], { input: 3, output: 5, cacheRead: 7, cacheCreation: 11 })
    .toolResult("m1-tool-0");
  const result = events(session);
  expect(result.map((e) => e.kind)).toEqual(["prompt", "agent-turn"]);
  expect(result[1]).toMatchObject({
    kind: "agent-turn",
    tokens: { input: 3, output: 5, cacheRead: 7, cacheCreation: 11 },
    actions: [{ kind: "read", path: "/work/repo/a.ts" }],
  });
});

test("lines that share a message id are one agent turn, counted once", () => {
  const session = new SyntheticSession()
    .prompt()
    .assistant("m1", [read("/work/repo/a.ts"), read("/work/repo/b.ts")], { output: 10 });
  const turns = events(session).filter((e) => e.kind === "agent-turn");
  expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({ tokens: { output: 10 } });
  expect(turns[0]?.kind === "agent-turn" && turns[0].actions).toHaveLength(2);
});

test("tool results, metadata lines, meta prompts and non-human origins are not prompts", () => {
  const session = new SyntheticSession()
    .metadata("file-history-snapshot")
    .prompt("p", { isMeta: true })
    .prompt("p", { origin: { kind: "task-notification" } })
    .prompt("p", { isSidechain: true })
    .assistant("m1", [read("/work/repo/a.ts")])
    .toolResult("m1-tool-0");
  expect(events(session).map((e) => e.kind)).toEqual(["agent-turn"]);
});

test("a prompt may carry content blocks, and an absent origin still counts as a prompt", () => {
  const session = new SyntheticSession().prompt("p", {
    origin: undefined,
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  });
  expect(events(session).map((e) => e.kind)).toEqual(["prompt"]);
});

test("tool calls are classified as read, search or edit by name, and unknown tools are ignored", () => {
  const session = new SyntheticSession().prompt().assistant("m1", [
    read("/work/repo/a.ts"),
    grep("/work/repo/src"),
    grep(),
    edit("/work/repo/b.ts"),
    { name: "Write", input: { file_path: "/work/repo/c.ts" } },
    { name: "NotebookEdit", input: { notebook_path: "/work/repo/n.ipynb" } },
    { name: "MultiEdit", input: { file_path: "/work/repo/d.ts" } },
    bash(),
  ]);
  const turn = events(session)[1];
  expect(turn?.kind === "agent-turn" && turn.actions).toEqual([
    { kind: "read", path: "/work/repo/a.ts" },
    { kind: "search", path: "/work/repo/src" },
    { kind: "search", path: null },
    { kind: "edit", path: "/work/repo/b.ts" },
    { kind: "edit", path: "/work/repo/c.ts" },
    { kind: "edit", path: "/work/repo/n.ipynb" },
    { kind: "edit", path: "/work/repo/d.ts" },
  ]);
});

test("an unrecognised version is not measured, and names the version", () => {
  const parsed = parseTranscript(new SyntheticSession({ version: "3.0.1" }).prompt().toJsonl());
  expect(parsed).toEqual({ status: "not-measured", version: "3.0.1", reason: "unrecognised transcript version" });
});

test("a transcript with no version stamps is not measured", () => {
  const parsed = parseTranscript(new SyntheticSession({ version: null }).prompt().toJsonl());
  expect(parsed).toMatchObject({ status: "not-measured", version: null });
});

test("a session whose versions are mixed with an unrecognised one is not measured", () => {
  const text =
    new SyntheticSession().prompt().toJsonl() + new SyntheticSession({ version: "9.9.9" }).prompt().toJsonl();
  expect(parseTranscript(text)).toMatchObject({ status: "not-measured", version: "9.9.9" });
});

test("a recognised version with an unexpected message shape is not measured rather than guessed", () => {
  const session = new SyntheticSession()
    .prompt()
    .raw(
      JSON.stringify({
        type: "assistant",
        version: "2.1.330",
        timestamp: "2026-03-01T09:00:05.000Z",
        message: { id: "x" },
      }),
    );
  expect(parseTranscript(session.toJsonl())).toMatchObject({
    status: "not-measured",
    reason: "unexpected assistant message shape",
  });
});

test("truncated or non-JSON lines are skipped", () => {
  const session = new SyntheticSession().raw("{not json").prompt().raw('{"type":"assis');
  expect(events(session).map((e) => e.kind)).toEqual(["prompt"]);
});

test("an empty transcript is not measured", () => {
  expect(parseTranscript("")).toMatchObject({ status: "not-measured" });
});
