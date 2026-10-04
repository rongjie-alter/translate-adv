import { describe, expect, it } from "vitest";
import { buildGlossary, chapterGlossary, countMentions, GLOSSARY_LIMIT, isValuableTerm } from "./glossary";
import type { SceneNode, Speaker } from "./model";
import { parseBookHtml } from "./parseHtml";

let n = 0;
const line = (src: string, speaker?: Speaker): SceneNode => ({
  kind: "text",
  uid: `c/${++n}`,
  src,
  hash: String(n),
  ...(speaker ? { speaker } : {}),
});

const yoshiori: Speaker = { jp: "ヨシオリ", tl: { en: "Yoshiori" } };

describe("isValuableTerm", () => {
  it.each(["？？？？", "■■■■■■", "（観客）", "体育会系大学生？", "エンジェルたち", "子供達", "３人", "生徒３人", "全員", "少年", "社員", "あ"])(
    "drops %s",
    (k) => expect(isValuableTerm(k)).toBe(false),
  );

  it.each(["ヨシオリ", "アナウンス", "潜行のキョウイチ", "イド・レプリカ", "「介在者」", "ビオトープ"])(
    "keeps %s",
    (k) => expect(isValuableTerm(k)).toBe(true),
  );
});

describe("countMentions", () => {
  it("prefers the longest key and claims each stretch of text once", () => {
    const c = countMentions(["カイブツ", "カイブツ幼体"], ["カイブツ幼体が現れた。カイブツだ。"]);
    expect(c.get("カイブツ幼体")).toBe(1);
    expect(c.get("カイブツ")).toBe(1);
  });

  it("does not match a katakana key inside a longer katakana word", () => {
    const c = countMentions(["アカシ"], ["アカシアの木", "アカシは笑った", "ヴァアカシ"]);
    expect(c.get("アカシ")).toBe(1);
  });

  it("matches across ruby readings", () => {
    expect(countMentions(["星の海"], ["星(ほし)の海(うみ)へ"]).get("星の海")).toBe(1);
  });

  it("applies no boundary check to kanji keys", () => {
    expect(countMentions(["介在者"], ["あの介在者たち"]).get("介在者")).toBe(1);
  });
});

