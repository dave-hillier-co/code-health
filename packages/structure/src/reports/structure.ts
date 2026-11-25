import { builtinOmissions } from "@code-health/cli-kit/builtin-excludes";
import { droppedCounts } from "@code-health/cli-kit/dropped-files";
import type { ReportKind } from "@code-health/cli-kit/report-command";
import type { CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { runNotes } from "@code-health/cli-kit/run-notes";
import { windowOptions } from "@code-health/cochange/window-options";
import type { Evidence } from "@code-health/history/evidence";
import type { FiltersApplied } from "@code-health/history/noise";
import type { IncludeResolution } from "@code-health/parse/resolved-dependencies";
import type { Block } from "@code-health/report/block";
import type { Cell } from "@code-health/report/components/ranked-table";
import type { StabilityPoint } from "@code-health/report/components/stability-chart";
import { dropEmptySlots } from "@code-health/report/empty-block";
import { judgementId } from "@code-health/report/components/judgement";
import { pageHref, reportHref } from "@code-health/report/links";
import { targetId } from "@code-health/report/text";
import type { Slot } from "@code-health/report/protocol";
import type { ReportBuild, Section } from "@code-health/report/report-model";
import { command as census } from "../commands/census.ts";
import { command as cycles } from "../commands/cycles.ts";
import { command as hubs } from "../commands/hubs.ts";
import { command as layers } from "../commands/layers.ts";
import { command as packages } from "../commands/packages.ts";
import { command as stability } from "../commands/stability.ts";
import { readSettings, type StructureSettings } from "../config.ts";
import type { CycleRow, ProjectFolderCycles } from "../cycles.ts";
import { DSM_MODULES, type Dsm } from "../dsm.ts";
import type { Hub } from "../hubs.ts";
import type { LayerViolation } from "../layers.ts";
import type { PackageRow } from "../packaging/list.ts";
import type { CensusRow } from "../census/rows.ts";
import { splitAtTargetFloor, type UnstableDependency } from "../unstable.ts";
import { excludedCounts, historyWindowText, isoDate } from "@code-health/history/report-header";

/** How many rows each list shows. The rest are counted on the page, and the command prints them. */
const TOP_CYCLES = 5;
const TOP_AGAINST = 8;
const TOP_LAYER_VIOLATIONS = 15;
const TOP_HUBS = 10;
const SYMBOLS_PER_EDGE = 3;
const NODES_PER_CYCLE = 4;
const TOP_PACKAGES = 15;

const yesNo = (value: boolean) => (value ? "yes" : "no");
const plural = (n: number, noun: string, many = `${noun}s`) => `${n} ${n === 1 ? noun : many}`;

/** Names with the rest counted: `a, b, c and 4 more`. */
function nameList(names: readonly string[], shown: number): string {
  if (names.length <= shown) return names.join(", ");
  return `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
}

interface Extra {
  evidence: Evidence;
  filtersApplied: FiltersApplied;
  window: { since: string; until: string };
  /** Present only when the structure.csharpFolderCycles setting is true. */
  projectFolderCycles?: ProjectFolderCycles;
  /** The module matrix the cycles command computes at the default level, or null when no module of the largest language depends on another. */
  dsm?: Dsm | null;
}

type IncludeSection = IncludeResolution & { guideline: number; aboveGuideline: boolean };

/** Everything the report reads, each from the command that computes it. */
interface Results {
  cycles: CycleRow[];
  against: UnstableDependency[];
  layerViolations: LayerViolation[] | null;
  hubs: Hub[];
  hubNotices: string[];
  census: CensusRow[];
  packages: PackageRow[];
  extra: Extra;
  inputs: Record<string, unknown>;
  include: { section: IncludeSection; notice: string | undefined } | null;
}

async function gather(context: CommandContext, settings: StructureSettings): Promise<Results> {
  // The first command brings the history cache up to date and the others read it as it is.
  const first = { ...context, positionals: [], values: { ...context.values } };
  const rest = { ...context, positionals: [], values: { ...context.values, "no-refresh": true } };
  const cyclesOutput = await cycles.run(first);
  const run = (command: { run(context: CommandContext): CommandOutput | Promise<CommandOutput> }, values: Record<string, unknown> = {}, positionals: string[] = []) =>
    command.run({ ...rest, positionals, values: { ...rest.values, ...values } });
  const stabilityOutput = await run(stability);
  const layersOutput = settings.layers.length === 0 ? undefined : await layers.run({ ...rest, positionals: [] });
  const hubsOutput = await run(hubs);
  const censusOutput = await census.run({ ...rest, positionals: [] });
  const packagesOutput = await run(packages, {}, ["list"]);
  const note = runNotes().find((n) => n.key === "includeResolution");
  return {
    cycles: cyclesOutput.results as CycleRow[],
    against: stabilityOutput.results as UnstableDependency[],
    layerViolations: layersOutput === undefined ? null : (layersOutput.results as LayerViolation[]),
    hubs: hubsOutput.results as Hub[],
    hubNotices: hubsOutput.notices ?? [],
    census: censusOutput.results as CensusRow[],
    packages: packagesOutput.results as PackageRow[],
    extra: cyclesOutput.extra as unknown as Extra,
    inputs: {
      cycles: cyclesOutput.inputs ?? null,
      stability: stabilityOutput.inputs ?? null,
      layers: layersOutput?.inputs ?? null,
      hubs: hubsOutput.inputs ?? null,
      census: censusOutput.inputs ?? null,
    },
    include: note === undefined ? null : { section: note.value as IncludeSection, notice: note.notice },
  };
}

const LABEL_CHARS = 20;

/** A module's name cut from the left to fit a matrix label; names that cut to the same text get a number. */
function matrixLabels(modules: readonly string[]): string[] {
  const cut = modules.map((m) => (m.length <= LABEL_CHARS ? m : `…${m.slice(m.length - LABEL_CHARS + 1)}`));
  const seen = new Map<string, number>();
  return cut.map((label) => {
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return cut.indexOf(label) === cut.lastIndexOf(label) ? label : `${label} #${n}`;
  });
}

