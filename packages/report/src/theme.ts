import { schemeTableau10, schemeYlOrBr } from "d3-scale-chromatic";

/** The ink of body text and of text on a light fill. */
const INK = "#1c1c1c";
const WHITE = "#ffffff";

/** The five value bands, least to most: d3-scale-chromatic's YlOrBr, five steps of one ramp from yellow to brown. */
const SEQUENTIAL = schemeYlOrBr[5] as readonly string[];
/**
 * The kinds (knowledge patterns, groups of components) in a fixed order: six of d3-scale-chromatic's Tableau10 (blue,
 * teal, green, purple, red, pink). Its orange and yellow are left out, because they read as steps of the value ramp.
 */
const CATEGORICAL = [0, 3, 4, 6, 2, 7].map((i) => schemeTableau10[i] as string);

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** The text colour for a fill: ink or white, whichever contrasts more. */
export const textOn = (fill: string): string => (contrast(fill, INK) >= contrast(fill, WHITE) ? INK : WHITE);

/** Custom properties for a list of fills: `--band-1` and `--on-band-1`, and so on. */
const fills = (name: string, colours: readonly string[], indent = "  ") => colours.map((c, i) => `--${name}-${i + 1}: ${c}; --on-${name}-${i + 1}: ${textOn(c)};`).join(`\n${indent}`);

/**
 * The page's CSS: one block, inline, with no external request. Colours are variables, redefined for dark through
 * prefers-color-scheme. Surfaces and ink are neutral. Every magnitude uses the one value ramp (in dark, the same ramp
 * reversed, so the least value recedes towards the dark surface); kinds use the categorical colours. Each fill has a
 * text colour chosen for the higher contrast of ink and white. Empty cells and tiles are grey. Print drops the
 * navigation, uses black on white and keeps charts and tables whole across pages.
 */
export const themeCss = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --text: ${INK}; --muted: #575757; --rule: #d6d6d3; --panel: #f3f3f1; --empty: #ececea;
  --link: #1a5fb4; --focus: #1a5fb4;
  ${fills("band", SEQUENTIAL)}
  ${fills("cat", CATEGORICAL)}
  --bar: #6b6b68; --bar-above: ${SEQUENTIAL[3]}; --marker: ${INK}; --point: #6b6b68;
  --notice-bg: #f3f3f1; --notice-rule: #b07800;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1e1e1e; --text: #e9e9e6; --muted: #ababa6; --rule: #42423f; --panel: #282826; --empty: #2f2f2d;
    --link: #8cb8f5; --focus: #8cb8f5;
    ${fills("band", [...SEQUENTIAL].reverse(), "    ")}
    --bar: #9a9a96; --bar-above: ${SEQUENTIAL[2]}; --marker: #e9e9e6; --point: #9a9a96;
    --notice-bg: #282826; --notice-rule: #e0b84a;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
