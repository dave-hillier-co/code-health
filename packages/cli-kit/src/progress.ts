export interface ProgressOptions {
  /** Defaults to stderr. Progress never goes to stdout, so the JSON stays deterministic. */
  stream?: { write(text: string): unknown; isTTY?: boolean };
  now?: () => number;
  /** On a terminal, the line is redrawn at most this often. */
  redrawEveryMs?: number;
  /** Elsewhere, nothing is printed until the work has lasted this long, */
  quietMs?: number;
  /** and then one line at most this often. */
  lineEveryMs?: number;
}

export interface ProgressReporter {
  update(done: number, total: number): void;
  /** Ends the line on a terminal. */
  end(): void;
}

/**
 * Progress of a long piece of work, such as a first blame, on stderr. On a terminal one
 * line is redrawn in place. When stderr is a file or a pipe, as for an agent, a short run
 * prints nothing and a long one prints a line now and then.
 */
export function progressReporter(describe: (done: number, total: number) => string, options: ProgressOptions = {}): ProgressReporter {
  const { stream = process.stderr, now = Date.now, redrawEveryMs = 200, quietMs = 30_000, lineEveryMs = 60_000 } = options;
  const started = now();
  let printedAt: number | undefined;
  return {
    update(done, total) {
      const at = now();
      if (stream.isTTY) {
        if (printedAt !== undefined && at - printedAt < redrawEveryMs && done < total) return;
        stream.write(`\r${describe(done, total)}`);
        printedAt = at;
        return;
      }
      if (at - started < quietMs) return;
      if (printedAt !== undefined && at - printedAt < lineEveryMs) return;
      stream.write(`${describe(done, total)}\n`);
      printedAt = at;
    },
    end() {
      if (stream.isTTY && printedAt !== undefined) stream.write("\n");
    },
  };
}