/** The id of a cycle's row in the cycles table, which a cycle box of the matrix links to. */
const cycleId = (n: number) => `cycle-${n}`;
/** The id of a registration hub's row in the hubs table. */
const hubId = (file: string) => targetId("hub", file);

/** The link of a matrix box labelled `cycle N`, when the cycles table lists cycle N. */
function cycleLink(label: string, listed: number): { href?: string } {
  const n = /^cycle (\d+)$/.exec(label)?.[1];
  return n !== undefined && Number(n) <= listed ? { href: pageHref(cycleId(Number(n))) } : {};
}

/** The dependency structure matrix of the modules at the default level, and the lines that say what it draws and leaves out. */
export function dsmBlocks(dsm: Dsm | null | undefined, layered: boolean, hubs: ReadonlySet<string> = new Set(), cyclesShown = 0): Block[] {
  if (dsm === null || dsm === undefined) return [{ type: "notice", level: "notice", text: "No module depends on another at the default level, so there is no dependency structure matrix." }];
  const drawn = dsm.modules.length;
  const labels = matrixLabels(dsm.modules);
  const against = new Set(dsm.againstOrder.map(([i, j]) => `${i},${j}`));
  const layer = new Set(dsm.layerViolations.map(([i, j]) => `${i},${j}`));
  const cellMarks = dsm.cells.map((row, i) =>
    row.map((value, j) => {
      if (value === null) return null;
      const a = against.has(`${i},${j}`);
      const l = layer.has(`${i},${j}`);
      return a && l ? "both" : a ? "against" : l ? "layer" : null;
    }),
  );
  const omitted = dsm.connectedModules - drawn;
  const isolated = dsm.totalModules - dsm.connectedModules;
  const others = dsm.languages.filter((l) => l.language !== dsm.language);
  const isAre = (n: number) => (n === 1 ? "is" : "are");
  return [
    {
      type: "matrix",
      title: "Module dependency matrix",
      valueLabel: "file imports from the row module into the column module",
      rows: labels,
      columns: labels,
      cells: dsm.cells,
      // A module that is a registration hub in the hubs table links to its row there.
      rowHrefs: dsm.modules.map((m) => (hubs.has(m) ? pageHref(hubId(m)) : null)),
      columnHrefs: dsm.modules.map((m) => (hubs.has(m) ? pageHref(hubId(m)) : null)),
      marks: {
        against: { symbol: "!", text: "a dependency against the order: below the diagonal, inside an import cycle" },
        ...(layered ? { layer: { symbol: "L", text: "an import the configured layer rules forbid" }, both: { symbol: "!L", text: "against the order and forbidden by the layer rules" } } : {}),
      },
      cellMarks,
      groups: dsm.groups.map((g) => ({ label: g.size > g.end - g.start + 1 ? `${g.label}, ${g.end - g.start + 1} of ${g.size} modules drawn` : g.label, start: g.start, end: g.end, ...cycleLink(g.label, cyclesShown) })),
      orderText: `A row is a module and the cells in it are the modules it depends on. Rows are ordered by layer, top first: a module comes after every module that depends on it, so in a layered design every cell is above the diagonal. The members of one cycle stay together in a box labelled as in the cycles table, ordered so that only the edges of its breaking set lie below the diagonal. Names are cut from the left to ${LABEL_CHARS} characters; the cycles table gives them whole.${layered && dsm.layerViolations.length === 0 ? " No drawn import breaks a layer rule." : ""}`,
    },
    {
      type: "paragraph",
      text: `The matrix draws ${drawn === dsm.totalModules ? `all ${plural(drawn, "module")}` : `${drawn} of the ${plural(dsm.totalModules, "module")}`} of ${dsm.language}, the language with the most modules at the default level${others.length === 0 ? "" : `; the ${others.map((l) => `${l.modules} of ${l.language}`).join(" and ")} ${others.length === 1 && others[0]!.modules === 1 ? "is" : "are"} not drawn`}.${omitted > 0 ? ` It leaves out ${plural(omitted, "module")} that ${omitted === 1 ? "has" : "have"} a dependency, to stay readable: the members of cycles come first, in the order of the cycles table, then the modules with the most neighbours, up to ${DSM_MODULES}.` : ""}${isolated > 0 ? ` ${plural(isolated, "module")} with no dependency on another ${isAre(isolated)} not drawn.` : ""}`,
    },
  ];
}

