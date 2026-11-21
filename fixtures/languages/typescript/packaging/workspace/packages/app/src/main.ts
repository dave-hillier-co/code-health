import { describe, Level } from "@acme/core";
import { secret } from "../../core/src/internal.ts";

export function main(): string {
  return describe(Level.High) + secret();
}
