/** The sides of a co-change count: `shared` changes touched both, among `a` and `b` that touched each, of `total`. */
export interface CoChangeCounts {
  shared: number;
  a: number;
  b: number;
  total: number;
}

const logFactorials: number[] = [0];

function logFactorial(n: number): number {
  for (let i = logFactorials.length; i <= n; i++) logFactorials.push(logFactorials[i - 1]! + Math.log(i));
  return logFactorials[n]!;
}

const logChoose = (n: number, k: number): number => logFactorial(n) - logFactorial(k) - logFactorial(n - k);

/**
 * A one-sided exact test of co-change: the probability that two sides which changed
 * independently, `a` and `b` times in `total` changes, would share at least `shared` of them. It is
 * the upper tail of the hypergeometric distribution, whose mean is the expected count `a * b / total`.
 * Comparing with that mean alone is not enough, since it is usually well below one on real histories,
 * so any shared change would exceed it.
 */
export function coChangePValue({ shared, a, b, total }: CoChangeCounts): number {
  if (shared <= 0) return 1;
  const most = Math.min(a, b);
  if (shared > most) return 0;
  const least = Math.max(0, a + b - total);
  let tail = 0;
  for (let k = Math.max(shared, least); k <= most; k++) {
    tail += Math.exp(logChoose(a, k) + logChoose(total - a, b - k) - logChoose(total, b));
  }
  return Math.min(1, tail);
}