/** One line about the folder cycles inside one C# project, which the table of cycles does not list. */
function projectFolderCyclesText(cycles: ProjectFolderCycles): string {
  if (cycles.count === 0) return "No folder cycle lies inside one C# project (structure.csharpFolderCycles is true).";
  const largest = cycles.largest.map((c) => `${nameList(c.nodes, NODES_PER_CYCLE)} in ${c.project}`).join("; ");
  return `${plural(cycles.count, "folder cycle")} lie${cycles.count === 1 ? "s" : ""} inside one C# project and ${cycles.count === 1 ? "is" : "are"} not in the table (structure.csharpFolderCycles is true). Largest: ${largest}.`;
}

function cycleBlocks(rows: readonly CycleRow[], projectFolderCycles: ProjectFolderCycles | undefined): { blocks: Block[]; slots: Slot[] } {
  const shown = rows.slice(0, TOP_CYCLES);
  const slots: Slot[] = [];
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: "Cycles are found at the default level: a Go package for Go, a project for C# and a file for every other language. The breaking set is the smallest set of edges whose removal makes the cycle acyclic, and between equally small sets the one whose sides co-change least. Nested folder cycles, a folder and its own sub-folder, sort last.",
    },
    {
      type: "ranked-table",
      caption: "Import cycles, largest first",
      noun: "cycles",
      total: rows.length,
      emptyText: "No import cycle at the default level.",
      rowIds: shown.map((_, i) => cycleId(i + 1)),
      // The cycle's breaking set and judgement follow the table.
      cellHrefs: shown.map((_, i): Record<string, string> => ({ modules: pageHref(judgementId(`cycle-${i + 1}`)) })),
      seeAlso: [
        { href: reportHref("coupling"), text: "The coupling report lists the files that change together, which the changes touching two members of a cycle count." },
        ...(shown.some((row) => row.unblockedGain !== null) ? [{ href: reportHref("locality"), text: "The locality report lists the moves that resolving a cycle unblocks." }] : []),
      ],
      columns: [
        { key: "modules", label: "Modules in the cycle" },
        { key: "size", label: "Size", align: "right" },
        { key: "method", label: "Breaking set found by" },
        { key: "edges", label: "Edges to break", align: "right" },
        { key: "coChange", label: "Changes touching two members", align: "right" },
        { key: "nested", label: "Nested folders" },
        ...(shown.some((row) => row.unblockedGain !== null) ? [{ key: "gain", label: "Locality gain unblocked", align: "right" as const }] : []),
      ],
      rows: shown.map((row): Record<string, Cell> => ({
        modules: nameList(row.nodes, NODES_PER_CYCLE),
        size: row.size,
        method: row.method,
        edges: row.breakingSet.length,
        coChange: row.coChangeAcross,
        nested: yesNo(row.nested),
        gain: row.unblockedGain,
      })),
    },
  ];
  shown.forEach((row, i) => {
    const id = `cycle-${i + 1}`;
    const label = `cycle ${i + 1} (${nameList(row.nodes, 2)})`;
    blocks.push({
      type: "ranked-table",
      caption: `Cycle ${i + 1}: the breaking set of ${plural(row.breakingSet.length, "edge")} (${row.method})`,
      numbered: false,
      columns: [
        { key: "edge", label: "Edge to break" },
        { key: "coChange", label: "Changes touching both sides", align: "right" },
        { key: "fileEdges", label: "File imports", align: "right" },
        { key: "typeOnly", label: "Type only" },
        { key: "symbols", label: "Symbols used across it" },
      ],
      rows: row.breakingSet.map((edge): Record<string, Cell> => ({
        edge: `${edge.from} → ${edge.to}`,
        coChange: edge.coChange,
        fileEdges: edge.fileEdges,
        typeOnly: yesNo(edge.typeOnly),
        symbols: edge.symbols.length === 0 ? null : nameList(edge.symbols.map((s) => `${s.symbol} (${plural(s.sites, "site")})`), SYMBOLS_PER_EDGE) + (edge.symbolsTotal > edge.symbols.length ? ` of ${edge.symbolsTotal}` : ""),
      })),
    });
    blocks.push({ type: "judgement", slot: id });
    slots.push({
      id,
      title: `Judgement: ${label}`,
      about: { kind: "finding", ref: row.id, label },
      task: "Say which edge of this cycle's breaking set to break and how (move the symbol the edge uses, invert the dependency, pass a value or a callback), or say to leave the cycle and why. You may name an edge outside the breaking set when you give the reason. Prefer a mechanism the census section shows in use. Cite only values shown in this report.",
      verdicts: ["break-the-listed-edge", "break-another-edge", "leave"],
      maxChars: 400,
    });
  });
  if (projectFolderCycles !== undefined) blocks.push({ type: "notice", level: "notice", text: projectFolderCyclesText(projectFolderCycles) });
  return { blocks, slots };
}

