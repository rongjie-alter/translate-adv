/**
 * Retranslating a hand-picked set of lines.
 *
 * The problem this solves: a user spots three bad lines in a chapter of eight
 * hundred. Redoing the chapter is absurd, and redoing the three lines alone
 * reproduces the mistake — a line was mistranslated *because* it was ambiguous out
 * of context, so sending it with less context than the first attempt had is the one
 * thing guaranteed not to help.
 *
 * So each selected line goes with its neighbours as `~` context: already
 * translated, so they cost input tokens and produce no output, and they show the
 * model the names and register it already committed to. Scattered selections are
 * grouped, nearby groups merge, and as many groups as the budget allows ride in one
 * request — which for the common case of "a few bad lines" is a single call.
 *
 * Nothing here adds a wire token. `~` already means "context, not content" to the
 * prompt, to `parseResponse` and to `mock_server.py`.
 */
import { calibrate, estimateTokens, type Calibration } from "../llm/estimate";
import { buildSystemPrompt, hintBlock, RETRANSLATE_INSTRUCTION } from "../llm/prompt";
import type { LabelMap } from "../scenario/labels";
import { isTranslatable, type Lang, type SceneNode, type Speaker } from "../scenario/model";
import {
  serializeSelection,
  SELECTION_GAP,
  type SelectionItem,
  type StructureNode,
  type WireChunk,
} from "../scenario/serialize";
import { artifactNodes, type Artifact } from "../storage/exchange";
import { budgetParts } from "./chunker";
import { isFatal, translateWire, type SendDeps } from "./send";

export interface ContextOptions {
  /** Units of context before each group. Matches `CONTEXT_LINES` in the runner. */
  lead: number;
  /**
   * Units of context after each group. The runner cannot do this — it streams
   * forward and the next chunk is untranslated — but here everything is already
   * translated, and a line's meaning often only resolves on the one after it.
   */
  trail: number;
  /** Merge two groups separated by at most this many unselected units... */
  mergeGap: number;
  /** ...but only when bridging them costs at most this many tokens. */
  mergeTokens: number;
  /** Send the existing translation as context, or the Japanese source. */
  contextLang: "tl" | "src";
}

export const DEFAULT_CONTEXT: ContextOptions = {
  lead: 3,
  trail: 1,
  mergeGap: 3,
  mergeTokens: 120,
  contextLang: "tl",
};

/** Per-line overhead on the wire: the number, the separator, the speaker prefix. */
const LINE_OVERHEAD = 6;

export interface PlannedRequest {
  wire: WireChunk;
  /** Unit ids this request will bring back. */
  uids: string[];
  inputTokens: number;
  /** Estimated tokens of the *source* being retranslated, for calibration. */
  srcTokens: number;
  outputTokens: number;
}

export interface RetranslatePlan {
  requests: PlannedRequest[];
  /** Selected ids not present in the artifact — surfaced, never silently dropped. */
  unknown: string[];
  /** Units sent as context but never renumbered, so the UI can show what was read. */
  contextUids: string[];
}

interface Group {
  /** Selected unit indices, ascending. */
  targets: number[];
  /** Context window, inclusive; always covers every target. */
  ctxLo: number;
  ctxHi: number;
}

/**
 * The artifact's units with the structure that precedes each one.
 *
 * `artifactNodes` interleaves both; splitting them makes "what conditions are open
 * at unit i" and "which label encloses unit i" cheap to answer.
 */
interface Flat {
  nodes: SceneNode[];
  before: StructureNode[][];
}

function flatten(a: Artifact): Flat {
  const nodes: SceneNode[] = [];
  const before: StructureNode[][] = [];
  let pending: StructureNode[] = [];

  for (const n of artifactNodes(a)) {
    if (isTranslatable(n)) {
      nodes.push(n);
      before.push(pending);
      pending = [];
    } else {
      pending.push(n as StructureNode);
    }
  }
  return { nodes, before };
}

/** Conditional blocks open immediately before unit `i`, outermost first. */
function openConds(flat: Flat, i: number): StructureNode[] {
  const stack: StructureNode[] = [];
  for (let u = 0; u <= i && u < flat.before.length; u++) {
    for (const n of flat.before[u]) {
      if (n.kind === "cond") stack.push(n);
      else if (n.kind === "cond-end") stack.pop();
    }
  }
  return stack;
}

