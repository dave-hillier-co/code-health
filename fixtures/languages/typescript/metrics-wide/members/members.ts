export class Counter {
  static zero = (): Counter => new Counter(0);
  constructor(public value: number) {}
  bump = async (by: number, force = false): Promise<number> => {
    if (by < 0 && !force) {
      throw new RangeError("negative");
    }
    this.value += by;
    return this.value;
  };
}
