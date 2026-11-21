function escape(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** Whether the `{` at `start` has a matching `}`. An unmatched one is a literal. */
function hasClosingBrace(pattern: string, start: number): boolean {
  let depth = 0;
  for (let i = start; i < pattern.length; i++) {
    if (pattern[i] === "{") depth++;
    else if (pattern[i] === "}" && --depth === 0) return true;
  }
  return false;
}

function toRegExp(pattern: string): RegExp {
  let out = "";
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{" && hasClosingBrace(pattern, i)) {
      braces++;
      out += "(?:";
    } else if (ch === "}" && braces > 0) {
      braces--;
      out += ")";
    } else if (ch === "," && braces > 0) {
      out += "|";
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
      } else {
        const body = pattern.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\");
        out += `[${body}]`;
        i = end;
      }
    } else {
      out += escape(ch);
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Matches repo-relative POSIX paths against globs. Supports `*`, `**`, `?`,
 * `[abc]` and `{a,b}`.
 *
 * - A pattern without a slash matches any path segment, so `node_modules`
 *   and `*.min.js` match at any depth, and a directory name covers
 *   everything beneath it.
 * - A pattern with a slash is anchored at the repo root (a leading slash is
 *   optional) and also covers everything beneath a directory it matches.
 */
export function compileGlobs(patterns: readonly string[]): (path: string) => boolean {
  const compiled = patterns
    .map((p) => p.trim())
    .filter((p) => p !== "" && !p.startsWith("#"))
    .map((raw) => {
      const pattern = raw.replace(/\/+$/, "");
      const anchored = pattern.includes("/");
      return { anchored, regex: toRegExp(anchored ? pattern.replace(/^\//, "") : pattern) };
    });
  return (path) => {
    const segments = path.split("/");
    for (const { anchored, regex } of compiled) {
      if (anchored) {
        for (let n = 1; n <= segments.length; n++) {
          if (regex.test(segments.slice(0, n).join("/"))) return true;
        }
      } else if (segments.some((s) => regex.test(s))) {
        return true;
      }
    }
    return false;
  };
}
