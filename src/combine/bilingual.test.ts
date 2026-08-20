import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isTranslatable } from "../scenario/model";
import { parseBookHtml } from "../scenario/parseHtml";
import { buildArtifact, type Artifact } from "../storage/exchange";
import { combineBilingual, combinedFileName } from "./bilingual";

const book = parseBookHtml(
  "touroumatsuri2026.book.html",
  readFileSync("book/touroumatsuri2026.book.html", "utf8"),
);

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
    expect(html).toMatch(/class="to" href="#quest_[^"]*">→/);
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
    expect(html).toContain("Not translated yet: tourou2026_1-2");
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
});
