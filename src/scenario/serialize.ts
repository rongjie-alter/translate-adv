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
import { isTranslatable, type Lang, type SceneNode, type Speaker } from "./model";

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

export function serializeChunk(nodes: SceneNode[], opts: SerializeOptions): WireChunk {
  const lines: WireLine[] = [];
  const out: string[] = [];

  for (const c of opts.context ?? []) out.push(`~ ${c}`);

  for (const node of nodes) {
    switch (node.kind) {
      case "label":
        out.push(`== ${opts.labels.alias(node.id)} ==`);
        break;
      case "jump":
        out.push(`=> ${opts.labels.alias(node.to)}${node.random ? " (50%)" : ""}`);
        break;
      case "cond":
        out.push(`? ${node.expr}`);
        break;
      case "cond-end":
        out.push("?end");
        break;
      case "text":
      case "select":
      case "title": {
        const n = lines.length + 1;
        const hadSpeaker = node.kind === "text" && !!node.speaker;
        let prefix = "";
        if (node.kind === "select") prefix = `>${opts.labels.alias(node.to)} `;
        else if (node.kind === "title") prefix = "# ";
        else if (node.speaker) prefix = `${speakerName(node.speaker, opts.lang)}: `;
        out.push(`${n} ${prefix}${node.src}`);
        lines.push({ n, uid: node.uid, src: node.src, hadSpeaker });
        break;
      }
    }
  }

  return { text: out.join("\n"), lines };
}

/** Re-ask for a subset of lines, renumbered to their original ids. */
export function serializeRepair(lines: WireLine[]): string {
  return lines.map((l) => `${l.n} ${l.src}`).join("\n");
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

export function parseResponse(raw: string, lines: WireLine[]): ParseResult {
  const byN = new Map(lines.map((l) => [l.n, l]));
  const translations = new Map<string, string>();
  const extra: number[] = [];
  let last: { n: number; uid: string } | null = null;

  for (const rawLine of raw.split("\n")) {
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