function layerBlocks(rows: readonly LayerViolation[], settings: StructureSettings): Block[] {
  const shown = rows.slice(0, TOP_LAYER_VIOLATIONS);
  return [
    { type: "paragraph", text: `Layers are declared in order, top first, in structure.layers: ${settings.layers.map((l) => l.name).join(", ")}. Each row is one file import that crosses to a layer its rule does not allow. Value imports come first, then type-only imports.` },
    {
      type: "ranked-table",
      caption: "Imports that break the layer rules",
      noun: "violations",
      total: rows.length,
      columns: [
        { key: "from", label: "Importing file" },
        { key: "to", label: "Imported file" },
        { key: "layers", label: "Layers" },
        { key: "typeOnly", label: "Type only" },
        { key: "symbols", label: "Symbols used" },
      ],
      rows: shown.map((row): Record<string, Cell> => ({
        from: row.from,
        to: row.to,
        layers: `${row.fromLayer} → ${row.toLayer}`,
        typeOnly: yesNo(row.typeOnly),
        symbols: row.symbols.length === 0 ? null : nameList(row.symbols.map((s) => s.symbol), SYMBOLS_PER_EDGE),
      })),
    },
    ...(rows.length === 0 ? [{ type: "notice" as const, level: "notice" as const, text: "No import breaks the configured layer rules." }] : []),
  ];
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** The dependencies the report lists, and how many it leaves out because the depended-on folder is below the evidence floor. */
export function withEvidenceFloor(against: readonly UnstableDependency[], settings: Pick<StructureSettings, "minTargetFiles">): { listed: UnstableDependency[]; belowFloor: number } {
  const { listed, belowFloor } = splitAtTargetFloor(against, settings);
  return { listed, belowFloor: belowFloor.length };
}

function stabilityBlocks(packageRows: readonly PackageRow[], allAgainst: readonly UnstableDependency[], settings: StructureSettings): { blocks: Block[]; slots: Slot[] } {
  const { listed: against, belowFloor } = withEvidenceFloor(allAgainst, settings);
  const floor = settings.packages.minExportedTypes;
  const unplaced = packageRows.filter((row) => row.abstractness !== null && (row.exportedTypes ?? 0) < floor).length;
  const measured = packageRows.flatMap((row): StabilityPoint[] =>
    row.instability === null || row.abstractness === null || row.distance === null || (row.exportedTypes ?? 0) < floor
      ? []
      : [{ name: row.id, instability: row.instability, abstractness: row.abstractness, distance: row.distance, ca: row.ca, ce: row.ce, exportedTypes: row.exportedTypes ?? 0, weak: row.abstractnessWeak }],
  );
  const points = measured.sort((a, b) => b.distance - a.distance || (a.name < b.name ? -1 : 1));
  const shown = against.slice(0, TOP_AGAINST);
  const slots: Slot[] = [];
  const blocks: Block[] = [
    { type: "stability-chart", title: "Packages by instability and abstractness", zoneDistance: settings.packages.zoneDistance, zoneSource: "structure.packages.zoneDistance, a judgement call", points, maxPoints: TOP_PACKAGES, total: packageRows.length - unplaced, noun: "packages" },
    ...(unplaced === 0 ? [] : [{ type: "notice" as const, level: "notice" as const, text: `${plural(unplaced, "package")} ${unplaced === 1 ? "has" : "have"} too few exported types to place (fewer than ${floor}, structure.packages.minExportedTypes, a judgement call); abstractness is not measured for ${unplaced === 1 ? "it" : "them"}. ${unplaced === 1 ? "It is" : "They are"} left out of the chart, its table and its zone counts.` }]),
    {
      type: "paragraph",
      text: "A dependency should point towards the more stable side. Structural stability is Martin's instability I = Ce / (Ca + Ce) over distinct outside files. Change stability is revisions per file in the window, and it decides when the depended-on side has at least structure.minRevisions revisions. The table is sorted by, in order: rows at or above a guideline first; rows decided by change before rows decided by structure; the larger margin, which for change is the depended-on side's revisions per file minus the dependant's (both shown) and for structure is the instability gap; file imports; path. A row decided by change can have a negative instability gap: it is listed because the depended-on folder has more revisions per file, even when it is structurally more stable. No row is hidden for being below a guideline.",
    },
    {
      type: "ranked-table",
      caption: "Dependencies pointing towards less stable folders",
      noun: "dependencies",
      emptyText: belowFloor === 0 ? "No dependency points towards a less stable folder." : `No dependency points towards a less stable folder that has at least ${settings.minTargetFiles} files; ${plural(belowFloor, "dependency", "dependencies")} onto smaller folders ${belowFloor === 1 ? "is" : "are"} left out.`,
      total: against.length,
      columns: [
        { key: "from", label: "From (depends)" },
        { key: "to", label: "To (depended on)" },
        { key: "basis", label: "Decided by" },
        { key: "fromRpf", label: "Revisions per file, from", align: "right" },
        { key: "toRpf", label: "Revisions per file, to", align: "right" },
        { key: "ratio", label: "Revisions per file, to over from", align: "right", guideline: { value: settings.minVolatilityRatio, note: "structure.minVolatilityRatio" } },
        { key: "gap", label: "Instability gap in points", align: "right", guideline: { value: settings.minInstabilityGap, note: "structure.minInstabilityGap" } },
        { key: "imports", label: "File imports", align: "right" },
        { key: "disagree", label: "Measures disagree" },
      ],
      rows: shown.map((row): Record<string, Cell> => {
        const gap = row.stability.from.structural.instability === null || row.stability.to.structural.instability === null ? null : round3((row.stability.to.structural.instability - row.stability.from.structural.instability) * 100);
        return { from: row.from, to: row.to, basis: row.basis, fromRpf: round3(row.stability.from.change.revisionsPerFile), toRpf: round3(row.stability.to.change.revisionsPerFile), ratio: row.volatilityRatio, gap, imports: row.fileEdges, disagree: yesNo(row.disagree) };
      }),
    },
  ];
  shown.forEach((row, i) => {
    const id = `against-${i + 1}`;
    const label = `dependency ${i + 1} (${row.from} → ${row.to})`;
    blocks.push({ type: "judgement", slot: id });
    slots.push({
      id,
      title: `Judgement: ${label}`,
      about: { kind: "finding", ref: row.id, label },
      task: "Say whether this dependency from the more stable folder onto the less stable one is worth fixing, and why. Change evidence outranks structure when the measures disagree, and with a weak evidence grade say the verdict is tentative. Cite only values shown in this report.",
      verdicts: ["worth-fixing", "leave", "evidence-too-weak"],
      maxChars: 320,
    });
  });
  if (belowFloor > 0) blocks.push({ type: "notice", level: "notice", text: `${plural(belowFloor, "dependency", "dependencies")} onto a folder of fewer than ${settings.minTargetFiles} files ${belowFloor === 1 ? "is" : "are"} left out, because the figures of a one-file folder are the figures of one file (evidence floor structure.minTargetFiles, a judgement call). \`structure stability\` lists ${belowFloor === 1 ? "it" : "them"} after the others.` });
  return { blocks, slots };
}

/** A package is placed on the chart when it has instability and abstractness and exports enough types to place. */
const isPlaced = (row: PackageRow, settings: StructureSettings): boolean =>
  row.instability !== null && row.abstractness !== null && row.distance !== null && (row.exportedTypes ?? 0) >= settings.packages.minExportedTypes;

/** The packages found, those whose code is read (abstractness is measured only where an adapter reads production code), and those placed on the chart. */
function packagesText(rows: readonly PackageRow[], settings: StructureSettings): string {
  const withCode = rows.filter((row) => row.abstractness !== null).length;
  const placed = rows.filter((row) => isPlaced(row, settings)).length;
  return `${rows.length} found from manifests: ${withCode} ${withCode === 1 ? "holds" : "hold"} production code in a supported language, and ${placed} of them ${placed === 1 ? "is" : "are"} placed on the chart`;
}

function censusBlocks(rows: readonly CensusRow[]): Block[] {
  const none = rows.filter((row) => row.count === 0).map((row) => row.mechanism);
  const lookAlikes = rows.flatMap((row) =>
    row.lookAlikes.length === 0
      ? []
      : [`${row.mechanism}: ${nameList(row.lookAlikes.map((l) => `${l.name} (${plural(l.count, "call")})`), 5)}`],
  );
  return [
    {
      type: "ranked-table",
      caption: "Decoupling mechanisms the codebase uses today",
      numbered: false,
      columns: [
        { key: "mechanism", label: "Mechanism" },
        { key: "count", label: "Occurrences", align: "right" },
        { key: "files", label: "Files", align: "right" },
        { key: "variants", label: "Variants" },
        { key: "folders", label: "Busiest folders (counts include the folders of implementers and callers)" },
        { key: "example", label: "Example" },
      ],
      rows: rows.map((row): Record<string, Cell> => ({
        mechanism: row.mechanism,
        count: row.count,
        files: row.files,
        variants: row.variants.length === 0 ? null : nameList(row.variants.map((v) => `${v.variant} (${v.count})`), 3),
        folders: row.folders.length === 0 ? null : nameList(row.folders.map((f) => `${f.folder} (${f.count})`), 3),
        example: row.examples[0] === undefined ? null : `${row.examples[0].path}${row.examples[0].line === null ? "" : `:${row.examples[0].line}`}`,
      })),
    },
    {
      type: "notice",
      level: "notice",
      text: `The census describes and does not judge. ${none.length === 0 ? "Every mechanism is in use here." : `A count of zero is a finding: ${none.join(", ")} ${none.length === 1 ? "is" : "are"} not in use here, so choosing ${none.length === 1 ? "it" : "one"} would introduce something new.`}`,
    },
    ...(lookAlikes.length === 0
      ? []
      : [
          {
            type: "notice" as const,
            level: "notice" as const,
            text: `Calls left out of the counts as look-alikes, ${lookAlikes.join("; ")}. The repository defines each of these send names only on types and files that have no listen method and no event base type, so a call runs that code and notifies no listener. \`structure census\` lists them under lookAlikes.`,
          },
        ]),
  ];
}

const SIGNALS: [keyof Hub["signals"], string][] = [
  ["starCoChange", "star co-change"],
  ["outwardDependencies", "outward dependencies"],
  ["appendShapedEdits", "append-shaped edits"],
  ["contention", "contention"],
];

function hubBlocks(rows: readonly Hub[], notices: readonly string[]): Block[] {
  return [
    {
      type: "ranked-table",
      caption: "Registration hubs: files every feature edits",
      noun: "hubs",
      total: rows.length,
      emptyText: notices.join(" "),
      rowIds: rows.slice(0, TOP_HUBS).map((hub) => hubId(hub.file)),
      columns: [
        { key: "file", label: "File" },
        { key: "reached", label: "Signals reached of 4", align: "right" },
        { key: "signals", label: "Which" },
        { key: "features", label: "Features", align: "right" },
        { key: "revisions", label: "Revisions", align: "right" },
      ],
      rows: rows.slice(0, TOP_HUBS).map((hub): Record<string, Cell> => ({
        file: hub.file,
        reached: hub.signalsReached,
        signals: SIGNALS.filter(([key]) => hub.signals[key].reached).map(([, name]) => name).join(", "),
        features: hub.featureCount,
        revisions: hub.revisions,
      })),
    },
    ...(rows.length === 0 ? [] : notices.map((text): Block => ({ type: "notice", level: "notice", text }))),
  ];
}

function includeBlocks(include: NonNullable<Results["include"]>): Block[] {
  const { section } = include;
  const source =
    section.compileCommands !== null
      ? `compile_commands.json at ${section.compileCommands.paths.join(", ")}${section.compileCommands.tracked ? "" : " (not tracked by git)"}`
      : section.configuredRoots.length > 0
        ? `the includeRoots setting: ${section.configuredRoots.map((r) => (r === "" ? "the repository root" : r)).join(", ")}`
        : section.inferredRoots.length > 0
          ? `inferred from where the unresolved includes' files are: ${nameList(section.inferredRoots, 5)}`
          : "none: no compile_commands.json, no includeRoots setting and nothing to infer from";
  const share = round3(section.unresolvedShare * 100);
  return [
    {
      type: "facts",
      caption: "How C and C++ includes were resolved",
      facts: [
        { label: "Include directories from", value: source },
        { label: "Includes that name a file of the repository", value: String(section.includes) },
        { label: "Of them, found no file", value: String(section.unresolved) },
        { label: "Share that found no file", value: `${share}%` },
      ],
    },
    { type: "guideline-bars", title: "Includes that found no file against the guideline", unit: "percent of includes", source: "Guideline: structure.unresolvedIncludePercent, a judgement call.", bars: [{ label: "Unresolved includes", value: share, guideline: section.guideline }] },
    ...(include.notice === undefined ? [] : [{ type: "notice" as const, level: "warning" as const, text: include.notice }]),
  ];
}

function slotsOf(extra: readonly Slot[]): Slot[] {
  return [
    {
      id: "summary",
      title: "Judgement: what to look at first",
      about: { kind: "report", ref: "structure", label: "the repository" },
      task: "In at most four sentences say where the structure of this repository needs attention first, using only values shown in this report: the cycles, the dependencies against stability, the layer violations when layers are configured, and the hubs. When the evidence grade is weak, say the change-based results are tentative.",
      verdicts: [],
      maxChars: 700,
    },
    ...extra,
    {
      id: "limits",
      title: "Judgement: what limits these results",
      about: { kind: "report", ref: "structure", label: "the repository" },
      task: "In at most three sentences, say what limits how far these results can be trusted for this repository, using only the evidence, the exclusions and the warnings shown above.",
      verdicts: [],
      maxChars: 500,
    },
  ];
}

function limitsOf(results: Results, settings: StructureSettings): string[] {
  const { evidence } = results.extra;
  return [
    "Guidelines order and label results. They are heuristics for investigation and decide nothing.",
    `Each list shows up to ${TOP_CYCLES} cycles, ${TOP_AGAINST} dependencies against stability, ${results.layerViolations === null ? "" : `${TOP_LAYER_VIOLATIONS} layer violations, `}${TOP_HUBS} hubs and ${TOP_PACKAGES} packages in the stability table, and says how many it leaves out. The chart draws every package it places. The commands print the rest.`,
    "Packages are counted from the manifests found. `structure cycles --level package` has a module for each package that holds production code in a supported language, and the chart places only those that also export enough types and have a dependency in or out.",
    "Cycles are found at the default level for each language, so a file cycle in Go or C# that stays inside one package or folder is not shown. `structure cycles --level` shows the other levels.",
    `Abstractness is measured for packages from the exported interfaces, abstract classes, classes and enums. A package that exports fewer than ${settings.packages.minExportedTypes} types (structure.packages.minExportedTypes) has too few for the abstract-to-concrete ratio to mean anything, so it is unplaced: left out of the chart, its table and its zone counts, and counted. Folders have no abstractness, so the chart is of packages and the dependencies against stability are between folders.`,
    ...(results.packages.some((row) => row.ecosystem === "go")
      ? ["In Go, packages offer behaviour through functions and structurally satisfied interfaces, and the measure counts only declared types, so a concrete Go package that many packages depend on is common and a position in the zone of pain says little about it. Change evidence carries the judgement."]
      : []),
    "The zones of the chart are geometric. `structure packages coupling` raises a finding only when a package in a zone also has dependents and changes often.",
    "The census finds mechanisms by name and shape, so a look-alike can be counted and a custom convention missed.",
    ...(settings.layers.length === 0 ? ["No layers are configured in structure.layers, so no layer rule was checked."] : []),
    ...(results.include?.section.aboveGuideline === true ? ["More C and C++ includes found no file than the guideline allows, so the dependency graph and everything drawn from it are incomplete."] : []),
    ...(evidence.grade === "weak" ? ["The evidence grade is weak, so change stability and the co-change counts are tentative and the static structure should lead."] : []),
    ...(evidence.truncated.shallow ? [`The clone is shallow, so history before ${evidence.truncated.availableSince === null ? "its boundary" : isoDate(evidence.truncated.availableSince)} is missing.`] : []),
  ];
}

export const structure: ReportKind = {
  summary: "Import cycles with their breaking sets, layer violations, stability by package and folder, the decoupling census, hubs and C++ include resolution, with a judgement of each cycle and each dependency against stability",
  options: { ...windowOptions, "no-refresh": { type: "boolean" } },
  optionHelp: {
    since: "analyse history from this date (ISO 8601); needed on a shallow clone",
    until: "analyse history up to this date (ISO 8601, exclusive)",
    "no-refresh": "read the history cache without bringing it up to date",
  },
  async build(context): Promise<ReportBuild> {
    const settings = readSettings(context.config);
    const results = await gather(context, settings);
    const { evidence } = results.extra;
    const cycle = cycleBlocks(results.cycles, results.extra.projectFolderCycles);
    const dependency = stabilityBlocks(results.packages, results.against, settings);
    const listedAgainst = withEvidenceFloor(results.against, settings).listed;
    const aboveGuideline = listedAgainst.filter((row) => row.aboveGuideline).length;
    const excluded = excludedCounts(results.extra.filtersApplied, droppedCounts(), builtinOmissions()).filter((e) => e.count > 0);
    const sections: Section[] = [
      {
        id: "summary",
        heading: "What to look at first",
        blocks: [
          {
            type: "facts",
            caption: "The structure at a glance",
            facts: [
              { label: "Import cycles at the default level", value: String(results.cycles.length) },
              { label: "Layer violations", value: results.layerViolations === null ? "no layers configured" : String(results.layerViolations.length) },
              { label: "Dependencies pointing towards less stable folders", value: `${listedAgainst.length}, of which ${aboveGuideline} reach a guideline` },
              { label: "Registration hubs", value: String(results.hubs.length) },
              { label: "Packages", value: packagesText(results.packages, settings) },
            ],
          },
          ...dsmBlocks(results.extra.dsm, results.layerViolations !== null, new Set(results.hubs.slice(0, TOP_HUBS).map((hub) => hub.file)), Math.min(results.cycles.length, TOP_CYCLES)),
          { type: "judgement", slot: "summary" },
        ],
      },
      { id: "cycles", heading: "Import cycles", blocks: cycle.blocks },
      ...(results.layerViolations === null ? [] : [{ id: "layers", heading: "Layer violations", blocks: layerBlocks(results.layerViolations, settings) }]),
      { id: "stability", heading: "Stability", blocks: dependency.blocks },
      { id: "census", heading: "Decoupling mechanisms in use", blocks: censusBlocks(results.census) },
      { id: "hubs", heading: "Hubs", blocks: hubBlocks(results.hubs, results.hubNotices) },
      ...(results.include === null ? [] : [{ id: "includes", heading: "C and C++ include resolution", blocks: includeBlocks(results.include) }]),
    ];
    return dropEmptySlots({
      title: "Structure report",
      inputs: { since: context.values.since ?? null, until: context.values.until ?? null, ...results.inputs },
      header: {
        evidenceGrade: evidence.grade,
        historyWindow: historyWindowText(evidence, results.extra.window),
        excluded,
      },
      sections,
      limits: limitsOf(results, settings),
      slots: slotsOf([...cycle.slots, ...dependency.slots]),
    });
  },
};
