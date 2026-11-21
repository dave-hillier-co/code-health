import { f, g, v, K, deco } from "./lib";
import * as lib from "./lib";
import Def from "./def";
import type { Shape } from "./lib";

export function run(): unknown {
  f();
  const x = g;
  new K();
  lib.f();
  lib.v;
  Def();
  const s: Shape | undefined = undefined;
  return [v, x, s];
}

@deco
export class Dec {}

export function shadowed(f: () => void): void {
  f();
}

export function blockShadow(): number {
  const g = 1;
  return g;
}

export function loop(items: number[]): void {
  for (const v of items) {
    console.log(v);
  }
}
