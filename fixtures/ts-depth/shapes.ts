export function add(a: number, b: number): number {
  return a + b;
}

export function save(record: Row, options: Options): Promise<void> {
  return store.save(record, options);
}

export const load = async (id: string) => await store.load(id);

export function audit(id: string): void {
  store.audit(id);
  log(id);
}

export function tagged(id: string) {
  return store.find(id.trim());
}

function hidden(id: string) {
  return other(id);
}

export class Repo {
  constructor(private readonly store: Store, name: string) {}
  find(id: string) {
    return this.store.find(id);
  }
  get size(): number {
    return this.items.length;
  }
  private secret() {
    return 1;
  }
  #hash = 0;
  count = 0;
}

export default function () {
  return 1;
}
