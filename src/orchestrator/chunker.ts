/**
 * Splitting a chapter into chunks that fit the model's limits.
 *
 * Where the split falls matters for quality: a chunk that starts mid-conversation
 * gives the model no idea who is speaking to whom, and a chunk that separates a
 * branch option from its siblings makes them read inconsistently. So cuts are
 * ranked — branch label, then end of a conditional or a jump, then a change of
 * speaker — and the best-ranked one in the acceptable range wins.
 */
import { estimateTokens } from "../llm/estimate";
import { isTranslatable, type SceneNode } from "../scenario/model";

export interface Chunk {
  nodes: SceneNode[];
  units: number;
  /** Estimated input tokens for the chunk body, excluding the system prompt. */
  tokens: number;
}

export interface ChunkOptions {
  maxInputTokens: number;
  maxOutputTokens: number;
  charsPerToken: number;
  outputRatio: number;
  /** Tokens the system prompt occupies in every request. */
  systemTokens: number;
  /** Fraction of the budget a chunk must reach before a cut is considered good. */
  minFill?: number;
}

/** Per-line overhead: the id, the separator, and the speaker prefix. */
const LINE_OVERHEAD = 6;

export function chunkNodes(nodes: SceneNode[], opts: ChunkOptions): Chunk[] {
  const budget = chunkBudget(opts);
  const minFill = (opts.minFill ?? 0.6) * budget;
  const cost = nodes.map((n) => nodeCost(n, opts.charsPerToken));

  const chunks: Chunk[] = [];
  let start = 0;
  let acc = 0;

  for (let i = 0; i < nodes.length; ) {
    acc += cost[i];
    if (acc > budget && hasUnits(nodes, start, i)) {
      const cut = findCut(nodes, cost, start, i, minFill);
      chunks.push(makeChunk(nodes, cost, start, cut));
      start = cut;
      i = cut;
      acc = 0;
      continue;
    }
    i++;
  }
  if (hasUnits(nodes, start, nodes.length)) {
    chunks.push(makeChunk(nodes, cost, start, nodes.length));
  }
  return chunks;
}

/**
 * The usable input budget: whichever of the input window or the output cap binds
 * first. A model that accepts 32k in but only emits 8k out cannot be fed 32k of
 * Japanese, or its answer gets truncated halfway.
 */
export function chunkBudget(opts: ChunkOptions): number {
  const { byInput, byOutput } = budgetParts(opts);
  return Math.max(200, Math.min(byInput, byOutput));
}

/**
 * The two limits behind `chunkBudget`, kept separate.
 *
 * A chunk pays both at once, so collapsing them to one number is right for the
 * chunker. A targeted retranslation does not: most of its body is `~` context that
 * costs input tokens and produces no output at all, so it has to weigh the two
 * independently or it would split requests that would comfortably have fit.
 */
export function budgetParts(opts: ChunkOptions): { byInput: number; byOutput: number } {
  return {
    byInput: opts.maxInputTokens - opts.systemTokens,
    byOutput: Math.floor((opts.maxOutputTokens * 0.85) / Math.max(0.2, opts.outputRatio)),
  };
}

function makeChunk(nodes: SceneNode[], cost: number[], start: number, end: number): Chunk {
  const slice = nodes.slice(start, end);
  return {
    nodes: slice,
    units: slice.filter(isTranslatable).length,
    tokens: cost.slice(start, end).reduce((a, b) => a + b, 0),
  };
}

function hasUnits(nodes: SceneNode[], start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (isTranslatable(nodes[i])) return true;
  return false;
}

function nodeCost(n: SceneNode, charsPerToken: number): number {
  switch (n.kind) {
    case "text":
    case "select":
    case "title": {
      const speaker = n.kind === "text" && n.speaker ? n.speaker.jp.length : 0;
      return estimateTokens(n.src, charsPerToken) + estimateTokens(" ".repeat(speaker), 4) + LINE_OVERHEAD;
    }
    case "label":
    case "jump":
      return 5;
    case "cond":
      return estimateTokens(n.expr, 4) + 2;
    case "cond-end":
      return 2;
  }
}

/**
 * Pick where to cut in `(start, end]`. Returns an index strictly greater than
 * `start`, so progress is always made even for a single oversized line.
 */
function findCut(
  nodes: SceneNode[],
  cost: number[],
  start: number,
  end: number,
  minFill: number,
): number {
  let best = -1;
  let bestQuality = -1;
  let acc = 0;

  const depths = condDepths(nodes, start, end);

  for (let j = start + 1; j <= end; j++) {
    acc += cost[j - 1];
    const q = cutQuality(nodes, j, depths[j - start]);
    if (q < 0) continue;
    if (acc < minFill && j !== end) continue;
    if (q >= bestQuality) {
      bestQuality = q;
      best = j;
    }
  }

  if (best > start) return best;
  // Nothing legal in range — fall back to the last unit boundary, then to one node.
  for (let j = end; j > start; j--) if (isTranslatable(nodes[j - 1])) return j;
  return start + 1;
}

/** Conditional-block nesting depth *before* each index in the window. */
function condDepths(nodes: SceneNode[], start: number, end: number): number[] {
  const out: number[] = [];
  let depth = 0;
  for (let i = start; i <= end; i++) {
    out.push(depth);
    const n = nodes[i];
    if (!n) break;
    if (n.kind === "cond") depth++;
    else if (n.kind === "cond-end") depth = Math.max(0, depth - 1);
  }
  return out;
}

/** Higher is better; negative means the cut is not allowed. */
function cutQuality(nodes: SceneNode[], j: number, depth: number): number {
  const prev = nodes[j - 1];
  const next = nodes[j];
  if (!next) return 4; // end of chapter

  // Never break up a run of branch options, and never strand one from its siblings.
  if (prev.kind === "select" && next.kind === "select") return -1;
  // Splitting inside a conditional would drop the condition from the second chunk.
  if (depth > 0) return -1;

  if (next.kind === "label") return 3;
  if (prev.kind === "cond-end" || prev.kind === "jump") return 2;
  if (next.kind === "text" && prev.kind === "text") {
    const a = prev.speaker?.jp ?? "";
    const b = next.speaker?.jp ?? "";
    return a !== b ? 1 : 0;
  }
  return 0;
}
