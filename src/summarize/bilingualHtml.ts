/**
 * Reads a `.bilingual.html` back into text, one side at a time.
 *
 * `bilingual.ts` writes every unit as `div.text|select|title > div.tl + div.jp`, so both
 * sides of the book are in the file and either can be summarized. Chapters are `h3`,
 * and `div.cond-block` nests, so like `parseHtml.ts` this walks the tree.
 */
import { toCompact } from "../scenario/inline";
import { CHARA_TEXT } from "../scenario/parseHtml";
import { LANGS, LANG_LABEL, type Lang } from "../scenario/model";
import { unitLine, type LineKind } from "./doc";

export interface BilingualChapter {
  id: string;
  title: string;
  /** The translation side, flattened by {@link unitLine}. */
  tl: string;
  /** The Japanese side. */
  jp: string;
}

export interface BilingualDoc {
  file: string;
  /** The `.book.html` this was made from, reconstructed from the file name. */
  book: string;
  /** Language of the translation side, when the name or title says. */
  lang?: Lang;
  chapters: BilingualChapter[];
}

/** Whether a dropped `.html` is a bilingual file rather than a `.book.html`. */
export function isBilingualHtml(name: string, html: string): boolean {
  if (/\.bilingual\.html$/i.test(name)) return true;
  // Renamed files: the two sides are the giveaway, and `parse.py` never writes them.
  return html.includes('<div class="tl">') && html.includes('<div class="jp">');
}

/** ` (If x==TRUE)` / ` (Execute x=TRUE)` that `bilingual.ts` appends to a conditional option. */
const COND_SUFFIX = /(\s*\((?:If|Execute)\s[^)]*\))+\s*$/;

export function parseBilingualHtml(file: string, html: string): BilingualDoc {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const { book, lang: nameLang } = fromFileName(file);
  const lang = nameLang ?? fromTitle(doc.title);
  const chapters: BilingualChapter[] = [];
  let tl: string[] = [];
  let jp: string[] = [];

  const close = () => {
    const last = chapters[chapters.length - 1];
    if (last) {
      last.tl = tl.join("\n");
      last.jp = jp.join("\n");
    }
    tl = [];
    jp = [];
  };

  const walk = (parent: Element) => {
    for (const el of Array.from(parent.children)) {
      if (el.tagName.toLowerCase() === "h3") {
        close();
        const title = (el.textContent ?? "").trim();
        chapters.push({ id: el.id || title || `chapter${chapters.length}`, title: title || el.id, tl: "", jp: "" });
        continue;
      }
      if (!chapters.length) continue; // control fieldset, TOC and style before the first chapter
      if (el.className === "cond-block") {
        walk(el);
        continue;
      }
      const kind: LineKind | null =
        el.className === "text" ? "text" : el.className === "select" ? "select" : el.className === "title" ? "title" : null;
      if (!kind) continue;
      const a = side(el.querySelector(":scope > .tl"), kind);
      const b = side(el.querySelector(":scope > .jp"), kind);
      if (a) tl.push(a);
      if (b) jp.push(b);
    }
  };

  walk(doc.body);
  close();
  return { file, book, ...(lang ? { lang } : {}), chapters };
}

function side(el: Element | null, kind: LineKind): string {
  if (!el) return "";
  const chara = el.querySelector(":scope > .chara");
  let speaker: string | undefined;
  if (chara) {
    const raw = (chara.textContent ?? "").trim();
    // The pose rides in the label as `Name (pose):`; it is not part of the name.
    speaker = CHARA_TEXT.exec(raw)?.[1]?.trim() || raw.replace(/[:：]\s*$/, "");
  }
  let { text } = toCompact(el, (c) => {
    const k = c.classList;
    return k.contains("chara") || k.contains("to") || k.contains("gap");
  });
  // `bilingual.ts` appends the suffix for any unit with a condition, not just options.
  text = text.replace(COND_SUFFIX, "");
  return unitLine(kind, speaker, text);
}

function fromFileName(file: string): { book: string; lang?: Lang } {
  const m = /^(.*)\.([a-z0-9-]+)\.bilingual\.html$/i.exec(file);
  const lang = LANGS.find((l) => l === m?.[2].toLowerCase());
  const base = (m && lang ? m[1] : file.replace(/\.bilingual\.html$|\.html$/i, "")).replace(/\.book$/i, "");
  return { book: `${base}.book.html`, ...(lang ? { lang } : {}) };
}

function fromTitle(title: string): Lang | undefined {
  return LANGS.find((l) => title.includes(LANG_LABEL[l]));
}
