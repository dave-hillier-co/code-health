import { target, Target } from "./target.ts";

export function relay(...rest: number[]) {
  return target(...rest);
}

export function fixed(id: string) {
  return target(id, "x", 1, undefined);
}

export function bare() {
  return target();
}

export async function wrapped(id: string) {
  return (await target(id)) as number;
}

export function computed(id: string) {
  return target({ id });
}

export function creates(id: string) {
  return new Target(id);
}

export function early(id: string) {
  if (!id) return;
  return target(id);
}

export abstract class Shape {
  abstract area(): number;
  describe(): string {
    return "shape";
  }
}
