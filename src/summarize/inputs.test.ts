import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { combineBilingual } from "../combine/bilingual";
import type { Book, Chapter, SceneNode } from "../scenario/model";
import { parseBookHtml } from "../scenario/parseHtml";
import type { SourceRecord } from "../storage/db";
import { buildArtifact, type Artifact } from "../storage/exchange";
import { isBilingualHtml, parseBilingualHtml } from "./bilingualHtml";
import { chapterFromBook, collectDocs, docFromBook, docsFromArtifacts, docsFromBilingual, textDoc } from "./inputs";

const nodes: SceneNode[] = [
  { kind: "label", id: "start" },
  { kind: "title", uid: "start/1", src: "第一話", hash: "1" },
  {
    kind: "text",
    uid: "start/2",
    src: "平(たいら)の*祭り*だ。",
    hash: "2",
    speaker: { jp: "火のテンジン", pose: "通常", nameText: "テンジン", tl: { en: "Tenjin" } },
  },
  { kind: "text", uid: "start/3", src: "風が吹いた。", hash: "3" },
  { kind: "cond", expr: "flag==TRUE" },
  { kind: "text", uid: "start/4", src: "条件付きの台詞。", hash: "4", speaker: { jp: "タサブロウ", tl: { en: "Tasaburo" } } },
  { kind: "cond-end" },
  { kind: "select", uid: "start/5", src: "行く", hash: "5", to: "next", cond: "flag==TRUE", exec: "x=TRUE" },
  { kind: "select", uid: "start/6", src: "残る", hash: "6", to: "next" },
  { kind: "text", uid: "start/7", src: "訳されていない。", hash: "7" },
  { kind: "jump", to: "next" },
  { kind: "label", id: "next" },
];
const chapter: Chapter = { name: "ch1", nodes, units: 7, chars: 60 };
const second: Chapter = {
  name: "ch2",
  units: 1,
  chars: 5,
  nodes: [{ kind: "text", uid: "ch2/1", src: "二話目。", hash: "8" }],
};
const book: Book = { file: "demo.book.html", srcHash: "h", chapters: [chapter, second], hasMeta: true, hasCharaMeta: true };

const translations = new Map([
  ["start/1", "Episode One"],
  ["start/2", "Tairas *festival*."],
  ["start/3", "The wind blew."],
  ["start/4", "A conditional line."],
  ["start/5", "Go"],
  ["start/6", "Stay"],
]);
const artifact1: Artifact = buildArtifact({
  book: book.file,
  srcHash: "h",
  chapter,
  lang: "en",
  model: "m",
  translations,
  generatedAt: 1,
});
const artifact2: Artifact = buildArtifact({
  book: book.file,
  srcHash: "h",
  chapter: second,
  lang: "en",
  model: "m",
  translations: new Map([["ch2/1", "Episode two."]]),
  generatedAt: 1,
});

const TL_TEXT = [
  "# Episode One",
  "Tenjin: Tairas festival.",
  "The wind blew.",
  "Tasaburo: A conditional line.",
  "▶ Go",
  "▶ Stay",
].join("\n");

const JP_TEXT = [
  "# 第一話",
  "火のテンジン: 平の祭りだ。",
  "風が吹いた。",
  "タサブロウ: 条件付きの台詞。",
  "▶ 行く",
  "▶ 残る",
  "訳されていない。",
].join("\n");

describe("chapterFromBook", () => {
  it("flattens nodes to readable lines: no ruby, no markers, no structure", () => {
    expect(chapterFromBook(chapter).text).toBe(JP_TEXT);
  });

  it("reads the real fixture", () => {
    const html = readFileSync("book/touroumatsuri2026.book.html", "utf8");
    const doc = docFromBook("touroumatsuri2026.book.html", parseBookHtml("touroumatsuri2026.book.html", html));
    expect(doc.chapters.length).toBeGreaterThan(0);
    for (const c of doc.chapters) {
      expect(c.text.length).toBeGreaterThan(0);
      expect(c.text).not.toMatch(/<[a-z]/i);
    }
  });
});

describe("docFromBook with already-translated text", () => {
  // What `parse.py --lang en` writes: English dialogue, speaker still the Japanese sprite id.
  const english: Book = {
    file: "demo.book.en.html",
    srcHash: "h",
    hasMeta: true,
    hasCharaMeta: true,
    chapters: [
      {
        name: "ch1",
        units: 2,
        chars: 40,
        nodes: [
          {
            kind: "text",
            uid: "a/1",
            src: "The festival begins.",
            hash: "1",
            speaker: { jp: "火のテンジン", nameText: "テンジン", tl: { en: "Tenjin" } },
          },
          { kind: "text", uid: "a/2", src: "Who is there?", hash: "2", speaker: { jp: "タサブロウ" } },
        ],
      },
    ],
  };

  it("names speakers in the text's language, falling back to the Japanese name", () => {
    const text = docFromBook(english.file, english).chapters[0].text;
    expect(text).toBe("Tenjin: The festival begins.\nタサブロウ: Who is there?");
  });

  it("leaves a Japanese book on Speaker.jp", () => {
    expect(docFromBook(book.file, book).chapters[0].text).toBe(JP_TEXT);
  });
});

