import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderCompact, toCompact } from "./inline";
import { makeLabelMap } from "./labels";
import { isTranslatable, type SelectNode, type TextNode } from "./model";
import { chapterSpeakers, parseBookHtml } from "./parseHtml";
import { parseResponse, serializeChunk, serializeSelection } from "./serialize";

const tourou = parseBookHtml(
  "touroumatsuri2026.book.html",
  readFileSync("book/touroumatsuri2026.book.html", "utf8"),
);
const valentine = parseBookHtml(
  "valentinetime2020_special.book.html",
  readFileSync("book/valentinetime2020_special.book.html", "utf8"),
);

describe("parseBookHtml", () => {
  it("splits chapters on h3", () => {
    expect(tourou.chapters.map((c) => c.name)).toEqual([
      "tourou2026_0",
      "tourou2026_1-1",
      "tourou2026_1-2",
      "tourou2026_2-1",
      "tourou2026_2-2",
      "tourou2026_3-1",
      "tourou2026_3-2",
    ]);
    expect(valentine.chapters).toHaveLength(1);
  });

  it("counts translatable units and characters", () => {
    for (const c of tourou.chapters) {
      expect(c.units).toBeGreaterThan(0);
      expect(c.chars).toBeGreaterThan(c.units);
    }
  });

  it("drops sprite-only rows that carry a speaker but no line", () => {
    const empties = tourou.chapters
      .flatMap((c) => c.nodes)
      .filter((n): n is TextNode => n.kind === "text" && n.src === "");
    expect(empties).toHaveLength(0);
  });

  it("drops bgm, background and voice ids", () => {
    const all = tourou.chapters.flatMap((c) => c.nodes);
    expect(all.some((n) => isTranslatable(n) && /^(BGM|Background):/.test(n.src))).toBe(false);
    expect(all.some((n) => isTranslatable(n) && /\(v_\w+\)/.test(n.src))).toBe(false);
  });

  it("compacts ruby, params, emphasis and size runs", () => {
    const texts = tourou.chapters.flatMap((c) =>
      c.nodes.filter((n): n is TextNode => n.kind === "text"),
    );
    expect(texts.some((t) => t.src.includes("平(たいら)"))).toBe(true);
    expect(texts.some((t) => t.src.startsWith("{playerName}は布団から出て、"))).toBe(true);
    expect(texts.some((t) => t.src.includes("*許婚*"))).toBe(true);

    const big = texts.find((t) => t.sizes?.length);
    expect(big!.src).toMatch(/\^.+\^/);
    expect(big!.sizes![0]).toBeGreaterThan(0);
  });

  it("strips line breaks", () => {
    const all = tourou.chapters.flatMap((c) => c.nodes).filter(isTranslatable);
    expect(all.some((n) => n.src.includes("\n") || n.src.includes("<br>"))).toBe(false);
  });

  it("keeps branch structure", () => {
    const ch0 = tourou.chapters[0];
    const selects = ch0.nodes.filter((n): n is SelectNode => n.kind === "select");
    expect(selects.length).toBeGreaterThan(0);
    expect(selects[0].to).toMatch(/^quest_evMain_touroumatsuri2026_0/);
    expect(selects.some((s) => s.src === "（飛び起きる）")).toBe(true);

    const jumps = ch0.nodes.filter((n) => n.kind === "jump");
    expect(jumps.length).toBeGreaterThan(0);
    expect(ch0.nodes.some((n) => n.kind === "label")).toBe(true);
  });

  it("gives every translatable unit a unique id scoped to its label", () => {
    for (const c of tourou.chapters) {
      const uids = c.nodes.filter(isTranslatable).map((n) => n.uid);
      expect(new Set(uids).size).toBe(uids.length);
      expect(uids[0]).toMatch(/\/\d+$/);
    }
  });

  it("parses speaker name and pose", () => {
    const speakers = chapterSpeakers(tourou.chapters[0]);
    expect(speakers.length).toBeGreaterThan(3);
    expect(speakers.every((s) => !s.jp.endsWith(":"))).toBe(true);
    expect(speakers.some((s) => s.jp === "タサブロウ")).toBe(true);
    // One entry per sprite id, not per pose.
    expect(speakers.filter((s) => s.jp === "タサブロウ")).toHaveLength(1);

    const withPose = tourou.chapters[0].nodes.find(
      (n): n is TextNode => n.kind === "text" && !!n.speaker?.pose,
    );
    expect(withPose!.speaker!.pose).toBeTruthy();
    expect(withPose!.speaker!.jp).not.toContain("(");
  });
});

