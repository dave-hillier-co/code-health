export function pipeline(items: number[], limit: number): number[] {
  return items
    .filter((item) => item > 0 && item < limit)
    .map((item) => (item % 2 === 0 ? item / 2 : item * 3 + 1));
}

export function configure(
  this: Window,
  { host, port = 80 }: { host: string; port?: number },
  [first, second]: string[],
  ...rest: number[]
): string {
  return `${host}:${port}:${first}${second}${rest.length}`;
}
