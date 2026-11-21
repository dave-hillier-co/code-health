/**
 * Parses JSON with comments and trailing commas, the dialect tsconfig.json
 * uses. Returns undefined when the text is not valid even after tolerating
 * those, so a broken config is skipped rather than fatal.
 */
export function parseJsonc(text: string): unknown {
  let cleaned = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;
    if (char === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      cleaned += text.slice(i, end + 1);
      i = end + 1;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      cleaned += char;
      i++;
    }
  }
  try {
    return JSON.parse(removeTrailingCommas(cleaned));
  } catch {
    return undefined;
  }
}

function removeTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;
    if (char === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(i, end + 1);
      i = end + 1;
    } else if (char === ",") {
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next] as string)) next++;
      if (text[next] !== "}" && text[next] !== "]") out += char;
      i++;
    } else {
      out += char;
      i++;
    }
  }
  return out;
}