/** The nearest label at or before unit `i`, for orientation. */
function enclosingLabel(flat: Flat, i: number): StructureNode | null {
  for (let u = Math.min(i, flat.before.length - 1); u >= 0; u--) {
    for (let k = flat.before[u].length - 1; k >= 0; k--) {
      if (flat.before[u][k].kind === "label") return flat.before[u][k];
    }
  }
  return null;
}

/**
 * Branch options are always pulled in as a whole run.
 *
 * `chunker.ts` refuses to split a run of `select` nodes for the same reason:
 * options not translated together stop reading as alternatives.
 */
function extendOverSelects(flat: Flat, lo: number, hi: number): [number, number] {
  let a = lo;
  let b = hi;
  if (flat.nodes[a]?.kind === "select") while (a > 0 && flat.nodes[a - 1].kind === "select") a--;
  if (flat.nodes[b]?.kind === "select") {
    while (b < flat.nodes.length - 1 && flat.nodes[b + 1].kind === "select") b++;
  }
  return [a, b];
}

function contextText(a: Artifact, i: number, opts: ContextOptions): string {
  const u = a.units[i];
  if (!u) return "";
  return opts.contextLang === "tl" && u.tl ? u.tl : u.src;
}

export function planRetranslate(
  args: { artifact: Artifact; uids: string[]; options?: Partial<ContextOptions> },
  ctx: {
    labels: LabelMap;
    lang: Lang;
    systemTokens: number;
    charsPerToken: number;
    outputRatio: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  },
): RetranslatePlan {
  const opts = { ...DEFAULT_CONTEXT, ...args.options };
  const a = args.artifact;

  const indexById = new Map(a.units.map((u, i) => [u.id, i]));
  const unknown = args.uids.filter((id) => !indexById.has(id));
  const selected = args.uids
    .map((id) => indexById.get(id))
    .filter((i): i is number => i !== undefined)
    .sort((x, y) => x - y);

  if (!selected.length) return { requests: [], unknown, contextUids: [] };

  const flat = flatten(a);
  const wanted = new Set(selected);

  // 1. maximal runs of consecutive selected indices, widened over select runs
  const groups: Group[] = [];
  for (const i of selected) {
    const last = groups[groups.length - 1];
    if (last && i === last.targets[last.targets.length - 1] + 1) last.targets.push(i);
    else groups.push({ targets: [i], ctxLo: i, ctxHi: i });
  }
  for (const g of groups) {
    const [lo, hi] = extendOverSelects(flat, g.targets[0], g.targets[g.targets.length - 1]);
    g.ctxLo = lo;
    g.ctxHi = hi;
  }

  // 2. merge groups close enough that bridging beats repeating their context
  const merged: Group[] = [];
  for (const g of groups) {
    const p = merged[merged.length - 1];
    if (p) {
      const gap = g.ctxLo - p.ctxHi - 1;
      if (gap >= 0 && gap <= opts.mergeGap) {
        let cost = 0;
        for (let i = p.ctxHi + 1; i < g.ctxLo; i++) {
          cost += estimateTokens(contextText(a, i, opts), ctx.charsPerToken);
        }
        if (cost <= opts.mergeTokens) {
          p.targets.push(...g.targets);
          p.ctxHi = Math.max(p.ctxHi, g.ctxHi);
          continue;
        }
      }
    }
    merged.push(g);
  }

  // 3. context window, clamped so two groups never emit the same unit twice
  merged.forEach((g, gi) => {
    const prev = merged[gi - 1];
    g.ctxLo = Math.max(0, g.ctxLo - opts.lead, prev ? prev.ctxHi + 1 : 0);
    g.ctxHi = Math.min(a.units.length - 1, g.ctxHi + opts.trail);
  });

  // 4. flatten to render items and cost each group once
  const contextUids: string[] = [];
  const built = merged.map((g) => build(a, flat, g, wanted, opts, ctx.charsPerToken, contextUids));

  const budget = budgetParts({
    maxInputTokens: ctx.maxInputTokens,
    maxOutputTokens: ctx.maxOutputTokens,
    charsPerToken: ctx.charsPerToken,
    outputRatio: ctx.outputRatio,
    systemTokens: ctx.systemTokens,
  });

  return { requests: pack(built, budget, ctx), unknown, contextUids };
}

