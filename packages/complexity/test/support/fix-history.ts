import { GitFixture, type Change, type Step } from "@code-health/fixtures/git-fixture";
import { priceFunction } from "./ratchet.ts";

const describeFunction = (separator = ", ") => `export function describe(order: { items: number[] }): string {
  const lines: string[] = [];
  for (const item of order.items) {
    lines.push(\`item \${item}\`);
  }
  return lines.join("${separator}");
}
`;

const legacyFunction = (rate = 5) => `export function legacy(weight: number): number {
  if (weight > 10) {
    return weight * ${rate};
  }
  return ${rate};
}
`;

/** The file as a sequence of parts: a comment and a constant outside any function, then three functions. */
function orders(options: { header?: string; tax?: number; price?: string; separator?: string; legacy?: number | null } = {}): string {
  const { header = "// Order totals.", tax = 0.2, price = priceFunction(), separator = ", ", legacy = null } = options;
  return `${header}\nexport const TAX = ${tax};\n\n${price}\n${describeFunction(separator)}${legacy === null ? "" : `\n${legacyFunction(legacy)}`}`;
}

const at = (day: number) => `2024-02-${String(day).padStart(2, "0")}T12:00:00+00:00`;

const commit = (day: number, message: string, changes: Change[]): Step => ({ type: "commit", message, date: at(day), changes });

const modify = (path: string, content: string): Change => ({ op: "modify", path, content });

/** `price` with the vip rate changed, which is not a fix. */
const vipPrice = priceFunction().replace("item * 0.8", "item * 0.75");
/** `price` after the coupon fix. */
const couponPrice = vipPrice.replace("item * 0.9", "item * 0.85");
/** The same function renamed. */
const renamed = (body: string) => body.replace("function price(", "function priceOrder(");
/** The renamed function after a second fix. */
const secondFix = renamed(couponPrice).replace("item * 0.75", "item * 0.7");

/**
 * Eleven commits to `src/orders.ts`, in February 2024, with fix commits chosen so that the counts are known by hand:
 *
 *   price (later priceOrder, in src/billing.ts): 5 revisions (created, vip change, two fixes, rename), 2 fixes
 *   describe: 2 revisions (created, one fix), 1 fix
 *   legacy, deleted at the end: 2 revisions (created, one fix), 1 fix
 *   two fixes that changed only the header comment and the TAX constant, outside every function
 */
export const fixHistory: Step[] = [
  commit(1, "Add order totals", [{ op: "add", path: "src/orders.ts", content: orders() }, { op: "add", path: "README.md", content: "# Shop\n" }]),
  commit(2, "Add the vip discount", [modify("src/orders.ts", orders({ price: vipPrice }))]),
  commit(3, "Fix coupon rounding bug", [modify("src/orders.ts", orders({ price: couponPrice }))]),
  commit(4, "Fix the header comment wording", [modify("src/orders.ts", orders({ header: "// Order totals, in euros.", price: couponPrice }))]),
  commit(5, "Fix the separator in describe", [modify("src/orders.ts", orders({ header: "// Order totals, in euros.", price: couponPrice, separator: "; " }))]),
  commit(6, "Fix tax rate", [modify("src/orders.ts", orders({ header: "// Order totals, in euros.", tax: 0.21, price: couponPrice, separator: "; " }))]),
  commit(7, "Add legacy shipping", [modify("src/orders.ts", orders({ header: "// Order totals, in euros.", tax: 0.21, price: couponPrice, separator: "; ", legacy: 5 }))]),
  commit(8, "Fix legacy shipping rate", [modify("src/orders.ts", orders({ header: "// Order totals, in euros.", tax: 0.21, price: couponPrice, separator: "; ", legacy: 6 }))]),
  commit(9, "Rename price to priceOrder and move the file to billing", [
    { op: "rename", from: "src/orders.ts", path: "src/billing.ts", content: orders({ header: "// Order totals, in euros.", tax: 0.21, price: renamed(couponPrice), separator: "; ", legacy: 6 }) },
  ]),
  commit(10, "Fix vip rate in priceOrder", [modify("src/billing.ts", orders({ header: "// Order totals, in euros.", tax: 0.21, price: secondFix, separator: "; ", legacy: 6 }))]),
  commit(11, "Remove legacy shipping", [modify("src/billing.ts", orders({ header: "// Order totals, in euros.", tax: 0.21, price: secondFix, separator: "; " }))]),
];

/** The file at the end of `fixHistory`, with another header comment. */
export const finalBilling = (header: string): string => orders({ header, tax: 0.21, price: secondFix, separator: "; " });

/** A fresh copy of the repository above, with its commits dated in February 2024 so the default window holds all of them. */
export function buildFixRepo(extra: Step[] = []): GitFixture {
  return GitFixture.build([...fixHistory, ...extra]);
}

const small = (name: string, revision: number) => `export function ${name}(x: number): number {\n  if (x > ${revision}) {\n    return x;\n  }\n  return ${revision};\n}\n`;
const later = (day: number) => `2024-02-${String(day)}T12:00:00+00:00`;

/**
 * Two functions with one fix each and different evidence: `steady` has four revisions (created, two changes, one fix) and so a
 * share of 0.25, `tiny` has two (created, one fix) and a share of 0.5.
 */
export const evidenceHistory: Step[] = [
  { type: "commit", message: "Add steady", date: later(12), changes: [{ op: "add", path: "src/steady.ts", content: small("steady", 0) }, { op: "add", path: "src/tiny.ts", content: small("tiny", 0) }] },
  { type: "commit", message: "Change steady once", date: later(13), changes: [{ op: "modify", path: "src/steady.ts", content: small("steady", 1) }] },
  { type: "commit", message: "Change steady twice", date: later(14), changes: [{ op: "modify", path: "src/steady.ts", content: small("steady", 2) }] },
  { type: "commit", message: "Fix steady", date: later(15), changes: [{ op: "modify", path: "src/steady.ts", content: small("steady", 3) }] },
  { type: "commit", message: "Fix tiny", date: later(16), changes: [{ op: "modify", path: "src/tiny.ts", content: small("tiny", 1) }] },
];

/** A constant outside every function in each of two files, changed together by one fix. */
export const outsideHistory: Step[] = [
  {
    type: "commit",
    message: "Add rates and limits",
    date: later(12),
    changes: [
      { op: "add", path: "src/rates.ts", content: "export const RATE = 1;\n\n" + small("rate", 0) },
      { op: "add", path: "src/limits.ts", content: "export const LIMIT = 1;\n\n" + small("limit", 0) },
    ],
  },
  {
    type: "commit",
    message: "Fix the rate and the limit together",
    date: later(13),
    changes: [
      { op: "modify", path: "src/rates.ts", content: "export const RATE = 2;\n\n" + small("rate", 0) },
      { op: "modify", path: "src/limits.ts", content: "export const LIMIT = 2;\n\n" + small("limit", 0) },
    ],
  },
];
