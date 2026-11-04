import { describe, expect, it } from "vitest";
import { DEFAULT_SUMMARY_PROMPT, detectLanguage, lengthHint, renderSummaryPrompt } from "./prompt";

describe("detectLanguage", () => {
  it("tells Japanese by its kana", () => {
    expect(detectLanguage("タサブロウ: 今日はいい天気ですね。祭りの準備をしましょう。")).toBe("ja");
  });

  it("tells English", () => {
    expect(detectLanguage("Tasaburo: It is a fine day. Let us prepare for the festival.")).toBe("en");
    expect(detectLanguage("")).toBe("en");
  });

  it("tells simplified from traditional Chinese", () => {
    expect(detectLanguage("他们说这个国家的学生都在时间里来到了会场")).toBe("zh-hans");
    expect(detectLanguage("他們說這個國家的學生都在時間裡來到了會場")).toBe("zh-hant");
  });

  it("falls back to plain Chinese when no character gives the script away", () => {
    expect(detectLanguage("天空很蓝")).toBe("zh");
  });

  it("is not fooled by a few ideographs in English", () => {
    expect(detectLanguage("The word 祭 means festival, and the rest of this sentence is long plain English.")).toBe("en");
  });
});

describe("renderSummaryPrompt", () => {
  it("names the language and a length in the text's own unit", () => {
    const en = renderSummaryPrompt(DEFAULT_SUMMARY_PROMPT, "en", "medium");
    expect(en).toContain("in English");
    expect(en).toContain(lengthHint("medium", "en"));
    expect(en).toMatch(/words/);

    const ja = renderSummaryPrompt(DEFAULT_SUMMARY_PROMPT, "ja", "short");
    expect(ja).toContain("in Japanese");
    expect(ja).toMatch(/characters/);
    expect(ja).not.toContain("{{");
  });
});
