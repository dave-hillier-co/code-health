/**
 * A share printed as a percentage with one decimal. A share above 0 that rounds to 0 prints as "<0.1%" and one
 * below 1 that rounds to 100 prints as ">99.9%", so a non-zero share is never printed as 0% and a partial one
 * never as 100%.
 */
export function percentText(share: number): string {
  if (share > 0 && share < 0.0005) return "<0.1%";
  if (share < 1 && share >= 0.9995) return ">99.9%";
  return `${Math.round(share * 1000) / 10}%`;
}

/** `percentText` of part over whole; 0% when whole is 0. */
export function percentTextOfCounts(part: number, whole: number): string {
  return whole === 0 ? "0%" : percentText(part / whole);
}
