import { expect, test } from "vitest";
import { themeCss } from "../src/theme.ts";

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

test("every fill's text colour meets WCAG AA (4.5:1) on it, in light and dark", () => {
  const pairs = [...themeCss.matchAll(/--((?:band|cat)-\d): (#[0-9a-f]{6}); --on-\1: (#[0-9a-f]{6});/g)];
  expect(pairs.length).toBe(16);
  for (const [, name, fill, text] of pairs) expect(ratio(fill!, text!), `${name} ${fill} on ${text}`).toBeGreaterThanOrEqual(4.5);
});

test("the value bands run from light to dark in light mode and the reverse in dark mode", () => {
  const [light, dark] = themeCss.split("@media (prefers-color-scheme: dark)") as [string, string];
  const bands = (css: string) => [...css.matchAll(/--band-\d: (#[0-9a-f]{6});/g)].map((m) => luminance(m[1]!));
  const l = bands(light);
  const d = bands(dark);
  expect(l.length).toBe(5);
  expect(d.length).toBe(5);
  for (let i = 1; i < 5; i++) {
    expect(l[i]!).toBeLessThan(l[i - 1]!);
    expect(d[i]!).toBeGreaterThan(d[i - 1]!);
  }
});