interface Built {
  items: SelectionItem[];
  uids: string[];
  /** Tokens of the rendered body for this group alone. */
  inputTokens: number;
  /** Tokens of the target source lines only — the part that comes back. */
  srcTokens: number;
}

function build(
  a: Artifact,
  flat: Flat,
  g: Group,
  wanted: Set<number>,
  opts: ContextOptions,
  charsPerToken: number,
  contextUids: string[],
): Built {
  const items: SelectionItem[] = [];
  const uids: string[] = [];
  let srcTokens = 0;

  // Conditions open at the window start, so the model sees what block it is in.
  const conds = openConds(flat, g.ctxLo - 1);
  for (const c of conds) items.push({ role: "structure", node: c });

  // The enclosing label, unless one already falls inside the window.
  const inWindow = flat.before
    .slice(g.ctxLo, g.ctxHi + 1)
    .some((ns) => ns.some((n) => n.kind === "label"));
  if (!inWindow) {
    const label = enclosingLabel(flat, g.ctxLo);
    if (label) items.push({ role: "structure", node: label });
  }

  for (let i = g.ctxLo; i <= g.ctxHi; i++) {
    for (const n of flat.before[i] ?? []) items.push({ role: "structure", node: n });
    const node = flat.nodes[i];
    if (wanted.has(i) && isTranslatable(node)) {
      items.push({ role: "target", node });
      uids.push(a.units[i].id);
      srcTokens += estimateTokens(node.src, charsPerToken) + LINE_OVERHEAD;
    } else {
      contextUids.push(a.units[i].id);
      items.push({ role: "context", text: contextText(a, i, opts) });
    }
  }

  // Close whatever we opened, so `?`/`?end` stay balanced.
  for (let k = 0; k < conds.length; k++) {
    items.push({ role: "structure", node: { kind: "cond-end" } });
  }

  return { items, uids, inputTokens: costOf(items, charsPerToken), srcTokens };
}

/** Rendered size of a group, without actually serializing it. */
function costOf(items: SelectionItem[], charsPerToken: number): number {
  let n = 0;
  for (const item of items) {
    if (item.role === "target") n += estimateTokens(item.node.src, charsPerToken) + LINE_OVERHEAD;
    else if (item.role === "context") n += estimateTokens(item.text, charsPerToken) + 2;
    else n += 5;
  }
  return n;
}

const GAP_TOKENS = 4;

/**
 * Fill each request with as many groups as fit, in document order.
 *
 * Never sorted by size: reordering groups would scramble the narrative and make a
 * single ascending numbering read as nonsense. Costs are precomputed per group, so
 * this is linear in the selection rather than re-rendering on every trial fit —
 * the UI re-plans on every selection change.
 */
function pack(
  groups: Built[],
  budget: { byInput: number; byOutput: number },
  ctx: { labels: LabelMap; lang: Lang; outputRatio: number },
): PlannedRequest[] {
  const out: PlannedRequest[] = [];
  let cur: Built[] = [];
  let inAcc = 0;
  let srcAcc = 0;

  const emit = (batch: Built[]) => {
    if (!batch.length) return;
    const wire = serializeSelection(
      batch.map((g) => ({ items: g.items })),
      { labels: ctx.labels, lang: ctx.lang },
    );
    const srcTokens = batch.reduce((t, g) => t + g.srcTokens, 0);
    out.push({
      wire,
      uids: batch.flatMap((g) => g.uids),
      inputTokens: batch.reduce((t, g) => t + g.inputTokens, 0) + (batch.length - 1) * GAP_TOKENS,
      srcTokens,
      outputTokens: Math.ceil(srcTokens * ctx.outputRatio),
    });
  };

  const flush = () => {
    emit(cur);
    cur = [];
    inAcc = 0;
    srcAcc = 0;
  };

  for (const g of expand(groups, budget, ctx.outputRatio)) {
    const gapCost = cur.length ? GAP_TOKENS : 0;
    const overInput = inAcc + gapCost + g.inputTokens > budget.byInput;
    const overOutput = Math.ceil((srcAcc + g.srcTokens) * ctx.outputRatio) > budget.byOutput;
    if (cur.length && (overInput || overOutput)) flush();
    cur.push(g);
    inAcc += gapCost + g.inputTokens;
    srcAcc += g.srcTokens;
  }
  flush();
  return out;
}

