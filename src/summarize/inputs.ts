/**
 * Adapters: everything the summarizer can read, flattened to {@link SummaryDoc}.
 *
 * Both sides of a translation are offered. A Library artifact and a bilingual file each
 * carry the Japanese and the translation, and "summarize in the same language" means
 * the reader picks which one.
 */
import type { SourceRecord } from "../storage/db";
import type { Artifact } from "../storage/exchange";
import { normalizeBookBase } from "../storage/groups";
import { LANG_LABEL, isTranslatable, type Book, type Chapter, type Lang } from "../scenario/model";
import { speakerName } from "../scenario/serialize";
import type { BilingualDoc } from "./bilingualHtml";
import { unitLine, type SummaryChapter, type SummaryDoc } from "./doc";

export function bookDocId(file: string): string {
  return `book:${file}`;
}

export function translationDocId(file: string, lang: Lang): string {
  return `tl:${file}::${lang}`;
}

/** A free-text input. Never persisted — there is no book for it to belong to. */
export const TEXT_DOC_ID = "text";

export function textDoc(text: string, title = "Pasted text"): SummaryDoc {
  return {
    id: TEXT_DOC_ID,
    title,
    origin: "text",
    chapters: [{ id: TEXT_DOC_ID, title, text: text.trim() }],
  };
}

/**
 * The source side always names a speaker by `Speaker.jp`, never the base `nameText`: a
 * bilingual file carries only the former, and all three routes to the same document must
 * produce the same text, or a synopsis would read as stale depending on how it was loaded.
 */
export function chapterFromBook(chapter: Chapter): SummaryChapter {
  const lines: string[] = [];
  for (const n of chapter.nodes) {
    if (!isTranslatable(n)) continue;
    const speaker = n.kind === "text" && n.speaker ? n.speaker.jp : undefined;
    const line = unitLine(n.kind, speaker, n.src);
    if (line) lines.push(line);
  }
  return { id: chapter.name, title: chapter.name, text: lines.join("\n") };
}

export function docFromBook(file: string, book: Book): SummaryDoc {
  return {
    id: bookDocId(file),
    title: file,
    origin: "book",
    chapters: book.chapters.map(chapterFromBook).filter((c) => c.text),
  };
}

/** One side of an artifact. `tl` is the translation, `jp` the Japanese it came from. */
function chapterFromArtifact(a: Artifact, side: "tl" | "jp"): SummaryChapter {
  const lines: string[] = [];
  for (const u of a.units) {
    const text = side === "tl" ? u.tl : u.src;
    const speaker = u.speaker
      ? side === "tl"
        ? speakerName(u.speaker, a.lang)
        : u.speaker.jp
      : undefined;
    const line = unitLine(u.kind, speaker, text);
    if (line) lines.push(line);
  }
  return { id: a.chapter, title: a.chapter, text: lines.join("\n") };
}

/** Natural order, so `1-2` sorts before `1-10`. */
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/**
 * Library translations, one doc per book and language per side.
 *
 * `chapterOrder` follows the loaded `.book.html` when there is one, as the combined file
 * does; otherwise chapters fall back to natural name order.
 */
export function docsFromArtifacts(
  artifacts: Artifact[],
  chapterOrder: (book: string) => string[] | undefined = () => undefined,
): SummaryDoc[] {
  const groups = new Map<string, Artifact[]>();
  for (const a of artifacts) {
    const key = `${normalizeBookBase(a.book)}::${a.lang}`;
    const list = groups.get(key);
    if (list) list.push(a);
    else groups.set(key, [a]);
  }

  const docs: SummaryDoc[] = [];
  for (const list of groups.values()) {
    const { book, lang } = list[0];
    const order = chapterOrder(book);
    const sorted = [...list].sort((x, y) => {
      const xi = order?.indexOf(x.chapter) ?? -1;
      const yi = order?.indexOf(y.chapter) ?? -1;
      if (xi >= 0 && yi >= 0) return xi - yi;
      if (xi >= 0) return -1;
      if (yi >= 0) return 1;
      return byName(x.chapter, y.chapter);
    });
    const base = normalizeBookBase(book);
    const tl = sorted.map((a) => chapterFromArtifact(a, "tl")).filter((c) => c.text);
    const jp = sorted.map((a) => chapterFromArtifact(a, "jp")).filter((c) => c.text);
    if (tl.length) {
      docs.push({
        id: translationDocId(book, lang),
        title: `${base} — ${LANG_LABEL[lang]} translation`,
        origin: "library",
        language: lang,
        chapters: tl,
      });
    }
    if (jp.length) {
      docs.push({
        id: bookDocId(book),
        title: `${base} — Japanese source of the ${LANG_LABEL[lang]} translation`,
        origin: "library",
        language: "ja",
        chapters: jp,
      });
    }
  }
  return docs;
}

export function docsFromBilingual(b: BilingualDoc): SummaryDoc[] {
  const tl = b.chapters.filter((c) => c.tl).map((c) => ({ id: c.id, title: c.title, text: c.tl }));
  const jp = b.chapters.filter((c) => c.jp).map((c) => ({ id: c.id, title: c.title, text: c.jp }));
  const docs: SummaryDoc[] = [];
  if (tl.length) {
    docs.push({
      // Without a language in the name there is no stable translation id; keep the
      // file name in it so two unnamed files do not share synopses.
      id: b.lang ? translationDocId(b.book, b.lang) : `tl:${b.file}`,
      title: `${b.file} — ${b.lang ? `${LANG_LABEL[b.lang]} translation` : "translation side"}`,
      origin: "bilingual",
      ...(b.lang ? { language: b.lang } : {}),
      chapters: tl,
    });
  }
  if (jp.length) {
    docs.push({
      id: bookDocId(b.book),
      title: `${b.file} — Japanese side`,
      origin: "bilingual",
      language: "ja",
      chapters: jp,
    });
  }
  return docs;
}

/**
 * Everything on offer. Order is the order of preference when two routes lead to the
 * same document: a loaded `.book.html` beats the Japanese side of a translation, and
 * the Library beats a dropped file, because the Library may have been edited since.
 */
export function collectDocs(args: {
  sources: SourceRecord[];
  books: Map<string, Book>;
  artifacts: Artifact[];
  bilingual: BilingualDoc[];
}): SummaryDoc[] {
  const docs: SummaryDoc[] = [];
  for (const s of args.sources) {
    const book = args.books.get(s.id);
    if (book) docs.push(docFromBook(s.file, book));
  }

  const chapterOrder = (file: string) => {
    const base = normalizeBookBase(file);
    for (const s of args.sources) {
      if (normalizeBookBase(s.file) === base) return args.books.get(s.id)?.chapters.map((c) => c.name);
    }
    return undefined;
  };
  docs.push(...docsFromArtifacts(args.artifacts, chapterOrder));
  for (const b of args.bilingual) docs.push(...docsFromBilingual(b));

  // One entry per id. Preference order wins a tie, but a later route that covers more
  // chapters replaces an earlier one: a dropped file must not vanish behind a Library
  // doc that holds only a few of its chapters.
  const byId = new Map<string, SummaryDoc>();
  for (const d of docs) {
    const kept = byId.get(d.id);
    if (!kept || d.chapters.length > kept.chapters.length) byId.set(d.id, d);
  }
  return [...byId.values()];
}
