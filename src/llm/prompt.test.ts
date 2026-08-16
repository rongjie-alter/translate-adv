import { describe, expect, it } from "vitest";
import { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT, glossaryBlock } from "./prompt";
import type { Speaker } from "../scenario/model";

describe("glossaryBlock", () => {
  it("omits character names that only contain question marks '？' or '?'", () => {
    const speakers: Speaker[] = [
      { jp: "？" },
      { jp: "？" },
      { jp: "？？？" },
      { jp: "?" },
      { jp: "???" },
      { jp: "？?", nameText: "？?" },
    ];
    expect(glossaryBlock(speakers, "en")).toBe("");
  });

  it("includes normal character names and filters out question-mark-only ones", () => {
    const speakers: Speaker[] = [
      { jp: "？" },
      { jp: "タサブロウ" },
      { jp: "？？？" },
      { jp: "男？" },
    ];
    const block = glossaryBlock(speakers, "en");
    expect(block).not.toContain("  ？");
    expect(block).not.toContain("  ？？？");
    expect(block).toContain("  タサブロウ");
    expect(block).toContain("  男？");
  });

  it("handles official translated names while filtering out question mark names", () => {
    const speakers: Speaker[] = [
      { jp: "？", tl: { en: "Unknown", "zh-hans": "未知", "zh-hant": "未知" } },
      { jp: "花子", tl: { en: "Hanako", "zh-hans": "花子", "zh-hant": "花子" } },
    ];
    const block = glossaryBlock(speakers, "en");
    expect(block).not.toContain("  ？ = Unknown");
    expect(block).toContain("  花子 = Hanako");
  });

  it("builds full system prompt without question-mark character names", () => {
    const speakers: Speaker[] = [
      { jp: "？" },
      { jp: "Alice", tl: { en: "Alice", "zh-hans": "爱丽丝", "zh-hant": "愛麗絲" } },
    ];
    const prompt = buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, "en", speakers);
    expect(prompt).not.toContain("  ？");
    expect(prompt).toContain("  Alice = Alice");
  });
});
