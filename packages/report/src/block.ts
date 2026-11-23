import { categoryTreemapHtml, categoryTreemapMd, type CategoryTreemapData } from "./components/category-treemap.ts";
import { evidenceListHtml, evidenceListMd, type EvidenceListData } from "./components/evidence-list.ts";
import { factsHtml, factsMd, type FactsData } from "./components/facts.ts";
import { guidelineBarsHtml, guidelineBarsMd, type GuidelineBarsData } from "./components/guideline-bar.ts";
import { histogramHtml, histogramMd, type HistogramData } from "./components/histogram.ts";
import { judgementHtml, judgementMd } from "./components/judgement.ts";
import { matrixHtml, matrixMd, type MatrixData } from "./components/matrix.ts";
import { noticeHtml, noticeMd, type NoticeData } from "./components/notice.ts";
import { paragraphHtml, paragraphMd, type ParagraphData } from "./components/paragraph.ts";
import { rankedTableHtml, rankedTableMd, type RankedTableData } from "./components/ranked-table.ts";
import { stabilityChartHtml, stabilityChartMd, type StabilityChartData } from "./components/stability-chart.ts";
import { sparklineHtml, sparklineMd, type SparklineData } from "./components/sparkline.ts";
import { trendMarkerHtml, trendMarkerMd, type TrendMarkerData } from "./components/trend-marker.ts";
import { treemapHtml, treemapMd, type TreemapData } from "./components/treemap.ts";
import { ReportError, type Format, type Notes, type Slot } from "./protocol.ts";

/** One piece of a section: a component's data, tagged with the component. Plain JSON, so `--slots` prints it. */
export type Block =
  | ({ type: "paragraph" } & ParagraphData)
  | ({ type: "facts" } & FactsData)
  | ({ type: "ranked-table" } & RankedTableData)
  | ({ type: "treemap" } & TreemapData)
  | ({ type: "category-treemap" } & CategoryTreemapData)
  | ({ type: "sparkline" } & SparklineData)
  | ({ type: "histogram" } & HistogramData)
  | ({ type: "matrix" } & MatrixData)
  | ({ type: "guideline-bars" } & GuidelineBarsData)
  | ({ type: "stability-chart" } & StabilityChartData)
  | ({ type: "trend-marker" } & TrendMarkerData)
  | ({ type: "evidence-list" } & EvidenceListData)
  | ({ type: "notice" } & NoticeData)
  /** The place a slot's entry appears. */
  | { type: "judgement"; slot: string };

export interface BlockContext {
  slots: readonly Slot[];
  /** The validated entries. Undefined in a data-only markdown draft. */
  notes: Notes | undefined;
}

function slotOf(id: string, context: BlockContext): Slot {
  const slot = context.slots.find((s) => s.id === id);
  if (slot === undefined) throw new ReportError(`a judgement block names slot "${id}", which the report does not define`);
  return slot;
}

/** Renders one block as html or markdown. */
export function renderBlock(block: Block, format: Format, context: BlockContext): string {
  switch (block.type) {
    case "paragraph": return format === "html" ? paragraphHtml(block) : paragraphMd(block);
    case "facts": return format === "html" ? factsHtml(block) : factsMd(block);
    case "ranked-table": return format === "html" ? rankedTableHtml(block) : rankedTableMd(block);
    case "treemap": return format === "html" ? treemapHtml(block) : treemapMd(block);
    case "category-treemap": return format === "html" ? categoryTreemapHtml(block) : categoryTreemapMd(block);
    case "sparkline": return format === "html" ? sparklineHtml(block) : sparklineMd(block);
    case "histogram": return format === "html" ? histogramHtml(block) : histogramMd(block);
    case "matrix": return format === "html" ? matrixHtml(block) : matrixMd(block);
    case "guideline-bars": return format === "html" ? guidelineBarsHtml(block) : guidelineBarsMd(block);
    case "stability-chart": return format === "html" ? stabilityChartHtml(block) : stabilityChartMd(block);
    case "trend-marker": return format === "html" ? `<p>${trendMarkerHtml(block)}</p>` : trendMarkerMd(block);
    case "evidence-list": return format === "html" ? evidenceListHtml(block) : evidenceListMd(block);
    case "notice": return format === "html" ? noticeHtml(block) : noticeMd(block);
    case "judgement": {
      const slot = slotOf(block.slot, context);
      const data = { slot, entry: context.notes?.[slot.id] };
      return format === "html" ? judgementHtml(data) : judgementMd(data);
    }
  }
}
