import { runGit } from "./git.ts";
import { identityKey, type Address } from "./identity-names.ts";

/**
 * Maps identities through the mailmap as it stands in the working tree (and the
 * local-only mailmap file when there is one), so a mapping just written is seen
 * before it is committed. Returns the mapped address for each identity key.
 */
export async function mapThroughMailmap(
  root: string,
  identities: readonly Address[],
  localMailmap?: string,
): Promise<Map<string, Address>> {
  const keys = [...new Set(identities.map(identityKey))].sort();
  const mapped = new Map<string, Address>();
  if (keys.length === 0) return mapped;
  const out = await runGit(root, ["-c", `mailmap.file=${localMailmap ?? ""}`, "-c", "mailmap.blob=", "check-mailmap", "--stdin"], {
    input: keys.join("\n") + "\n",
  });
  const lines = out.split("\n");
  keys.forEach((key, i) => {
    const line = lines[i] ?? key;
    const open = line.lastIndexOf("<");
    const close = line.lastIndexOf(">");
    mapped.set(
      key,
      open === -1 || close < open
        ? parseKey(key)
        : { name: line.slice(0, open).trim(), email: line.slice(open + 1, close) },
    );
  });
  return mapped;
}

function parseKey(key: string): Address {
  const open = key.lastIndexOf("<");
  return { name: key.slice(0, open).trim(), email: key.slice(open + 1, key.lastIndexOf(">")) };
}
