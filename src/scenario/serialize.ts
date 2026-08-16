/**
 * The wire format between the app and the LLM.
 *
 * Structure (labels, jumps, conditions) is sent as context so the model can tell a
 * branch option from narration, but the model is asked to echo back only
 * `<id> <text>` — no speaker names, no structure. That roughly halves output tokens
 * on a dialogue-heavy chapter, and output tokens are the scarcer resource on the
 * free tiers this app targets.
 */
import type { LabelMap } from "./labels";
import {
  isTranslatable,
  type CondEndNode,
  type CondNode,
  type JumpNode,
  type LabelNode,
  type Lang,
  type SceneNode,
  type Speaker,
  type TranslatableNode,
} from "./model";

export interface WireLine {
  n: number;
  uid: string;
  /** Source text, kept so a repair pass can re-ask for just these lines. */
  src: string;
  hadSpeaker: boolean;
}

export interface WireChunk {
  text: string;
  lines: WireLine[];
}

export interface SerializeOptions {
  labels: LabelMap;
  lang: Lang;
  /** Already-translated tail of the previous chunk, for continuity. */
  context?: string[];
}

/** Speaker name to show the model: the official translation when known, else the JP. */
export function speakerName(s: Speaker, lang: Lang): string {
  return s.tl?.[lang] || s.jp;
}

/** Speaker name for the wire line: always Japanese (this is source text), using the
 *  clean base name when parse.py resolved one, else the raw costume-suffixed label. */
function sourceSpeakerName(s: Speaker): string {
  return s.nameText ?? s.jp;
}

/** Structure sent as context; never numbered, never echoed back. */
export type StructureNode = LabelNode | JumpNode | CondNode | CondEndNode;

/** The unnumbered form of a structural node. Shared by both serializers. */
function renderStructure(node: StructureNode, labels: LabelMap): string {
  switch (node.kind) {
    case "label":
      return `== ${labels.alias(node.id)} ==`;
    case "jump":
      return `=> ${labels.alias(node.to)}${node.random ? " (50%)" : ""}`;
    case "cond":
      return `? ${node.expr}`;
    case "cond-end":
      return "?end";
  }
}

/** What sits between a line's number and its text. Shared by both serializers. */
function renderPrefix(node: TranslatableNode, labels: LabelMap): string {
  if (node.kind === "select") return `>${labels.alias(node.to)} `;
  if (node.kind === "title") return "# ";
  if (node.speaker) return `${sourceSpeakerName(node.speaker)}: `;
  return "";
}

function toWireLine(node: TranslatableNode, n: number): WireLine {
  return { n, uid: node.uid, src: node.src, hadSpeaker: node.kind === "text" && !!node.speaker };
}

export function serializeChunk(nodes: SceneNode[], opts: SerializeOptions): WireChunk {
  const lines: WireLine[] = [];
  const out: string[] = [];

  for (const c of opts.context ?? []) out.push(`~ ${c}`);

  for (const node of nodes) {
    if (isTranslatable(node)) {
      const n = lines.length + 1;
      out.push(`${n} ${renderPrefix(node, opts.labels)}${node.src}`);
      lines.push(toWireLine(node, n));
    } else {
      out.push(renderStructure(node, opts.labels));
    }
  }

  return { text: out.join("\n"), lines };
}

/** Re-ask for a subset of lines, renumbered to their original ids. */
export function serializeRepair(lines: WireLine[]): string {
  return lines.map((l) => `${l.n} ${l.src}`).join("\n");
}

/**
 * One item of a targeted retranslation body.
 *
 * The planner decides which units are targets and which are only there so the
 * model can see what surrounds them; this file only renders that decision.
 */
export type SelectionItem =
  | { role: "structure"; node: StructureNode }
  /** An already-translated line (or the Japanese, when it has no translation yet). */
  | { role: "context"; text: string; prefix?: string }
  /** A line that must come back translated. */
  | { role: "target"; node: TranslatableNode };

/** A contiguous stretch of the chapter: targets plus the context wrapped around them. */
export interface SelectionGroup {
  items: SelectionItem[];
}

