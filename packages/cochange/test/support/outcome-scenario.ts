import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { emptySession, writeSession } from "@code-health/history/session-state";
import { encodeProjectDir } from "@code-health/transcripts/measure-repo";
import { edit, SyntheticSession } from "../../../transcripts/test/synthetic-transcript.ts";

const dana: Identity = { name: "Dana", email: "dana@example.com" };

export const invoice = "src/billing/invoice.ts";
export const invoiceTest = "test/billing/invoice.test.ts";
export const tax = "src/billing/tax.ts";
export const order = "src/orders/order.ts";
export const orderTest = "test/orders/order.test.ts";
export const misc = "src/misc/misc.ts";
export const pageA = "src/ui/a.ts";
export const pageB = "src/ui/b.ts";

/** Enough stable lines that git sees a modification, not a rewrite. */
const source = (name: string, version: number): string =>
  [...Array.from({ length: 9 }, (_, i) => `export const ${name}Step${i} = ${i};`), `export const ${name} = ${version};`, ""].join("\n");

const at = (day: string) => `${day}T09:00:00Z`;

/**
 * Six months of changes, with the work done on 1 April 2024.
 *
 * Before (January to March): the invoice changes four times, each time with a test two folders away (spread 4);
 * the order changes four times with its own distant test (spread 4); the miscellaneous file changes once alone.
 * After (April to June): the invoice now changes with the tax module beside it (spread 0), four times; the order
 * is unchanged in kind (spread 4, four times). The two pages change together six times and are coupled.
 *
 * Revisions in the before window: the invoice 4, its test 4, the order 4, its test 4, miscellaneous 1. The order is
 * the nearest control to the invoice: the invoice's own test shares its changes, so it cannot stand for the untouched.
 */
export function outcomeHistory(): GitFixture {
  const steps: Step[] = [];
  const commit = (day: string, message: string, changes: Change[]) => steps.push({ type: "commit", message, date: at(day), author: dana, changes });
  const add = (path: string, name: string, version = 0): Change => ({ op: "add", path, content: source(name, version) });
  const modify = (path: string, name: string, version: number): Change => ({ op: "modify", path, content: source(name, version) });

  commit("2023-12-01", "Start", [add(invoice, "invoice"), add(invoiceTest, "invoiceTest"), add(tax, "tax"), add(order, "order"), add(orderTest, "orderTest"), add(misc, "misc"), add(pageA, "pageA"), add(pageB, "pageB")]);
  const before = ["2024-01-10", "2024-01-24", "2024-02-07", "2024-02-21"];
  before.forEach((day, i) => {
    commit(day, `Invoice ${i + 1}`, [modify(invoice, "invoice", i + 1), modify(invoiceTest, "invoiceTest", i + 1)]);
    commit(day.replace(/-\d\d$/, (d) => `-${String(Number(d.slice(1)) + 2).padStart(2, "0")}`), `Order ${i + 1}`, [modify(order, "order", i + 1), modify(orderTest, "orderTest", i + 1)]);
  });
  commit("2024-03-01", "Tidy", [modify(misc, "misc", 1)]);
  const after = ["2024-04-10", "2024-04-24", "2024-05-08", "2024-05-22"];
  after.forEach((day, i) => {
    commit(day, `Invoice and tax ${i + 1}`, [modify(invoice, "invoice", 10 + i), modify(tax, "tax", i + 1)]);
    commit(day.replace(/-\d\d$/, (d) => `-${String(Number(d.slice(1)) + 2).padStart(2, "0")}`), `Order again ${i + 1}`, [modify(order, "order", 10 + i), modify(orderTest, "orderTest", 10 + i)]);
  });
  const pages = ["2024-03-03", "2024-03-05", "2024-03-07", "2024-06-03", "2024-06-05", "2024-06-07"];
  pages.forEach((day, i) => commit(day, `Pages ${i + 1}`, [modify(pageA, "pageA", i + 1), modify(pageB, "pageB", i + 1)]));
  commit("2024-07-05", "Release", [modify(misc, "misc", 2)]);

  const dated = steps.map((step, index) => ({ step, index }));
  dated.sort((x, y) => {
    const dx = (x.step as { date: string }).date;
    const dy = (y.step as { date: string }).date;
    return dx < dy ? -1 : dx > dy ? 1 : x.index - y.index;
  });
  return GitFixture.build(dated.map((d) => d.step));
}

/** A directory of Claude Code sessions for a repository, and the hook's own session state beside the repository. */
export class AgentSessions {
  readonly directory: string;
  readonly root: string;
  private readonly project: string;

  constructor(repositoryPath: string) {
    this.directory = mkdtempSync(join(tmpdir(), "code-health-agent-"));
    this.root = realpathSync(repositoryPath);
    this.project = join(this.directory, encodeProjectDir(this.root));
    mkdirSync(this.project, { recursive: true });
  }

  /**
   * One session that edits `files` in order, one turn each, on `day`. With `hook`, the cochange hook ran in it
   * and spoke about `spoke` files.
   */
  session(id: string, day: string, files: string[], hook?: { spoke: string[] }): void {
    const transcript = new SyntheticSession({ cwd: this.root, sessionId: id, start: `${day}T09:00:00.000Z` }).prompt("Make the change");
    files.forEach((file, i) => transcript.assistant(`${id}-m${i}`, [edit(join(this.root, file))]));
    writeFileSync(join(this.project, `${id}.jsonl`), transcript.toJsonl());
    if (hook !== undefined) writeSession(this.root, id, "cochange", { ...emptySession(), edited: [...new Set(files)], spokenAbout: hook.spoke });
  }

  dispose(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}
