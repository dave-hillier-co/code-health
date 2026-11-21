export function List({ items, empty }: { items: string[]; empty: string }) {
  return items.length > 0 ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <p>{empty}</p>;
}
