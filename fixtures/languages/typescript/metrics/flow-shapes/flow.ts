export async function load(ids: string[]): Promise<number> {
  let total = 0;
  for (const id of ids) {
    try {
      total += await fetchOne(id);
    } catch (error) {
      if (error instanceof RangeError) {
        continue;
      }
      throw error;
    } finally {
      total += 1;
    }
  }
  return total;
}

export function* pairs(rows: number[][]): Generator<number> {
  outer: for (const row of rows) {
    for (const cell of row) {
      if (cell < 0) continue outer;
      yield cell ?? 0;
    }
  }
}

export const depth = (node?: { child?: unknown }): number =>
  node?.child ? 1 + depth(node.child as never) : 0;

export function kind(code: number): string {
  switch (code) {
    case 1:
    case 2:
      return "low";
    case 3:
      return "mid";
    default:
      return "other";
  }
}

export class Box {
  private value = 0;
  get size(): number {
    return this.value > 0 ? this.value : 0;
  }
  set size(next: number) {
    if (next < 0 || next > 100) {
      throw new RangeError("size");
    }
    this.value = next;
  }
}
