/**
 * The summarizer core: text in, one markdown synopsis per chapter out.
 *
 * It talks to the endpoint through `sendRequest`, so quota, retry and backoff behave
 * exactly as they do for translation — nothing is sent unless the limiter has room.
 * It never touches the wire format; the model gets prose and answers in prose.
 *
 * A chapter that fits the input budget is one call. A longer one is split at line
 * boundaries, each part is summarized, and one more call merges the parts. With
 * `carryOver` the previous chapter's synopsis rides along as context, which makes the
 * run sequential; without it chapters are independent and run a few at a time.
 */
import { estimateTokens } from "../llm/estimate";
import { isFatal, sendRequest, type SendDeps, type SendEvent } from "../orchestrator/send";
import type { SummaryChapter, SummaryDoc } from "./doc";
import { MERGE_INSTRUCTION, PART_INSTRUCTION } from "./prompt";

export type SummarizeEvent =
  | SendEvent
  | { type: "chapter-start"; id: string; title: string; position: number; total: number }
  | { type: "chapter-done"; id: string; parts: number; usage: Usage }
  | { type: "chapter-failed"; id: string; error: string };

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface SummarizeDeps extends Omit<SendDeps, "onEvent"> {
  onEvent(e: SummarizeEvent): void;
  charsPerToken: number;
  /** Largest prompt, system included, one call may carry. */
  maxInputTokens: number;
}

/** Independent chapters in flight at once. The limiter still gates every request. */
export const CONCURRENCY = 3;

/** Stand-in for the carried-over synopsis when planning; real ones vary with length. */
const CARRY_TOKENS = 500;
/** Wrapper tags and slack on top of the system prompt and the text itself. */
const OVERHEAD_TOKENS = 200;

export interface Previous {
  title: string;
  markdown: string;
}

function attr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function userMessage(title: string, text: string, previous?: Previous): string {
  const prev = previous
    ? `<previous_synopsis chapter="${attr(previous.title)}">\n${previous.markdown}\n</previous_synopsis>\n\n`
    : "";
  return `${prev}<chapter title="${attr(title)}">\n${text}\n</chapter>`;
}

/** Models sometimes wrap the whole answer in a code fence. */
export function cleanSynopsis(s: string): string {
  const t = s.trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(t);
  return (fenced ? fenced[1] : t).trim();
}

/** Tokens left for text once the system prompt, carry-over and wrapper are paid for. */
function textBudget(o: { maxInputTokens: number; systemTokens: number; carryTokens: number }): number {
  return Math.max(500, o.maxInputTokens - o.systemTokens - o.carryTokens - OVERHEAD_TOKENS);
}

/**
 * Split at line boundaries into pieces of at most `maxTokens`. A single line longer
 * than that is cut by characters, since there is nowhere kinder to cut it.
 */
export function splitText(text: string, maxTokens: number, charsPerToken: number): string[] {
  if (estimateTokens(text, charsPerToken) <= maxTokens) return [text];
  const pieces: string[] = [];
  let cur: string[] = [];
  let curTokens = 0;
  const flush = () => {
    if (cur.length) pieces.push(cur.join("\n"));
    cur = [];
    curTokens = 0;
  };
  for (const line of text.split("\n")) {
    const tokens = estimateTokens(line, charsPerToken) + 1;
    const parts =
      tokens <= maxTokens
        ? [line]
        : chunkChars(line, Math.max(1, Math.floor((line.length * maxTokens) / tokens)));
    for (const part of parts) {
      const t = estimateTokens(part, charsPerToken) + 1;
      if (cur.length && curTokens + t > maxTokens) flush();
      cur.push(part);
      curTokens += t;
    }
  }
  flush();
  return pieces;
}

