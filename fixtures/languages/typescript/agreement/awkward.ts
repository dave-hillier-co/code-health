// Awkward shapes for the lexical agreement corpus. Every function here is a unit the structural layer finds.
export function destructured({ a, b }: { a: number; b: number }): number {
  return a + b;
}

export function withDefault(options = { retries: 3 }): number {
  return options.retries;
}

export const arrowWithPattern = ({ id }: { id: string }): string => {
  return id;
};

export const expressionBodied = (x: number): number => x * 2;

export const curried = (a: number) => (b: number) => {
  return a + b;
};

export class Outer {
  static Inner = class {
    run(): number {
      return 1;
    }
  };

  handler = (event: string): string => {
    return event;
  };

  get size(): number {
    return 3;
  }

  async *stream(): AsyncGenerator<number> {
    yield 1;
  }
}

export function outerFn(): () => number {
  function innerFn(): number {
    return 2;
  }
  return () => {
    return innerFn();
  };
}

const pattern = /["'`]\/\/\*/g;
export function afterRegex(text: string): boolean {
  return pattern.test(text) && text.length > 0 ? true : false;
}

export function overloaded(a: string): string;
export function overloaded(a: number): number;
export function overloaded(a: unknown): unknown {
  return a;
}

export const registry = {
  register(name: string): void {
    void name;
  },
  nested: {
    deep(): number {
      return 1;
    },
  },
};

export default function (): number {
  return 0;
}

namespace Shapes {
  export function area(r: number): number {
    return r * r;
  }
}
