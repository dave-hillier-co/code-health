import { money } from "./money.ts";

export function total(value: number): string {
  return money(value);
}
