import { describe, expect, it } from "vitest";
import { isTranslatable, type Book, type Chapter } from "../scenario/model";
import { buildArtifact, type Artifact } from "../storage/exchange";
import { combineBilingual, combinedFileName } from "./bilingual";

const chapter0: Chapter = {
  name: "tourou2026_0",
  nodes: [
    { kind: "label", id: "quest_evMain_touroumatsuri2026_0" },
    { kind: "text", uid: "tourou2026_0/1", src: "平(たいら)の御殿様", hash: "11111111", speaker: { jp: "タサブロウ" } },
    { kind: "text", uid: "tourou2026_0/2", src: "{playerName}は布団から出て、", hash: "22222222", speaker: { jp: "火のテンジン" } },
  ],
  units: 2,
  chars: 20,
};
const chapter1: Chapter = {
  name: "tourou2026_1-1",
  nodes: [
    { kind: "jump", to: "quest_evMain_touroumatsuri2026_1_1" },
    { kind: "text", uid: "tourou2026_1-1/1", src: "我が*許婚*が", hash: "33333333", speaker: { jp: "ハナコ" } },
  ],
  units: 1,
  chars: 10,
};
const book: Book = {
  file: "touroumatsuri2026.book.html",
  srcHash: "00000000",
  chapters: [chapter0, chapter1],
  hasMeta: true,
  hasCharaMeta: true,
};

function artifactFor(index: number, fill = true): Artifact {
  const chapter = book.chapters[index];
  const translations = new Map<string, string>();
  if (fill) {
    for (const n of chapter.nodes) if (isTranslatable(n)) translations.set(n.uid, `[EN] ${n.src}`);
  }
  return buildArtifact({
    book: book.file,
    srcHash: book.srcHash,
    chapter,
    lang: "en",
    model: "mock",
    translations,
    generatedAt: 1_700_000_000_000,
  });
}

const html = combineBilingual({
  book: book.file,
  lang: "en",
  artifacts: [artifactFor(1), artifactFor(0)],
  chapterOrder: book.chapters.map((c) => c.name),
  generatedAt: 1_700_000_000_000,
});

