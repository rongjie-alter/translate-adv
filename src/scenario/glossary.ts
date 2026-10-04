/**
 * The glossary sent in the system prompt: which official names and terms the model
 * is told about for one chapter.
 *
 * It is *text-driven*, not speaker-driven. A name is sent if it speaks in the chapter
 * **or** appears in the chapter's Japanese — so a character who is only mentioned
 * still gets their official name, and so do the special terms a user types into the
 * Dictionary. Everything else is left out, because every line costs input tokens on
 * every chunk and a model translates most generic words acceptably unaided.
 *
 * Pure: no storage, no UI. `parse.py` mirrors {@link isValuableTerm} so `#term-meta`
 * is already filtered when it is written; keep the two in step.
 */
import { chapterSpeakers } from "./parseHtml";
import { speakerName } from "./serialize";
import {
  isTranslatable,
  type Book,
  type Chapter,
  type GlossaryEntry,
  type Lang,
  type SceneNode,
  type Speaker,
  type TermTable,
} from "./model";

/** Upper bound on lines per chapter, so a name-heavy scene cannot bloat every request. */
export const GLOSSARY_LIMIT = 40;

/**
 * Whether a game-table key is worth a prompt line. Shape-based and deterministic:
 * drops what the model gets right unaided (`少年`, `社員`, `エンジェルたち`) and what
 * is not a name at all (`？？？？`, `（観客）`). User-typed entries bypass this.
 */
export function isValuableTerm(key: string): boolean {
  const k = key.trim();
  if ([...k].length < 2) return false;
  if (/^[？?■―ー・\s]*$/.test(k)) return false; // symbol-only placeholders
  if (/^[（(].*[）)]$/.test(k)) return false; // （観客） stage-direction labels
  if (/[？?]$/.test(k)) return false; // 体育会系大学生？ — unknown-speaker labels
  if (/(たち|達|一同|全員|同時|そろって)$/.test(k)) return false; // collectives
  if (/[0-9０-９一二三四五六七八九十]人/.test(k)) return false; // ３人, 二人, 生徒３人
  if (/^[一-鿿]{1,3}$/.test(k)) return false; // short generic kanji nouns
  return true;
}

const KATAKANA_KEY = /^[ァ-ヶー・]+$/;
const KATAKANA_NEIGHBOUR = /[ァ-ヶー]/;

/** Compact ruby `漢字(よみ)` -> `漢字`, so a name written with readings still matches. */
function stripReadings(s: string): string {
  return s.replace(/\([^()\n]*\)/g, "");
}

/** Source text of every translatable line, one per row. */
function sourceLines(nodes: SceneNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) if (isTranslatable(n)) out.push(n.src);
  return out;
}

/**
 * Occurrences per key, longest key first, each stretch of text claimed once — so
 * `カイブツ幼体` does not also count as `カイブツ`, and a katakana key is never matched
 * inside a longer katakana word (`アカシ` in `アカシア`). Kanji keys get no boundary
 * check: Japanese has no spaces to check against.
 */
export function countMentions(keys: Iterable<string>, lines: string[]): Map<string, number> {
  const ordered = [...new Set(keys)].filter(Boolean).sort((a, b) => b.length - a.length);
  const counts = new Map<string, number>();
  if (!ordered.length) return counts;

  const stripped = lines.map(stripReadings);
  // [haystack, claimed]; a line is searched with readings stripped first, raw as fallback.
  const claimed = [stripped.map((l) => new Uint8Array(l.length)), lines.map((l) => new Uint8Array(l.length))];
  const hay = [stripped, lines];

  for (const key of ordered) {
    const boundary = KATAKANA_KEY.test(key);
    let n = 0;
    // Raw text is only a fallback for keys the stripped pass never found, so that a
    // line is not counted twice.
    for (let pass = 0; pass < 2 && n === 0; pass++) {
      hay[pass].forEach((line, li) => {
        const used = claimed[pass][li];
        for (let at = line.indexOf(key); at !== -1; at = line.indexOf(key, at + 1)) {
          const end = at + key.length;
          if (used[at] || used[end - 1]) continue;
          if (boundary && (KATAKANA_NEIGHBOUR.test(line[at - 1] ?? "") || KATAKANA_NEIGHBOUR.test(line[end] ?? ""))) {
            continue;
          }
          used.fill(1, at, end);
          n++;
        }
      });
    }
    if (n) counts.set(key, n);
  }
  return counts;
}

function displayOf(s: Speaker): string {
  return (s.nameText ?? s.jp).trim();
}

export interface GlossaryInput {
  /** The chapter's nodes (or an artifact's, rebuilt) — the text mentions are found in. */
  nodes: SceneNode[];
  lang: Lang;
  /** Speakers of this chapter: always sent when they have a translation. */
  speakers: Speaker[];
  /** Speakers anywhere in the book — a character who speaks in chapter 1 and is mentioned in 4. */
  bookSpeakers?: Speaker[];
  /** Official terms from `#term-meta`. */
  terms?: TermTable;
  /** Terms a previous run recorded in the artifact (lang-resolved); trusted, so unfiltered. */
  carried?: Record<string, string>;
  /** The user's entries — Dictionary merged with the file's — unfiltered and never dropped for being short. */
  custom?: Record<string, string>;
  /** Keys the user switched off for this file. */
  excluded?: Iterable<string>;
  limit?: number;
}

