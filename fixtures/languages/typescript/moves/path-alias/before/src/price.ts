import { tax } from "@app/tax";

export function price(value: number): number {
  return value + tax(value);
}
