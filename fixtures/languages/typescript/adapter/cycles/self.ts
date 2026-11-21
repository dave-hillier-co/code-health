import * as self from "./self";

export function me(): number {
  return self === undefined ? 0 : 1;
}
