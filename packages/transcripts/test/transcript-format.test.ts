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
  expect(parsed).toEqual({
    status: "not-measured",
    version: "3.0.1",
    reason: "unrecognised transcript version",
    startedAt: "2026-03-01T09:00:01.000Z",
    cwds: ["/work/repo"],
  });
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

test("an assistant line with an unexpected shape is skipped and counted, not fatal to the session", () => {
  const session = new SyntheticSession()
    .prompt()
    .assistant("m1", [read("/work/repo/a.ts")])
    .raw(JSON.stringify({ type: "assistant", version: "2.1.330", timestamp: "2026-03-01T09:00:05.000Z", message: { id: "x" } }))
    .raw(
      JSON.stringify({
        type: "assistant",
        version: "2.1.330",
        timestamp: "2026-03-01T09:00:06.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "API Error" }], model: "<synthetic>" },
      }),
    );
  const parsed = parseTranscript(session.toJsonl());
  expect(parsed).toMatchObject({ status: "recognised", skippedLines: 2 });
  expect(events(session).map((e) => e.kind)).toEqual(["prompt", "agent-turn"]);
});

test("truncated or non-JSON lines are skipped", () => {
  const session = new SyntheticSession().raw("{not json").prompt().raw('{"type":"assis');
  expect(events(session).map((e) => e.kind)).toEqual(["prompt"]);
});

test("an empty transcript is not measured", () => {
  expect(parseTranscript("")).toMatchObject({ status: "not-measured" });
});

test("compaction summaries, interrupt markers and transcript-only lines are not prompts", () => {
  const session = new SyntheticSession()
    .prompt("real")
    .prompt("This session is being continued from a previous conversation...", { isCompactSummary: true })
    .prompt("shown only in the transcript", { isVisibleInTranscriptOnly: true })
    .prompt("[Request interrupted by user]")
    .raw(
      JSON.stringify({
        type: "user",
        version: "2.1.330",
        timestamp: "2026-03-01T09:30:00.000Z",
        origin: { kind: "human" },
        message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] },
      }),
    );
  expect(events(session).map((e) => e.kind)).toEqual(["prompt"]);
});

test("versions are compared numerically, so 2.1.10 is newer than 2.1.9", () => {
  const text =
    new SyntheticSession({ version: "2.1.9" }).prompt().toJsonl() +
    new SyntheticSession({ version: "2.1.10", start: "2026-03-02T09:00:00.000Z" }).prompt().toJsonl();
  expect(parseTranscript(text)).toMatchObject({ status: "recognised", version: "2.1.10" });
  const mixed = text + new SyntheticSession({ version: "3.0.0" }).prompt().toJsonl() + new SyntheticSession({ version: "2.10.0" }).prompt().toJsonl();
  expect(parseTranscript(mixed)).toMatchObject({ status: "not-measured", version: "2.10.0" });
});

test("when lines of one message carry different usage, the last line's usage is the message's", () => {
  const usage = (output: number) => ({ input_tokens: 1, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  const line = (output: number, block: object) =>
    JSON.stringify({
      type: "assistant",
      version: "2.1.330",
      timestamp: "2026-03-01T09:00:05.000Z",
      message: { id: "m1", role: "assistant", content: [block], usage: usage(output) },
    });
  const session = new SyntheticSession()
    .prompt()
    .raw(line(2, { type: "text", text: "partial" }))
    .raw(line(40, { type: "tool_use", id: "t", name: "Read", input: { file_path: "/work/repo/a.ts" } }));
  expect(events(session)[1]).toMatchObject({ tokens: { output: 40 }, actions: [{ kind: "read" }] });
});

test("subagent (sidechain) lines are left out of the main session's effort", () => {
  const session = new SyntheticSession()
    .prompt()
    .assistant("m1", [read("/work/repo/a.ts")], { output: 5 })
    .raw(
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        version: "2.1.330",
        timestamp: "2026-03-01T09:00:07.000Z",
        message: { id: "side", role: "assistant", content: [{ type: "text", text: "x" }], usage: { output_tokens: 999 } },
      }),
    );
  expect(events(session).filter((e) => e.kind === "agent-turn")).toHaveLength(1);
});

test("a byte order mark, CRLF line endings and a tool_use without a result are tolerated", () => {
  const session = new SyntheticSession().prompt().assistant("m1", [read("/work/repo/a.ts")]);
  const text = "\uFEFF" + session.toJsonl().replaceAll("\n", "\r\n");
  const parsed = parseTranscript(text);
  expect(parsed.status).toBe("recognised");
  if (parsed.status === "recognised") expect(parsed.events.map((e) => e.kind)).toEqual(["prompt", "agent-turn"]);
});

test("usage with missing fields counts as zero, and the working directories are reported", () => {
  const session = new SyntheticSession({ cwd: "/work/a" }).prompt().raw(
    JSON.stringify({
      type: "assistant",
      version: "2.1.330",
      cwd: "/work/b",
      timestamp: "2026-03-01T09:00:05.000Z",
      message: { id: "m1", role: "assistant", content: [], usage: { output_tokens: 3 } },
    }),
  );
  const parsed = parseTranscript(session.toJsonl());
  expect(parsed).toMatchObject({ status: "recognised", cwds: ["/work/a", "/work/b"] });
  if (parsed.status === "recognised") {
    expect(parsed.events[1]).toMatchObject({ tokens: { input: 0, output: 3, cacheRead: 0, cacheCreation: 0 } });
  }
});
