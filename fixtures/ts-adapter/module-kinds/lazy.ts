export async function load(name: string) {
  const fixed = await import("./helper.mjs");
  const computed = await import(name);
  return [fixed, computed];
}
