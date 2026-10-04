import { describe, expect, it } from "vitest";
import { makeLabelMap } from "./labels";
import type { SceneNode, Speaker } from "./model";
import { cleanUnits, stripSelectMarker, stripSpeakerPrefix } from "./cleanup";
import { parseResponse, serializeChunk } from "./serialize";

describe("stripSelectMarker", () => {
  it("drops the exact alias the wire line carried", () => {
    expect(stripSelectMarker(">23-1aa_alt1 今天也多谢您的指导！", "23-1aa_alt1")).toBe(
      "今天也多谢您的指导！",
    );
  });

  it("drops an alias the model mangled, such as the prompt's own `>alt1` example", () => {
    expect(stripSelectMarker(">alt1 今天也多谢您的指导！", "23-1aa_alt1")).toBe("今天也多谢您的指导！");
    expect(stripSelectMarker(">23-1aa_alt1 ……我是不是稍微变厉害了一点？")).toBe(
      "……我是不是稍微变厉害了一点？",
    );
  });

  it("copes with no space after the alias, and with a bare `>`", () => {
    expect(stripSelectMarker(">23-1aa_alt1今天也", "23-1aa_alt1")).toBe("今天也");
    expect(stripSelectMarker(">今天也")).toBe("今天也");
    expect(stripSelectMarker("> Yes please")).toBe("Yes please");
  });

  it("leaves text without a leading `>` alone", () => {
    expect(stripSelectMarker("今天也多谢您的指导！", "x")).toBe("今天也多谢您的指导！");
    expect(stripSelectMarker("alt1 is a word")).toBe("alt1 is a word");
  });
});

describe("stripSpeakerPrefix", () => {
  const names = ["フーレイ紹介前", "ゼロトラストＣＥＯ？", "零信任CEO?"];

  it("strips a full-width colon with no space after it", () => {
    expect(
      stripSpeakerPrefix("零信任CEO？：对我来说，只要格里高利君觉得好，那就没问题。", names),
    ).toBe("对我来说，只要格里高利君觉得好，那就没问题。");
  });

  it("matches across width and punctuation differences", () => {
    expect(stripSpeakerPrefix("零信任CEO?：你好", names)).toBe("你好");
    expect(stripSpeakerPrefix("ゼロトラストCEO？：你好", names)).toBe("你好");
  });

  it("still handles the ASCII form", () => {
    expect(stripSpeakerPrefix("Tenjin: Hello", ["Tenjin"])).toBe("Hello");
    expect(stripSpeakerPrefix("Tenjin:Hello", ["Tenjin"])).toBe("Hello");
  });

  it("strips a name that itself contains a colon, whole", () => {
    expect(stripSpeakerPrefix("SYSTEM：DEUS：启动。", ["SYSTEM：DEUS"])).toBe("启动。");
  });

  it("only takes an unknown prefix on trust in loose mode", () => {
    expect(stripSpeakerPrefix("职员：你好", names)).toBe("职员：你好");
    expect(stripSpeakerPrefix("职员：你好", names, { loose: true })).toBe("你好");
  });

  it("does not take a sentence for a name, even in loose mode", () => {
    const line = "等等，听我说完：这很重要。";
    expect(stripSpeakerPrefix(line, names, { loose: true })).toBe(line);
  });

  it("never strips a line down to nothing", () => {
    expect(stripSpeakerPrefix("零信任CEO？：", names)).toBe("零信任CEO？：");
  });
});