/**
 * Which term wins when several sources name the same Japanese key:
 * a speaker's own official name, then the user's entry, then the game tables.
 */
export function buildGlossary(input: GlossaryInput): GlossaryEntry[] {
  const { lang, custom = {}, carried = {} } = input;
  const excluded = new Set(input.excluded ?? []);

  const chapterSpeakers = new Map<string, number>(); // display -> speaker lines
  for (const n of input.nodes) {
    if (n.kind !== "text" || !n.speaker) continue;
    const d = displayOf(n.speaker);
    chapterSpeakers.set(d, (chapterSpeakers.get(d) ?? 0) + 1);
  }

  const official = new Map<string, string>(); // key -> tl, from the game's own data
  const speakerOfficial = new Set<string>();
  for (const s of [...(input.bookSpeakers ?? []), ...input.speakers]) {
    const d = displayOf(s);
    const tl = s.tl?.[lang]?.trim();
    if (!d || !tl || !isValuableTerm(d)) continue;
    official.set(d, tl);
    speakerOfficial.add(d);
  }
  for (const [jp, per] of Object.entries(input.terms ?? {})) {
    const tl = per[lang]?.trim();
    if (tl && isValuableTerm(jp) && !official.has(jp)) official.set(jp, tl);
  }
  for (const [jp, tl] of Object.entries(carried)) {
    if (tl.trim() && !official.has(jp)) official.set(jp, tl.trim());
  }

  const resolved = new Map<string, { tl: string; source: GlossaryEntry["source"] }>();
  for (const [jp, tl] of official) resolved.set(jp, { tl, source: "official" });
  for (const [jp, raw] of Object.entries(custom)) {
    const tl = raw.trim();
    const key = jp.trim();
    if (!key || !tl) continue;
    // A speaker's parser-supplied name outranks the user's, as it always has.
    if (speakerOfficial.has(key)) continue;
    resolved.set(key, { tl, source: "custom" });
  }

  const mentions = countMentions(resolved.keys(), sourceLines(input.nodes));

  const out: GlossaryEntry[] = [];
  for (const [jp, { tl, source }] of resolved) {
    if (excluded.has(jp) || tl === jp) continue;
    const spoken = chapterSpeakers.get(jp) ?? 0;
    const count = spoken + (mentions.get(jp) ?? 0);
    if (!count) continue; // neither speaks nor is mentioned here
    out.push({ jp, tl, source: spoken ? "speaker" : source, count });
  }

  // Speakers first (the `Name:` label is on the wire), then by how often the chapter says it.
  out.sort((a, b) => Number(b.source === "speaker") - Number(a.source === "speaker") || b.count - a.count);
  return out.slice(0, input.limit ?? GLOSSARY_LIMIT);
}

/**
 * The same, from just a speaker list and the user's names: for callers with no chapter
 * text to scan. Every speaker with a name is included.
 */
export function speakerGlossary(
  speakers: Speaker[],
  lang: Lang,
  custom: Record<string, string> = {},
): GlossaryEntry[] {
  const seen = new Set<string>();
  const out: GlossaryEntry[] = [];
  for (const s of speakers) {
    const jp = displayOf(s);
    if (!jp || seen.has(jp) || /^[？?]+$/.test(jp)) continue;
    seen.add(jp);
    const tl = s.tl?.[lang] ? speakerName(s, lang) : custom[jp]?.trim();
    if (tl) out.push({ jp, tl, source: s.tl?.[lang] ? "speaker" : "custom", count: 1 });
  }
  return out;
}

/** Distinct speakers across every chapter, preferring an occurrence that carries official names. */
export function bookSpeakers(book: Book): Speaker[] {
  const seen = new Map<string, Speaker>();
  for (const ch of book.chapters) {
    for (const n of ch.nodes) {
      if (n.kind !== "text" || !n.speaker) continue;
      const prev = seen.get(n.speaker.jp);
      if (!prev || (!prev.tl && n.speaker.tl)) seen.set(n.speaker.jp, n.speaker);
    }
  }
  return [...seen.values()];
}

/** What the user has told us beyond the game's own data, for one target language. */
export interface UserTerms {
  /** Global Dictionary for the language. */
  dictionary?: Record<string, string>;
  /** The file's own names; override the Dictionary. */
  customNames?: Record<string, string>;
  /** Keys switched off for this file. */
  excluded?: Iterable<string>;
}

/** The glossary for one chapter of a loaded book. */
export function chapterGlossary(
  book: Book,
  chapter: Chapter,
  lang: Lang,
  user: UserTerms = {},
): GlossaryEntry[] {
  return buildGlossary({
    nodes: chapter.nodes,
    lang,
    speakers: chapterSpeakers(chapter),
    bookSpeakers: bookSpeakers(book),
    terms: book.terms,
    custom: { ...user.dictionary, ...user.customNames },
    excluded: user.excluded,
  });
}