function chunkChars(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

export interface ChapterResult {
  markdown: string;
  parts: number;
  usage: Usage;
  /** A call hit the output limit, so the synopsis may end mid-sentence. */
  truncated: boolean;
}

/** One chapter: a single call, or parts then a merge. */
export async function summarizeChapter(args: {
  chapter: SummaryChapter;
  previous?: Previous;
  system: string;
  /** Only labels events. */
  index: number;
  deps: SummarizeDeps;
  signal: AbortSignal;
}): Promise<ChapterResult> {
  const { chapter, previous, system, index, deps, signal } = args;
  const usage: Usage = { promptTokens: 0, completionTokens: 0 };
  let truncated = false;

  const ask = async (sys: string, user: string): Promise<string> => {
    const res = await sendRequest({
      system: sys,
      user,
      estimate: estimateTokens(sys + user, deps.charsPerToken),
      index,
      deps,
      signal,
    });
    usage.promptTokens += res.usage.promptTokens;
    usage.completionTokens += res.usage.completionTokens;
    if (res.finishReason === "length") truncated = true;
    return cleanSynopsis(res.content);
  };

  const pieces = splitText(
    chapter.text,
    textBudget({
      maxInputTokens: deps.maxInputTokens,
      systemTokens: estimateTokens(system, deps.charsPerToken),
      carryTokens: previous ? estimateTokens(previous.markdown, deps.charsPerToken) : 0,
    }),
    deps.charsPerToken,
  );

  if (pieces.length === 1) {
    const markdown = await ask(system, userMessage(chapter.title, pieces[0], previous));
    return { markdown, parts: 1, usage, truncated };
  }

  deps.onEvent({
    type: "log",
    message: `${chapter.title} is long: summarizing it in ${pieces.length} parts, then merging.`,
  });
  const partials: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    partials.push(
      await ask(
        `${system}\n\n${PART_INSTRUCTION(i + 1, pieces.length)}`,
        userMessage(`${chapter.title} (part ${i + 1}/${pieces.length})`, pieces[i], previous),
      ),
    );
  }
  // The partials are prose the model wrote at length, so many of them may not fit one
  // call. Merge in rounds, each round folding as many consecutive synopses as the budget
  // allows, until one is left.
  const mergeSystem = `${system}\n\n${MERGE_INSTRUCTION}`;
  const mergeBudget = textBudget({
    maxInputTokens: deps.maxInputTokens,
    systemTokens: estimateTokens(mergeSystem, deps.charsPerToken),
    carryTokens: previous ? estimateTokens(previous.markdown, deps.charsPerToken) : 0,
  });
  let level = partials;
  while (level.length > 1) {
    const groups: string[][] = [];
    let cur: string[] = [];
    let curTokens = 0;
    for (const p of level) {
      const t = estimateTokens(p, deps.charsPerToken) + 1;
      // At least two per group, or a round would make no progress.
      if (cur.length >= 2 && curTokens + t > mergeBudget) {
        groups.push(cur);
        cur = [];
        curTokens = 0;
      }
      cur.push(p);
      curTokens += t;
    }
    groups.push(cur);
    const next: string[] = [];
    for (const g of groups) {
      if (g.length === 1) {
        next.push(g[0]);
        continue;
      }
      const merged = g.map((p, i) => `Part ${i + 1}:\n${p}`).join("\n\n");
      next.push(await ask(mergeSystem, userMessage(chapter.title, merged, previous)));
    }
    level = next;
  }
  return { markdown: level[0], parts: pieces.length, usage, truncated };
}

export interface SummarizeRun {
  doc: SummaryDoc;
  /** Chapters to (re)generate. Anything else in the doc is left alone. */
  ids: ReadonlySet<string>;
  /**
   * Synopses already stored, by chapter id. Chapters that are not being run still feed
   * the carry-over of the one after them.
   */
  existing: ReadonlyMap<string, string>;
  carryOver: boolean;
  system: string;
  /** Called as each chapter lands, so it can be stored before the next call is made. */
  onChapter(id: string, result: ChapterResult): void | Promise<void>;
}

