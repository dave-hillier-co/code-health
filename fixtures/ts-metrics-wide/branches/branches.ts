// Wider metric conformance, counted by hand in expected.json from the definitions in unit-metrics.ts.
// Kept apart from fixtures/ts-metrics, which is also the lexical agreement corpus, so adding cases here never moves the recorded agreement.
export function grade(score: number): string {
  if (score >= 90) {
    return "A";
  } else if (score >= 80) {
    return "B";
  } else if (score >= 70) {
    return "C";
  } else {
    return "F";
  }
}

export function scan(grid: number[][], seen: Record<string, number>): number {
  let hits = 0;
  for (const row of grid) {
    for (const key in seen) {
      while (hits < row.length) {
        hits++;
      }
    }
  }
  return hits;
}

export function route(codes: number[]): string[] {
  const out: string[] = [];
  for (const code of codes) {
    switch (code) {
      case 1:
        out.push(code > 0 ? "one" : "never");
        break;
      case 2:
      case 3:
        out.push("few");
        break;
      default:
        out.push("many");
    }
  }
  return out;
}

export function validate(a: boolean, b: boolean, c: boolean, d: boolean): boolean {
  if (a && b || c && d) {
    return true;
  }
  return !(a || b) && !c;
}
