interface Options {
  retries: number;
  timeout: number;
  extra?: string;
}

export function outer(items: number[]): number[] {
  const result: number[] = [];
  items.forEach((item) => {
    if (item > 0) {
      result.push(item);
    }
  });
  function helper(x: number): number {
    return x > 1 ? x : 1;
  }
  return result.map(helper);
}

export class Service {
  constructor(private readonly name: string, public count = 0) {}

  run({ retries, timeout, ...rest }: Options, flag?: boolean): void {
    for (const attempt of [retries]) {
      if (flag && attempt > timeout) break;
    }
    void rest;
  }

  get label(): string {
    return this.name;
  }

  walk(n: number): number {
    return n > 0 ? this.walk(n - 1) : 0;
  }
}