describe("buildGlossary", () => {
  const base = { lang: "en" as const, speakers: [] as Speaker[] };

  it("Case 1: a character who speaks elsewhere in the book is sent when merely mentioned", () => {
    const ch4 = [line("ヨシオリはどこだ？", { jp: "ハックル", tl: { en: "Huckle" } })];
    const hit = buildGlossary({
      ...base,
      nodes: ch4,
      speakers: [{ jp: "ハックル", tl: { en: "Huckle" } }],
      bookSpeakers: [yoshiori, { jp: "ハックル", tl: { en: "Huckle" } }],
    });
    expect(hit.map((g) => g.jp)).toContain("ヨシオリ");
    // ...and not when they are neither a speaker nor mentioned.
    expect(buildGlossary({ ...base, nodes: [line("関係ない話。")], bookSpeakers: [yoshiori] })).toEqual([]);
  });

  it("Case 2: a never-speaking name comes from the term table", () => {
    const g = buildGlossary({
      ...base,
      nodes: [line("セイイチロウが来た。")],
      terms: { セイイチロウ: { en: "Seiichirou" }, ツネアキ: { en: "Tsuneaki" } },
    });
    expect(g).toEqual([{ jp: "セイイチロウ", tl: "Seiichirou", source: "official", count: 1 }]);
  });

  it("Case 3: the user's own terms are sent only where the Japanese appears, and skip the value filter", () => {
    const custom = { パラレルフライト: "Parallel Flight", 警報: "Alarm" };
    const withTerm = buildGlossary({ ...base, nodes: [line("パラレルフライトが始まる。警報が鳴る。")], custom });
    expect(withTerm.map((g) => [g.jp, g.tl, g.source])).toEqual([
      ["パラレルフライト", "Parallel Flight", "custom"],
      ["警報", "Alarm", "custom"],
    ]);
    expect(buildGlossary({ ...base, nodes: [line("別の話。")], custom })).toEqual([]);
  });

  it("filters low-value official entries but not speakers' real names", () => {
    const g = buildGlossary({
      ...base,
      nodes: [line("全員そろって少年を見た。ヨシオリも。")],
      terms: { 全員: { en: "Everyone" }, 少年: { en: "Boy" }, ヨシオリ: { en: "Yoshiori" } },
    });
    expect(g.map((e) => e.jp)).toEqual(["ヨシオリ"]);
  });

  it("always sends this chapter's speakers, ranked before mentioned terms", () => {
    const hanako: Speaker = { jp: "ハナコ", tl: { en: "Hanako" } };
    const g = buildGlossary({
      ...base,
      speakers: [hanako],
      nodes: [line("", hanako), line("タサブロウ、タサブロウ、タサブロウ"), line("…", hanako)],
      terms: { タサブロウ: { en: "Tasaburou" } },
    });
    expect(g.map((e) => [e.jp, e.source])).toEqual([
      ["ハナコ", "speaker"],
      ["タサブロウ", "official"],
    ]);
  });

  it("parser name wins for a speaker; the user's wins over a game-table term", () => {
    const g = buildGlossary({
      ...base,
      speakers: [yoshiori],
      nodes: [line("ヨシオリ", yoshiori), line("ツネアキ")],
      terms: { ツネアキ: { en: "Tsuneaki" } },
      custom: { ヨシオリ: "Mine", ツネアキ: "Tsune" },
    });
    expect(Object.fromEntries(g.map((e) => [e.jp, e.tl]))).toEqual({ ヨシオリ: "Yoshiori", ツネアキ: "Tsune" });
  });

  it("uses nameText so costume variants collapse to one line", () => {
    const a: Speaker = { jp: "オニワカ法被", nameText: "オニワカ", tl: { en: "Oniwaka" } };
    const b: Speaker = { jp: "オニワカ普段着", nameText: "オニワカ", tl: { en: "Oniwaka" } };
    const g = buildGlossary({ ...base, speakers: [a, b], nodes: [line("x", a), line("y", b)] });
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ jp: "オニワカ", count: 2 });
  });

  it("honours exclusions", () => {
    const g = buildGlossary({
      ...base,
      nodes: [line("セイイチロウとツネアキ")],
      terms: { セイイチロウ: { en: "Seiichirou" }, ツネアキ: { en: "Tsuneaki" } },
      excluded: ["ツネアキ"],
    });
    expect(g.map((e) => e.jp)).toEqual(["セイイチロウ"]);
  });

  it("caps the list, dropping the least frequent", () => {
    const terms: Record<string, { en: string }> = {};
    const text: string[] = [];
    for (let i = 0; i < GLOSSARY_LIMIT + 10; i++) {
      const jp = `テスト${String.fromCharCode(0x30a1 + (i % 80))}${String.fromCharCode(0x30a1 + ((i * 7) % 80))}ン`;
      terms[jp] = { en: `T${i}` };
      text.push(jp.repeat(i + 1));
    }
    const g = buildGlossary({ ...base, nodes: text.map((t) => line(t)), terms });
    expect(g.length).toBeLessThanOrEqual(GLOSSARY_LIMIT);
    expect(g[0].count).toBeGreaterThanOrEqual(g[g.length - 1].count);
  });

  it("skips entries whose translation equals the Japanese", () => {
    const g = buildGlossary({ ...base, nodes: [line("ABC-12")], custom: { "ABC-12": "ABC-12" } });
    expect(g).toEqual([]);
  });
});

describe("book integration", () => {
  const html = (withTerms: boolean) => `<body data-parse-version="4">
<h3 id="a">a</h3><div class="label" id="a1">Label: a1</div>
<div class="text" data-chara-id="0"><span class="chara">ヨシオリ (通常):</span> こんにちは</div>
<h3 id="b">b</h3><div class="label" id="b1">Label: b1</div>
<div class="text">ヨシオリとセイイチロウの話。</div>
<script type="application/json" id="chara-meta">{"0":{"chara":"ヨシオリ","en":"Yoshiori"}}</script>
${withTerms ? '<script type="application/json" id="term-meta">{"セイイチロウ":{"en":"Seiichirou"},"空":{}}</script>' : ""}
</body>`;

  it("sends a speaker from another chapter, and #term-meta names, when mentioned", () => {
    const book = parseBookHtml("x.book.html", html(true));
    expect(book.terms).toEqual({ セイイチロウ: { en: "Seiichirou" } });
    const g = chapterGlossary(book, book.chapters[1], "en");
    expect(g.map((e) => [e.jp, e.tl])).toEqual([
      ["ヨシオリ", "Yoshiori"],
      ["セイイチロウ", "Seiichirou"],
    ]);
  });

  it("still works without #term-meta (older files)", () => {
    const book = parseBookHtml("x.book.html", html(false));
    expect(book.terms).toBeUndefined();
    expect(chapterGlossary(book, book.chapters[1], "en").map((e) => e.jp)).toEqual(["ヨシオリ"]);
  });
});
