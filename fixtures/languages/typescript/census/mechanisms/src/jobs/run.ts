import { retry } from "../app/retry.ts";

export function run(): void {
  retry(() => undefined);
}