/**
 * Split groups that cannot fit a request even alone.
 *
 * A single unit larger than the whole budget is still emitted — the chunker takes
 * the same posture, preferring a possibly-truncated answer that then goes through
 * the repair round over stalling.
 */
function* expand(
  groups: Built[],
  budget: { byInput: number; byOutput: number },
  outputRatio: number,
): Generator<Built> {
  for (const g of groups) {
    const fits =
      g.inputTokens <= budget.byInput &&
      Math.ceil(g.srcTokens * outputRatio) <= budget.byOutput;
    if (fits || g.uids.length <= 1) {
      yield g;
      continue;
    }
    yield* expand(halve(g), budget, outputRatio);
  }
}

/** Cut an oversized group at a target boundary, keeping context with each half. */
function halve(g: Built): Built[] {
  const half = Math.ceil(g.uids.length / 2);
  const a: SelectionItem[] = [];
  const b: SelectionItem[] = [];
  let seen = 0;
  for (const item of g.items) {
    if (item.role === "target") seen++;
    (seen <= half ? a : b).push(item);
  }
  const share = (items: SelectionItem[]) =>
    items.filter((i) => i.role === "target").length / Math.max(1, g.uids.length);
  return [
    {
      items: a,
      uids: g.uids.slice(0, half),
      inputTokens: Math.ceil(g.inputTokens * share(a)) || 1,
      srcTokens: Math.ceil(g.srcTokens * share(a)),
    },
    {
      items: b,
      uids: g.uids.slice(half),
      inputTokens: Math.ceil(g.inputTokens * share(b)) || 1,
      srcTokens: Math.ceil(g.srcTokens * share(b)),
    },
  ];
}

// -- running ----------------------------------------------------------------

export type RetranslateEvent =
  | { type: "plan"; requests: number; units: number; inputTokens: number; outputTokens: number }
  | { type: "request-start"; index: number; total: number; units: number }
  | {
      type: "request-done";
      index: number;
      units: number;
      usage: { prompt: number; completion: number };
    }
  | { type: "request-failed"; index: number; error: string }
  | { type: "waiting"; ms: number; reason: string }
  | { type: "retry"; index: number; attempt: number; error: string }
  | { type: "repair"; index: number; missing: number }
  | { type: "log"; message: string }
  | { type: "done"; translated: number; failed: number };

export interface RetranslateDeps extends Omit<SendDeps, "onEvent"> {
  systemPromptTemplate: string;
  speakers: Speaker[];
  labels: LabelMap;
  calibration: Calibration;
  maxInputTokens: number;
  lang: Lang;
  /** A user's free-text note for this run only. Never written to settings. */
  hint?: string;
  options?: Partial<ContextOptions>;
  /**
   * Persist one request's worth of results before the next is sent, so an abort or
   * an exhausted quota keeps whatever already landed.
   */
  saveUnits(next: Map<string, string>, previous: Map<string, string>): Promise<void>;
  onCalibration(c: Calibration): void;
  onEvent(e: RetranslateEvent): void;
}

export interface RetranslateResult {
  translations: Map<string, string>;
  /** What each retranslated uid said before, for the accept/revert step. */
  previous: Map<string, string>;
  /** Requested but never returned, even after the repair round. */
  missing: string[];
  unknown: string[];
  failedRequests: number;
  usage: { requests: number; promptTokens: number; completionTokens: number };
}

/** The system prompt a retranslation sends, including the user's note. */
export function retranslateSystemPrompt(
  template: string,
  lang: Lang,
  speakers: Speaker[],
  hint?: string,
): string {
  const base = buildSystemPrompt(template, lang, speakers);
  return `${base}\n\n${RETRANSLATE_INSTRUCTION}${hintBlock(hint ?? "")}`;
}

