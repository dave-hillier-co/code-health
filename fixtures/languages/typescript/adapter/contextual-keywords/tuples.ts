export function pairs(imports: [specifier: string, symbol: string][]): number {
  return imports.length;
}

export type Entry = [number: number, new: boolean, typeof: string];

export function module(name: string, entries: [any: string, void: number][]): string {
  return name + entries.length;
}