describe("cleanUnits", () => {
  const ceo: Speaker = { jp: "フーレイ紹介前", nameText: "ゼロトラストＣＥＯ？", tl: { "zh-hans": "零信任CEO?" } };
  const unit = (id: string, tl: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: "text" as const,
    src: "こんにちは",
    tl,
    ...over,
  });

  it("repairs both of the reported cases", () => {
    const out = cleanUnits([
      unit("a/1", "零信任CEO？：对我来说，只要格里高利君觉得好，那就没问题。", { speaker: ceo }),
      unit("a/2", ">23-1aa_alt1 ……我是不是稍微变厉害了一点？", { kind: "select" }),
    ]);
    expect(out[0].tl).toBe("对我来说，只要格里高利君觉得好，那就没问题。");
    expect(out[1].tl).toBe("……我是不是稍微变厉害了一点？");
  });

  it("learns a name the model invented when it opens most of a speaker's lines", () => {
    const clerk: Speaker = { jp: "職員" };
    const out = cleanUnits([
      unit("a/1", "职员：欢迎光临。", { speaker: clerk }),
      unit("a/2", "职员：请问有什么事？", { speaker: clerk }),
      unit("a/3", "请稍等。", { speaker: clerk }),
    ]);
    expect(out.map((u) => u.tl)).toEqual(["欢迎光临。", "请问有什么事？", "请稍等。"]);
  });

  it("does not learn a prefix that appears once, or on a minority of lines", () => {
    const hero: Speaker = { jp: "主人公" };
    const lines = ["注意：别过来。", "好。", "嗯。", "知道了。", "走吧。"];
    const out = cleanUnits(lines.map((tl, i) => unit(`a/${i}`, tl, { speaker: hero })));
    expect(out.map((u) => u.tl)).toEqual(lines);
  });

  it("leaves narration untouched", () => {
    expect(cleanUnits([unit("a/1", "注意：前方危险。")])[0].tl).toBe("注意：前方危险。");
  });

  it("does not guess at a prefix when the source itself opens with a name", () => {
    const hero: Speaker = { jp: "主人公" };
    const lead = { src: "注意：これは原文通り", speaker: hero };
    // Repeated, so it would be learned if the guard did not hold.
    const lines = ["注意：别过来。", "注意：小心。"].map((tl, i) => unit(`a/${i}`, tl, lead));
    expect(cleanUnits(lines).map((u) => u.tl)).toEqual(["注意：别过来。", "注意：小心。"]);
  });

  it("still removes the speaker's own name when the source opens with a colon construct", () => {
    const system: Speaker = { jp: "SYSTEM：DEUS" };
    const out = cleanUnits([
      unit("a/1", "SYSTEM：DEUS: 第1条：关于游戏。", { speaker: system, src: "第1条：ゲームについて。" }),
    ]);
    expect(out[0].tl).toBe("第1条：关于游戏。");
  });

  it("is idempotent, and returns the same objects when nothing changes", () => {
    const once = cleanUnits([
      unit("a/1", "零信任CEO？：你好", { speaker: ceo }),
      unit("a/2", ">alt1 好的", { kind: "select" }),
      unit("a/3", "已经干净了"),
    ]);
    const twice = cleanUnits(once);
    expect(twice).toEqual(once);
    expect(twice[2]).toBe(once[2]);
  });

  it("keeps a select that is nothing but a marker", () => {
    expect(cleanUnits([unit("a/1", ">alt1", { kind: "select" })])[0].tl).toBe(">alt1");
  });
});

describe("echoed furniture, end to end", () => {
  const speaker: Speaker = { jp: "フーレイ紹介前", nameText: "ゼロトラストＣＥＯ？", tl: { "zh-hans": "零信任CEO?" } };
  const nodes: SceneNode[] = [
    { kind: "label", id: "quest_main_23-1_gdafter" },
    { kind: "select", uid: "q/1", src: "今日もご指導ありがとうございます！", hash: "1", to: "quest_main_23-1aa_alt1" },
    { kind: "label", id: "quest_main_23-1aa_alt1" },
    { kind: "text", uid: "q/2", src: "僕としては、グリゴリー君が良ければそれで良いから、ね。", hash: "2", speaker },
    { kind: "text", uid: "q/3", src: "（足音）", hash: "3" },
  ];
  const wire = serializeChunk(nodes, {
    labels: makeLabelMap(["quest_main_23-1_gdafter", "quest_main_23-1aa_alt1"]),
    lang: "zh-hans",
  });

  it("strips the alias and the speaker from a reply that echoes both", () => {
    const reply = [
      "1 >gdafter 今天也多谢您的指导！",
      "2 零信任CEO？：对我来说，只要格里高利君觉得好，那就没问题。",
      "3 （脚步声）",
    ].join("\n");
    const r = parseResponse(reply, wire.lines);
    expect(r.translations.get("q/1")).toBe("今天也多谢您的指导！");
    expect(r.translations.get("q/2")).toBe("对我来说，只要格里高利君觉得好，那就没问题。");
    expect(r.translations.get("q/3")).toBe("（脚步声）");
    expect(r.missing).toEqual([]);
  });

  it("strips the real alias the wire carried", () => {
    const alias = wire.lines[0].alias!;
    const r = parseResponse(`1 >${alias} 今天也多谢您的指导！\n2 x\n3 y`, wire.lines);
    expect(r.translations.get("q/1")).toBe("今天也多谢您的指导！");
  });

  it("does not strip a colon from narration", () => {
    const r = parseResponse("1 好\n2 好\n3 注意：前方", wire.lines);
    expect(r.translations.get("q/3")).toBe("注意：前方");
  });

  it("reports a select that was only the marker as missing, for the repair pass", () => {
    const r = parseResponse(`1 >${wire.lines[0].alias}\n2 好\n3 好`, wire.lines);
    expect(r.missing.map((l) => l.uid)).toEqual(["q/1"]);
  });
});