export async function runRetranslate(
  args: { artifact: Artifact; uids: string[] },
  deps: RetranslateDeps,
  signal: AbortSignal,
): Promise<RetranslateResult> {
  const system = retranslateSystemPrompt(
    deps.systemPromptTemplate,
    deps.lang,
    deps.speakers,
    deps.hint,
  );

  let calibration = deps.calibration;
  const systemTokens = estimateTokens(system, calibration.charsPerToken);
  const plan = planRetranslate(
    { artifact: args.artifact, uids: args.uids, options: deps.options },
    {
      labels: deps.labels,
      lang: deps.lang,
      systemTokens,
      charsPerToken: calibration.charsPerToken,
      outputRatio: calibration.outputRatio,
      maxInputTokens: deps.maxInputTokens,
      maxOutputTokens: deps.maxOutputTokens,
    },
  );

  deps.onEvent({
    type: "plan",
    requests: plan.requests.length,
    units: plan.requests.reduce((n, r) => n + r.uids.length, 0),
    inputTokens: plan.requests.reduce((n, r) => n + r.inputTokens + systemTokens, 0),
    outputTokens: plan.requests.reduce((n, r) => n + r.outputTokens, 0),
  });

  const byId = new Map(args.artifact.units.map((u) => [u.id, u]));
  const translations = new Map<string, string>();
  const previous = new Map<string, string>();
  const missing: string[] = [];
  const usage = { requests: 0, promptTokens: 0, completionTokens: 0 };
  let failedRequests = 0;

  const sendDeps: SendDeps = {
    limiter: deps.limiter,
    apiKey: deps.apiKey,
    baseUrl: deps.baseUrl,
    model: deps.model,
    maxOutputTokens: deps.maxOutputTokens,
    reasoningEffort: deps.reasoningEffort,
    chat: deps.chat,
    onEvent: (e) => deps.onEvent(e),
  };

  for (let i = 0; i < plan.requests.length; i++) {
    const req = plan.requests[i];
    signal.throwIfAborted();
    deps.onEvent({
      type: "request-start",
      index: i,
      total: plan.requests.length,
      units: req.uids.length,
    });

    try {
      const res = await translateWire({
        system,
        wire: req.wire,
        estimate: systemTokens + req.inputTokens,
        charsPerToken: calibration.charsPerToken,
        index: i,
        deps: sendDeps,
        signal,
      });

      // Only lines that actually came back are written; a blank answer must never
      // wipe a translation the user already had.
      const landed = new Map<string, string>();
      const before = new Map<string, string>();
      for (const [uid, text] of res.translations) {
        if (!text) continue;
        landed.set(uid, text);
        before.set(uid, byId.get(uid)?.tl ?? "");
      }

      await deps.saveUnits(landed, before);
      for (const [uid, text] of landed) {
        translations.set(uid, text);
        previous.set(uid, before.get(uid) ?? "");
      }
      for (const l of res.missing) missing.push(l.uid);

      usage.requests++;
      usage.promptTokens += res.usage.promptTokens;
      usage.completionTokens += res.usage.completionTokens;

      calibration = calibrate(calibration, {
        promptText: system + req.wire.text,
        promptTokens: res.usage.promptTokens,
        sourceTokens: req.srcTokens,
        totalTokens: res.usage.totalTokens,
      });
      deps.onCalibration(calibration);

      deps.onEvent({
        type: "request-done",
        index: i,
        units: landed.size,
        usage: { prompt: res.usage.promptTokens, completion: res.usage.completionTokens },
      });
    } catch (e) {
      if (signal.aborted) throw e;
      failedRequests++;
      deps.onEvent({ type: "request-failed", index: i, error: (e as Error).message });
      // A dead endpoint or an exhausted daily quota fails every remaining request
      // the same way; stopping leaves the quota for a later, working run.
      if (isFatal(e)) break;
    }
  }

  deps.onEvent({ type: "done", translated: translations.size, failed: failedRequests });
  return { translations, previous, missing, unknown: plan.unknown, failedRequests, usage };
}

export { SELECTION_GAP };
