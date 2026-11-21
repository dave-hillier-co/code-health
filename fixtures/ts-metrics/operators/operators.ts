export function access(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean): boolean {
  if (a && b && c || d || e) {
    return !(a && b) || (c && d);
  }
  return (a ?? b) ? c : d;
}

// Optional chaining is free. The nullish operator is a decision point for cyclomatic and free for cognitive.
export const pick = (a?: { b?: { c: number } }): number => a?.b?.c ?? 0;

export function assign(a: number | null, b: boolean): number | null {
  a ??= 1;
  b &&= a > 0;
  return b ? a : null;
}
