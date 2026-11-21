export function plain(a: number): number {
  return a;
}

function overloaded(a: string): string;
function overloaded(a: number): number;
function overloaded(a: unknown): unknown {
  return a;
}

export const arrow = (a: number) => a + 1;

export const multi = (a: number) => {
  return a;
};

const fnExpr = function () {
  return 1;
};

const first = () => 1,
  second = () => 2;

export default function () {
  return 0;
}

export class Widget {
  count = 0;
  handler = () => {
    return this.count;
  };

  constructor(readonly name: string) {}

  render(): string {
    const helper = () => this.name;
    function inner() {
      return helper();
    }
    return inner();
  }

  get size(): number {
    return 1;
  }

  set size(value: number) {
    this.count = value;
  }

  static create(): Widget {
    return new Widget("w");
  }

  #secret() {}

  [Symbol.iterator]() {}
}

abstract class Base {
  abstract run(): void;
  walk() {}
}

const registry = {
  register() {},
  lookup: (key: string) => key,
  build: function () {},
  nested: { skipped() {} },
};

namespace Outer {
  export function deep() {
    return () => 1;
  }
}

export const Expr = class {
  method() {}
};

[1].map(function callback() {});
[1].map(() => {
  function named() {}
});

function dup() {}
function dup() {}
