/**
 * Structured model of a `.book.html` produced by `parse.py`.
 *
 * The HTML is scraped rather than re-derived from `.book.json`, so this model is
 * deliberately close to what the HTML actually carries. Anything `parse.py` drops
 * (Wait, Se, Tween, sprite changes...) never reaches us in the first place.
 */

/** Target languages the app can translate into. Source is always Japanese. */
export type Lang = "en" | "zh-hans" | "zh-hant";

export const LANGS: Lang[] = ["en", "zh-hans", "zh-hant"];

export const LANG_LABEL: Record<Lang, string> = {
  en: "English",
  "zh-hans": "简体中文",
  "zh-hant": "繁體中文",
};

/** Speaker of a dialogue line, from `span.chara`. */
export interface Speaker {
  /** Raw Japanese label as it appears in the HTML, e.g. `火のテンジン`. */
  jp: string;
  /** Expression/pose in parentheses, e.g. `通常`, or `hide sprite`. */
  pose?: string;
  /** Official name per language, present only when `parse.py --tl_meta` wrote it. */
  tl?: Partial<Record<Lang, string>>;
  /** Base name (Character.xls `NameText`), when it differs from the costume-specific
   *  `jp` label; present only when `parse.py --tl_meta` resolved one. */
  nameText?: string;
}

export type SceneNode =
  | LabelNode
  | TextNode
  | SelectNode
  | JumpNode
  | TitleNode
  | CondNode
  | CondEndNode;

/** Branch anchor — `div.label[id]`. Scopes the unit ids that follow it. */
export interface LabelNode {
  kind: "label";
  id: string;
}

/** A narration or dialogue line — `div.text` with a non-empty body. */
export interface TextNode {
  kind: "text";
  uid: string;
  speaker?: Speaker;
  /** Compact source text (see `inline.ts`). */
  src: string;
  hash: string;
  /** Pixel sizes of `<size=N>` runs, in order, so they can be rendered back. */
  sizes?: number[];
}

/** A branch option — `div.select > a`. */
export interface SelectNode {
  kind: "select";
  uid: string;
  src: string;
  hash: string;
  /** Label id this option jumps to. */
  to: string;
  /** `Arg2` condition, when `parse.py --tl_meta` split it out of the anchor text. */
  cond?: string;
  /** `Arg3` effect, likewise. */
  exec?: string;
  sizes?: number[];
}

/** An unconditional or random jump — `div.jump`. Not translated. */
export interface JumpNode {
  kind: "jump";
  to: string;
  random?: boolean;
  note?: string;
}

/** Episode title card — `div.title`. */
export interface TitleNode {
  kind: "title";
  uid: string;
  src: string;
  hash: string;
}

/** Opening of a `div.cond-block`; nodes until the matching `cond-end` are inside it. */
export interface CondNode {
  kind: "cond";
  expr: string;
}

export interface CondEndNode {
  kind: "cond-end";
}

export interface Chapter {
  /** `h3[id]`, e.g. `tourou2026_1-1`. Unique within a book. */
  name: string;
  nodes: SceneNode[];
  /** Number of translatable units. */
  units: number;
  /** Total characters of translatable source text. */
  chars: number;
}

export interface Book {
  /** Original file name, e.g. `touroumatsuri2026.book.html`. Part of the artifact identity. */
  file: string;
  /** Hash of the file contents, used to warn when translations came from another version. */
  srcHash: string;
  chapters: Chapter[];
  /** True when the HTML carried `parse.py --tl_meta` attributes. */
  hasMeta: boolean;
  /** True when the HTML carried the consolidated `data-chara-id` + `#chara-meta` JSON dict. */
  hasCharaMeta: boolean;
}

/** Node kinds that carry text needing translation. */
export type TranslatableNode = TextNode | SelectNode | TitleNode;

export function isTranslatable(n: SceneNode): n is TranslatableNode {
  return n.kind === "text" || n.kind === "select" || n.kind === "title";
}

/** FNV-1a, 8 hex chars. Synchronous and stable across runs — enough to detect drift. */
export function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Hash of a whole file, for the `srcHash` identity field. */
export function hashFile(s: string): string {
  return `${hash8(s)}${hash8(s.slice(s.length >> 1))}`;
}