describe("combineBilingual", () => {
  it("produces a standalone document", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("</html>");
    expect(html).toContain("hide-jp");
  });

  it("orders chapters by the book, not by import order", () => {
    expect(html.indexOf('id="tourou2026_0"')).toBeLessThan(html.indexOf('id="tourou2026_1-1"'));
  });

  it("shows the translation and the Japanese source for each line", () => {
    expect(html).toContain('<div class="tl">');
    expect(html).toContain('<div class="jp">');
    expect(html).toContain("[EN] ");
  });

  it("preserves branch navigation", () => {
    expect(html).toMatch(/<div class="label" id="quest_evMain_touroumatsuri2026_0"/);
    expect(html).toMatch(/<div class="jump">Jump to <a href="#quest_/);
  });

  it("keeps params, emphasis and ruby readings on the Japanese side", () => {
    expect(html).toContain("&lt;param=playerName&gt;");
    expect(html).toContain("<rt>たいら</rt>");
    expect(html).toContain("<em>");
  });

  it("does not invent ruby on the translated side", () => {
    const tlLines = html.match(/<div class="tl">.*?<\/div>/g) ?? [];
    expect(tlLines.length).toBeGreaterThan(0);
    expect(tlLines.some((l) => l.includes("<rt>"))).toBe(false);
  });

  it("closes every div it opens", () => {
    const divOpens = (html.match(/<div[ >]/g) ?? []).length;
    const divCloses = (html.match(/<\/div>/g) ?? []).length;
    expect(divCloses).toBe(divOpens);
  });

  it("renders conditional blocks and closes an unterminated one", () => {
    // These two books contain no cond-blocks (parse.py only emits them for
    // team/player conditions), so drive the branch directly.
    const base = artifactFor(0);
    const withCond: Artifact = {
      ...base,
      units: base.units.slice(0, 3),
      markers: [
        { at: 0, kind: "cond", expr: "playerTeam==1" },
        { at: 2, kind: "cond-end" },
        { at: 2, kind: "cond", expr: "never closed" },
      ],
    };
    const out = combineBilingual({ book: base.book, lang: "en", artifacts: [withCond] });
    expect(out).toContain("<code>If playerTeam==1</code>");
    expect((out.match(/<div[ >]/g) ?? []).length).toBe((out.match(/<\/div>/g) ?? []).length);
  });

  it("lists chapters that nobody has translated yet", () => {
    const out = combineBilingual({
      book: book.file,
      lang: "en",
      artifacts: [artifactFor(0)],
      chapterOrder: book.chapters.map((c) => c.name),
    });
    expect(out).toContain("Not translated yet: tourou2026_1-1");
  });

  it("marks individual missing lines rather than dropping them", () => {
    const partial = combineBilingual({
      book: book.file,
      lang: "en",
      artifacts: [artifactFor(0, false)],
    });
    expect(partial).toContain("[not translated]");
    expect(partial).toContain("line(s) untranslated");
  });

  it("includes chapters whose artifact book name differs in extension from book option", () => {
    const a0 = artifactFor(0);
    const a1 = {
      ...artifactFor(1),
      book: "touroumatsuri2026.html",
    };
    const out = combineBilingual({
      book: "touroumatsuri2026.book.html",
      lang: "en",
      artifacts: [a0, a1],
      chapterOrder: book.chapters.map((c) => c.name),
    });
    expect(out).toContain('id="tourou2026_0"');
    expect(out).toContain('id="tourou2026_1-1"');
    expect(out).not.toContain("Not translated yet: tourou2026_1-1");
  });

  it("names the file by book and language", () => {
    expect(combinedFileName(book.file, "zh-hant")).toBe("touroumatsuri2026.zh-hant.bilingual.html");
  });

  it("renders the custom target-language speaker name beside translated dialogue", () => {
    const chapter = book.chapters[0];
    const translations = new Map<string, string>();
    for (const n of chapter.nodes) if (isTranslatable(n)) translations.set(n.uid, `[EN] ${n.src}`);
    const first = chapter.nodes.find(
      (n): n is Extract<typeof n, { kind: "text" }> => n.kind === "text" && !!n.speaker,
    )!;
    const display = first.speaker!.nameText ?? first.speaker!.jp;
    const custom = buildArtifact({
      book: book.file,
      srcHash: book.srcHash,
      chapter,
      lang: "en",
      model: "mock",
      translations,
      generatedAt: 1_700_000_000_000,
      customNames: { [display]: "Custom Hero" },
    });

    const out = combineBilingual({ book: book.file, lang: "en", artifacts: [custom] });
    expect(out).toContain('<span class="chara">Custom Hero');
    expect(out).toContain(`<span class="chara">${first.speaker!.jp}:</span>`);
  });

  it("renders selection conditions and execute attributes in bilingual output", () => {
    const chapterWithCond: Chapter = {
      name: "ch_cond",
      nodes: [
        {
          kind: "select",
          uid: "ch_cond/1",
          src: "選択肢",
          hash: "12345678",
          to: "label_target",
          cond: "chasers2ab1==TRUE",
          exec: "chasers2ab1=FALSE",
        },
      ],
      units: 1,
      chars: 3,
    };
    const art = buildArtifact({
      book: "202607_montage_special.book.html",
      srcHash: "00000000",
      chapter: chapterWithCond,
      lang: "en",
      model: "mock",
      translations: new Map([["ch_cond/1", "Choice"]]),
      generatedAt: 1_700_000_000_000,
    });

    const out = combineBilingual({
      book: "202607_montage_special.book.html",
      lang: "en",
      artifacts: [art],
    });
    expect(out).toContain('data-if="chasers2ab1==TRUE"');
    expect(out).toContain('data-do="chasers2ab1=FALSE"');
    expect(out).toContain('(If chasers2ab1==TRUE)');
    expect(out).toContain('(Execute chasers2ab1=FALSE)');
  });
});