describe("parse.py --tl_meta attributes", () => {
  it("is detected", () => {
    expect(tourou.hasMeta).toBe(true);
    expect(tourou.hasCharaMeta).toBe(true); // regenerated with the consolidated #chara-meta dict
  });

  it("supplies official character names per language", () => {
    const speaker = chapterSpeakers(tourou.chapters[0]).find((s) => s.tl?.en);
    expect(speaker).toBeDefined();
    expect(speaker!.tl).toMatchObject({
      en: expect.any(String),
      "zh-hans": expect.any(String),
      "zh-hant": expect.any(String),
    });
  });

  it("takes the speaker and pose from attributes rather than the visible text", () => {
    const withPose = tourou.chapters[0].nodes.find(
      (n): n is TextNode => n.kind === "text" && n.speaker?.pose === "hide sprite",
    );
    expect(withPose!.speaker!.jp).not.toContain("(");
  });

  it("keeps selection conditions out of the translated text", () => {
    const selects = tourou.chapters.flatMap((c) =>
      c.nodes.filter((n): n is SelectNode => n.kind === "select"),
    );
    expect(selects.every((s) => !/\((If|Execute) /.test(s.src))).toBe(true);
    expect(selects.every((s) => s.to)).toBe(true);
  });

  it("degrades to the visible text when the attributes are absent", () => {
    const stripped = readFileSync("book/touroumatsuri2026.book.html", "utf8")
      .replace(/ data-[a-z-]+="[^"]*"/g, "");
    const plain = parseBookHtml("plain.book.html", stripped);
    expect(plain.hasMeta).toBe(false);
    expect(plain.chapters.map((c) => c.units)).toEqual(tourou.chapters.map((c) => c.units));
    const speakers = chapterSpeakers(plain.chapters[0]);
    expect(speakers.some((s) => s.jp === "タサブロウ")).toBe(true);
    expect(speakers.every((s) => !s.tl)).toBe(true);
  });

  it("resolves official names through the consolidated data-chara-id + #chara-meta dict", () => {
    const html = `<body data-parse-version="3">
<h3 id="ch1">ch1</h3>
<div class="label" id="ch1_a">Label: ch1_a</div>
<div class="text" data-chara-id="0" data-pose="通常"><span class="chara">花子 (通常):</span> こんにちは</div>
<script type="application/json" id="chara-meta">{"0":{"chara":"花子","en":"Hanako","zh-hans":"花子","zh-hant":"花子"}}</script>
</body>`;
    const book = parseBookHtml("synthetic.book.html", html);
    expect(book.hasMeta).toBe(true);
    expect(book.hasCharaMeta).toBe(true);
    const speaker = chapterSpeakers(book.chapters[0])[0];
    expect(speaker.jp).toBe("花子");
    expect(speaker.pose).toBe("通常");
    expect(speaker.tl).toEqual({ en: "Hanako", "zh-hans": "花子", "zh-hant": "花子" });
  });

  it("reports hasCharaMeta false for legacy inline attributes, while names still resolve", () => {
    // The real fixture now carries the consolidated #chara-meta dict, so this
    // legacy-inline-attribute case is covered with a synthetic data-parse-version="2" fixture.
    const html = `<body data-parse-version="2">
<h3 id="ch1">ch1</h3>
<div class="label" id="ch1_a">Label: ch1_a</div>
<div class="text" data-chara="花子" data-pose="通常" data-chara-en="Hanako"><span class="chara">花子 (通常):</span> こんにちは</div>
</body>`;
    const book = parseBookHtml("legacy.book.html", html);
    expect(book.hasCharaMeta).toBe(false);
    const speaker = chapterSpeakers(book.chapters[0])[0];
    expect(speaker.tl?.en).toBe("Hanako");
  });
});

describe("makeLabelMap", () => {
  it("strips the shared prefix", () => {
    const map = makeLabelMap([
      "quest_evMain_touroumatsuri2026_0_a_alt1",
      "quest_evMain_touroumatsuri2026_0_a_alt2",
      "quest_evMain_touroumatsuri2026_0_a_after",
    ]);
    expect(map.alias("quest_evMain_touroumatsuri2026_0_a_alt1")).toBe("alt1");
    expect(map.expand("alt1")).toBe("quest_evMain_touroumatsuri2026_0_a_alt1");
  });

  it("falls back to a positional alias when the remainder is empty or too long", () => {
    const map = makeLabelMap(["a_b", "a_b_the_rest_is_far_too_long_here"]);
    expect(map.alias("a_b")).toBe("b");
    expect(map.alias("a_b_the_rest_is_far_too_long_here")).toBe("L1");

    const degenerate = makeLabelMap(["x_", "x_y"]);
    expect(degenerate.alias("x_")).toBe("L0");
    expect(degenerate.expand("L0")).toBe("x_");
  });

  it("survives labels with nothing in common", () => {
    const map = makeLabelMap(["alpha", "beta"]);
    expect(map.expand(map.alias("alpha"))).toBe("alpha");
  });
});

describe("serializeChunk", () => {
  const ch = tourou.chapters[0];
  const labels = makeLabelMap(
    ch.nodes.flatMap((n) => (n.kind === "label" ? [n.id] : n.kind === "jump" ? [n.to] : [])),
  );
  const chunk = serializeChunk(ch.nodes.slice(0, 60), { labels, lang: "en" });

  it("numbers only translatable lines, from 1", () => {
    expect(chunk.lines[0].n).toBe(1);
    expect(chunk.lines.map((l) => l.n)).toEqual(chunk.lines.map((_, i) => i + 1));
  });

  it("emits structure as unnumbered context lines", () => {
    expect(chunk.text).toMatch(/^== .+ ==$/m);
    expect(chunk.text).toMatch(/^=> /m);
  });

  it("uses short label aliases, never the full id", () => {
    expect(chunk.text).not.toContain("quest_evMain_touroumatsuri2026");
  });

  it("prefixes selections with their branch target", () => {
    expect(chunk.text).toMatch(/^\d+ >\S+ （飛び起きる）$/m);
  });

  it("includes carry-over context lines", () => {
    const withCtx = serializeChunk(ch.nodes.slice(0, 10), {
      labels,
      lang: "en",
      context: ["Previously translated line."],
    });
    expect(withCtx.text.startsWith("~ Previously translated line.")).toBe(true);
  });
});

describe("serializeSelection", () => {
  const ch = tourou.chapters[0];
  const labels = makeLabelMap(
    ch.nodes.flatMap((n) => (n.kind === "label" ? [n.id] : n.kind === "jump" ? [n.to] : [])),
  );
  const targets = ch.nodes.filter(isTranslatable);

  const groups = [
    {
      items: [
        { role: "context" as const, text: "Something said earlier." },
        { role: "target" as const, node: targets[0] },
      ],
    },
    {
      items: [
        { role: "context" as const, text: "Something said much later." },
        { role: "target" as const, node: targets[10] },
      ],
    },
  ];
  const wire = serializeSelection(groups, { labels, lang: "en" });

  it("numbers ascending across groups so one parse maps them all", () => {
    expect(wire.lines.map((l) => l.n)).toEqual([1, 2]);
    expect(wire.lines.map((l) => l.uid)).toEqual([targets[0].uid, targets[10].uid]);
  });

  it("marks the jump between groups with an existing token", () => {
    expect(wire.text.split("\n").filter((l) => l === "~ [...]")).toHaveLength(1);
    // `~` is what the prompt, parseResponse and mock_server already skip.
    expect(wire.text).toMatch(/^~ /m);
  });

  it("never numbers a context line", () => {
    const numbered = wire.text.split("\n").filter((l) => /^\d+ /.test(l));
    expect(numbered).toHaveLength(2);
  });

  it("round-trips through parseResponse", () => {
    const reply = wire.lines.map((l) => `${l.n} translated ${l.n}`).join("\n");
    const parsed = parseResponse(reply, wire.lines);
    expect(parsed.missing).toEqual([]);
    expect(parsed.translations.get(targets[0].uid)).toBe("translated 1");
    expect(parsed.translations.get(targets[10].uid)).toBe("translated 2");
  });

  it("ignores a model that echoes the context back", () => {
    const reply = `~ Something said earlier.\n1 first\n~ [...]\n2 second`;
    const parsed = parseResponse(reply, wire.lines);
    expect(parsed.translations.get(targets[0].uid)).toBe("first");
    expect(parsed.translations.get(targets[10].uid)).toBe("second");
  });
});

describe("parseResponse", () => {
  const lines = [
    { n: 1, uid: "a/1", src: "こんにちは", hadSpeaker: true },
    { n: 2, uid: "a/2", src: "さようなら", hadSpeaker: false },
    { n: 3, uid: "a/3", src: "またね", hadSpeaker: false },
  ];

  it("maps ids back to uids", () => {
    const r = parseResponse("1 Hello\n2 Goodbye\n3 See you", lines);
    expect(r.translations.get("a/2")).toBe("Goodbye");
    expect(r.missing).toHaveLength(0);
  });

  it("reports missing lines for the repair pass", () => {
    const r = parseResponse("1 Hello\n3 See you", lines);
    expect(r.missing.map((l) => l.n)).toEqual([2]);
  });

  it("ignores code fences, structure echoes and invented ids", () => {
    const r = parseResponse("```\n== L1 ==\n1 Hello\n2 Goodbye\n9 Invented\n3 Bye\n```", lines);
    expect(r.extra).toEqual([9]);
    expect(r.translations.get("a/1")).toBe("Hello");
    expect(r.missing).toHaveLength(0);
  });

  it("joins wrapped continuation lines", () => {
    const r = parseResponse("1 Hello there,\nfriend of mine\n2 Goodbye\n3 Bye", lines);
    expect(r.translations.get("a/1")).toBe("Hello there, friend of mine");
  });

  it("strips an echoed speaker name only when the source had a speaker", () => {
    const r = parseResponse("1 Tenjin: Hello\n2 Tenjin: Goodbye\n3 Bye", lines);
    expect(r.translations.get("a/1")).toBe("Hello");
    expect(r.translations.get("a/2")).toBe("Tenjin: Goodbye");
  });

  it("accepts common id separators", () => {
    const r = parseResponse("1. Hello\n2) Goodbye\n3\tBye", lines);
    expect(r.missing).toHaveLength(0);
  });

  it("strips a thinking block glued to the first numbered line", () => {
    // Gemma-style reasoning models emit `<thought>...</thought>1 text` with no
    // newline in between, so line 1 would otherwise be swallowed by the thought.
    const r = parseResponse("<thought>plan: translate line 1 first</thought>1 Hello\n2 Goodbye\n3 Bye", lines);
    expect(r.translations.get("a/1")).toBe("Hello");
    expect(r.missing).toHaveLength(0);
  });

  it("passes an unfamiliar {param} placeholder through the wire format untouched", () => {
    const node: TextNode = { kind: "text", uid: "a/1", src: "{someNewParam}に会う", hash: "deadbeef" };
    const chunk = serializeChunk([node], { labels: makeLabelMap([]), lang: "en" });
    expect(chunk.text).toContain("{someNewParam}");

    const r = parseResponse("1 Meet {someNewParam}", chunk.lines);
    expect(r.translations.get("a/1")).toBe("Meet {someNewParam}");
  });
});

describe("renderCompact", () => {
  it("restores ruby on the Japanese side and leaves it alone otherwise", () => {
    expect(renderCompact("平(たいら)の御殿様")).toContain("<rt>たいら</rt>");
    expect(renderCompact("Taira(tai) lord", { ruby: false })).not.toContain("<rt>");
  });

  it("restores params, emphasis and size runs", () => {
    expect(renderCompact("{playerName}は")).toContain("&lt;param=playerName&gt;");
    expect(renderCompact("我が*許婚*が")).toContain("<em>許婚</em>");
    expect(renderCompact("^おはよう^", { sizes: [45] })).toContain("calc(45px * 0.5)");
  });

  it("escapes stray angle brackets", () => {
    expect(renderCompact("a < b & c")).toBe("a &lt; b &amp; c");
  });

  it("round-trips an arbitrary param name never seen in the sample books", () => {
    const doc = new DOMParser().parseFromString(
      '<p><code data-param="teamLeaderCharaName">&lt;param=teamLeaderCharaName&gt;</code>と話す</p>',
      "text/html",
    );
    const { text } = toCompact(doc.querySelector("p")!);
    expect(text).toBe("{teamLeaderCharaName}と話す");
    expect(renderCompact(text)).toContain("<code>&lt;param=teamLeaderCharaName&gt;</code>");
  });
});
