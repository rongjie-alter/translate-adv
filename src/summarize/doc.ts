/**
 * What the summarizer reads: chapters of plain text, whatever they came from.
 *
 * Every input — a scanned `.book.html`, a Library translation, a dropped
 * `.bilingual.html`, pasted text — is flattened to this shape by `inputs.ts`, so the
 * core never learns where its text came from.
 */
import { stripCompact } from "../scenario/inline";
import { hash8 } from "../scenario/model";
import type { SummaryLang } from "./prompt";

export interface SummaryChapter {
  /** Stable within its document: the `h3` id, or the artifact's chapter name. */
  id: string;
  title: string;
  /** Lines as `Name: text`, one per line. See {@link unitLine}. */
  text: string;
}

export type DocOrigin = "book" | "library" | "bilingual" | "text";

export interface SummaryDoc {
  /**
   * Where stored synopses live. `book:<file>` is the text of a `.book.html` (or the
   * Japanese side of a translation of it); `tl:<file>::<lang>` is a translation's
   * side. Using the same id from every route means a synopsis made from a dropped
   * `.bilingual.html` is found again from the Library, and vice versa.
   */
  id: string;
  title: string;
  origin: DocOrigin;
  /** Known language; absent means "detect it from the text". */
  language?: SummaryLang;
  chapters: SummaryChapter[];
}

export type LineKind = "text" | "select" | "title";

/**
 * One unit as the model reads it. Structure (labels, jumps, conditions) is dropped
 * because a synopsis does not need it; choices keep a `▶` so the model can tell an
 * option from narration, and the prompt documents the three prefixes.
 */
export function unitLine(kind: LineKind, speaker: string | undefined, text: string): string {
  const body = stripCompact(text).trim();
  if (!body) return "";
  if (kind === "title") return `# ${body}`;
  if (kind === "select") return `▶ ${body}`;
  return speaker ? `${speaker}: ${body}` : body;
}

/** Fingerprint of a chapter's text, to notice that a stored synopsis is out of date. */
export function textHash(text: string): string {
  return hash8(text);
}

export function summaryKey(docId: string, chapterId: string): string {
  return `${docId}::${chapterId}`;
}
