/**
 * The page's CSS: one block, inline, with no external request. Colours are variables, redefined for dark
 * through prefers-color-scheme. Text and tile colours meet WCAG AA contrast in both themes: body text is at
 * least 7:1 on its background, and each band pairs its fill with a text colour of at least 4.5:1. Print drops
 * the navigation, uses black on white and keeps charts and tables whole across pages.
 */
export const themeCss = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --text: #16181d; --muted: #4a4f5c; --rule: #c9ced8; --panel: #f4f6fa;
  --link: #0b4fb3; --focus: #0b4fb3;
  --band-1: #eef3fb; --on-band-1: #12233f;
  --band-2: #cfdff5; --on-band-2: #12233f;
  --band-3: #9fbfe8; --on-band-3: #0d1f3a;
  --band-4: #3f78c4; --on-band-4: #ffffff;
  --band-5: #1c4587; --on-band-5: #ffffff;
  --bar: #3f78c4; --bar-above: #1c4587; --marker: #16181d;
  --notice-bg: #fff8e1; --notice-rule: #8a6100;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #12151b; --text: #e8eaf0; --muted: #b4bac8; --rule: #3a4150; --panel: #1b2029;
    --link: #8db8ff; --focus: #8db8ff;
    --band-1: #1b2535; --on-band-1: #dbe6f7;
    --band-2: #25406a; --on-band-2: #e8f0fc;
    --band-3: #3566a8; --on-band-3: #ffffff;
    --band-4: #7ba6e0; --on-band-4: #0b1830;
    --band-5: #b9d3f5; --on-band-5: #0b1830;
    --bar: #7ba6e0; --bar-above: #b9d3f5; --marker: #e8eaf0;
    --notice-bg: #2a2310; --notice-rule: #e0b84a;
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
caption { text-align: left; font-weight: 600; padding: .25rem 0; }
th, td { border: 1px solid var(--rule); padding: .25rem .6rem; text-align: left; vertical-align: top; }
thead th { background: var(--panel); }
th[scope="row"] { font-weight: 600; background: var(--panel); }
.number { text-align: right; font-variant-numeric: tabular-nums; }
.legend, .omitted { color: var(--muted); font-size: .9rem; margin: .25rem 0 1rem; }
.empty { color: var(--muted); font-style: italic; }
.marker { white-space: nowrap; }
figure.chart { margin: 1rem 0; }
figure.chart figcaption { font-weight: 600; margin-bottom: .25rem; }
figure.chart svg { display: block; width: 100%; height: auto; max-width: 60rem; font: 11px system-ui, sans-serif; }
figure.sparkline svg { max-width: 16rem; }
figure.chart svg text { fill: var(--text); }
svg .folder rect { fill: none; stroke: var(--rule); }
svg .folder text { fill: var(--muted); }
svg .tile rect, svg .cell rect { stroke: var(--bg); stroke-width: 1; }
svg .band-1 rect { fill: var(--band-1); } svg .band-1 text { fill: var(--on-band-1); }
svg .band-2 rect { fill: var(--band-2); } svg .band-2 text { fill: var(--on-band-2); }
svg .band-3 rect { fill: var(--band-3); } svg .band-3 text { fill: var(--on-band-3); }
svg .band-4 rect { fill: var(--band-4); } svg .band-4 text { fill: var(--on-band-4); }
svg .band-5 rect { fill: var(--band-5); } svg .band-5 text { fill: var(--on-band-5); }
svg .band-none rect { fill: var(--panel); stroke: var(--muted); stroke-dasharray: 3 2; }
svg .group rect { fill: none; stroke: var(--marker); stroke-width: 2; }
svg .cell[class*="mark-"] text { font-weight: 700; }
svg .bin rect { fill: var(--bar); }
svg .bar rect { fill: var(--bar); } svg .bar.above rect { fill: var(--bar-above); }
svg .bar line { stroke: var(--marker); stroke-width: 2; }
svg .frame { fill: none; stroke: var(--rule); }
svg .guideline line { stroke: var(--muted); stroke-width: 1.5; stroke-dasharray: 6 4; } svg .guideline text, svg .tick { fill: var(--muted); }
svg circle.point { fill: var(--bar); fill-opacity: .4; }
svg rect.point, svg .point.named rect { fill: var(--bar-above); stroke: var(--bg); stroke-width: 1; }
svg .point.named text { paint-order: stroke; stroke: var(--bg); stroke-width: 3px; }
svg polyline { fill: none; stroke: var(--bar-above); stroke-width: 2; } svg circle { fill: var(--bar-above); }
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
