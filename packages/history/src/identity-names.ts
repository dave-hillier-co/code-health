export interface Address {
  name: string;
  email: string;
}

/** The identity as `git log` shows it. */
export const identityKey = (a: Address): string => `${a.name} <${a.email}>`;

const NOREPLY = /^(?:(\d+)\+)?([^@+]+)@users\.noreply\.github\.com$/i;

/** The id and username in a GitHub noreply address, or null for any other address. */
export function parseNoreply(email: string): { id: string | null; username: string } | null {
  const match = NOREPLY.exec(email.trim());
  return match ? { id: match[1] ?? null, username: match[2]!.toLowerCase() } : null;
}

/** Lower case, with a `+tag` removed from the local part. A GitHub noreply address is only lower-cased: its `+` separates the id. */
export function normaliseEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  if (parseNoreply(lower)) return lower;
  const at = lower.lastIndexOf("@");
  if (at === -1) return lower;
  const plus = lower.indexOf("+");
  return plus !== -1 && plus < at ? lower.slice(0, plus) + lower.slice(at) : lower;
}

export function emailLocalPart(email: string): string {
  const normalised = normaliseEmail(email);
  const at = normalised.lastIndexOf("@");
  return at === -1 ? normalised : normalised.slice(0, at);
}

/**
 * Case, diacritics, whitespace, `_` as a separator, a parenthesised or bracketed affiliation (`Jo Park (Contoso)`)
 * and `Last, First` order removed, so equal names compare equal.
 */
export function normaliseName(name: string): string {
  let text = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/_/g, " ");
  const comma = text.indexOf(",");
  if (comma !== -1 && text.indexOf(",", comma + 1) === -1) text = `${text.slice(comma + 1)} ${text.slice(0, comma)}`;
  return text
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter((t) => t !== "")
    .join(" ");
}

export function nameTokens(name: string): string[] {
  return normaliseName(name)
    .split(" ")
    .filter((t) => t !== "");
}

/** Local parts a person named `John Smith` commonly picks. Empty unless the name has a first and a last part. */
export function derivedLocalParts(name: string): string[] {
  const tokens = nameTokens(name);
  if (tokens.length < 2) return [];
  const first = tokens[0]!;
  const last = tokens[tokens.length - 1]!;
  return [
    `${first}.${last}`,
    `${first}${last}`,
    `${first}_${last}`,
    `${first}-${last}`,
    `${first[0]}.${last}`,
    `${first[0]}${last}`,
  ];
}

/**
 * The usernames a name could be written as, for matching a GitHub noreply username: all its parts joined
 * (`jo-park`), or the first initial and the last name (`jpark`), or the first name and the last initial (`jop`).
 */
export function flattenedNames(name: string): string[] {
  const tokens = nameTokens(name);
  if (tokens.length < 2) return [];
  const first = tokens[0]!;
  const last = tokens[tokens.length - 1]!;
  return [...new Set([...["", "-", ".", "_"].map((glue) => tokens.join(glue)), `${first[0]}${last}`, `${first}${last[0]}`])];
}

/** Providers whose addresses anyone can hold, so a shared domain says nothing about an organisation. */
const MAILBOX_PROVIDERS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "icloud.com", "me.com",
  "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "gmx.de", "web.de", "yandex.ru",
  "yandex.com", "mail.ru", "qq.com", "163.com", "126.com", "fastmail.com", "zoho.com", "hey.com", "tutanota.com",
]);

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ltd", "plc"]);

/**
 * The organisation an address belongs to, as its registrable domain, or null for a mailbox provider and for an
 * address with no domain. `sbykov@pc12.redmond.corp.microsoft.com` and `sbykov@microsoft.com` are both `microsoft.com`.
 */
export function organisationOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const labels = email.slice(at + 1).trim().toLowerCase().split(".").filter((l) => l !== "");
  if (labels.length < 2) return null;
  const keep = labels.length >= 3 && labels[labels.length - 1]!.length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]!) ? 3 : 2;
  const domain = labels.slice(-keep).join(".");
  return MAILBOX_PROVIDERS.has(domain) ? null : domain;
}