export interface SerializeSelectionOptions {
  labels: LabelMap;
  lang: Lang;
  /** Text after `~` marking a jump to a different part of the scene. */
  gap?: string;
}

/** Default gap marker. `~` already means "not content" to the model and the mock. */
export const SELECTION_GAP = "[...]";

/**
 * Render several non-contiguous groups as one request body.
 *
 * Numbering is global and ascending across every group, so a single
 * `parseResponse` maps the whole reply back — and a `serializeRepair` round over
 * the misses works unchanged. Context rides on `~`, which the prompt already
 * documents as "not content", so this adds no token to the wire format.
 */
export function serializeSelection(
  groups: SelectionGroup[],
  opts: SerializeSelectionOptions,
): WireChunk {
  const lines: WireLine[] = [];
  const out: string[] = [];

  groups.forEach((group, gi) => {
    if (gi > 0) out.push(`~ ${opts.gap ?? SELECTION_GAP}`);
    for (const item of group.items) {
      switch (item.role) {
        case "structure":
          out.push(renderStructure(item.node, opts.labels));
          break;
        case "context":
          out.push(`~ ${item.prefix ?? ""}${item.text}`);
          break;
        case "target": {
          const n = lines.length + 1;
          out.push(`${n} ${renderPrefix(item.node, opts.labels)}${item.node.src}`);
          lines.push(toWireLine(item.node, n));
          break;
        }
      }
    }
  });

  return { text: out.join("\n"), lines };
}

export interface ParseResult {
  /** uid -> translated text. */
  translations: Map<string, string>;
  /** Lines the model did not answer. */
  missing: WireLine[];
  /** Ids the model invented; kept for diagnostics only. */
  extra: number[];
}

const ID_LINE = /^(\d+)[ \t.:)]\s*(.*)$/;
const FENCE = /^\s*```.*$/;
const STRUCTURE = /^\s*(==|=>|\?|~)/;
const ECHOED_SPEAKER = /^([^:：]{1,24})[:：]\s+(.+)$/;
/**
 * Reasoning models (e.g. Gemma) sometimes emit a thinking block with no newline
 * before the first numbered line, so it would otherwise swallow line 1 whole.
 */
const THOUGHT_BLOCK = /<(?:thought|think|reasoning)>[\s\S]*?<\/(?:thought|think|reasoning)>/gi;

export function parseResponse(raw: string, lines: WireLine[]): ParseResult {
  const byN = new Map(lines.map((l) => [l.n, l]));
  const translations = new Map<string, string>();
  const extra: number[] = [];
  let last: { n: number; uid: string } | null = null;

  for (const rawLine of raw.replace(THOUGHT_BLOCK, "").split("\n")) {
    if (FENCE.test(rawLine)) continue;
    const m = ID_LINE.exec(rawLine.trim());
    if (m) {
      const n = Number(m[1]);
      const line = byN.get(n);
      if (!line) {
        extra.push(n);
        last = null;
        continue;
      }
      translations.set(line.uid, clean(m[2], line));
      last = { n, uid: line.uid };
      continue;
    }
    // A wrapped continuation of the previous answer — join it back on.
    const t = rawLine.trim();
    if (last && t && !STRUCTURE.test(rawLine)) {
      translations.set(last.uid, `${translations.get(last.uid)} ${t}`.trim());
    }
  }

  const missing = lines.filter((l) => !translations.has(l.uid) || !translations.get(l.uid));
  return { translations, missing, extra };
}

/**
 * Models sometimes echo the speaker name back despite the instruction. Strip it,
 * but only when the source line did not itself begin with a `name:` construct.
 */
function clean(text: string, line: WireLine): string {
  let t = text.trim();
  if (line.hadSpeaker && !ECHOED_SPEAKER.test(line.src)) {
    const m = ECHOED_SPEAKER.exec(t);
    if (m) t = m[2].trim();
  }
  return t;
}

/** Nodes that will produce a wire line — used by the chunker and the estimator. */
export function countUnits(nodes: SceneNode[]): number {
  return nodes.filter(isTranslatable).length;
}
