import { area, type Shape } from "./types";
import { helper } from "./helper.mjs";

export function View(props: { shape: Shape }) {
  return <div>{area(props.shape) + helper()}</div>;
}
