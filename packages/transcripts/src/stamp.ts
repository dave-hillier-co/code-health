import { createHash } from "node:crypto";

/** A stamp of the transcript input (its tasks or sessions): the same input always gives the same stamp, so output can name it. */
export function stampOf(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}
