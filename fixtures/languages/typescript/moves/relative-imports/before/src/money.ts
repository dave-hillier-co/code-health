import { round } from "./round.ts";

export function money(value: number): string {
  return round(value).toFixed(2);
}
