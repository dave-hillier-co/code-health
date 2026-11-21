// Order pricing.
export class Pricing {
  private rate = 0.2;

  total(items: Item[], coupon?: string): number {
    let sum = 0;
    for (const item of items) {
      if (item.qty > 0 && item.price > 0) {
        sum += item.qty * item.price;
      }
    }
    /* apply coupon: if (x) { */
    if (coupon) {
      sum -= this.discount(coupon) ?? 0;
    }
    return sum * (1 + this.rate);
  }

  label(n: number): string {
    return `n=${n > 1 ? "many" : "one"} {`;
  }
}

export const double = (x: number) => {
  return x * 2;
};
