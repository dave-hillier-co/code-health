/**
 * Builds synthetic Claude Code session transcripts for tests. The shapes mirror
 * what the format module recognises, with invented content only.
 */

export interface UsageSpec {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

export interface ToolCallSpec {
  name: string;
  input: Record<string, unknown>;
}

export class SyntheticSession {
  private lines: string[] = [];
  private clock: number;
  private counter = 0;

  constructor(
    private readonly options: { version?: string | null; cwd?: string; sessionId?: string; start?: string } = {},
  ) {
    this.clock = Date.parse(options.start ?? "2026-03-01T09:00:00.000Z");
  }

  private envelope(type: string): Record<string, unknown> {
    this.clock += 1000;
    const version = this.options.version === undefined ? "2.1.330" : this.options.version;
    return {
      type,
      uuid: `uuid-${++this.counter}`,
      timestamp: new Date(this.clock).toISOString(),
      sessionId: this.options.sessionId ?? "session-1",
      cwd: this.options.cwd ?? "/work/repo",
      isSidechain: false,
      ...(version === null ? {} : { version }),
    };
  }

  private push(entry: Record<string, unknown>): this {
    this.lines.push(JSON.stringify(entry));
    return this;
  }

  /** Place the next entry at an explicit time, for example on a later day. */
  at(timestamp: string): this {
    this.clock = Date.parse(timestamp) - 1000;
    return this;
  }

  metadata(type: string): this {
    return this.push({ type, note: "ignored" });
  }

  prompt(text = "synthetic prompt", extra: Record<string, unknown> = {}): this {
    return this.push({
      ...this.envelope("user"),
      origin: { kind: "human" },
      message: { role: "user", content: text },
      ...extra,
    });
  }

  /** One assistant message, written as one transcript line per content block, as Claude Code does. */
  assistant(id: string, calls: ToolCallSpec[], usage: UsageSpec = {}, withText = true): this {
    const blocks: Record<string, unknown>[] = [];
    if (withText) blocks.push({ type: "text", text: "synthetic reply" });
    calls.forEach((call, i) =>
      blocks.push({ type: "tool_use", id: `${id}-tool-${i}`, name: call.name, input: call.input }),
    );
    for (const block of blocks) {
      this.push({
        ...this.envelope("assistant"),
        message: {
          id,
          role: "assistant",
          content: [block],
          usage: {
            input_tokens: usage.input ?? 0,
            output_tokens: usage.output ?? 0,
            cache_read_input_tokens: usage.cacheRead ?? 0,
            cache_creation_input_tokens: usage.cacheCreation ?? 0,
          },
        },
      });
    }
    return this;
  }

  toolResult(id: string): this {
    return this.push({
      ...this.envelope("user"),
      toolUseResult: { synthetic: true },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "synthetic output" }] },
    });
  }

  raw(line: string): this {
    this.lines.push(line);
    return this;
  }

  toJsonl(): string {
    return this.lines.join("\n") + "\n";
  }
}

export function read(path: string): ToolCallSpec {
  return { name: "Read", input: { file_path: path } };
}
export function edit(path: string): ToolCallSpec {
  return { name: "Edit", input: { file_path: path, old_string: "a", new_string: "b" } };
}
export function write(path: string): ToolCallSpec {
  return { name: "Write", input: { file_path: path, content: "x" } };
}
export function grep(path?: string): ToolCallSpec {
  return { name: "Grep", input: { pattern: "needle", ...(path === undefined ? {} : { path }) } };
}
export function bash(command = "ls"): ToolCallSpec {
  return { name: "Bash", input: { command } };
}
