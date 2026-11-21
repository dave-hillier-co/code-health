/**
 * True when the message carries a `Code-Health:` trailer: a `Code-Health:` line
 * in the last paragraph, which must follow the subject paragraph. The key is
 * matched case-insensitively, as git's own trailer parsing does. Commits made
 * through the suite's skills carry it.
 */
export function hasCodeHealthTrailer(message: string): boolean {
  const paragraphs = message
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n[ \t]*\n/);
  if (paragraphs.length < 2) return false;
  return paragraphs[paragraphs.length - 1]!.split("\n").some((line) => /^code-health[ \t]*:/i.test(line));
}
