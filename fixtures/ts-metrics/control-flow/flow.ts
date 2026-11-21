// Every unit here is counted by hand in expected.json. Comment lines and blank lines do not add to length.
export function plain(a: number): number {
  return a + 1;
}

export function sign(n: number): string {
  // A comment inside the body is not a line of code.

  if (n < 0) {
    return "negative";
  } else if (n === 0) {
    return "zero";
  } else {
    return "positive";
  }
}

// Cognitive complexity specification, sumOfPrimes: for +1, nested for +2, if +3, labelled continue +1 = 7.
export function sumOfPrimes(max: number): number {
  let total = 0;
  OUT: for (let i = 1; i <= max; ++i) {
    for (let j = 2; j < i; ++j) {
      if (i % j === 0) {
        continue OUT;
      }
    }
    total += i;
  }
  return total;
}

export function describe(kind: string, flag: boolean): string {
  switch (kind) {
    case "a":
    case "b":
      return flag ? "ab" : "other";
    case "c":
      return "c";
    default:
      return "none";
  }
}

export function fact(n: number): number {
  try {
    return n <= 1 ? 1 : n * fact(n - 1);
  } catch (error) {
    do {
      n--;
    } while (n > 0 && error);
    throw error;
  }
}