body > header, body > nav, body > main, body > footer { max-width: 72rem; margin: 0 auto; padding: 0 1rem; }
body > header { padding-top: 1.5rem; border-bottom: 1px solid var(--rule); }
h1 { margin: 0 0 .75rem; font-size: 1.75rem; line-height: 1.2; }
h2 { margin: 2rem 0 .75rem; font-size: 1.35rem; border-bottom: 1px solid var(--rule); padding-bottom: .25rem; }
h3 { margin: 1.25rem 0 .5rem; font-size: 1.1rem; }
a { color: var(--link); }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.skip { position: absolute; left: -999px; }
.skip:focus { left: 1rem; top: 1rem; background: var(--bg); padding: .5rem; z-index: 1; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
dl.header { display: grid; grid-template-columns: max-content 1fr; gap: .15rem 1rem; margin: 0 0 1rem; }
dl.header dt { color: var(--muted); }
dl.header dd { margin: 0; overflow-wrap: anywhere; }
dl.header ul { margin: 0; padding-left: 1.1rem; }
nav { padding-top: .75rem; padding-bottom: .75rem; }
nav ul { display: flex; flex-wrap: wrap; gap: .25rem 1rem; list-style: none; margin: 0; padding: 0; }
main { overflow-wrap: anywhere; padding-bottom: 2rem; }
table { border-collapse: collapse; margin: .5rem 0; max-width: 100%; }
caption { text-align: left; font-weight: 600; padding: .25rem 0 .4rem; }
th, td { border-bottom: 1px solid var(--rule); padding: .3rem .75rem .3rem 0; text-align: left; vertical-align: top; }
th:last-child, td:last-child { padding-right: 0; }
thead th { border-bottom: 2px solid var(--text); font-weight: 600; vertical-align: bottom; }
th[scope="row"] { font-weight: 600; }
.number { text-align: right; font-variant-numeric: tabular-nums; }
.legend, .omitted { color: var(--muted); font-size: .9rem; margin: .25rem 0 1rem; }
.empty { color: var(--muted); font-style: italic; }
.marker { white-space: nowrap; }
figure.chart { margin: 1rem 0; }
figure.chart figcaption { font-weight: 600; margin-bottom: .25rem; }
figure.chart svg { display: block; max-width: 100%; height: auto; font: 11px system-ui, sans-serif; }
figure.sparkline svg { max-width: 16rem; }
svg text { fill: var(--text); }
svg .folder rect { fill: none; stroke: var(--muted); stroke-width: .75; }
svg .folder text { fill: var(--muted); }
svg .tile rect, svg .cell rect { stroke: var(--bg); stroke-width: 1; }
svg .tile.marked rect { stroke: var(--text); stroke-width: 2; }
svg .band-1 rect { fill: var(--band-1); } svg .band-1 text { fill: var(--on-band-1); }
svg .band-2 rect { fill: var(--band-2); } svg .band-2 text { fill: var(--on-band-2); }
svg .band-3 rect { fill: var(--band-3); } svg .band-3 text { fill: var(--on-band-3); }
svg .band-4 rect { fill: var(--band-4); } svg .band-4 text { fill: var(--on-band-4); }
svg .band-5 rect { fill: var(--band-5); } svg .band-5 text { fill: var(--on-band-5); }
svg .band-none rect { fill: var(--empty); stroke: var(--bg); } svg .band-none text { fill: var(--muted); }
svg .span-1 rect, svg .cat-1 rect { fill: var(--cat-1); } svg .span-1 text, svg .cat-1 text { fill: var(--on-cat-1); }
svg .span-2 rect, svg .cat-2 rect { fill: var(--cat-2); } svg .span-2 text, svg .cat-2 text { fill: var(--on-cat-2); }
svg .span-3 rect, svg .cat-3 rect { fill: var(--cat-3); } svg .span-3 text, svg .cat-3 text { fill: var(--on-cat-3); }
svg .span-4 rect, svg .cat-4 rect { fill: var(--cat-4); } svg .span-4 text, svg .cat-4 text { fill: var(--on-cat-4); }
svg .span-5 rect, svg .cat-5 rect { fill: var(--cat-5); } svg .span-5 text, svg .cat-5 text { fill: var(--on-cat-5); }
svg .span-6 rect, svg .cat-6 rect { fill: var(--cat-6); } svg .span-6 text, svg .cat-6 text { fill: var(--on-cat-6); }
svg .span text { font-weight: 600; }
svg .span-boundary { stroke: var(--marker); stroke-width: 1; }
svg .group rect { fill: none; stroke: var(--marker); stroke-width: 2; }
svg .cell[class*="mark-"] text { font-weight: 700; }
svg .folder-row .folder-name { font-weight: 600; } svg .folder-row .row-note { fill: var(--muted); }
svg .folder-row .guide { stroke: var(--rule); stroke-dasharray: 1 3; }
svg .edge path { fill: none; stroke: var(--bar-above); } svg .edge polygon { fill: var(--bar-above); }
svg .edge.dashed path { stroke-dasharray: 6 4; }
svg .bin rect { fill: var(--bar); }
svg .bar rect { fill: var(--bar); } svg .bar.above rect { fill: var(--bar-above); }
svg .bar line { stroke: var(--marker); stroke-width: 2; }
svg .frame { fill: none; stroke: var(--rule); }
svg .guideline line { stroke: var(--muted); stroke-width: 1.5; stroke-dasharray: 6 4; } svg .guideline text, svg .tick { fill: var(--muted); }
svg circle.point { fill: var(--point); fill-opacity: .45; }
svg rect.point, svg .point.named rect { fill: var(--bar-above); stroke: var(--bg); stroke-width: 1; }
svg .point.named text { paint-order: stroke; stroke: var(--bg); stroke-width: 3px; }
svg a:hover text { text-decoration: underline; }
svg a > text, svg a > tspan { fill: var(--link); text-decoration: underline; }
svg a:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
svg a .tile rect, svg a .tile.marked rect { stroke: var(--link); stroke-width: 2; }
svg polyline { fill: none; stroke: var(--bar-above); stroke-width: 2; } svg circle { fill: var(--bar-above); }
svg .grid { stroke: var(--rule); stroke-width: 1; } svg .zero { stroke: var(--marker); stroke-width: 1.5; }
svg .series.cat-1 polyline { stroke: var(--cat-1); } svg .series.cat-1 circle { fill: var(--cat-1); }
svg .series.cat-2 polyline { stroke: var(--cat-2); } svg .series.cat-2 circle { fill: var(--cat-2); }
svg .series.cat-3 polyline { stroke: var(--cat-3); } svg .series.cat-3 circle { fill: var(--cat-3); }
svg .series.cat-4 polyline { stroke: var(--cat-4); } svg .series.cat-4 circle { fill: var(--cat-4); }
svg .series.cat-5 polyline { stroke: var(--cat-5); } svg .series.cat-5 circle { fill: var(--cat-5); }
svg .series.cat-6 polyline { stroke: var(--cat-6); } svg .series.cat-6 circle { fill: var(--cat-6); }
svg .series text { fill: var(--text); }
svg .series .name, svg .panel .name, svg .change .name { font-weight: 600; }
figure.chart details { margin: .25rem 0 .5rem; } figure.chart summary { cursor: pointer; color: var(--muted); font-size: .9rem; }
svg .panel polyline { stroke: var(--bar); } svg .panel circle { fill: var(--bar); }
svg .panel.stronger polyline { stroke: var(--bar-above); } svg .panel.stronger circle { fill: var(--bar-above); }
svg .panel .reading, svg .panel .word { fill: var(--muted); } svg .panel.stronger .word { fill: var(--text); font-weight: 600; }
svg .change rect { fill: var(--bar); } svg .change.rise rect { fill: var(--bar-above); }
.notice { border-left: 4px solid var(--notice-rule); background: var(--notice-bg); padding: .5rem .75rem; margin: .75rem 0; }
.judgement { border: 1px solid var(--rule); border-left: 4px solid var(--link); background: var(--panel); padding: .25rem 1rem .5rem; margin: 1rem 0; }
.judgement ol { margin: 0; padding-left: 1.25rem; }
.judgement li { margin: .4rem 0; }
.evidence ul { margin: 0; padding-left: 1.25rem; }
.trend .trend-detail, .evidence .detail { color: var(--muted); }
body > footer { border-top: 1px solid var(--rule); color: var(--muted); font-size: .9rem; padding-top: .75rem; padding-bottom: 1.5rem; }
@media (max-width: 40rem) { dl.header { grid-template-columns: 1fr; } table { font-size: .9rem; } }
@media print {
  :root { --bg: #ffffff; --text: #000000; --muted: #333333; --rule: #888888; --panel: #f0f0f0; --link: #000000; }
  nav, .skip { display: none; }
  body { font-size: 11pt; }
  figure.chart, table, .judgement, .notice { break-inside: avoid; }
  h2 { break-after: avoid; }
  a { text-decoration: none; }
}
`;
