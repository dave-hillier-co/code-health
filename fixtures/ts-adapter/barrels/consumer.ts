import { a, bee, ns, D, x, cc2, nothing } from "./src";
import { one, two } from "./src/cycle1";

export function run() {
  a();
  bee();
  ns.cc();
  D();
  x();
  cc2();
  one();
  two();
  return nothing;
}
