import { format } from "./fmt";

export class Report {
  format(x: number): string {
    return format(x);
  }
  run(x: number): number {
    if (x > 0) {
      return this.run(x - 1);
    }
    return 0;
  }
  static walk(x: number): number {
    return x > 0 ? Report.walk(x - 1) : 0;
  }
}

export function shadow(n: number): number {
  const f = (shadow: (n: number) => number) => shadow(n);
  return f(() => 1);
}

export function countdown(n: number): number {
  if (n > 0) {
    return countdown(n - 1);
  }
  return 0;
}