describe("docsFromArtifacts", () => {
  const docs = docsFromArtifacts([artifact2, artifact1]);

  it("offers the translation and the Japanese side, with their languages", () => {
    const tl = docs.find((d) => d.id === "tl:demo.book.html::en")!;
    const jp = docs.find((d) => d.id === "book:demo.book.html")!;
    expect(tl.language).toBe("en");
    expect(jp.language).toBe("ja");
    expect(tl.chapters[0].text).toBe(TL_TEXT);
    // The untranslated line is simply absent from the translation side.
    expect(tl.chapters[0].text).not.toContain("訳されて");
    expect(jp.chapters[0].text).toBe(JP_TEXT);
  });

  it("orders chapters naturally, or by the loaded book", () => {
    const natural = docsFromArtifacts([artifact2, artifact1]).find((d) => d.language === "en")!;
    expect(natural.chapters.map((c) => c.id)).toEqual(["ch1", "ch2"]);
    const byBook = docsFromArtifacts([artifact1, artifact2], () => ["ch2", "ch1"]).find((d) => d.language === "en")!;
    expect(byBook.chapters.map((c) => c.id)).toEqual(["ch2", "ch1"]);
  });
});

describe("parseBilingualHtml", () => {
  const html = combineBilingual({ book: book.file, lang: "en", artifacts: [artifact1, artifact2] });

  it("is recognised by name or by its two sides", () => {
    expect(isBilingualHtml("demo.en.bilingual.html", "")).toBe(true);
    expect(isBilingualHtml("renamed.html", html)).toBe(true);
    expect(isBilingualHtml("demo.book.html", readFileSync("book/touroumatsuri2026.book.html", "utf8"))).toBe(false);
  });

  it("reads both sides back to what the Library would have given", () => {
    const doc = parseBilingualHtml("demo.en.bilingual.html", html);
    expect(doc.book).toBe("demo.book.html");
    expect(doc.lang).toBe("en");
    expect(doc.chapters.map((c) => c.id)).toEqual(["ch1", "ch2"]);
    // The pose and the `(If …)` suffix are display detail, not text.
    expect(doc.chapters[0].tl).toBe(TL_TEXT);
    expect(doc.chapters[0].jp).toBe(JP_TEXT);
  });

  it("finds the language in the title when the file was renamed", () => {
    expect(parseBilingualHtml("renamed.html", html).lang).toBe("en");
  });

  it("shares document ids with the Library, so synopses are found from either route", () => {
    const fromFile = docsFromBilingual(parseBilingualHtml("demo.en.bilingual.html", html)).map((d) => d.id).sort();
    const fromLibrary = docsFromArtifacts([artifact1, artifact2]).map((d) => d.id).sort();
    expect(fromFile).toEqual(fromLibrary);
  });
});

describe("collectDocs", () => {
  it("prefers a loaded book, then the Library, then a dropped file for the same id", () => {
    const source = { id: "demo.book.html:h", file: "demo.book.html" } as SourceRecord;
    const bilingual = parseBilingualHtml(
      "demo.en.bilingual.html",
      combineBilingual({ book: book.file, lang: "en", artifacts: [artifact1] }),
    );
    const docs = collectDocs({
      sources: [source],
      books: new Map([[source.id, book]]),
      artifacts: [artifact1, artifact2],
      bilingual: [bilingual],
    });
    expect(docs.map((d) => d.id)).toEqual(["book:demo.book.html", "tl:demo.book.html::en"]);
    expect(docs[0].origin).toBe("book");
    expect(docs[1].origin).toBe("library");
  });

  it("lets a dropped file that covers more chapters replace a thinner Library doc", () => {
    const bilingual = parseBilingualHtml(
      "demo.en.bilingual.html",
      combineBilingual({ book: book.file, lang: "en", artifacts: [artifact1, artifact2] }),
    );
    const docs = collectDocs({ sources: [], books: new Map(), artifacts: [artifact1], bilingual: [bilingual] });
    const tl = docs.find((d) => d.id === "tl:demo.book.html::en");
    expect(tl?.origin).toBe("bilingual");
    expect(tl?.chapters.length).toBeGreaterThan(1);
  });
});

describe("textDoc", () => {
  it("is one chapter that is never stored under a book id", () => {
    const d = textDoc("  hello  ");
    expect(d.chapters).toEqual([{ id: "text", title: "Pasted text", text: "hello" }]);
  });
});
