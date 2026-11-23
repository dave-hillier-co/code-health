import { escapeHtml, escapeMd, formatNumber } from "../text.ts";
import { htmlTable, mdTable } from "../tables.ts";
import { figureHtml } from "./figure.ts";

export interface SparklinePoint {
  /** The period or revision the value belongs to, such as "2025-03". */
  label: string;
  value: number;
}

export interface SparklineData {
  title: string;
  /** What the values measure, such as "changes per month". */
  unit: string;
  points: SparklinePoint[];
}

const WIDTH = 240;
const HEIGHT = 48;
const MARGIN = 6;

const columns = (data: SparklineData) => [{ label: "Period" }, { label: data.unit, align: "right" as const }];
const rows = (data: SparklineData) => data.points.map((p) => [p.label, formatNumber(p.value)]);

/** The points of the line as svg coordinates, oldest at the left. A flat series sits mid height. */
export function sparklineCoordinates(points: readonly SparklinePoint[]): [number, number][] {
  const values = points.map((p) => p.value);
  const least = Math.min(...values);
  const greatest = Math.max(...values);
  const span = greatest - least;
  return points.map((p, i): [number, number] => [
    points.length === 1 ? WIDTH / 2 : MARGIN + (i * (WIDTH - 2 * MARGIN)) / (points.length - 1),
    span === 0 ? HEIGHT / 2 : HEIGHT - MARGIN - ((p.value - least) * (HEIGHT - 2 * MARGIN)) / span,
  ]);
}

export function sparklineHtml(data: SparklineData): string {
  const coordinates = sparklineCoordinates(data.points);
  const last = coordinates[coordinates.length - 1];
  const line = coordinates.length > 1 ? `<polyline points="${coordinates.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}"/>` : "";
  const end = last === undefined ? "" : `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3"/>`;
  const values = data.points.map((p) => p.value);
  const range = values.length === 0 ? "no points" : `from ${formatNumber(values[0]!)} to ${formatNumber(values[values.length - 1]!)}, least ${formatNumber(Math.min(...values))}, greatest ${formatNumber(Math.max(...values))}`;
  return figureHtml({
    kind: "sparkline",
    title: data.title,
    description: `${data.unit} over ${data.points.length} periods, ${range}. The table below lists every value.`,
    width: WIDTH,
    height: HEIGHT,
    drawing: `${line}${end}`,
    table: htmlTable(`${data.title}: ${data.unit} by period`, columns(data), rows(data).map((r) => r.map(escapeHtml)), { rowHeaders: true }),
  });
}

export function sparklineMd(data: SparklineData): string {
  return [`**${escapeMd(data.title)}** (${escapeMd(data.unit)}, oldest first)`, "", mdTable(columns(data), rows(data))].join("\n");
}