/**
 * Run the chosen chapters. A failed chapter is reported and skipped; a fatal error (bad
 * key, spent daily quota, endpoint down) stops the run and is thrown once the chapters
 * already in flight have settled, because the next one would meet the same fate.
 */
export async function summarizeDoc(
  run: SummarizeRun,
  deps: SummarizeDeps,
  signal: AbortSignal,
): Promise<{ done: number; failed: number }> {
  const { doc } = run;
  const known = new Map(run.existing);
  const queue = doc.chapters.map((_, i) => i).filter((i) => run.ids.has(doc.chapters[i].id));
  const total = queue.length;
  let next = 0;
  let done = 0;
  let failed = 0;
  let fatal: unknown;

  const worker = async () => {
    while (!fatal) {
      signal.throwIfAborted();
      const at = next++;
      if (at >= total) return;
      const i = queue[at];
      const chapter = doc.chapters[i];
      const before = run.carryOver && i > 0 ? doc.chapters[i - 1] : undefined;
      const prevText = before ? known.get(before.id) : undefined;
      const previous = before && prevText ? { title: before.title, markdown: prevText } : undefined;

      deps.onEvent({ type: "chapter-start", id: chapter.id, title: chapter.title, position: at, total });
      try {
        const result = await summarizeChapter({
          chapter,
          previous,
          system: run.system,
          index: i,
          deps,
          signal,
        });
        known.set(chapter.id, result.markdown);
        await run.onChapter(chapter.id, result);
        done++;
        deps.onEvent({ type: "chapter-done", id: chapter.id, parts: result.parts, usage: result.usage });
        if (result.truncated) {
          deps.onEvent({
            type: "log",
            message: `${chapter.title}: the reply hit the output limit, so the synopsis may be cut off.`,
          });
        }
      } catch (e) {
        if (signal.aborted) throw e;
        failed++;
        // Do not let the next chapter carry over what was stored before this attempt.
        known.delete(chapter.id);
        deps.onEvent({ type: "chapter-failed", id: chapter.id, error: (e as Error).message });
        if (isFatal(e)) fatal = e;
      }
    }
  };

  const workers = run.carryOver ? 1 : Math.min(CONCURRENCY, Math.max(1, total));
  const settled = await Promise.allSettled(Array.from({ length: workers }, worker));
  const aborted = settled.find((r) => r.status === "rejected");
  if (aborted && aborted.status === "rejected") throw aborted.reason;
  if (fatal) throw fatal;
  return { done, failed };
}

export interface SummaryPlan {
  calls: number;
  inputTokens: number;
  /** Chapters that will be split, for the "this is long" note. */
  longChapters: string[];
}

/**
 * What a run will cost, for the page. Pure — nothing is sent and no quota is touched.
 * Rough by design: a carried-over synopsis is guessed at, and the real split depends on
 * it.
 */
export function planSummary(
  doc: SummaryDoc,
  ids: ReadonlySet<string>,
  o: { systemTokens: number; charsPerToken: number; maxInputTokens: number; carryOver: boolean },
): SummaryPlan {
  const carryTokens = o.carryOver ? CARRY_TOKENS : 0;
  const budget = textBudget({ ...o, carryTokens });
  let calls = 0;
  let inputTokens = 0;
  const longChapters: string[] = [];
  for (const c of doc.chapters) {
    if (!ids.has(c.id)) continue;
    const parts = splitText(c.text, budget, o.charsPerToken);
    const body = estimateTokens(c.text, o.charsPerToken);
    calls += parts.length;
    inputTokens += body + parts.length * (o.systemTokens + carryTokens + OVERHEAD_TOKENS / 2);
    if (parts.length > 1) {
      longChapters.push(c.title);
      calls += 1; // the merge
      inputTokens += o.systemTokens + parts.length * 600;
    }
  }
  return { calls, inputTokens, longChapters };
}
