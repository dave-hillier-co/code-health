/**
 * The subset of TOML that package manifests (`pyproject.toml`, `Cargo.toml`) use: tables, arrays of
 * tables, dotted keys, strings, numbers, booleans, arrays (also across lines) and inline tables.
 * Dates and multi-line strings are not read; a value that cannot be read is left out.
 */
export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };
export type TomlTable = { [key: string]: TomlValue };

class Reader {
  private index = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  skipSpace(): void {
    while (this.index < this.text.length && /[ \t\r\n]/.test(this.text[this.index]!)) this.index++;
  }

  /** Skips spaces, newlines and comments, as between items of an array. */
  skipFiller(): void {
    for (;;) {
      this.skipSpace();
      if (this.text[this.index] !== "#") return;
      this.restOfLine();
    }
  }

  value(): TomlValue | undefined {
    const ch = this.text[this.index];
    if (ch === '"' || ch === "'") return this.string();
    if (ch === "[") return this.array();
    if (ch === "{") return this.inline();
    const word = /^[^\s,\]}#]+/.exec(this.text.slice(this.index))?.[0];
    if (word === undefined) return undefined;
    this.index += word.length;
    if (word === "true") return true;
    if (word === "false") return false;
    const number = Number(word.replaceAll("_", ""));
    return Number.isNaN(number) ? undefined : number;
  }

  string(): string {
    const quote = this.text[this.index++]!;
    let out = "";
    while (this.index < this.text.length && this.text[this.index] !== quote) {
      const ch = this.text[this.index++]!;
      if (quote === '"' && ch === "\\") {
        const next = this.text[this.index++]!;
        out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      } else {
        out += ch;
      }
    }
    this.index++;
    return out;
  }

  array(): TomlValue[] {
    this.index++;
    const items: TomlValue[] = [];
    for (;;) {
      this.skipFiller();
      if (this.index >= this.text.length) return items;
      if (this.text[this.index] === "]") {
        this.index++;
        return items;
      }
      const item = this.value();
      if (item === undefined) this.index++;
      else items.push(item);
      this.skipFiller();
      if (this.text[this.index] === ",") this.index++;
    }
  }

  inline(): TomlTable {
    this.index++;
    const table: TomlTable = {};
    for (;;) {
      this.skipFiller();
      if (this.index >= this.text.length) return table;
      if (this.text[this.index] === "}") {
        this.index++;
        return table;
      }
      const path = this.key();
      this.skipSpace();
      if (this.text[this.index] === "=") {
        this.index++;
        this.skipSpace();
        const value = this.value();
        if (value !== undefined) assign(table, path, value);
      } else {
        this.index++;
      }
      this.skipFiller();
      if (this.text[this.index] === ",") this.index++;
    }
  }

  /** A possibly dotted, possibly quoted key. */
  key(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.skipSpace();
      const ch = this.text[this.index];
      if (ch === '"' || ch === "'") {
        parts.push(this.string());
      } else {
        const bare = /^[A-Za-z0-9_-]+/.exec(this.text.slice(this.index))?.[0] ?? "";
        this.index += bare.length;
        if (bare === "") return parts;
        parts.push(bare);
      }
      this.skipSpace();
      if (this.text[this.index] === ".") this.index++;
      else return parts;
    }
  }

  atEnd(): boolean {
    return this.index >= this.text.length;
  }

  peek(): string | undefined {
    return this.text[this.index];
  }

  next(): void {
    this.index++;
  }

  restOfLine(): void {
    while (this.index < this.text.length && this.text[this.index] !== "\n") this.index++;
  }
}

function assign(table: TomlTable, path: string[], value: TomlValue): void {
  let at = table;
  for (const part of path.slice(0, -1)) {
    const existing = at[part];
    if (Array.isArray(existing)) at = existing[existing.length - 1] as TomlTable;
    else if (typeof existing === "object") at = existing;
    else at = at[part] = {};
  }
  at[path.at(-1) as string] = value;
}

function tableAt(root: TomlTable, path: string[], appendToArray: boolean): TomlTable {
  let at = root;
  path.forEach((part, i) => {
    const last = i === path.length - 1;
    const existing = at[part];
    if (last && appendToArray) {
      const list = Array.isArray(existing) ? existing : (at[part] = []);
      const created: TomlTable = {};
      list.push(created);
      at = created;
    } else if (Array.isArray(existing)) {
      at = existing[existing.length - 1] as TomlTable;
    } else if (typeof existing === "object") {
      at = existing;
    } else {
      at = at[part] = {};
    }
  });
  return at;
}

export function parseToml(text: string): TomlTable {
  const reader = new Reader(text);
  const root: TomlTable = {};
  let current = root;
  while (!reader.atEnd()) {
    reader.skipFiller();
    if (reader.atEnd()) break;
    if (reader.peek() === "[") {
      reader.next();
      const array = reader.peek() === "[";
      if (array) reader.next();
      const path = reader.key();
      current = tableAt(root, path, array);
      reader.restOfLine();
      continue;
    }
    const path = reader.key();
    reader.skipSpace();
    if (path.length === 0 || reader.peek() !== "=") {
      reader.restOfLine();
      continue;
    }
    reader.next();
    reader.skipSpace();
    const value = reader.value();
    if (value !== undefined) assign(current, path, value);
    reader.restOfLine();
  }
  return root;
}
